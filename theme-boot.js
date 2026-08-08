/* Local Journal — early theme application (runs before <body> paints to avoid a
 * flash). Loaded blocking in <head>. Reads localStorage "localjournal.theme"
 * ("light" | "dark" | "system"; unset ⇒ system) and sets data-theme on <html>.
 * The full toggle wiring + matchMedia live-update listener lives in app.js. */
"use strict";
(function () {
  var KEY = "localjournal.theme";
  var pref;
  try { pref = localStorage.getItem(KEY); } catch (e) { pref = null; }
  var effective;
  if (pref === "light" || pref === "dark") {
    effective = pref;
  } else {
    // "system" or unset → follow the OS preference.
    effective = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", effective);
  // The single theme-color tag, set before first paint so the browser bar never
  // shows the wrong surface for a frame. app.js re-writes it on every theme
  // change. Values are --surface-chrome-solid in each theme.
  try {
    var m = document.getElementById("themeColorMeta");
    if (m) m.setAttribute("content", effective === "dark" ? "#17161a" : "#fffdfb");
  } catch (e) {}
})();
