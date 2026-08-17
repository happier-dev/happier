import { StrictMode, type ReactNode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import '../styles/globals.css';
import { LocaleProvider } from '../i18n';
import { LocaleSuggestion } from '../components/LocaleSuggestion';
import type { Locale } from '../i18n/locales';
import { useSiteAnalytics } from '../analytics/useSiteAnalytics';
import { exposeAnalyticsControls, initAnalytics } from '../analytics/analytics';

/**
 * Everything every page's entry does, so that an entry is one import and one
 * call and carries no code of its own.
 *
 * This module is the shared half of the split: it is imported by all 21 entries,
 * so Rollup emits it once, alongside the react/react-dom vendor chunk, and each
 * route chunk holds only the page nobody else renders. It must therefore import
 * NOTHING page-specific — no page component, no route table, no `src/data/*`.
 * Adding one here silently un-splits the site.
 *
 * WHY THIS IS NOT src/App.tsx. App calls `findRoute()`, and src/routes.tsx
 * statically imports all nine page components and (via them) every data module,
 * which is why one bundle held all 21 pages' copy. App is still the tree the
 * build-time renderer walks (src/entry-server.tsx) — the server has to be able
 * to render any path — but the browser already knows which page it is on,
 * because the page was served as its own file. The client entry is that
 * knowledge, made static.
 *
 * The markup it produces is byte-identical to `<App path={…}>`: same
 * LocaleProvider in the same position, same effect-only analytics hook, same
 * StrictMode wrapper. Hydration matches because the trees match, not because
 * they agree by luck.
 */

/**
 * App.tsx's body, with `route.render()` replaced by the page the entry named.
 *
 * `useSiteAnalytics` is effect-only, so it emits nothing into the markup and the
 * prerendered HTML is unaffected by it — the reason App can call it above the
 * provider and this can too, in the same place, without a hydration diff.
 */
function Page({ locale, children }: { locale: Locale; children: ReactNode }) {
    useSiteAnalytics();
    // `window.location.pathname` is the SAME string the prerenderer passed to
    // App for this file — the page was served as its own file, so the browser is
    // standing on exactly the path that produced the markup. That is what keeps
    // the locale switcher's hrefs identical on both sides of hydration.
    return (
        <LocaleProvider locale={locale} path={window.location.pathname}>
            <LocaleSuggestion />
            {children}
        </LocaleProvider>
    );
}

/**
 * Hydrate one page.
 *
 * The LOCALE IS PASSED IN, not derived from `location.pathname`. Deriving it is
 * what src/main.tsx used to do, and it was a second source of truth for
 * something the entry already knows for certain: an entry file exists per
 * (route, locale) pair, so `zh-Hans--security.tsx` is the Chinese security page
 * and nothing about the URL can change that. src/i18n/index.tsx's LocaleProvider
 * docblock asks for exactly this ("the client entry is generated per locale").
 */
export function mount(locale: Locale, page: ReactNode): void {
    /**
     * Analytics starts before React, not inside it.
     *
     * `$pageview` should carry the moment the page became a page, not the moment
     * hydration finished — on this page those are hundreds of milliseconds
     * apart, and the gap is exactly the interval where a bounced visitor leaves.
     * Mounting here also keeps it out of the render tree, so StrictMode's
     * double-invoke cannot double-fire it and the SSR bundle
     * (src/entry-server.tsx) never touches it at all.
     *
     * initAnalytics() is a no-op when the visitor sends Do Not Track or Global
     * Privacy Control, when they have opted out, or when the key is missing.
     */
    initAnalytics();
    exposeAnalyticsControls();

    const container = document.getElementById('root');
    if (!container) {
        throw new Error('No <div id="root"> to mount into. Did index.html change?');
    }

    const tree = (
        <StrictMode>
            <Page locale={locale}>{page}</Page>
        </StrictMode>
    );

    /**
     * The production build ships a prerendered #root (scripts/prerender.mjs), so
     * the markup is already there and must be hydrated rather than thrown away.
     * `vite dev` serves the empty shell from index.html, so fall back to a fresh
     * root — hydrating an empty container would warn on every dev reload.
     */
    if (container.firstChild) {
        hydrateRoot(container, tree);
    } else {
        createRoot(container).render(tree);
    }
}
