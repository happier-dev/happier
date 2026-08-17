import { LOCALES, LOCALE_META, SITE_ORIGIN, localeUrl, type Locale } from './locales';
import { messagesFor } from './messages/registry';

/**
 * Builds the per-locale <head> for a prerendered route.
 *
 * This is the ONLY place the site decides what goes in the head, so the
 * prerender lane's script and any future SSR path cannot drift. It returns a
 * string of tags to be spliced into the `<head>` of the emitted HTML, plus the
 * `lang` attribute for `<html>`.
 *
 * SEO contract implemented here:
 *  - Every locale's page carries a self-referencing `canonical`.
 *  - Every locale's page carries the FULL reciprocal `hreflang` set — Google
 *    ignores an hreflang cluster where the return links are missing.
 *  - `x-default` points at the English root, which is where an unmatched
 *    visitor should land.
 *  - `og:locale` / `og:locale:alternate` mirror the same cluster for crawlers
 *    that read Open Graph rather than link rel.
 */

export type HeadInput = {
    locale: Locale;
    /** Locale-independent route, e.g. `/`. */
    route?: string;
    /** Absolute or root-relative OG image path. */
    ogImage?: string;
};

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function htmlLangFor(locale: Locale): string {
    return LOCALE_META[locale].htmlLang;
}

export function buildHeadTags({ locale, route = '/', ogImage = '/images/og.png' }: HeadInput): string {
    const t = messagesFor(locale);
    const selfUrl = localeUrl(locale, route);
    const absoluteOgImage = ogImage.startsWith('http') ? ogImage : `${SITE_ORIGIN}${ogImage}`;

    const alternates = LOCALES.map(
        (other) =>
            `<link rel="alternate" hreflang="${escapeAttr(LOCALE_META[other].htmlLang)}" href="${escapeAttr(localeUrl(other, route))}" />`,
    );
    // x-default: the page shown to a visitor whose language matches nothing.
    alternates.push(`<link rel="alternate" hreflang="x-default" href="${escapeAttr(localeUrl('en', route))}" />`);

    const ogAlternates = LOCALES.filter((other) => other !== locale).map(
        (other) => `<meta property="og:locale:alternate" content="${escapeAttr(messagesFor(other).meta.ogLocale)}" />`,
    );

    return [
        `<title>${escapeAttr(t.meta.title)}</title>`,
        `<meta name="description" content="${escapeAttr(t.meta.description)}" />`,
        `<link rel="canonical" href="${escapeAttr(selfUrl)}" />`,
        ...alternates,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="Happier" />`,
        `<meta property="og:url" content="${escapeAttr(selfUrl)}" />`,
        `<meta property="og:title" content="${escapeAttr(t.meta.ogTitle)}" />`,
        `<meta property="og:description" content="${escapeAttr(t.meta.ogDescription)}" />`,
        `<meta property="og:image" content="${escapeAttr(absoluteOgImage)}" />`,
        `<meta property="og:locale" content="${escapeAttr(t.meta.ogLocale)}" />`,
        ...ogAlternates,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escapeAttr(t.meta.ogTitle)}" />`,
        `<meta name="twitter:description" content="${escapeAttr(t.meta.ogDescription)}" />`,
        `<meta name="twitter:image" content="${escapeAttr(absoluteOgImage)}" />`,
    ].join('\n        ');
}
