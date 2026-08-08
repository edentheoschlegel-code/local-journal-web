# Local Journal

A private journal that stays on your device. Write entries, tag them, search
them, see which days you wrote on, and export the lot — all without an account
and without anything being uploaded.

## Highlights

- **Write** — date, optional title, a plain-text editor with a live word count.
  Saves as you type, on blur, and when the tab closes. There is no save button.
- **Entries** — reverse-chronological, grouped by month, with a readable preview
  line. Delete gives you an undo window instead of a confirm dialog.
- **Mood and tags** — five neutral markers (Low, Quiet, Steady, Warm, Bright)
  and free-form tags. Filter the list by either.
- **Search** — across titles, entry text and tags at once, with matches
  highlighted. Stays responsive with several thousand entries.
- **Calendar** — which days have entries, and a plain "you have written N days
  this month" line. No streaks, no scores.
- **Export** — full JSON backup, readable Markdown, and a laid-out PDF.
- **Import** — restore a JSON backup with a merge-or-replace choice and a
  preview of exactly what will change before anything is written.
- **Optional passcode lock** — off by default. Encrypts your entries at rest
  with a key derived from your passcode (PBKDF2-HMAC-SHA256, 310,000 iterations,
  random salt → AES-GCM-256). There is no reset: a forgotten passcode means the
  entries cannot be recovered, because there is no server to ask.

Entries are stored in the browser on your device and are not sent to us.

## Tech notes

- One HTML file, one stylesheet, one script. No framework, no bundler, no build
  step, no npm dependency.
- Entries live in IndexedDB, in a database named `localjournal`. Preferences use
  `localStorage` keys prefixed `localjournal.`.
- `index.html` carries a meta Content-Security-Policy that names no host other
  than the one serving it — every source is `'self'`, alongside the `data:` and
  `blob:` forms the page generates for itself (images, the PDF blob, the worker)
  — so the browser blocks the page from loading or contacting anything else. It
  is a page-level policy: the supporting pages carry none, and a meta policy
  cannot carry `frame-ancestors`. Nothing the user writes is sent anywhere. Same-origin requests do happen after load: the service worker
  fetches and revalidates the app's own files, and the first PDF export loads
  `lib/pdf-lib.min.js` on demand.
- pdf-lib is vendored into `lib/` and lazy-loaded on the first PDF export.
- Light and dark themes are a token swap under `[data-theme]`, applied before
  first paint by `theme-boot.js`.

## Run locally

No build step. Serve the folder over any static server and open it:

```
python3 -m http.server 8813 --bind 127.0.0.1
# then open http://127.0.0.1:8813/
```

`npm run serve` does the same thing. Opening `index.html` straight from disk
mostly works, but `file://` blocks the service worker and some browsers restrict
IndexedDB there, so a local server is the reliable way.

`npm run build` copies the shipping files into `www/` and stamps a content hash
onto the script and style URLs. It is a deploy convenience, not a requirement.

## License

MIT. Bundled third-party code and its licence: `THIRD-PARTY-LICENSES.txt`.

An Eden Apps app · [edenapps.app](https://edenapps.app)
