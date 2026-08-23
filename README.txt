ELYSIA — INSTALL GUIDE

This is a real installable app (PWA). It needs to be served over http(s), not opened
as a double-clicked file, or the offline/install features won't activate.

QUICKEST WAY TO RUN IT LOCALLY
1. Unzip this folder.
2. Open a terminal inside the folder and run:
     python3 -m http.server 8000
   (or any static file server — e.g. `npx serve`)
3. Open http://localhost:8000 in Chrome/Edge on your PC.

INSTALL ON PC (Chrome/Edge)
1. Open the site above.
2. Click the install icon in the address bar (or menu > "Install Elysia"),
   or use the "Install Elysia App" button inside the app (top-right profile menu / Settings).
3. It now opens as its own desktop window and works offline.

INSTALL ON MOBILE
- Android (Chrome): open the site, tap the menu, choose "Add to Home screen" /
  "Install app". It will appear as a normal app icon.
- iPhone/iPad (Safari): open the site, tap Share, choose "Add to Home Screen".

DEPLOYING SO YOU CAN INSTALL IT ON YOUR PHONE FROM ANYWHERE
Upload this whole folder as-is to any static host (Netlify, Vercel, GitHub Pages,
Cloudflare Pages all have free tiers) — it needs HTTPS to install on mobile, which
these all provide automatically. Then open that URL on your phone and install it.

WHAT WORKS OFFLINE ONCE INSTALLED
- The app itself (shell, styling, fonts) — cached on first load.
- Every song you upload — stored fully in the device's local database, not the cloud.
- Every set of lyrics that has ever been found for a song — cached permanently the
  first time it's fetched, so it keeps showing up even with no internet afterward.

FILES
  index.html            the app
  manifest.webmanifest  installability metadata
  sw.js                 offline/service worker logic
  icons/                app icons
