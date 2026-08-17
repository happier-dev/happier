/**
 * Fail the build if a localised page links to the English one.
 *
 * THE BUG THIS EXISTS FOR. Every internal href on the site was written as the
 * bare route — `/agents`, `/security`, `/#faq` — and nothing put the locale
 * prefix back when the page was rendered for a locale. So a reader who arrived
 * on /zh-Hant and clicked anything at all landed on the English page: 566 links
 * per locale, on all 21 pages, including the nav, the footer and every call to
 * action. The translation survived exactly one page view.
 *
 * WHY A BUILD ASSERTION AND NOT A TEST. The fix is `localePath()` applied at
 * every link site, and link sites are added by anyone adding a page. A unit test
 * over the components would have to know where the links are, which is the same
 * knowledge that goes stale. This reads the ACTUAL prerendered HTML and needs to
 * know nothing: an `<a href>` that stays inside the site and does not start with
 * the page's own locale prefix is a defect, wherever it came from — JSX, a data
 * module, or a rich() slot.
 *
 * WHAT IS ALLOWED THROUGH. Absolute URLs (another origin), bare fragments (this
 * page), and links to a DIFFERENT locale — which is precisely what the footer's
 * language switcher and the suggestion banner are for, and the only place on the
 * site where crossing locales is correct.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = join(ROOT, 'dist');

/*
 * The prefixes come from the home page's own hreflang cluster, which
 * src/routes.tsx emits straight out of LOCALE_META. Hard-coding them here, or
 * reading the directory names in dist/, would be a second list that can
 * disagree with src/i18n/locales.ts — and a locale missing from THIS list
 * silently becomes a locale whose links are never checked, which is the exact
 * failure this script exists to prevent.
 *
 * Not the sitemap: `/agents` is published as a page AND has `/agents/<slug>`
 * beneath it, so "a path that is also a parent" cannot tell a locale root from
 * an ordinary index page. The hreflang cluster names the locales as locales.
 */
const home = readFileSync(join(DIST, 'index.html'), 'utf8');
const PREFIXES = [
    ...new Set(
        [...home.matchAll(/<link rel="alternate" hreflang="(?!x-default)[^"]+" href="[^"]*?happier\.dev(\/[^"]*)?"/g)]
            .map((m) => m[1] ?? '')
            .filter((prefix) => prefix && prefix !== '/'),
    ),
]
    // Longest first: `/zh-Hant` has to win over `/zh`, or every Traditional
    // Chinese page reads as a Simplified one with a stray `-Hant` path.
    .sort((a, b) => b.length - a.length);

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (name === 'index.html') out.push(p);
    }
    return out;
}

/** The locale prefix a prerendered file sits under, or '' for English. */
function prefixOf(file) {
    const rel = `/${relative(DIST, file).replace(/\/index\.html$/, '').replace(/^index\.html$/, '')}`;
    return PREFIXES.find((p) => rel === p || rel.startsWith(`${p}/`)) ?? '';
}

const failures = [];
const dangling = new Map();
let checked = 0;
let links = 0;
let resolved = 0;

/** The file Cloudflare Pages would serve for an origin-relative href. */
function fileFor(href) {
    const path = href.split('#')[0].split('?')[0];
    if (!path || path === '/') return join(DIST, 'index.html');
    return join(DIST, path.replace(/^\/|\/$/g, ''), 'index.html');
}

for (const file of walk(DIST)) {
    const prefix = prefixOf(file);
    const html = readFileSync(file, 'utf8');

    /*
     * The existence check runs on EVERY page including English, and it is a
     * different failure from the prefix one: a prefix can be perfectly correct
     * and still name a page the build never wrote — that is what a route
     * narrowing its `locales` does to every link pointing at it. Both are 404s
     * to a reader; only one of them is visible in the href.
     */
    for (const [tag] of html.slice(html.indexOf('<body')).matchAll(/<a\b[^>]*>/g).map((m) => [m[0]])) {
        const href = /\shref="([^"]*)"/.exec(tag)?.[1];
        if (!href || !href.startsWith('/') || href.startsWith('//')) continue;
        resolved += 1;
        if (!existsSync(fileFor(href))) {
            dangling.set(href, (dangling.get(href) ?? 0) + 1);
        }
    }

    if (!prefix) continue; // English is the bare path by definition.
    checked += 1;

    const body = html.slice(html.indexOf('<body'));
    const bad = new Map();

    // The WHOLE opening tag, then the href out of it. Matching only as far as
    // the href would stop before hreflang, which is written after it.
    for (const [tag] of body.matchAll(/<a\b[^>]*>/g).map((m) => [m[0]])) {
        const href = /\shref="([^"]*)"/.exec(tag)?.[1];
        if (!href || !href.startsWith('/') || href.startsWith('//')) continue;
        links += 1;

        // A link that DECLARES hreflang is deliberately crossing languages —
        // the footer switcher and the suggestion banner, and nothing else on
        // the site. That is the one case where leaving the prefix off is not
        // only allowed but required: the English alternate has no prefix, and
        // rewriting it to /ca/agents would point the "English" row at Catalan.
        if (/\shreflang=/i.test(tag)) continue;

        const owner = PREFIXES.find((p) => href === p || href.startsWith(`${p}/`) || href.startsWith(`${p}#`));
        if (owner) continue;
        bad.set(href, (bad.get(href) ?? 0) + 1);
    }

    if (bad.size) failures.push({ file: relative(DIST, file), prefix, bad });
}

if (dangling.size) {
    console.error(
        `\nassert-locale-links: ${[...dangling.values()].reduce((a, b) => a + b, 0)} link(s) point at a ` +
            'page the build did not write.\n',
    );
    for (const [href, count] of [...dangling].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        console.error(`      ${String(count).padStart(4)}x  ${href}`);
    }
    process.exit(1);
}

if (failures.length) {
    const total = failures.reduce((n, f) => n + [...f.bad.values()].reduce((a, b) => a + b, 0), 0);
    console.error(
        `\nassert-locale-links: ${total} internal link(s) on ${failures.length} localised page(s) ` +
            'point at the English page.\n' +
            'Every internal href on a localised page must carry that page\'s prefix. Wrap it in\n' +
            'localePath() — `const href = useLocalePath()` in a component, or `localePath(locale, …)`\n' +
            'where there is no hook. See src/i18n/locales.ts.\n',
    );
    for (const { file, prefix, bad } of failures.slice(0, 12)) {
        console.error(`  ${file}  (expected prefix ${prefix})`);
        for (const [href, count] of [...bad].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
            console.error(`      ${String(count).padStart(3)}x  ${href}`);
        }
    }
    if (failures.length > 12) console.error(`  … and ${failures.length - 12} more page(s)`);
    process.exit(1);
}

console.log(
    `assert-locale-links: OK — ${links} internal link(s) across ${checked} localised page(s) all stay ` +
        `in their own language; all ${resolved} internal link(s) site-wide resolve to a written page.`,
);
