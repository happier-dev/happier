/**
 * Locale registry for the marketing site.
 *
 * Deliberately mirrors the shipped app's language registry at
 * `remote-dev/apps/ui/sources/text/_all.ts` so the two surfaces cannot drift on
 * language codes. The app ships twelve fully translated languages
 * (en, ru, pl, es, fr, it, pt, ca, de, zh-Hans, zh-Hant, ja); the website starts
 * with a subset and grows into the same code space rather than inventing its own.
 *
 * `productLanguage` is the app-side `SupportedLanguage` code. Keeping it
 * explicit means a website locale can always be traced back to a translated
 * product experience — we never advertise in a language the app cannot speak.
 */

/**
 * The same twelve codes the app ships, in the same spelling.
 *
 * `zh-Hant` is listed BEFORE `zh-Hans` because `suggestLocale` and
 * `localeFromPathname` both resolve longest-match-first, and a Traditional
 * reader must never be handed Simplified text they did not ask for.
 */
export const LOCALES = [
    'en',
    'zh-Hant',
    'zh-Hans',
    'ja',
    'ru',
    'pl',
    'es',
    'fr',
    'it',
    'pt',
    'ca',
    'de',
] as const;

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
    /**
     * Open Graph's locale format — language_TERRITORY with an underscore, which
     * is NOT the BCP-47 tag in `htmlLang`. Facebook and LinkedIn reject the
     * hyphenated form and fall back to en_US, so the two cannot be shared.
     */
    ogLocale: string;
    /**
     * The three strings the suggestion banner needs, IN THIS LANGUAGE.
     *
     * They live here rather than in the message catalogue because of who reads
     * them: a Spanish speaker looking at the English page. The banner has to
     * speak the language it is offering, and that locale's overlay is not
     * loaded — a page ships exactly one overlay, which is what keeps the other
     * nine out of every reader's download. Ten short phrases in the shared
     * registry cost almost nothing and are always to hand.
     */
    suggestion: {
        /** "This page is also available in X." */
        offer: string;
        /** The link. "Read it in X." */
        action: string;
        /** aria-label for the dismiss button. */
        dismiss: string;
    };
    /**
     * Corresponding `SupportedLanguage` in the app's i18n registry
     * (remote-dev/apps/ui/sources/text/_all.ts). Keeping it explicit means a
     * website locale can always be traced to a translated product experience —
     * we never advertise in a language the app cannot speak.
     */
    productLanguage: Locale;
};

