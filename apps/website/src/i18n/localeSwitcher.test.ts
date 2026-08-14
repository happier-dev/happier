import { describe, expect, it } from 'vitest';

import { LOCALES, LOCALE_META, SITE_ORIGIN, localeUrl, pathForLocale } from './index';
import { ROUTES, localesFor, fileForRoute } from '../routes';

/**
 * The switcher offers TEN languages on every page, and it does not check.
 *
 * It cannot: `findRoute()` lives in src/routes.tsx, which statically imports
 * every page component and every data module, and the footer renders on all 210
 * pages — importing it there would pull the whole site into the chunk every page
 * shares and undo the bundle split. So src/components/LocaleSwitcher.tsx maps
 * over LOCALES and trusts that every route has all of them.
 *
 * This is what makes that trust safe. The moment a route narrows its `locales`,
 * the switcher starts linking to a URL the build never wrote, and this test
 * fails instead — naming the route and pointing at the component.
 */
describe('the footer locale switcher only ever links to pages that exist', () => {
    it('gives every route every locale, which is what the switcher assumes', () => {
        for (const route of ROUTES) {
            expect(
                [...localesFor(route)].sort(),
                `${route.path} does not ship in every language, but ` +
                    'src/components/LocaleSwitcher.tsx links to all of them from every page. ' +
                    'Either give the route the missing locales, or make the switcher take the ' +
                    "route's list — it cannot import findRoute() to ask.",
            ).toEqual([...LOCALES].sort());
        }
    });

    it('builds a URL the prerenderer actually writes, for every route and locale', () => {
        // The switcher's href and the file on disk are produced by two different
        // functions — pathForLocale here, localeUrl in the route manifest — and
        // a trailing-slash or prefix disagreement between them is a 404 that no
        // type checks and no page shows until someone clicks.
        const built = new Set(
            ROUTES.flatMap((route) =>
                localesFor(route).map((locale) => {
                    const prefix = LOCALE_META[locale].pathPrefix;
                    const path = route.path === '/' ? prefix || '/' : `${prefix}${route.path}`;
                    return fileForRoute(path);
                }),
            ),
        );

        for (const route of ROUTES) {
            for (const from of localesFor(route)) {
                const fromPrefix = LOCALE_META[from].pathPrefix;
                const currentPath = route.path === '/' ? fromPrefix || '/' : `${fromPrefix}${route.path}`;

                for (const to of LOCALES) {
                    const href = pathForLocale(to, currentPath);
                    expect(
                        built.has(fileForRoute(href)),
                        `switcher on ${currentPath} links to ${href}, which the build does not write`,
                    ).toBe(true);
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
            for (const to of LOCALES) {
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
});
