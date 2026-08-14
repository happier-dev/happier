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
};

const LocaleContext = createContext<LocaleContextValue>({
    locale: DEFAULT_LOCALE,
    t: en,
});

/**
 * Wraps the app. `locale` is passed explicitly by the prerender entry (which
 * knows which file it is emitting) and inferred from `location.pathname` in
 * the browser — the two must agree, or React would hydrate mismatched text.
 */
export function LocaleProvider({ locale, children }: { locale?: Locale; children: ReactNode }) {
    const resolved = locale
        ?? (typeof window === 'undefined'
            ? DEFAULT_LOCALE
            : localeFromPathname(window.location.pathname));

    const value = useMemo<LocaleContextValue>(
        () => ({ locale: resolved, t: messagesFor(resolved) }),
        [resolved],
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
    const path = targetPrefix ? `${targetPrefix}${bare === '/' ? '/' : bare}` : bare;
    return `${path}${currentHash}`;
}