export const LOCALE_META: Record<Locale, LocaleMeta> = {
    en: {
        htmlLang: 'en',
        pathPrefix: '',
        nativeName: 'English',
        englishName: 'English',
        acceptLanguagePrefixes: ['en'],
        ogLocale: 'en_US',
        suggestion: {
            offer: 'This page is also available in English.',
            action: 'Read it in English',
            dismiss: 'Dismiss',
        },
        productLanguage: 'en',
    },
    // Traditional is matched before Simplified — see the note on LOCALES. Bare
    // `zh` belongs to Simplified because it is overwhelmingly mainland traffic,
    // but zh-TW / zh-HK / zh-MO must never fall into it.
    'zh-Hant': {
        htmlLang: 'zh-Hant',
        pathPrefix: '/zh-Hant',
        nativeName: '中文(繁體)',
        englishName: 'Chinese (Traditional)',
        acceptLanguagePrefixes: ['zh-hant', 'zh-tw', 'zh-hk', 'zh-mo'],
        ogLocale: 'zh_TW',
        suggestion: {
            offer: '本頁面也有繁體中文版本。',
            action: '以繁體中文閱讀',
            dismiss: '關閉',
        },
        productLanguage: 'zh-Hant',
    },
    'zh-Hans': {
        htmlLang: 'zh-Hans',
        pathPrefix: '/zh',
        nativeName: '中文(简体)',
        englishName: 'Chinese (Simplified)',
        acceptLanguagePrefixes: ['zh-hans', 'zh-cn', 'zh-sg', 'zh'],
        ogLocale: 'zh_CN',
        suggestion: {
            offer: '本页面也有简体中文版本。',
            action: '用简体中文阅读',
            dismiss: '关闭',
        },
        productLanguage: 'zh-Hans',
    },
    ja: {
        htmlLang: 'ja',
        pathPrefix: '/ja',
        nativeName: '日本語',
        englishName: 'Japanese',
        acceptLanguagePrefixes: ['ja'],
        ogLocale: 'ja_JP',
        suggestion: {
            offer: 'このページは日本語でもご覧いただけます。',
            action: '日本語で読む',
            dismiss: '閉じる',
        },
        productLanguage: 'ja',
    },
    ru: {
        htmlLang: 'ru',
        pathPrefix: '/ru',
        nativeName: 'Русский',
        englishName: 'Russian',
        acceptLanguagePrefixes: ['ru'],
        ogLocale: 'ru_RU',
        suggestion: {
            offer: 'Эта страница также доступна на русском.',
            action: 'Читать по-русски',
            dismiss: 'Закрыть',
        },
        productLanguage: 'ru',
    },
    pl: {
        htmlLang: 'pl',
        pathPrefix: '/pl',
        nativeName: 'Polski',
        englishName: 'Polish',
        acceptLanguagePrefixes: ['pl'],
        ogLocale: 'pl_PL',
        suggestion: {
            offer: 'Ta strona jest dostępna także po polsku.',
            action: 'Czytaj po polsku',
            dismiss: 'Zamknij',
        },
        productLanguage: 'pl',
    },
    es: {
        htmlLang: 'es',
        pathPrefix: '/es',
        nativeName: 'Español',
        englishName: 'Spanish',
        acceptLanguagePrefixes: ['es'],
        ogLocale: 'es_ES',
        suggestion: {
            offer: 'Esta página también está disponible en español.',
            action: 'Leerla en español',
            dismiss: 'Cerrar',
        },
        productLanguage: 'es',
    },
    fr: {
        htmlLang: 'fr',
        pathPrefix: '/fr',
        nativeName: 'Français',
        englishName: 'French',
        // Bare `fr` covers fr-FR, fr-CA, fr-BE and fr-CH: the copy is written in
        // standard French with no France-specific idiom, so every variant is
        // better served this page than the English one.
        acceptLanguagePrefixes: ['fr'],
        ogLocale: 'fr_FR',
        suggestion: {
            offer: 'Cette page est aussi disponible en français.',
            action: 'La lire en français',
            dismiss: 'Fermer',
        },
        productLanguage: 'fr',
    },
    it: {
        htmlLang: 'it',
        pathPrefix: '/it',
        nativeName: 'Italiano',
        englishName: 'Italian',
        acceptLanguagePrefixes: ['it'],
        ogLocale: 'it_IT',
        suggestion: {
            offer: 'Questa pagina è disponibile anche in italiano.',
            action: 'Leggila in italiano',
            dismiss: 'Chiudi',
        },
        productLanguage: 'it',
    },
    pt: {
        htmlLang: 'pt',
        pathPrefix: '/pt',
        nativeName: 'Português',
        englishName: 'Portuguese',
        acceptLanguagePrefixes: ['pt'],
        ogLocale: 'pt_PT',
        suggestion: {
            offer: 'Esta página também está disponível em português.',
            action: 'Ler em português',
            dismiss: 'Fechar',
        },
        productLanguage: 'pt',
    },
    de: {
        htmlLang: 'de',
        pathPrefix: '/de',
        nativeName: 'Deutsch',
        englishName: 'German',
        // Bare `de` covers de-DE, de-AT and de-CH: the copy avoids Germany-only
        // idiom, and Swiss readers get standard German rather than the English
        // page. The ß is kept — Swiss orthography tolerates it far better than
        // an Austrian or German reader tolerates its absence.
        acceptLanguagePrefixes: ['de'],
        ogLocale: 'de_DE',
        suggestion: {
            offer: 'Diese Seite gibt es auch auf Deutsch.',
            action: 'Auf Deutsch lesen',
            dismiss: 'Schließen',
        },
        productLanguage: 'de',
    },
    ca: {
        htmlLang: 'ca',
        pathPrefix: '/ca',
        nativeName: 'Català',
        englishName: 'Catalan',
        acceptLanguagePrefixes: ['ca'],
        ogLocale: 'ca_ES',
        suggestion: {
            offer: 'Aquesta pàgina també està disponible en català.',
            action: 'Llegeix-la en català',
            dismiss: 'Tanca',
        },
        productLanguage: 'ca',
    },
};

export const SITE_ORIGIN = 'https://happier.dev';

