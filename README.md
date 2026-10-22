# Google Maps Lead Scraper

A Tampermonkey userscript that turns a Google Maps search into a spreadsheet of local business leads. It adds a small panel on top of Google Maps. You type a search, the script collects the results, and you download them as a CSV file.

Version 3.2.0. Licensed under MIT.

## What it does, in plain English

You search Google Maps the way you normally do, for example "cafes in Indiranagar". The script scrolls the results list for you and writes down each business: name, category, rating, number of reviews, address and a link to its Maps page. Phone numbers and websites are not shown in the results list, so you pick the rows you care about and click Enrich. The script then visits each place page and reads the phone number and website. When you are done, Download CSV gives you a file you can open in Excel or Google Sheets.

Everything runs in your own browser. There is no server and no account.

## Who it is for

Freelancers, agencies and sales people who build prospect lists of local businesses by hand today and want to skip the copy and paste. It also suits researchers who need a quick snapshot of what exists in an area.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension for your browser.
2. Open `google-maps-lead-scraper.user.js` in this repository and click Raw. Tampermonkey shows an install page. Click Install.
3. Open [Google Maps](https://www.google.com/maps).
4. The panel appears at the top right. If it does not, reload the page once.

## Use the panel

1. **Search.** Type a normal Maps query into the "Search Google Maps" box and click Run search. Include the place in the text, such as "dentists in Pune". The script loads that search and starts scrolling the list.
2. **Max.** The Max box sets how many results to capture, from 1 to 120. The default is 60. Google Maps itself stops at roughly 120 results per search.
3. **Review.** Captured leads appear in a table with name, rating, phone and a website marker. Sponsored listings are hidden by default. You can show them in Settings (gear icon).
4. **Enrich.** Tick the rows you want and click Enrich (N). The script opens each place page in turn, with a random pause of about 1.3 to 2.8 seconds between visits, and fills in phone, website and full address. Stop cancels the run. When it finishes, you return to your search.
5. **Fill pincodes.** Click Fill pincodes to add a postal code to rows whose address has none. See the privacy section, because this step contacts a third party.
6. **Download CSV.** Saves `maps-leads-<your-search>.csv`.
7. **Resume.** Captured leads are kept in your browser's local storage. If you reload or close the tab, the leads are restored the next time you open Google Maps. Clear removes them.

The panel can be dragged by its header, resized from any edge, and minimised to a round icon.

## Fields collected

| CSV column | Source |
|---|---|
| Name | Results list |
| Category | Results list |
| Rating | Results list |
| Reviews | Results list |
| Phone | Place page, after Enrich |
| Website | Place page, after Enrich |
| Address | Results list, replaced by the full address after Enrich |
| Pincode | Parsed from the address, or looked up from coordinates with Fill pincodes |
| Maps URL | Results list |
| Ad | "yes" for sponsored listings |

Latitude and longitude are held in memory for the pincode lookup but are not exported.

## How it works

This section is for developers.

- **Selectors.** All selectors live in one `SEL` object at the top of the script. They use ARIA roles, `aria-label` values and `data-item-id` attributes, which change far less often than Google's obfuscated class names. Examples: `div[role="feed"]`, `div[role="article"]`, `button[data-item-id^="phone:tel:"]`, `a[data-item-id="authority"]`, `button[data-item-id="address"]`. If Google changes the page, the fix is a one-line edit in `SEL`.
- **List tier.** The script scrolls the `role="feed"` container until the card count stays the same for four cycles or the Max cap is reached. Cards are de-duplicated by place id or URL. Category and address come from the `category · · address` text line, skipping the rating and price line. Coordinates and place id come from the `a[href*="/maps/place/"]` link.
- **Search trigger.** Setting the value of the search box from a script is unreliable because the page controls it. The script navigates to `https://www.google.com/maps/search/<query>` instead, and stores a pending job in `localStorage` under `gmls_job`. On the next page load, `init()` reads the job and starts scraping.
- **Enrich queue.** Selected rows are stored as a queue in `localStorage` (`gmls_enrich`). The script navigates directly to each row's own place URL, reads the `data-item-id` fields, saves them, then moves to the next place. This survives page reloads and does not depend on the results list still being on screen.
- **Persistence.** Leads are stored under `gmls_data`. All storage is `localStorage` on the google.com origin.
- **UI.** The panel is built in a Shadow DOM with a constructable stylesheet, so Google's CSS cannot affect it and the script's CSS cannot leak out.
- **Network calls.** The script uses `GM_xmlhttpRequest` for one purpose, the pincode lookup (see below). There is no `fetch` or `XMLHttpRequest` call. The page also loads business favicons as images from `https://www.google.com/s2/favicons`.

## Limits

- Google Maps returns about 120 results per search at most.
- The results list has no phone number. Phone and website need the Enrich step, which loads one page per business and is slow by design.
- Google changes its page markup from time to time. When that happens the script can stop finding results until the selectors are updated.
- Address and category parsing from the list is best effort. The address read during Enrich is the reliable one.
- The pincode parser targets Indian 6-digit PINs and US ZIP codes.
- Built and tested on desktop Chrome with Tampermonkey.

## Responsible use, terms of service and privacy

**Terms of service.** Google's terms restrict automated extraction of Maps content. Using this script may breach those terms, and Google can rate-limit or block accounts and IP addresses that behave like automated tools. You are responsible for how you use it. The script includes pauses and limits to keep activity modest, and that does not make it permitted. If you need bulk or commercial data, use the official [Google Places API](https://developers.google.com/maps/documentation/places/web-service).

**Personal data.** Business phone numbers, websites and addresses can count as personal data, especially for sole traders. Laws such as the GDPR, India's DPDP Act and anti-spam rules (CAN-SPAM, PECR, TRAI rules on unsolicited commercial communication) may apply to what you do with a lead list. Check the rules in your country before you contact anyone, give people a way to opt out, and delete data you no longer need.

**Where your data goes.** Captured leads stay in your browser's local storage and in the CSV you download. The script has no analytics, no author server and no account. Two things touch the network beyond Google Maps itself:

1. Fill pincodes sends latitude and longitude to `api.bigdatacloud.net` (BigDataCloud's reverse geocoder) through Tampermonkey. Business names, phone numbers and other fields are not sent. The button is optional, and if you never click it, no request goes to that host.
2. The results table shows business favicons loaded from `https://www.google.com/s2/favicons`, which sends the business website's domain to Google.

Tampermonkey asks you to approve the BigDataCloud connection the first time it is used.

No affiliation with Google. Google Maps is a trademark of Google LLC.

## Troubleshooting

- **Panel does not appear.** Reload the Google Maps tab. Check that the script is enabled in the Tampermonkey dashboard and that the URL starts with `https://www.google.com/maps`.
- **"Search loaded but no results feed appeared."** The search had no results or the page loaded slowly. Try again with a more specific query.
- **Phone column stays empty after Enrich.** Some places have no listed phone. The row records "no phone on page".
- **Enrich stops early or pages look blank.** Google may be throttling you. Click Stop, wait a few minutes and run a smaller batch.
- **Fill pincodes says it needs Tampermonkey.** Reinstall the script from the Raw file so the `@grant` lines apply. Allow the BigDataCloud connection when prompted.
- **Results stopped working after a Google update.** Open the script, find the `SEL` object and compare each selector with the live page in DevTools. Pull requests are welcome.
- **Start fresh.** Open Settings and click Reset, or use Clear on the main view.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Jatin Dinesh.
