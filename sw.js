/* Service worker — offline support for localjournal.
   Safe-by-design caching:
   - Navigations / HTML  -> network-first  (always picks up new deploys; cache = offline fallback)
   - Hashed assets (?v=) -> cache-first     (the URL changes when content changes, so never stale)
   - Other same-origin   -> network-first, cache as the offline fallback
   - Cross-origin        -> NOT intercepted. This app makes no cross-origin
                            requests at all, so in practice nothing reaches it.

   Why the third rule is network-first rather than stale-while-revalidate:
   `npm run build` stamps ?v=<hash> onto app.js / styles.css / theme-boot.js, which
   moves them to the cache-first branch — but that build step is a convenience, not
   a requirement (README, "Run locally"), and the folder can be served as-is. Under
   stale-while-revalidate an unhashed asset was returned from cache first and only
   replaced on the NEXT load, so a returning visitor got the new index.html with the
   previous styles.css and app.js. Network-first closes that; offline still works
   because the cached copy is the fallback, and a hashed deploy never pays the cost.

   CACHE carries a release token: bump it on every release. activate() deletes every
   cache whose key is not the current one, which is what drops a previous build's
   assets instead of leaving them to be matched forever. */
const CACHE = "localjournal-offline-20260816";

self.addEventListener("install", (event) => {
  // Precache the shell HTML AND its own same-origin dependencies (scripts,
  // styles, icons) parsed from index.html — so the app both loads AND runs
  // offline without throwing.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try { await cache.addAll(["/", "/index.html"]); } catch (e) {}
    try {
      const html = await (await fetch("/index.html", { cache: "no-cache" })).text();
      const urls = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g))
        .map((m) => m[1])
        .filter((u) => u && !u.includes("://") && !u.startsWith("//") && !u.startsWith("data:") && !u.startsWith("mailto:") && !u.startsWith("#"));
      await Promise.allSettled(urls.map((u) => cache.add(u).catch(() => {})));
    } catch (e) {}
    // Same-origin libs loaded by JS rather than by a src attribute, so the
    // regex above cannot see them. pdf-lib is lazy-loaded on the first PDF
    // export; without this line that first export fails offline with a
    // misleading error.
    try {
      const extraLibs = ["lib/pdf-lib.min.js"];
      await Promise.allSettled(extraLibs.map((u) => cache.add(u).catch(() => {})));
    } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) { if (key !== CACHE) await caches.delete(key); }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  const isDoc = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isDoc) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req)) || (await caches.match("/")) || (await caches.match("/index.html")) || Response.error();
      }
    })());
    return;
  }

  if (url.search.includes("v=")) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const fresh = await fetch(req);
      if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
      return fresh;
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
      return fresh;
    } catch {
      return (await caches.match(req)) || Response.error();
    }
  })());
});