/** Absolute URL for a locale's copy of a route. `route` is always the
 *  locale-independent path, e.g. `/` or `/pricing`. */
export function localeUrl(locale: Locale, route = '/'): string {
    const prefix = LOCALE_META[locale].pathPrefix;
    const normalized = route === '/' ? '/' : route.replace(/\/+$/, '');
    if (!prefix) return `${SITE_ORIGIN}${normalized}`;
    // `/zh`, NOT `/zh/`. Only the origin root carries a trailing slash; `/zh` is
    // an ordinary path segment like `/agents`, and it is written to
    // `zh/index.html`. scripts/assert-crawlable.mjs derives the canonical it
    // expects FROM that file path, so a trailing slash here makes every
    // localised home page fail its own canonical check.
    return normalized === '/' ? `${SITE_ORIGIN}${prefix}` : `${SITE_ORIGIN}${prefix}${normalized}`;
}

/**
 * An `href` for a link on a page being rendered in `locale`.
 *
 * WHY EVERY INTERNAL LINK HAS TO GO THROUGH SOMETHING. A visitor who reached
 * /zh-Hant and clicked "Agents we run" landed on /agents — the ENGLISH page —
 * because the href was written `/agents` and nothing put the prefix back. Every
 * internal link on the site did that: 566 of them per locale. The translation
 * held for exactly one page view.
 *
 * It is deliberately total rather than clever: hand it anything that goes in an
 * href and it either prefixes it or returns it untouched.
 *   - absolute (`https:`, `mailto:`, `//cdn`) → untouched, it is not our route
 *   - a bare fragment (`#faq`) → untouched, it is this page
 *   - already prefixed → untouched, so a double application is harmless and the
 *     locale-switcher's own hrefs survive being passed through
 *   - `/` → the prefix alone (`/zh`, never `/zh/`), matching localeUrl above,
 *     because that is the URL the page declares as canonical
 *   - `/#faq` → `/zh#faq`, for the same reason: the home page of a locale is
 *     `/zh`, so the anchor hangs off that and not off `/zh/`
 *
 * For the default locale the prefix is empty and this is the identity function,
 * which is what keeps the English build byte-identical.
 */
export function localePath(locale: Locale, href: string): string {
    const prefix = LOCALE_META[locale].pathPrefix;
    if (!prefix) return href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
    if (href.startsWith('#')) return href;
    if (!href.startsWith('/')) return href;
    if (href === prefix || href.startsWith(`${prefix}/`) || href.startsWith(`${prefix}#`)) return href;
    // Another locale's prefix — the switcher builds those, and prefixing them
    // again would produce /zh-Hant/fr/agents.
    for (const meta of Object.values(LOCALE_META)) {
        const other = meta.pathPrefix;
        if (other && (href === other || href.startsWith(`${other}/`) || href.startsWith(`${other}#`))) return href;
    }
    if (href === '/') return prefix;
    if (href.startsWith('/#')) return `${prefix}${href.slice(1)}`;
    return `${prefix}${href}`;
}

/**
 * Every path the build must emit for a route.
 *
 * `locales` is the route's OWN list, not the site's. A route that exists only in
 * English emits one file and advertises one alternate; a route that has been
 * translated emits more. That per-route gating is what makes a partially
 * translated site correct rather than merely tolerated — nothing can advertise a
 * URL the build did not write.
 */
export function localeRoutes(
    route = '/',
    locales: readonly Locale[] = LOCALES,
): ReadonlyArray<{ locale: Locale; path: string }> {
    return locales.map((locale) => ({
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
    // Longest prefix wins, independent of LOCALES order: `zh-hant` must beat the
    // bare `zh` that belongs to Simplified, or a Taiwanese reader is offered
    // mainland text. localeFromPathname already resolves URLs this way.
    const byLength = LOCALES.flatMap((locale) =>
        LOCALE_META[locale].acceptLanguagePrefixes.map((prefix) => ({ locale, prefix })),
    ).sort((a, b) => b.prefix.length - a.prefix.length);

    for (const raw of navigatorLanguages) {
        const tag = raw.trim().toLowerCase();
        if (!tag) continue;
        for (const { locale, prefix } of byLength) {
            if (tag === prefix || tag.startsWith(`${prefix}-`)) {
                return locale === current ? null : locale;
            }
        }
    }
    return null;
}
