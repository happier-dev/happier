import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { DEFAULT_LOCALE, LOCALE_META, localeFromPathname, type Locale } from './locales';
import { en } from './messages/en';
import { messagesFor, type Messages } from './messages/registry';

export { DEFAULT_LOCALE, LOCALES, LOCALE_META, SITE_ORIGIN, localeFromPathname, localeRoutes, localeUrl, suggestLocale } from './locales';
export type { Locale, LocaleMeta } from './locales';
export { messagesFor } from './messages/registry';
export type { Messages } from './messages/en';
export { buildHeadTags, htmlLangFor } from './head';

type LocaleContextValue = {
    locale: Locale;
    t: Messages;
    /**
     * The pathname being rendered, INCLUDING the locale prefix (`/es/security`).
     *
     * The locale switcher needs it to build the other languages' URLs, and it
     * cannot get it any other way: the obvious source is `findRoute()`, but
     * src/routes.tsx statically imports every page component, so a footer that
     * called it would pull the whole site into the chunk every page shares and
     * undo the bundle split. Both callers already know the path for free — the
     * prerenderer is rendering it, the browser is standing on it.
     */
    path: string;
};

const LocaleContext = createContext<LocaleContextValue>({
    locale: DEFAULT_LOCALE,
    t: en,
    path: '/',
});

/**
 * Wraps the app. `locale` is REQUIRED, and deliberately so.
 *
 * It used to be optional, falling back to DEFAULT_LOCALE on the server and to
 * `localeFromPathname(window.location.pathname)` in the browser. Those two
 * branches disagree by construction on every non-English page: the prerender
 * would emit English into `dist/zh/agents/index.html` and the browser would
 * hydrate Chinese over it. React does not merge that, it warns and re-renders,
 * and the crawler keeps the English it was served. Passing the locale in from
 * the caller that already knows it — the prerender entry knows which file it is
 * emitting, the client entry is generated per locale — removes the branch
 * rather than trying to keep two of them in agreement.
 */
export function LocaleProvider({
    locale,
    path,
    children,
}: {
    locale: Locale;
    /**
     * Origin-relative pathname with its locale prefix. The prerenderer passes
     * the path it is emitting; the client entry passes
     * `window.location.pathname`, which is the same string because the page was
     * served as its own file. Same input on both sides, so hydration matches.
     */
    path: string;
    children: ReactNode;
}) {
    const value = useMemo<LocaleContextValue>(
        () => ({ locale, t: messagesFor(locale), path }),
        [locale, path],
    );

    return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** `const { t } = useI18n()` then `t.hero.subhead`. Typed end to end. */
export function useI18n(): LocaleContextValue {
    return useContext(LocaleContext);
}

/** Shorthand for the common case. */
export function useT(): Messages {
    return useContext(LocaleContext).t;
}

/**
 * Swap the locale for the CURRENT route, preserving hash and query.
 * Used by the switcher and the suggestion banner.
 */
export function pathForLocale(target: Locale, currentPathname: string, currentHash = ''): string {
    const current = localeFromPathname(currentPathname);
    const currentPrefix = LOCALE_META[current].pathPrefix;
    const bare = currentPrefix && currentPathname.startsWith(currentPrefix)
        ? currentPathname.slice(currentPrefix.length) || '/'
        : currentPathname;
    const targetPrefix = LOCALE_META[target].pathPrefix;
    // `/zh`, NOT `/zh/` — the same rule localeUrl() follows, and it has to be
    // the same or the switcher links every reader at a URL that is not the
    // page's own canonical. Cloudflare Pages serves both from zh/index.html so
    // nothing 404s, which is exactly why this kind of mismatch survives: it is
    // invisible until something counts internal links.
    const path = targetPrefix ? (bare === '/' ? targetPrefix : `${targetPrefix}${bare}`) : bare;
    return `${path}${currentHash}`;
}
