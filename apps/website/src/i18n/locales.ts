/**
 * Locale registry for the marketing site.
 *
 * Deliberately mirrors the shipped app's language registry at
 * `remote-dev/apps/ui/sources/text/_all.ts` so the two surfaces cannot drift on
 * language codes. The app already ships ten fully translated languages
 * (en, ru, pl, es, it, pt, ca, zh-Hans, zh-Hant, ja); the website starts with a
 * subset and grows into the same code space rather than inventing its own.
 *
 * `productLanguage` is the app-side `SupportedLanguage` code. Keeping it
 * explicit means a website locale can always be traced back to a translated
 * product experience — we never advertise in a language the app cannot speak.
 */

export const LOCALES = ['en', 'zh-Hans'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export type LocaleMeta = {
    /** BCP-47 tag for `<html lang>` and for `hreflang` attributes. */
    htmlLang: string;
    /**
     * URL path prefix, without a trailing slash. The default locale is served
     * from the bare root (`''`) so the canonical English URL stays
     * `https://happier.dev/` — no redirect, no lost link equity.
     */
    pathPrefix: string;
    /** Endonym, used in the locale switcher. Never translate this. */
    nativeName: string;
    /** English name, used in `aria-label`s and analytics. */
    englishName: string;
    /**
     * Lowercased `navigator.language` prefixes that should be *offered* this
     * locale. Matching never redirects (see `suggestLocale`) — it only surfaces
     * a dismissible banner, because auto-redirecting by Accept-Language breaks
     * crawlers and traps users who deliberately chose the other language.
     */
    acceptLanguagePrefixes: readonly string[];
    /** Corresponding `SupportedLanguage` in the app's i18n registry. */
    productLanguage: 'en' | 'zh-Hans';
};

export const LOCALE_META: Record<Locale, LocaleMeta> = {
    en: {
        htmlLang: 'en',
        pathPrefix: '',
        nativeName: 'English',
        englishName: 'English',
        acceptLanguagePrefixes: ['en'],
        productLanguage: 'en',
    },
    'zh-Hans': {
        htmlLang: 'zh-Hans',
        pathPrefix: '/zh',
        nativeName: '简体中文',
        englishName: 'Chinese (Simplified)',
        // zh-Hans-CN, zh-CN, zh-Hans, zh-Hans-US, zh-Hans-HK and bare `zh` all
        // land here. zh-Hant/zh-TW/zh-HK deliberately do NOT — Traditional
        // readers get English until a zh-Hant locale ships, rather than being
        // shown Simplified text they did not ask for.
        acceptLanguagePrefixes: ['zh-hans', 'zh-cn', 'zh-sg', 'zh'],
        productLanguage: 'zh-Hans',
    },
};

export const SITE_ORIGIN = 'https://happier.dev';

/** Absolute URL for a locale's copy of a route. `route` is always the
 *  locale-independent path, e.g. `/` or `/pricing`. */
export function localeUrl(locale: Locale, route = '/'): string {
    const prefix = LOCALE_META[locale].pathPrefix;
    const normalized = route === '/' ? '/' : route.replace(/\/+$/, '');
    if (!prefix) return `${SITE_ORIGIN}${normalized}`;
    return normalized === '/' ? `${SITE_ORIGIN}${prefix}/` : `${SITE_ORIGIN}${prefix}${normalized}`;
}

/** Every path the build must emit for a route, keyed by locale. */
export function localeRoutes(route = '/'): ReadonlyArray<{ locale: Locale; path: string }> {
    return LOCALES.map((locale) => ({
        locale,
        path: localeUrl(locale, route).slice(SITE_ORIGIN.length),
    }));
}

/**
 * Resolve the locale a pathname belongs to. Longest prefix wins so `/zh-Hant`
 * could never be swallowed by a future `/zh` when both exist.
 */
export function localeFromPathname(pathname: string): Locale {
    const candidates = LOCALES
        .filter((locale) => LOCALE_META[locale].pathPrefix)
        .sort((a, b) => LOCALE_META[b].pathPrefix.length - LOCALE_META[a].pathPrefix.length);

    for (const locale of candidates) {
        const prefix = LOCALE_META[locale].pathPrefix;
        if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return locale;
    }
    return DEFAULT_LOCALE;
}

/**
 * Which locale this visitor would probably prefer, based on the browser's
 * ordered language list. Returns `null` when the current locale is already the
 * best match. Callers must treat this as a *suggestion* — render a dismissible
 * banner, never a redirect.
 */
export function suggestLocale(current: Locale, navigatorLanguages: readonly string[]): Locale | null {
    for (const raw of navigatorLanguages) {
        const tag = raw.trim().toLowerCase();
        if (!tag) continue;
        for (const locale of LOCALES) {
            const hit = LOCALE_META[locale].acceptLanguagePrefixes.some(
                (prefix) => tag === prefix || tag.startsWith(`${prefix}-`),
            );
            if (hit) return locale === current ? null : locale;
        }
    }
    return null;
}
