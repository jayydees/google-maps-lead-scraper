// ==UserScript==
// @name         Google Maps Lead Scraper
// @namespace    jatin.maps.leads
// @version      3.2.0
// @description  Scrape Google Maps search results into a lead list (name, rating, reviews, category, address, coords), then enrich selected rows with phone + real website on demand. CSV export. Rate-limited.
// @author       jatin
// @match        https://www.google.com/maps*
// @match        https://maps.google.com/*
// @include      /^https:\/\/(www|maps)\.google\.[a-z.]+\/maps\b/
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      api.bigdatacloud.net
// ==/UserScript==

(function () {
  'use strict';
  if (window.__gmlsLoaded) return;        // guard against double-injection
  window.__gmlsLoaded = true;

  /* ============================================================
   * SELECTOR CONTRACT  -  the only place selectors live.
   * If Google breaks the scraper, fix it HERE. All selectors are
   * roles / aria-labels / data-item-id (semantic, slow to rot).
   * ========================================================== */
  const SEL = {
    searchInput: 'input[name="q"]',
    feed:        'div[role="feed"]',
    article:     'div[role="article"]',
    placeLink:   'a[href*="/maps/place/"]',
    ratingImg:   'span[role="img"][aria-label*="star"]',
    adButton:    'button[aria-label="Why this ad?"]',
    // detail panel
    detailReady: '[data-item-id="authority"],[data-item-id^="phone:tel:"],[data-item-id="address"]',
    phone:       'button[data-item-id^="phone:tel:"]',
    website:     'a[data-item-id="authority"]',
    address:     'button[data-item-id="address"]',
  };

  /* ---- tunables / guardrails ---- */
  const CFG = {
    scrollDelay: 700, scrollJitter: 500, scrollStableCycles: 4, scrollMaxIters: 80,
    enrichDelay: 1300, enrichJitter: 1500,   // delay BETWEEN detail visits (anti-autoban)
    detailTimeout: 12000, phoneWait: 9000, feedTimeout: 12000,
    defaultMax: 60,
  };
  const LS = { job: 'gmls_job', data: 'gmls_data', enrich: 'gmls_enrich', enrichStop: 'gmls_enrich_stop', note: 'gmls_note' };

  // === EDIT THIS: your LinkedIn profile URL (used by the credit bar) ===
  const AUTHOR = { name: 'Jatin Dinesh', url: 'https://www.linkedin.com/in/jatindinesh' };

  /* ============================================================
   * small utilities
   * ========================================================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand  = (a, b) => a + Math.floor(Math.random() * (b - a));
  const $     = (s, r = document) => r.querySelector(s);
  const $$    = (s, r = document) => [...r.querySelectorAll(s)];

  function waitFor(pred, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        let v; try { v = pred(); } catch { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(poll, 200);
      })();
    });
  }

  // hyperscript helper - dynamic text ALWAYS via textContent (Trusted-Types safe, XSS-safe)
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'title') n.title = v;
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false)
      n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return n;
  }

  // SVG icon helpers
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(paths, { size = 20, sw = 1.8, fill = 'none', vb = 24 } = {}) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', `0 0 ${vb} ${vb}`); s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('fill', fill);
    if (fill === 'none') { s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', sw); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); }
    for (const d of [].concat(paths)) { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  }
  const IC = {
    gear: () => svg('M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.48.48 0 0013.4 2h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.22 8.47a.49.49 0 00.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 110-7.2 3.6 3.6 0 010 7.2z', { fill: 'currentColor', size: 18 }),
    close: () => svg(['M18 6 6 18', 'M6 6l12 12'], { size: 18 }),
    minimize: () => svg(['M5 12h14'], { size: 18 }),
    back:  () => svg(['M19 12H5', 'M12 19l-7-7 7-7'], { size: 18 }),
    chevron: () => svg(['M6 9l6 6 6-6'], { size: 16 }),
    pin:   () => svg(['M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z', 'M12 13a3 3 0 100-6 3 3 0 000 6z'], { size: 34, sw: 1.6 }),
  };
  function statusCircle(ok) {
    const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', 18); s.setAttribute('height', 18);
    const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', 12); c.setAttribute('cy', 12); c.setAttribute('r', 10); c.setAttribute('fill', ok ? '#16a34a' : '#ef4444');
    const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#fff'); p.setAttribute('stroke-width', '2.2'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('d', ok ? 'M7.5 12.5l3 3 6-6.5' : 'M9 9l6 6M15 9l-6 6');
    s.appendChild(c); s.appendChild(p); return s;
  }
  // Google Maps logo (multicolor pin) built via clipPath; unique id per instance
  let __uid = 0;
  function mapsLogo(size = 20) {
    const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
    const id = 'gmls-pin-' + (++__uid);
    const mk = (t, a) => { const e = document.createElementNS(SVGNS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
    const defs = document.createElementNS(SVGNS, 'defs');
    const cp = mk('clipPath', { id });
    cp.appendChild(mk('path', { d: 'M12 2C7.58 2 4 5.58 4 10c0 5.4 6.6 11 7.35 11.64a1 1 0 0 0 1.3 0C13.4 21 20 15.4 20 10 20 5.58 16.42 2 12 2z' }));
    defs.appendChild(cp); s.appendChild(defs);
    const g = mk('g', { 'clip-path': `url(#${id})` });
    g.appendChild(mk('rect', { x: 0, y: 0, width: 24, height: 24, fill: '#EA4335' }));
    g.appendChild(mk('polygon', { points: '0,9 24,9 24,24 0,24', fill: '#4285F4' }));
    g.appendChild(mk('polygon', { points: '0,14 24,2 24,8 6,24 0,24', fill: '#34A853' }));
    g.appendChild(mk('polygon', { points: '0,0 10,0 0,9', fill: '#FBBC04' }));
    s.appendChild(g);
    s.appendChild(mk('circle', { cx: 12, cy: 9.2, r: 3, fill: '#fff' }));
    return s;
  }
  // LinkedIn glyph (brand blue) for the credit bar
  function linkedinIcon(size = 16) {
    const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('fill', '#0A66C2');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', 'M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 110-4.13 2.06 2.06 0 010 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z');
    s.appendChild(p); return s;
  }

  /* ============================================================
   * extraction
   * ========================================================== */
  function parsePlaceHref(href) {
    const ll  = href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    const cid = href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    return { lat: ll ? ll[1] : '', lng: ll ? ll[2] : '', cid: cid ? cid[1] : '', url: href.split('?')[0] };
  }

  function parseInfo(article, name) {
    // Card text is e.g.:  name / "4.8(194) · ₹1–200" / "Category ·  · Address" / "Open · Closes 11 pm" / service tags
    // We want the "Category · [service] · Address" line, NOT the "rating · price" line.
    const lines = (article.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const hoursRe = /(^Open\b|Clos|Opens|Closes|24 hours|Permanently|Temporarily)/i;
    const ratingTok = /^\d([.,]\d)?\(?[\d,]+\)?$/;   // "4.8" or "4.8(194)" -> marks the rating·price line
    const priceRe = /[₹$€£¥]/;                        // a currency token is a price, never an address
    const serviceRe = /^(Dine-in|Takeaway|Take-out|Takeout|Delivery|No-contact delivery|Kerbside pickup|Drive-through|Curbside pickup|In-store shopping|Reserve a table|Order online|Reserve)$/i;
    let category = '', address = '';
    for (const ln of lines) {
      if (ln === name || ln === 'Sponsored' || ln === '·') continue;
      if (hoursRe.test(ln)) continue;
      if (serviceRe.test(ln)) continue;
      if (!ln.includes('·')) continue;
      const parts = ln.split('·').map((p) => p.trim()).filter(Boolean);
      if (!parts.length) continue;
      if (ratingTok.test(parts[0].replace(/\s/g, ''))) continue; // skip the "rating · price" line
      category = parts[0];
      const rest = parts.slice(1).filter((p) => !serviceRe.test(p) && !priceRe.test(p));
      address = rest.length ? rest[rest.length - 1] : '';
      break;
    }
    // phone shown on the card, e.g. "Open · Closes 8:30 pm · 074831 28061"
    let phone = '';
    for (const ln of lines) for (const part of ln.split('·').map((t) => t.trim())) {
      if (/^[+(]?\d[\d\s\-()]{7,}$/.test(part) && part.replace(/\D/g, '').length >= 8) { phone = part; break; }
    }
    return { category, address, phone };
  }

  function extractCard(article) {
    const link = $(SEL.placeLink, article);
    if (!link) return null;
    // Google moved the name from the article's aria-label onto the place link's; try both, then first text line
    let name = (link.getAttribute('aria-label') || article.getAttribute('aria-label') || (article.innerText || '').split('\n')[0] || '')
      .replace(/\s*·\s*Visited link\s*$/, '').trim();
    if (!name) return null;
    const meta = parsePlaceHref(link.href);
    const key = meta.cid || meta.url || name;

    let rating = '', reviews = '';
    const rEl = $(SEL.ratingImg, article);
    if (rEl) {
      const m = (rEl.getAttribute('aria-label') || '').match(/([\d.,]+)\s*stars?\s*([\d,]+)?\s*Review/i);
      if (m) { rating = m[1].replace(',', '.'); if (m[2]) reviews = m[2].replace(/,/g, ''); }
    }
    const { category, address, phone } = parseInfo(article, name);
    const ad = !!$(SEL.adButton, article) || /^Sponsored/.test(article.innerText || '');

    return { key, name, category, rating, reviews, address, phone, website: '',
             lat: meta.lat, lng: meta.lng, cid: meta.cid, url: meta.url, ad, enriched: false };
  }

  /* ============================================================
   * scrape (list tier) - auto-scroll + incremental dedupe
   * ========================================================== */
  async function scrapeList(max, onProgress, shouldStop) {
    const feed = await waitFor(() => $(SEL.feed), CFG.feedTimeout);
    if (!feed) return { error: 'No results feed found. Run a search first, or Google changed the layout.' };

    const rows = new Map();
    let lastCount = -1, stable = 0;
    for (let i = 0; i < CFG.scrollMaxIters; i++) {
      if (shouldStop()) break;
      for (const a of $$(SEL.article, feed)) {
        const r = extractCard(a);
        if (r && !rows.has(r.key)) rows.set(r.key, r);
      }
      onProgress(`Loading results… ${rows.size} found`, rows.size, max);
      if (rows.size >= max) break;

      const domCount = $$(SEL.article, feed).length;
      if (domCount === lastCount) { if (++stable >= CFG.scrollStableCycles) break; }
      else { stable = 0; lastCount = domCount; }

      feed.scrollTop = feed.scrollHeight;
      await sleep(rand(CFG.scrollDelay, CFG.scrollDelay + CFG.scrollJitter));
    }
    return { rows: [...rows.values()].slice(0, max) };
  }

  /* ============================================================
   * enrich (detail tier) - navigate to each place's own URL and read the
   * stable data-item-id fields. Decoupled from the live feed, so it works
   * even after a refresh, a different search, or a restored session
   * (the old feed-click approach failed with "card not found" in those cases).
   * Driven by a persisted queue + auto-resume; see enrichSelected/resumeEnrich.
   * ========================================================== */
  function extractDetailInto(row) {
    const ph = $(SEL.phone);
    if (ph) row.phone = (ph.getAttribute('aria-label') || '').replace(/^Phone:\s*/, '').trim()
                        || (ph.getAttribute('data-item-id') || '').replace('phone:tel:', '');
    const site = $(SEL.website);
    if (site) row.website = site.href;
    const addr = $(SEL.address);
    if (addr) { const a = (addr.getAttribute('aria-label') || '').replace(/^Address:\s*/, '').trim(); if (a) row.address = a; }
    row.pincode = pincodeOf(row.address) || row.pincode || '';
  }

  // India: 6-digit PIN (optionally "560 038"); fallback US ZIP at end of address
  function pincodeOf(addr) {
    const a = String(addr || '');
    const m = a.match(/\b([1-9]\d{2})\s?(\d{3})\b/);
    if (m) return m[1] + m[2];
    const z = a.match(/\b(\d{5})(?:-\d{4})?\s*(?:,\s*(?:USA|United States))?\s*$/);
    return z ? z[1] : '';
  }

  /* ============================================================
   * CSV
   * ========================================================== */
  function toCSV(rows) {
    const cols = [
      ['name', 'Name'], ['category', 'Category'], ['rating', 'Rating'], ['reviews', 'Reviews'],
      ['phone', 'Phone'], ['website', 'Website'], ['address', 'Address'], ['pincode', 'Pincode'],
      ['url', 'Maps URL'], ['ad', 'Ad'],
    ];
    const esc = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [cols.map((c) => c[1]).join(',')];
    for (const r of rows) lines.push(cols.map((c) => esc(c[0] === 'ad' ? (r.ad ? 'yes' : '') : c[0] === 'pincode' ? (r.pincode || pincodeOf(r.address)) : r[c[0]])).join(','));
    return '\uFEFF' + lines.join('\r\n');
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ============================================================
   * STATE
   * ========================================================== */
  const state = { query: '', rows: [], running: false, stop: false, hideAds: true };

  function persist() {
    try { localStorage.setItem(LS.data, JSON.stringify({ query: state.query, ts: Date.now(), rows: state.rows })); } catch {}
  }
  function restore() {
    try {
      const d = JSON.parse(localStorage.getItem(LS.data) || 'null');
      if (d && Array.isArray(d.rows) && d.rows.length) { state.query = d.query || ''; state.rows = d.rows; return true; }
    } catch {}
    return false;
  }

  /* small presentational helpers */
  function host(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
  const TINTS = ['#0d5b61', '#b45309', '#7c3aed', '#0369a1', '#be123c', '#15803d', '#0f766e', '#a16207'];
  function tint(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TINTS[h % TINTS.length]; }
  function initial(s) { const m = (s || '?').match(/[A-Za-z0-9]/); return (m ? m[0] : '?').toUpperCase(); }

  /* ============================================================
   * UI  (Shadow DOM + constructable stylesheet)
   *  Design language mimics the Numira reference: white card, soft
   *  rounded corners, deep-teal primary, bordered table w/ gray head,
   *  green/red status circles, Inter-style type, separate Settings view.
   * ========================================================== */
  const hostEl = el('div', { id: 'gmls-host' });
  document.documentElement.appendChild(hostEl);
  const root = hostEl.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host{ all: initial; }
    *{ box-sizing:border-box; font-family:var(--font); }
    :host{
      --font:'Inter','Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,Arial,sans-serif;
      --teal:#0d5b61; --teal-press:#0a4a4f; --link:#0d7a82;
      --ink:#19231f; --body:#46504c; --muted:#8b95a1;
      --card:#fff; --head:#f6f9f8; --line:#edefef; --line2:#f4f6f6; --field:#e4e9e8; --tint:#fafbfb;
      --ok:#16a34a; --bad:#ef4444;
      --rm:10px; --rl:14px; --rxl:16px;
    }
    .fab{ position:fixed; top:16px; right:16px; z-index:2147483646; width:48px; height:48px; border-radius:50%;
      display:grid; place-items:center; background:#fff; border:1px solid var(--line); cursor:pointer;
      box-shadow:0 6px 18px rgba(16,40,34,.22); }
    .fab:hover{ box-shadow:0 8px 22px rgba(16,40,34,.3); }
    .panel{ position:fixed; top:16px; right:16px; width:460px; max-height:calc(100vh - 32px);
      display:flex; flex-direction:column; background:var(--card); color:var(--body);
      border-radius:var(--rxl); box-shadow:0 16px 40px rgba(16,40,34,.18); z-index:2147483646; overflow:hidden; font-size:13px; }
    /* header */
    .hdr{ display:flex; align-items:center; gap:6px; padding:14px 14px; border-bottom:1px solid var(--line); cursor:move; user-select:none; }
    .hdr .logo{ display:inline-flex; flex:0 0 auto; }
    .hdr .brand{ font-weight:600; font-size:14px; color:var(--ink); flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .hdr .sp{ flex:1; min-width:6px; }
    .ico{ width:28px; height:28px; display:grid; place-items:center; background:transparent; border:none; color:#6b7682; border-radius:8px; cursor:pointer; }
    .ico:hover{ background:var(--line2); color:var(--ink); }
    .scroll{ flex:1 1 auto; min-height:0; overflow:auto; }
    /* search */
    .search{ padding:16px; display:flex; flex-direction:column; gap:12px; border-bottom:1px solid var(--line); }
    .field{ display:flex; flex-direction:column; gap:6px; }
    .field.full{ grid-column:1 / -1; }
    .lbl{ font-size:12px; color:var(--muted); font-weight:500; }
    input[type=text], input[type=number]{ width:100%; background:#fff; border:1px solid var(--field); border-radius:var(--rm);
      padding:11px 12px; font-size:13px; color:var(--ink); outline:none; }
    input::placeholder{ color:#aab2bb; }
    input:focus{ border-color:var(--teal); }
    .btn{ border-radius:var(--rm); padding:12px 14px; font-size:13.5px; font-weight:600; cursor:pointer; border:1px solid transparent; }
    .btn.primary{ background:var(--teal); color:#fff; }
    .btn.primary:hover{ background:var(--teal-press); }
    .btn.primary:disabled{ opacity:.5; cursor:not-allowed; }
    .btn.outline{ background:#fff; color:var(--ink); border-color:var(--field); }
    .btn.outline:hover{ background:var(--tint); }
    .btn.outline:disabled{ opacity:.5; cursor:not-allowed; }
    .btn.danger{ background:#fff; color:var(--bad); border-color:#f0d2d2; }
    .btn.danger:hover{ background:#fdf3f3; }
    .btn.full{ width:100%; }
    .btn.sm{ padding:8px 12px; font-size:12.5px; }
    /* status */
    .status{ display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--line); }
    .dot{ width:8px; height:8px; border-radius:50%; background:#c4ccc9; flex:0 0 auto; }
    .dot.run{ background:#f59e0b; } .dot.ok{ background:var(--ok); } .dot.err{ background:var(--bad); }
    .status .msg{ flex:1; color:var(--muted); font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .pbar{ width:84px; height:4px; background:var(--line); border-radius:99px; overflow:hidden; flex:0 0 auto; }
    .pbar > i{ display:block; height:100%; width:0; background:var(--teal); transition:width .15s; }
    /* results */
    .results{ padding:16px; }
    .res-head{ display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .h-title{ font-size:15px; font-weight:600; color:var(--ink); letter-spacing:-.01em; }
    .h-count{ font-size:12px; color:var(--muted); white-space:nowrap; flex:0 0 auto; }
    .h-count .n{ color:var(--ink); font-weight:600; }
    .h-sub{ margin-top:4px; font-size:12px; color:var(--muted); line-height:1.45; }
    .tablewrap{ margin-top:12px; border:1px solid var(--line); border-radius:var(--rl); overflow:hidden; }
    table{ width:100%; border-collapse:collapse; table-layout:fixed; }
    thead th{ background:var(--head); text-align:left; font-size:11.5px; font-weight:600; color:var(--muted);
      padding:10px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
    th.center, td.center{ text-align:center; } th.right, td.right{ text-align:right; }
    tbody td{ padding:9px 12px; border-bottom:1px solid var(--line2); vertical-align:middle; }
    tbody tr:last-child td{ border-bottom:none; }
    tbody tr:hover{ background:var(--tint); }
    tbody tr.sel{ background:#eef6f5; }
    .c-chk{ width:30px; } .c-rate{ width:50px; } .c-ph{ width:122px; } .c-web{ width:40px; }
    td.c-rate, td.c-ph, td.c-web, th.c-rate, th.c-ph, th.c-web{ padding-left:8px; padding-right:8px; }
    .biz{ display:flex; align-items:center; gap:10px; min-width:0; }
    .av{ width:26px; height:26px; border-radius:7px; flex:0 0 auto; display:grid; place-items:center; overflow:hidden; color:#fff; font-weight:600; font-size:12px; }
    .av img{ display:block; width:18px; height:18px; }
    .biztext{ min-width:0; }
    .nm{ font-size:13px; font-weight:600; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .cat{ font-size:11.5px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px; }
    .rate{ font-size:12.5px; color:var(--body); white-space:nowrap; }
    .rate .na, .ph.na{ color:#c0c8cd; }
    .ph{ font-size:12px; color:var(--body); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .weblink{ display:inline-grid; place-items:center; }
    .na-dash{ color:#c4ccc9; }
    .rowerr{ font-size:10.5px; color:var(--bad); margin-top:2px; }
    input[type=checkbox]{ accent-color:var(--teal); width:15px; height:15px; cursor:pointer; }
    /* empty hero (mimics the reference login/hero screen) */
    .hero{ padding:40px 26px 44px; text-align:center; }
    .hero .pin{ color:var(--teal); margin-bottom:14px; display:inline-flex; }
    .hero h3{ margin:0 0 8px; font-size:18px; font-weight:700; color:var(--ink); line-height:1.3; }
    .hero p{ margin:0 auto; max-width:300px; font-size:13px; color:var(--muted); line-height:1.55; }
    /* search hint (fine grey examples under Location) */
    .hint{ font-size:11px; color:var(--muted); margin-top:6px; line-height:1.45; }
    /* actions toolbar (top of captured-leads section) */
    .actions{ display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .actions .sp{ flex:1; min-width:8px; }
    .maxfield{ display:inline-flex; align-items:center; gap:5px; flex:0 0 auto; }
    .maxfield .mf-lbl{ font-size:11.5px; color:var(--muted); font-weight:500; }
    .maxfield input{ width:54px; padding:7px 6px; text-align:center; font-size:12.5px; }
    /* settings */
    .set{ padding:20px 16px; display:flex; flex-direction:column; gap:24px; }
    .set-sec .st{ font-size:15px; font-weight:600; color:var(--ink); }
    .set-sec .ss{ margin-top:4px; font-size:12.5px; color:var(--muted); line-height:1.55; }
    .set-field{ margin-top:14px; }
    .set-field .fl{ display:flex; justify-content:space-between; align-items:center; margin-bottom:7px; }
    .reset-link{ color:var(--link); font-size:12px; font-weight:600; background:none; border:none; cursor:pointer; padding:0; }
    .reset-link:hover{ text-decoration:underline; }
    .toggle-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; }
    .toggle-row .tt{ font-size:13px; color:var(--ink); font-weight:500; }
    .switch{ position:relative; width:40px; height:22px; border-radius:99px; background:#d3dad8; cursor:pointer; transition:background .15s; flex:0 0 auto; border:none; padding:0; }
    .switch.on{ background:var(--teal); }
    .switch i{ position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%; background:#fff; transition:left .15s; box-shadow:0 1px 2px rgba(0,0,0,.2); }
    .switch.on i{ left:20px; }
    /* resize handles (drag any edge or corner) */
    .rh{ position:absolute; z-index:5; }
    .rh-n{ top:0; left:14px; right:14px; height:8px; cursor:ns-resize; }
    .rh-s{ bottom:0; left:14px; right:14px; height:8px; cursor:ns-resize; }
    .rh-e{ right:0; top:14px; bottom:14px; width:8px; cursor:ew-resize; }
    .rh-w{ left:0; top:14px; bottom:14px; width:8px; cursor:ew-resize; }
    .rh-ne{ top:0; right:0; width:16px; height:16px; cursor:nesw-resize; z-index:6; }
    .rh-nw{ top:0; left:0; width:16px; height:16px; cursor:nwse-resize; z-index:6; }
    .rh-se{ bottom:0; right:0; width:16px; height:16px; cursor:nwse-resize; z-index:6; }
    .rh-sw{ bottom:0; left:0; width:16px; height:16px; cursor:nesw-resize; z-index:6; }
    /* compact author credit in header (hover-reveal personal-brand link) */
    .credit{ display:inline-flex; align-items:center; gap:4px; flex:0 0 auto; padding-right:7px; margin-right:1px; border-right:1px solid var(--line); }
    .credit .li{ display:inline-flex; flex:0 0 auto; opacity:.9; }
    .credit-link{ position:relative; display:inline-grid; text-decoration:none; line-height:1.2; }
    .credit-link > span{ grid-area:1 / 1; transition:opacity .18s ease; font-size:11px; font-weight:600; white-space:nowrap; }
    .c-name{ color:var(--muted); }
    .c-cta{ color:var(--teal); opacity:0; }
    .credit-link:hover .c-name{ opacity:0; }
    .credit-link:hover .c-cta{ opacity:1; }
  `);
  root.adoptedStyleSheets = [sheet];

  const ui = {};

  /* ---------- floating icon (shown when panel minimized/closed) ---------- */
  ui.fab = el('button', { class: 'fab', title: 'Open Google Maps Lead Scraper' }, mapsLogo(26));
  ui.fab.style.display = 'none';
  ui.fab.addEventListener('click', () => showPanel(true));
  root.appendChild(ui.fab);

  /* ---------- panel ---------- */
  // headers (one per view, toggled)
  ui.gearBtn  = el('button', { class: 'ico', title: 'Settings' }, IC.gear());
  ui.minBtn   = el('button', { class: 'ico', title: 'Minimize' }, IC.minimize());
  ui.closeBtn = el('button', { class: 'ico', title: 'Close' }, IC.close());
  // compact author credit (hover-reveal LinkedIn link) sits in the header
  ui.credit = el('span', { class: 'credit' },
    el('span', { class: 'li' }, linkedinIcon(13)),
    el('a', { class: 'credit-link', href: AUTHOR.url, target: '_blank', rel: 'noopener', title: `${AUTHOR.name} on LinkedIn` },
      el('span', { class: 'c-name', text: AUTHOR.name }),
      el('span', { class: 'c-cta', text: 'View profile ↗' }),
    ),
  );
  ui.hdrMain = el('div', { class: 'hdr' },
    el('span', { class: 'logo' }, mapsLogo(20)),
    el('span', { class: 'brand', text: 'Google Maps Lead Scraper' }),
    el('span', { class: 'sp' }), ui.credit, ui.gearBtn, ui.minBtn, ui.closeBtn);

  ui.backBtn  = el('button', { class: 'ico', title: 'Back' }, IC.back());
  ui.closeBtn2 = el('button', { class: 'ico', title: 'Close' }, IC.close());
  ui.hdrSet = el('div', { class: 'hdr' },
    ui.backBtn, el('span', { class: 'brand', text: 'Settings' }), el('span', { class: 'sp' }), ui.closeBtn2);
  ui.hdrSet.style.display = 'none';

  // ----- MAIN view -----
  ui.term = el('input', { type: 'text', placeholder: 'e.g. cafes in Indiranagar' });
  ui.hint = el('div', { class: 'hint', text: 'Tip: include the area in your search, e.g. "cafes in Indiranagar", "dentists in Austin TX", or "gyms near Koramangala".' });
  ui.runBtn = el('button', { class: 'btn primary full', text: 'Run search' });
  const search = el('div', { class: 'search' },
    el('div', { class: 'field full' }, el('span', { class: 'lbl', text: 'Search Google Maps' }), ui.term, ui.hint),
    ui.runBtn,
  );

  ui.dot = el('span', { class: 'dot' });
  ui.msg = el('span', { class: 'msg', text: 'Ready.' });
  ui.barFill = el('i');
  ui.pbar = el('div', { class: 'pbar' }, ui.barFill); ui.pbar.style.visibility = 'hidden';
  const statusBar = el('div', { class: 'status' }, ui.dot, ui.msg, ui.pbar);

  ui.hTitle = el('span', { class: 'h-title', text: 'Captured leads' });
  ui.hCount = el('span', { class: 'h-count' });
  ui.hSub = el('div', { class: 'h-sub', text: 'Select rows, then Enrich to add phone numbers and websites.' });

  // action toolbar lives at the TOP of the captured-leads section
  ui.stopBtn = el('button', { class: 'btn danger sm', text: 'Stop' }); ui.stopBtn.style.display = 'none';
  ui.enrichBtn = el('button', { class: 'btn outline sm', text: 'Enrich (0)' });
  ui.pinBtn = el('button', { class: 'btn outline sm', text: 'Fill pincodes', title: 'Look up each lead\'s pincode from its map coordinates (BigDataCloud). Sends only coordinates.' });
  ui.dlBtn = el('button', { class: 'btn primary sm', text: 'Download CSV' });
  ui.max = el('input', { type: 'number', min: '1', max: '120', value: String(CFG.defaultMax), title: 'Max results to capture per search (1-120)' });
  ui.maxField = el('label', { class: 'maxfield', title: 'Max results to capture per search (1-120)' }, el('span', { class: 'mf-lbl', text: 'Max' }), ui.max);
  ui.clearBtn = el('button', { class: 'btn outline sm', text: 'Clear' });
  ui.actions = el('div', { class: 'actions' }, ui.stopBtn, ui.enrichBtn, ui.pinBtn, ui.dlBtn, ui.maxField, el('span', { class: 'sp' }), ui.clearBtn);

  ui.selAll = el('input', { type: 'checkbox', title: 'Select all' });
  ui.tbody = el('tbody');
  ui.tableWrap = el('div', { class: 'tablewrap' },
    el('table', null,
      el('thead', null, el('tr', null,
        el('th', { class: 'c-chk' }, ui.selAll),
        el('th', { text: 'Business' }),
        el('th', { class: 'c-rate', text: 'Rating' }),
        el('th', { class: 'c-ph', text: 'Phone' }),
        el('th', { class: 'c-web center', text: 'Web' }),
      )),
      ui.tbody,
    ),
  );
  ui.heroBox = el('div'); // holds hero OR table
  ui.results = el('div', { class: 'results' },
    el('div', { class: 'res-head' }, ui.hTitle, ui.hCount),
    ui.hSub,
    ui.actions,
    ui.heroBox,
  );

  ui.viewMain = el('div', { class: 'scroll' }, search, statusBar, ui.results);

  // ----- SETTINGS view -----
  ui.adSwitch = el('button', { class: 'switch on' }, el('i'));
  ui.resetBtn = el('button', { class: 'btn danger full', text: 'Reset' });
  ui.viewSettings = el('div', { class: 'scroll' },
    el('div', { class: 'set' },
      el('div', { class: 'set-sec' },
        el('div', { class: 'st', text: 'Sponsored listings' }),
        el('div', { class: 'ss', text: 'Hide ad results from your captured leads so the list stays organic.' }),
        el('div', { class: 'toggle-row' }, el('span', { class: 'tt', text: 'Hide ads' }), ui.adSwitch),
      ),
      el('div', { class: 'set-sec' },
        el('div', { class: 'st', text: 'Reset local store' }),
        el('div', { class: 'ss', text: 'This will remove captured leads stored locally by the extension.' }),
        el('div', { class: 'set-field' }, ui.resetBtn),
      ),
    ),
  );
  ui.viewSettings.style.display = 'none';

  ui.panel = el('div', { class: 'panel' }, ui.hdrMain, ui.hdrSet, ui.viewMain, ui.viewSettings);
  root.appendChild(ui.panel);

  /* ============================================================
   * view + panel toggling
   * ========================================================== */
  function showView(v) {
    const main = v !== 'settings';
    ui.hdrMain.style.display = main ? '' : 'none';
    ui.hdrSet.style.display = main ? 'none' : '';
    ui.viewMain.style.display = main ? '' : 'none';
    ui.viewSettings.style.display = main ? 'none' : '';
  }
  function showPanel(on) {
    ui.panel.style.display = on ? '' : 'none';
    ui.fab.style.display = on ? 'none' : '';
  }

  /* ============================================================
   * render
   * ========================================================== */
  function setStatus(msg, kind) {
    ui.msg.textContent = msg;
    ui.dot.className = 'dot' + (kind ? ' ' + kind : '');
  }
  function setProgress(done, total) {
    if (total > 0) { ui.pbar.style.visibility = 'visible'; ui.barFill.style.width = Math.min(100, (done / total) * 100) + '%'; }
    else { ui.pbar.style.visibility = 'hidden'; ui.barFill.style.width = '0'; }
  }
  function visibleRows() { return state.rows.filter((r) => !(state.hideAds && r.ad)); }
  function selectedRows() { return visibleRows().filter((r) => r._sel); }

  function refreshCounts() {
    const v = visibleRows(), sel = selectedRows().length, enr = state.rows.filter((r) => r.enriched).length;
    ui.hCount.replaceChildren();
    if (v.length) {
      ui.hCount.append(el('span', { class: 'n', text: String(v.length) }), document.createTextNode(` lead${v.length === 1 ? '' : 's'}`));
      if (enr) ui.hCount.append(document.createTextNode(' · '), el('span', { class: 'n', text: String(enr) }), document.createTextNode(' enriched'));
    }
    ui.enrichBtn.textContent = `Enrich (${sel})`;
    ui.enrichBtn.disabled = state.running || sel === 0;
    ui.pinBtn.disabled = state.running || v.length === 0;
    ui.dlBtn.disabled = state.running || v.length === 0;
    ui.clearBtn.disabled = state.running || state.rows.length === 0;
  }

  function avatar(r) {
    const a = el('div', { class: 'av' });
    const dom = host(r.website);
    if (dom) {
      const img = el('img', { src: `https://www.google.com/s2/favicons?domain=${dom}&sz=64`, alt: '' });
      img.addEventListener('error', () => { img.remove(); a.textContent = initial(r.name); a.style.background = tint(r.name); });
      a.style.background = '#eef2f1'; a.appendChild(img);
    } else { a.textContent = initial(r.name); a.style.background = tint(r.name); }
    return a;
  }

  function renderRows() {
    ui.heroBox.textContent = '';
    const rows = visibleRows();

    if (!rows.length) {
      const hero = el('div', { class: 'hero' },
        el('span', { class: 'pin' }, IC.pin()),
        el('h3', { text: state.rows.length ? 'All results are ads' : 'Turn a search into a lead list' }),
        el('p', { text: state.rows.length
          ? 'Every captured result is sponsored. Turn off "Hide ads" in Settings to show them.'
          : 'Enter a business type and location above, then run a search to capture leads.' }),
      );
      ui.heroBox.appendChild(hero);
      ui.tableWrap.remove();
      refreshCounts();
      return;
    }

    ui.tbody.textContent = '';
    for (const r of rows) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!r._sel;
      const tr = el('tr', r._sel ? { class: 'sel' } : null);
      cb.addEventListener('change', () => { r._sel = cb.checked; tr.classList.toggle('sel', cb.checked); syncSelAll(); refreshCounts(); });

      const bizText = el('div', { class: 'biztext' },
        el('div', { class: 'nm', title: r.name, text: r.name }),
        (r.category || r.address || r.pincode) ? el('div', { class: 'cat', text: [r.category || r.address, r.pincode].filter(Boolean).join(' · ') }) : null,
        r.enrichErr ? el('div', { class: 'rowerr', text: r.enrichErr }) : null,
      );
      const bizCell = el('td', { title: r.address || '' }, el('div', { class: 'biz' }, avatar(r), bizText));

      const rateCell = el('td', { class: 'c-rate rate' },
        r.rating ? document.createTextNode('★ ' + r.rating) : el('span', { class: 'na', text: '-' }));

      const phCell = r.phone
        ? el('td', { class: 'c-ph ph', title: r.phone, text: r.phone.replace(/^\+1\s+/, '') })
        : el('td', { class: 'c-ph ph na', text: r.enriched ? 'none' : '-' });

      let webNode;
      if (r.website) webNode = el('a', { class: 'weblink', href: r.website, target: '_blank', rel: 'noopener', title: r.website }, statusCircle(true));
      else if (r.enriched) webNode = statusCircle(false);
      else webNode = el('span', { class: 'na-dash', text: '·' });
      const webCell = el('td', { class: 'c-web center' }, webNode);

      tr.append(el('td', { class: 'c-chk' }, cb), bizCell, rateCell, phCell, webCell);
      ui.tbody.appendChild(tr);
    }
    ui.heroBox.appendChild(ui.tableWrap);
    syncSelAll();
    refreshCounts();
  }

  function syncSelAll() {
    const v = visibleRows(), sel = v.filter((r) => r._sel).length;
    ui.selAll.checked = v.length > 0 && sel === v.length;
    ui.selAll.indeterminate = sel > 0 && sel < v.length;
  }

  /* ============================================================
   * actions
   * ========================================================== */
  function setRunning(on) {
    state.running = on;
    ui.runBtn.disabled = on; ui.term.disabled = on;
    ui.stopBtn.style.display = on ? '' : 'none';
    refreshCounts();
  }

  async function doScrape() {
    state.stop = false;
    setRunning(true);
    setStatus('Loading results…', 'run');
    const max = Math.max(1, Math.min(120, parseInt(ui.max.value, 10) || CFG.defaultMax));
    const res = await scrapeList(max, (m, d, t) => { setStatus(m, 'run'); setProgress(d, t); }, () => state.stop);
    setProgress(0, 0);
    if (res.error) { setStatus(res.error, 'err'); setRunning(false); return; }

    const prev = new Map(state.rows.map((r) => [r.key, r]));
    state.rows = res.rows.map((r) => {
      const p = prev.get(r.key);
      return p && p.enriched ? { ...r, phone: p.phone || r.phone, website: p.website || r.website, address: p.address || r.address, pincode: p.pincode || r.pincode, enriched: true } : r;
    });
    state.query = ui.term.value.trim() || state.query || document.title;
    persist();
    renderRows();
    setStatus(state.stop ? `Stopped: ${state.rows.length} leads captured.` : `Done: ${state.rows.length} leads captured.`, 'ok');
    setRunning(false);
  }

  function runSearchAndScrape() {
    const query = ui.term.value.trim();
    if (!query) { setStatus('Enter a search first.', 'err'); ui.term.focus(); return; }
    const max = Math.max(1, Math.min(120, parseInt(ui.max.value, 10) || CFG.defaultMax));
    try { localStorage.setItem(LS.job, JSON.stringify({ query, max })); } catch {}
    setStatus('Searching…', 'run');
    location.href = 'https://www.google.com/maps/search/' + encodeURIComponent(query);
  }

  // Start enrichment: persist a queue of selected keys, then navigate to the
  // first place URL. resumeEnrich() (called from init on each load) does the work.
  function enrichSelected() {
    const sel = selectedRows().filter((r) => r.url);
    if (!sel.length) return;
    const keys = sel.map((r) => r.key);
    const returnUrl = state.query
      ? 'https://www.google.com/maps/search/' + encodeURIComponent(state.query)
      : location.href;
    try { localStorage.removeItem(LS.enrichStop); localStorage.setItem(LS.enrich, JSON.stringify({ keys, i: 0, returnUrl })); } catch {}
    setRunning(true);
    setStatus(`Enriching 1/${keys.length}…`, 'run');
    setProgress(1, keys.length);
    const first = state.rows.find((r) => r.key === keys[0]);
    location.href = first.url;   // full nav to the place page; resumes on load
  }

  function finishEnrich(eq, stopped) {
    const done = eq.i;
    try { localStorage.removeItem(LS.enrich); localStorage.removeItem(LS.enrichStop); } catch {}
    const msg = stopped ? `Stopped: enriched ${done}/${eq.keys.length}.`
                        : `Enriched ${done} lead${done === 1 ? '' : 's'}.`;
    if (eq.returnUrl) {
      try { localStorage.setItem(LS.note, JSON.stringify({ msg })); } catch {}
      location.href = eq.returnUrl;   // back to the results list
    } else {
      setProgress(0, 0); setStatus(msg, 'ok'); setRunning(false);
    }
  }

  async function resumeEnrich(eq) {
    setRunning(true);
    if (localStorage.getItem(LS.enrichStop)) { finishEnrich(eq, true); return; }
    const row = state.rows.find((r) => r.key === eq.keys[eq.i]);
    setStatus(`Enriching ${eq.i + 1}/${eq.keys.length}${row ? ': ' + row.name : ''}`, 'run');
    setProgress(eq.i + 1, eq.keys.length);
    const ok = await waitFor(() => $(SEL.detailReady), CFG.detailTimeout);
    // address/website render before the phone button; give phone a few seconds (places with no phone just time out)
    if (ok) await waitFor(() => $(SEL.phone), CFG.phoneWait);
    if (row) {
      if (ok) {
        extractDetailInto(row);
        row.enrichErr = row.phone ? '' : 'no phone on page';
      } else row.enrichErr = 'detail page not loaded';
      row.enriched = true; persist(); renderRows();
    }
    eq.i++;
    if (eq.i < eq.keys.length && !localStorage.getItem(LS.enrichStop)) {
      const next = state.rows.find((r) => r.key === eq.keys[eq.i]);
      if (next && next.url) {
        try { localStorage.setItem(LS.enrich, JSON.stringify(eq)); } catch {}
        await sleep(rand(CFG.enrichDelay, CFG.enrichDelay + CFG.enrichJitter));
        location.href = next.url;
        return;
      }
    }
    finishEnrich(eq, !!localStorage.getItem(LS.enrichStop));
  }

  // Pincode from map coordinates via BigDataCloud's free client-side reverse geocoder (no 1 req/sec cap).
  // Resolves '' = no postcode, null = request failed.
  function geocodePin(lat, lng) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET', timeout: 10000, headers: { Accept: 'application/json' },
        url: `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`,
        onload: (r) => {
          if (r.status !== 200) return resolve(null);
          try { resolve(String(JSON.parse(r.responseText).postcode || '').replace(/\s/g, '')); } catch { resolve(null); }
        },
        onerror: () => resolve(null), ontimeout: () => resolve(null),
      });
    });
  }

  async function fillPincodes() {
    if (typeof GM_xmlhttpRequest !== 'function') { setStatus('Pincode lookup needs Tampermonkey (GM_xmlhttpRequest). Reinstall the script.', 'err'); return; }
    // rows whose address already has a pincode keep it; the rest are looked up by coordinates
    for (const r of visibleRows()) if (!r.pincode) r.pincode = pincodeOf(r.address);
    const todo = visibleRows().filter((r) => !r.pincode && r.lat && r.lng);
    if (!todo.length) { persist(); renderRows(); setStatus('All leads already have a pincode (or no coordinates).', 'ok'); return; }
    state.stop = false; setRunning(true);
    let next = 0, done = 0, fails = 0, aborted = false;
    const worker = async () => {
      while (!state.stop && !aborted) {
        const r = todo[next++]; if (!r) return;
        const pc = await geocodePin(r.lat, r.lng);
        if (pc === null) { if (++fails >= 5) aborted = true; continue; }
        fails = 0; r.pincode = pc; done++;
        setStatus(`Looking up pincodes ${done}/${todo.length}…`, 'run'); setProgress(done, todo.length);
        await sleep(rand(30, 120));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    persist(); renderRows(); setProgress(0, 0);
    if (aborted) setStatus(`Pincode lookup failed repeatedly after ${done}. Check your connection and try again.`, 'err');
    else setStatus(state.stop ? `Stopped: ${done} pincodes filled.` : `Filled ${done} of ${todo.length} pincodes.`, 'ok');
    setRunning(false);
  }

  /* ---- wire events ---- */
  ui.runBtn.addEventListener('click', runSearchAndScrape);
  ui.term.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearchAndScrape(); });
  ui.stopBtn.addEventListener('click', () => { state.stop = true; try { localStorage.setItem(LS.enrichStop, '1'); } catch {} setStatus('Stopping…', 'run'); });
  ui.enrichBtn.addEventListener('click', enrichSelected);
  ui.pinBtn.addEventListener('click', fillPincodes);
  ui.dlBtn.addEventListener('click', () => {
    const rows = visibleRows(); if (!rows.length) return;
    const slug = (state.query || 'leads').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    download(`maps-leads-${slug || 'export'}.csv`, toCSV(rows));
  });
  ui.clearBtn.addEventListener('click', () => {
    if (state.running) return;
    state.rows = []; state.query = '';
    try { localStorage.removeItem(LS.data); } catch {}
    renderRows(); setStatus('Leads cleared.', '');
  });
  ui.selAll.addEventListener('change', () => { const on = ui.selAll.checked; visibleRows().forEach((r) => (r._sel = on)); renderRows(); });

  ui.gearBtn.addEventListener('click', () => showView('settings'));
  ui.backBtn.addEventListener('click', () => showView('main'));
  ui.minBtn.addEventListener('click', () => showPanel(false));
  ui.closeBtn.addEventListener('click', () => showPanel(false));
  ui.closeBtn2.addEventListener('click', () => showPanel(false));

  ui.adSwitch.addEventListener('click', () => { state.hideAds = !state.hideAds; ui.adSwitch.classList.toggle('on', state.hideAds); renderRows(); });
  ui.resetBtn.addEventListener('click', () => {
    if (state.running) return;
    state.rows = []; state.query = '';
    try { localStorage.removeItem(LS.data); } catch {}
    renderRows(); setStatus('Local store cleared.', ''); showView('main');
  });

  // drag the panel by its header
  function dragify(handle) {
    let sx, sy, ox, oy, on = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ico')) return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = ui.panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      ui.panel.style.right = 'auto'; ui.panel.style.left = ox + 'px'; ui.panel.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!on) return;
      ui.panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      ui.panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { on = false; });
  }
  dragify(ui.hdrMain); dragify(ui.hdrSet);

  // resize from any edge or corner
  function attachResize(handle, dir) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = ui.panel.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top };
      ui.panel.style.right = 'auto'; ui.panel.style.maxHeight = 'none';
      ui.panel.style.left = r.left + 'px'; ui.panel.style.top = r.top + 'px';
      const MINW = 340, MINH = 240;
      const mm = (ev) => {
        let w = start.w, h = start.h, left = start.left, top = start.top;
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (dir.includes('e')) w = start.w + dx;
        if (dir.includes('s')) h = start.h + dy;
        if (dir.includes('w')) { w = start.w - dx; left = start.left + dx; }
        if (dir.includes('n')) { h = start.h - dy; top = start.top + dy; }
        if (w < MINW) { if (dir.includes('w')) left = start.left + (start.w - MINW); w = MINW; }
        if (h < MINH) { if (dir.includes('n')) top = start.top + (start.h - MINH); h = MINH; }
        ui.panel.style.width = w + 'px'; ui.panel.style.height = h + 'px';
        ui.panel.style.left = Math.max(0, left) + 'px'; ui.panel.style.top = Math.max(0, top) + 'px';
      };
      const mu = () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); };
      window.addEventListener('mousemove', mm); window.addEventListener('mouseup', mu);
    });
  }
  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const h = el('div', { class: 'rh rh-' + dir }); attachResize(h, dir); ui.panel.appendChild(h);
  }

  /* ============================================================
   * init / auto-resume
   * ========================================================== */
  function init() {
    if (restore()) { renderRows(); setStatus(`Restored ${state.rows.length} leads from last session.`, ''); }
    else renderRows();

    // show a one-shot note left by a just-finished enrichment run
    try { const note = JSON.parse(localStorage.getItem(LS.note) || 'null'); if (note && note.msg) { localStorage.removeItem(LS.note); setStatus(note.msg, 'ok'); } } catch {}

    // resume an in-progress enrichment queue (we navigate place-to-place across reloads)
    let eq = null;
    try { eq = JSON.parse(localStorage.getItem(LS.enrich) || 'null'); } catch {}
    if (eq && eq.keys && eq.i < eq.keys.length) { resumeEnrich(eq); return; }

    let job = null;
    try { job = JSON.parse(localStorage.getItem(LS.job) || 'null'); } catch {}
    if (job && (job.query || job.term)) {
      try { localStorage.removeItem(LS.job); } catch {}
      const jq = job.query || job.term || '';
      ui.term.value = jq; if (job.max) ui.max.value = String(job.max);
      state.query = jq;
      setStatus('Searching…', 'run');
      waitFor(() => $(SEL.article, $(SEL.feed) || document), 15000).then((ready) => {
        if (ready) doScrape();
        else setStatus('Search loaded but no results feed appeared.', 'err');
      });
    }
  }
  // The panel is already mounted above. Defer auto-resume until the page is actually
  // active (Chrome prerenders search-result links; don't auto-scrape a hidden doc).
  if (document.prerendering) document.addEventListener('prerenderingchange', init, { once: true });
  else init();
})();
