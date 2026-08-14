import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import './styles/globals.css';
import { App } from './App';
import { exposeAnalyticsControls, initAnalytics } from './analytics/analytics';

/**
 * Analytics starts before React, not inside it.
 *
 * `$pageview` should carry the moment the page became a page, not the moment
 * hydration finished — on this page those are hundreds of milliseconds apart,
 * and the gap is exactly the interval where a bounced visitor leaves. Mounting
 * here also keeps it out of the render tree, so StrictMode's double-invoke
 * cannot double-fire it and the SSR bundle (src/entry-server.tsx) never touches
 * it at all.
 *
 * initAnalytics() is a no-op when the visitor sends Do Not Track or Global
 * Privacy Control, when they have opted out, or when the key is missing.
 */
initAnalytics();
exposeAnalyticsControls();

const container = document.getElementById('root')!;

/**
 * One lookup, no router.
 *
 * The page the browser is showing was served as a real file from Cloudflare
 * Pages, so `location.pathname` is authoritative — it is the same string the
 * prerenderer used for this file, which is what keeps hydration from
 * mismatching. There is no client-side navigation to intercept: every link on
 * the site is a full page load, on purpose.
 */
const tree = (
    <StrictMode>
        <App path={window.location.pathname} />
    </StrictMode>
);

/**
 * The production build ships a prerendered #root (scripts/prerender.mjs), so the
 * markup is already there and must be hydrated rather than thrown away. `vite
 * dev` serves the empty shell from index.html, so fall back to a fresh root —
 * hydrating an empty container would warn on every dev reload.
 */
if (container.firstChild) {
    hydrateRoot(container, tree);
} else {
    createRoot(container).render(tree);
}
