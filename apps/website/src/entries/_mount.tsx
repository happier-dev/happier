import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../styles/globals.css';
import { LocaleProvider } from '../i18n';
import { LocaleSuggestion } from '../components/LocaleSuggestion';
import type { Locale } from '../i18n/locales';
import { armReveals, mountIslands } from '../islands';
import { useSiteAnalytics } from '../analytics/useSiteAnalytics';
import { ISLANDS } from './_islands';
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

/** Effect-only; renders nothing. See the note in mount(). */
function PageScopedEffects() {
    useSiteAnalytics();
    return null;
}

export function mount(locale: Locale): void {
    /**
     * Analytics starts before React, not inside it.
     *
     * `$pageview` should carry the moment the page became a page, not the moment
     * hydration finished — on this page those are hundreds of milliseconds
     * apart, and the gap is exactly the interval where a bounced visitor leaves.
     *
     * initAnalytics() is a no-op when the visitor sends Do Not Track or Global
     * Privacy Control, when they have opted out, or when the key is missing.
     */
    initAnalytics();
    exposeAnalyticsControls();

    mountIslands(locale, ISLANDS);
    armReveals();

    /**
     * The page-scoped extras, in one root of their own.
     *
     * `useSiteAnalytics` is the site's passive instrumentation — outbound_click,
     * download_badge_clicked, section_viewed, comparison_viewed — and it works by
     * listening at the document, not by sitting inside the components it
     * measures. That is precisely why it CANNOT live in an island: an island
     * only sees its own subtree, so mounting it there would measure the nav and
     * nothing else. It used to ride along inside the page-wide hydrate; now it
     * needs somewhere deliberate to live, and this is it.
     *
     * LocaleSuggestion renders nothing on the server — it decides from
     * navigator.language, which the build does not have — so unlike every other
     * island it has no prerendered container to hydrate. It gets a root of its
     * own, appended rather than matched.
     */
    const suggestion = document.createElement('div');
    suggestion.style.display = 'contents';
    document.body.appendChild(suggestion);
    createRoot(suggestion).render(
        <StrictMode>
            <LocaleProvider locale={locale} path={window.location.pathname}>
                <PageScopedEffects />
                <LocaleSuggestion />
            </LocaleProvider>
        </StrictMode>,
    );
}
