import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LOCALES, LOCALE_META, SITE_ORIGIN, localePath, localeUrl, pathForLocale } from './index';
import { ROUTES, localesFor, routeManifest } from '../routes';
import { App } from '../App';

describe('the footer locale switcher only ever links to pages that exist', () => {
    it('offers localized destinations and hides the switcher on English-only pages', () => {
        const destinations = new Set(routeManifest().map(({ path }) => path));
        for (const path of ['/fr/enterprise', '/plans', '/open', '/supporters']) {
            const html = renderToStaticMarkup(createElement(App, { path }));
            const switcher = /<details[^>]*data-section="locale-switcher"[\s\S]*?<\/details>/.exec(html)?.[0];
            if (path === '/supporters') {
                expect(switcher).toBeUndefined();
            } else {
                expect(switcher).toBeDefined();
                for (const [, href] of switcher!.matchAll(/href="([^"]+)"/g)) {
                    expect(destinations.has(href), href).toBe(true);
                }
            }
        }
    });

    /**
     * The href must be the target page's CANONICAL url, not merely a url that
     * resolves to it. `/zh/` and `/zh` are the same file on Cloudflare Pages, so
     * a switcher that linked to the first would work perfectly and still point
     * every internal link on the site at a non-canonical address — invisible
     * until something counts them.
     */
    it('links to each page at exactly the URL it declares as canonical', () => {
        for (const route of ROUTES) {
            for (const to of localesFor(route)) {
                const canonical = localeUrl(to, route.path).slice(SITE_ORIGIN.length);
                for (const from of localesFor(route)) {
                    const fromPrefix = LOCALE_META[from].pathPrefix;
                    const currentPath = route.path === '/' ? fromPrefix || '/' : `${fromPrefix}${route.path}`;
                    expect(
                        pathForLocale(to, currentPath),
                        `switcher on ${currentPath} links to ${to}`,
                    ).toBe(canonical);
                }
            }
        }
    });

    it('has a native name and banner copy for every locale', () => {
        for (const locale of LOCALES) {
            const meta = LOCALE_META[locale];
            expect(meta.nativeName.length, `${locale} has no nativeName`).toBeGreaterThan(0);
            // The banner speaks the language it is OFFERING, so these cannot fall
            // back to English the way a catalogue string can.
            expect(meta.suggestion.offer.length, `${locale} suggestion.offer`).toBeGreaterThan(0);
            expect(meta.suggestion.action.length, `${locale} suggestion.action`).toBeGreaterThan(0);
            expect(meta.suggestion.dismiss.length, `${locale} suggestion.dismiss`).toBeGreaterThan(0);
        }
    });

    it('keeps readers in the same locale between open, plans and download', () => {
        const open = renderToStaticMarkup(createElement(App, { path: '/zh/open' }));
        const plans = renderToStaticMarkup(createElement(App, { path: '/zh/plans' }));

        expect(open).toContain('href="/zh/plans#any-server"');
        expect(open).toContain('href="/supporters" hreflang="en"');
        expect(plans).toContain('href="/zh/download"');
        expect(plans).toContain('href="/zh/open"');
    });
});

/**
 * localePath is what every internal link on the site goes through, and the
 * cases below are the ones that were actually wrong or would have been.
 *
 * scripts/assert-locale-links.mjs is the real guarantee — it reads the built
 * HTML and cannot be fooled by a link site nobody remembered. This is here for
 * the edge cases that are cheaper to state than to infer from 6,000 hrefs.
 */
describe('localePath', () => {
    it('is the identity for the default locale, which keeps the English build unchanged', () => {
        for (const href of ['/', '/agents', '/#faq', 'https://github.com/x']) {
            expect(localePath('en', href)).toBe(href);
        }
    });

    it('sends the home link to /zh, never /zh/ — the URL that page calls canonical', () => {
        expect(localePath('zh-Hant', '/')).toBe('/zh-Hant');
        expect(localePath('zh-Hant', '/')).toBe(localeUrl('zh-Hant', '/').slice(SITE_ORIGIN.length));
    });

    it('hangs an off-home anchor off the locale root, not off a trailing slash', () => {
        expect(localePath('ja', '/#faq')).toBe('/ja#faq');
        expect(localePath('ja', '#faq')).toBe('#faq');
    });

    it('leaves anything that is not our own route alone', () => {
        for (const href of ['https://docs.happier.dev', 'mailto:a@b.c', '//cdn.example/x']) {
            expect(localePath('ru', href)).toBe(href);
        }
    });

    it('never prefixes twice, and never prefixes another locale’s path', () => {
        expect(localePath('ru', '/ru/agents')).toBe('/ru/agents');
        expect(localePath('ru', localePath('ru', '/agents'))).toBe('/ru/agents');
        // The switcher builds these; re-prefixing would give /ru/fr/agents.
        expect(localePath('ru', '/fr/agents')).toBe('/fr/agents');
    });

    it('prefixes for every locale the site ships', () => {
        for (const locale of LOCALES) {
            const prefix = LOCALE_META[locale].pathPrefix;
            expect(localePath(locale, '/agents')).toBe(`${prefix}/agents`);
        }
    });
});
