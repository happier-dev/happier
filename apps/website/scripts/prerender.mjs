#!/usr/bin/env node
/**
 * Bake every route into its own real HTML file under dist/.
 *
 * happier.dev has no router: each route in src/routes.tsx is rendered once at
 * build time and written to dist/<route>/index.html, so Cloudflare Pages serves
 * it as a genuine 200 asset. public/_redirects deliberately has no
 * `/* /index.html 200` catch-all — see the argument in that file — and this
 * script is what makes that stance work for more than one page.
 *
 * Without this step every emitted file is ~1.5KB ending in
 * `<div id="root"></div>` and the site has zero crawlable words. With it each
 * file carries its own text, its own <title>, its own canonical and its own
 * JSON-LD, and hydrates over the markup.
 *
 * IT ALSO CHOOSES WHICH CODE EACH PAGE LOADS. The client build emits one entry
 * per prerendered page (src/entries/, wired up in vite.config.ts), so the single
 * <script type="module"> Vite leaves in the shell is not the right script for
 * any of them. Each file gets its route's entry instead, read out of
 * dist/.vite/manifest.json, plus modulepreloads for the chunks that entry
 * statically imports. That is what stops a reader of /security downloading the
 * copy for the other twenty pages.
 *
 * Run after BOTH builds:
 *   vite build
 *   vite build --ssr src/entry-server.tsx
 *   node scripts/prerender.mjs
 */
import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { writeSitemap } from './sitemap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CLIENT_HTML = path.join(DIST, 'index.html');
const VITE_MANIFEST = path.join(DIST, '.vite', 'manifest.json');
const SSR_DIR = path.join(DIST, '.ssr');
const SSR_ENTRY = path.join(SSR_DIR, 'entry-server.js');

/** The exact empty container the client build leaves behind. */
const ROOT_DIV = /<div id="root">\s*<\/div>/;

/**
 * The shell's own <script type="module">, which is the DEV entry (src/main.tsx)
 * and is wrong on every shipped page.
 *
 * Vite emits exactly one of these into dist/index.html. It is replaced per route
 * with that route's entry, which is the whole mechanism of the bundle split: the
 * shell is a template, and the only thing that differs between the 21 files it
 * produces — besides the head and the markup — is which chunk they load.
 *
 * The other two <script> tags in the shell are untouched and must stay so: the
 * inline progressive-enhancement flag (no `type`) has to run before first paint,
 * and the site-scoped JSON-LD is `type="application/ld+json"`. Requiring
 * `type="module"` immediately after the tag name matches Vite's output and
 * neither of theirs.
 */
const MODULE_SCRIPT = /<script\s+type="module"[^>]*><\/script>/g;

/**
 * Vite's `base`, which this project leaves at the default. Manifest `file`
 * values are root-relative without a leading slash (`assets/route-home-x.js`),
 * so the served URL is this plus the file. If `base` is ever set in
 * vite.config.ts, it has to be set here too — hence the assertion below that the
 * shell's own script tag really does start with it.
 */
const BASE = '/';

/**
 * Every chunk a page must have before it can hydrate: its entry, and the static
 * imports of that entry, transitively.
 *
 * `imports` is Rollup's STATIC import list. `dynamicImports` is deliberately not
 * followed: posthog-js and anything else behind an `import()` is off the first
 * paint on purpose, and preloading it would put it back on.
 *
 * Returns dependencies first, entry last, which is the order Vite itself emits
 * — a modulepreload for a dependency is only useful if the browser sees it
 * before it has finished parsing the module that needs it.
 */
function chunkClosure(manifest, key, seen = new Set()) {
    if (seen.has(key)) return [];
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) return [];
    const files = [];
    for (const imported of chunk.imports ?? []) files.push(...chunkClosure(manifest, imported, seen));
    files.push(chunk.file);
    return files;
}

/**
 * The tags that replace the shell's dev script, for one route.
 *
 * Vite writes these itself for an HTML entry; a hand-picked entry has to write
 * its own. Skipping the modulepreloads would still WORK — the browser would
 * discover the shared react chunk a round trip after parsing the entry — which
 * is precisely the kind of regression a split introduces if nobody writes this
 * out, so it is not optional.
 */
function scriptTagsFor(manifest, entryKey, route) {
    const chunk = manifest[entryKey];
    if (!chunk) {
        throw new Error(
            `${route.file}: no client entry for "${route.path}". Expected ${entryKey}.\n` +
                `Create it — two lines, see src/entries/home.tsx — and vite.config.ts will pick ` +
                `it up from the directory on the next build. Every route in ROUTES ` +
                `(src/routes.tsx), in every locale it lists, needs one.`,
        );
    }
    const files = chunkClosure(manifest, entryKey);
    const preloads = files.slice(0, -1);
    const entryFile = files[files.length - 1];
    return [
        ...preloads.map((f) => `<link rel="modulepreload" crossorigin href="${BASE}${f}" />`),
        `<script type="module" crossorigin src="${BASE}${entryFile}"></script>`,
    ].join('\n        ');
}

/**
 * The slot index.html reserves for per-route head tags.
 *
 * Everything between the markers is replaced wholesale. index.html ships the
 * homepage's tags inside them so `vite dev` and `vite preview` still serve a
 * page with a title; the prerenderer overwrites them per route.
 */
const HEAD_OPEN = '<!--head-->';
const HEAD_CLOSE = '<!--/head-->';

async function exists(file) {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

async function waitForFile(file, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await exists(file))) {
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
}

/**
 * Strip authoring comments from the SHIPPED html only. The source keeps every one.
 *
 * index.html carries ~7KB of engineering notes — why there is one theme-color,
 * why twitter:site is absent, which hex is html.light --bg. Google ignores HTML
 * comments, so this is not an SEO trick. It matters because naive tag-strippers
 * do not ignore them, and naive tag-strippers are what a great many LLM
 * ingestion pipelines are: a note reading "the page does NOT follow the OS"
 * lands in extracted body text as if the page said it. Given this site's
 * deliberate allow-everything crawler stance, those readers are the intended
 * audience.
 *
 * REACT'S OWN COMMENTS ARE NOT AUTHORING COMMENTS. `<!--$-->`, `<!--/$-->`,
 * `<!--$!-->` and `<!--$?-->` are Suspense boundary markers that hydration
 * matches against; removing them would break the page rather than tidy it. They
 * all begin `<!--$` or `<!--/$`, which is exactly what the lookahead spares.
 * `<!--head-->` and `<!--/head-->` are NOT spared: they have done their job by
 * the time this runs and are pure noise in the shipped file.
 */
function stripAuthoringComments(html) {
    return html.replace(/<!--(?!\$|\/\$)[\s\S]*?-->/g, '');
}

/**
 * ISLANDS, AND THE ONE WAY THEIR PROPS CAN BE DESTROYED BETWEEN HERE AND THE
 * BROWSER.
 *
 * An island's props travel as JSON inside a `data-island-props` attribute — see
 * src/islands/props.ts for why an attribute and not an inline script block.
 * React escapes `& < > " '` on the way out, which is what makes that safe, and
 * in particular is what stops `stripAuthoringComments()` above from eating a
 * prop whose text contains `<!--`: by the time that regex runs the attribute
 * reads `&lt;!--` and it cannot see it.
 *
 * That is a two-sentence argument standing between a shipped page and a silent
 * mis-render, so it is checked rather than believed. Every island in the SHIPPED
 * html — after comment-stripping, not before — must still parse. The cost is one
 * regex per page; the win is that "the nav on /security hydrates into the
 * homepage's overlay variant" becomes a build failure naming the route and the
 * island instead of something a person has to notice.
 *
 * Both functions are inert until a page actually renders an <Island>, so they
 * cannot fail a build that has none.
 */
const ISLAND_MARKER = /\sdata-island="([^"]*)"/g;
const ISLAND_PROPS = /\sdata-island="([^"]*)"[^>]*?\sdata-island-props="([^"]*)"/g;

/** Reverses React's attribute escaping — what `getAttribute()` does in the browser. */
function unescapeAttribute(value) {
    return (
        value
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#x27;/g, "'")
            .replace(/&#39;/g, "'")
            // `&amp;` LAST. Doing it first would turn `&amp;lt;` — the correct
            // encoding of the literal text `&lt;` — into `<`.
            .replace(/&amp;/g, '&')
    );
}

/**
 * @returns how many islands the page declares, for the build log. A page whose
 * island count silently drops to zero is a page that stopped being interactive,
 * and that should be visible in a diff of the build output rather than in a bug
 * report.
 */
function assertIslandPropsSurvive(html, route) {
    for (const [, name, raw] of html.matchAll(ISLAND_PROPS)) {
        const json = unescapeAttribute(raw);
        let parsed;
        try {
            parsed = JSON.parse(json);
        } catch (cause) {
            throw new Error(
                `${route.file}: island "${name}" has props that did not survive prerendering.\n` +
                    `  after unescaping: ${json.slice(0, 200)}\n` +
                    `  ${cause.message}\n` +
                    'Something in this script rewrote the attribute — stripAuthoringComments() is ' +
                    'the usual suspect. The browser throws on this page rather than rendering it.',
            );
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(
                `${route.file}: island "${name}" serialised its props as ` +
                    `${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object. ` +
                    'src/islands/props.ts only emits objects, so the attribute was rewritten.',
            );
        }
    }
    return Array.from(html.matchAll(ISLAND_MARKER)).length;
}

/** Text content, the way a non-JS crawler would extract it. */
function visibleText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function main() {
    if (!(await waitForFile(CLIENT_HTML))) {
        throw new Error(`Missing ${CLIENT_HTML}. Run \`vite build\` first.`);
    }
    if (!(await waitForFile(SSR_ENTRY))) {
        throw new Error(
            `Missing ${SSR_ENTRY}. Run \`vite build --ssr src/entry-server.tsx\` first.`,
        );
    }

    const { render, routeManifest } = await import(pathToFileURL(SSR_ENTRY).href);
    if (typeof render !== 'function') {
        throw new Error('dist-ssr/entry-server.js does not export render().');
    }
    if (typeof routeManifest !== 'function') {
        throw new Error('dist-ssr/entry-server.js does not export routeManifest().');
    }

    const shell = await readFile(CLIENT_HTML, 'utf8');
    if (!ROOT_DIV.test(shell)) {
        throw new Error(
            'dist/index.html has no empty <div id="root"></div> to fill. ' +
                'Did index.html change, or has prerender already run?',
        );
    }
    const headStart = shell.indexOf(HEAD_OPEN);
    const headEnd = shell.indexOf(HEAD_CLOSE);
    if (headStart === -1 || headEnd === -1 || headEnd < headStart) {
        throw new Error(
            `index.html must contain ${HEAD_OPEN} … ${HEAD_CLOSE} around the per-route head ` +
                'tags. Without it every route would ship the homepage title and canonical.',
        );
    }

    // ---- the per-route bundle split ---------------------------------------
    // The shell carries ONE <script type="module">, pointing at the dev entry
    // Vite built from index.html. Every emitted page swaps it for its own route
    // chunk, so a reader of /security downloads /security's code and the shared
    // react/vendor chunk — not the other twenty pages. See vite.config.ts.
    const scriptTags = shell.match(MODULE_SCRIPT) ?? [];
    if (scriptTags.length !== 1) {
        throw new Error(
            `dist/index.html has ${scriptTags.length} <script type="module"> tags; expected exactly 1. ` +
                'The shell is the template for every page, so a second module script would be ' +
                'copied onto every one of them and the route split could not name which to replace.',
        );
    }
    if (!scriptTags[0].includes(`src="${BASE}`)) {
        throw new Error(
            `dist/index.html's module script does not start with base "${BASE}". ` +
                'If vite.config.ts now sets `base`, set BASE in this file to match — the ' +
                'modulepreload and script URLs written below are built from it.',
        );
    }
    // Vite injects the stylesheet into HTML inputs, and `cssCodeSplit: false`
    // (vite.config.ts) is what guarantees the ONE link in this shell covers
    // every page copied from it. Asserted rather than assumed: a Vite upgrade
    // that changed either behaviour would otherwise ship an unstyled site.
    if (!/<link[^>]+rel=["']stylesheet["']/i.test(shell)) {
        throw new Error(
            'dist/index.html has no <link rel="stylesheet">. Every page is copied from this ' +
                'shell, so the whole site would ship unstyled. Check build.cssCodeSplit in ' +
                'vite.config.ts — it must stay false while the shell is the only HTML input.',
        );
    }

    if (!(await exists(VITE_MANIFEST))) {
        throw new Error(
            `Missing ${VITE_MANIFEST}. build.manifest must stay true in vite.config.ts — it is ` +
                'how each page finds the hashed chunk it has to load.',
        );
    }
    const manifest = JSON.parse(await readFile(VITE_MANIFEST, 'utf8'));

    const routes = routeManifest();
    if (routes.some((route) => !route.clientEntry)) {
        throw new Error(
            'The route manifest carries no clientEntry. dist/.ssr/entry-server.js is from ' +
                'before the per-route split — rerun `vite build --ssr src/entry-server.tsx`.',
        );
    }
    const written = [];
    const entriesUsed = new Set();

    for (const route of routes) {
        const appHtml = render(route.path);
        if (typeof appHtml !== 'string' || appHtml.length < 1000) {
            throw new Error(
                `render("${route.path}") returned ${appHtml?.length ?? 0} bytes — the tree did not render.`,
            );
        }

        // `$` is special in String.replace replacements and the rendered markup
        // is full of `$` (shell prompts, install commands). A function
        // replacement takes the string verbatim.
        let out =
            shell.slice(0, headStart) +
            HEAD_OPEN +
            '\n        ' +
            route.head +
            '\n        ' +
            shell.slice(headEnd);
        out = out.replace(ROOT_DIV, () => `<div id="root">${appHtml}</div>`);

        // The one script this page loads, plus modulepreloads for the chunks it
        // statically imports. A function replacement for the same reason as
        // above: hashed filenames are safe, but `$` in a replacement string is
        // not worth relying on twice.
        const tags = scriptTagsFor(manifest, route.clientEntry, route);
        entriesUsed.add(route.clientEntry);
        out = out.replace(MODULE_SCRIPT, () => tags);

        // `<html lang>` per file. index.html ships `lang="en"` as the shell's
        // default; a localised page has to declare its own or a screen reader
        // announces Chinese in an English voice and Google reads the page as
        // English regardless of the hreflang cluster.
        if (route.htmlLang && route.htmlLang !== 'en') {
            const before = out;
            out = out.replace(/<html([^>]*)\slang="[^"]*"/i, (_m, rest) => `<html${rest} lang="${route.htmlLang}"`);
            if (out === before) {
                throw new Error(
                    `could not set lang="${route.htmlLang}" on ${route.file} — index.html no longer has a <html lang="…"> to replace.`,
                );
            }
        }

        out = stripAuthoringComments(out);

        // AFTER stripping, because the stripped file is the one that ships and
        // the comment stripper is the thing most likely to have corrupted a
        // prop. Checking `out` before this line would prove nothing about it.
        const islands = assertIslandPropsSurvive(out, route);

        const file = path.join(DIST, route.file);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, out, 'utf8');

        const words = visibleText(out).split(' ').length;
        written.push({ ...route, bytes: out.length, words, islands });
    }

    // An entry nobody hydrates is a page that was renamed or deleted in
    // src/routes.tsx and left behind in src/entries/. It ships a chunk no HTML
    // references — dead weight in the artifact, and a lie about what the site
    // has. The reverse direction (a route with no entry) is caught in
    // scriptTagsFor(); both have to fail or the two lists drift apart.
    const orphans = Object.keys(manifest).filter(
        (key) => manifest[key].isEntry && key.startsWith('src/entries/') && !entriesUsed.has(key),
    );
    if (orphans.length) {
        throw new Error(
            `client entr${orphans.length === 1 ? 'y is' : 'ies are'} built but no route loads ` +
                `${orphans.length === 1 ? 'it' : 'them'}: ${orphans.join(', ')}. ` +
                'Delete the file(s), or add the route to ROUTES in src/routes.tsx.',
        );
    }

    await rm(SSR_DIR, { recursive: true, force: true });

    // The sitemap is written HERE, not from a Vite plugin, because only here do
    // all the route files exist. As a closeBundle hook on the client build it
    // ran before the prerenderer had emitted anything, so its "every route has a
    // built page" assertion could only ever be true for the one page Vite itself
    // emitted. Same module, same assertions, correct moment.
    const sitemapResult = writeSitemap({ dist: DIST, routes });

    for (const route of written) {
        // The island count is omitted while it is zero, so the log stays exactly
        // as it reads today until the first page is actually cut into islands.
        const islands = route.islands ? `  ${route.islands} island(s)` : '';
        console.log(
            `prerender: ${route.file.padEnd(38)} ${(route.bytes / 1024).toFixed(1).padStart(6)}KB  ` +
                `~${route.words} words  ${route.clientEntry.replace('src/entries/', '')}${islands}`,
        );
    }
    console.log(
        `prerender: ${written.length} route(s) across ${entriesUsed.size} client entr` +
            `${entriesUsed.size === 1 ? 'y' : 'ies'}; sitemap lists ${sitemapResult.count}.`,
    );
}

main().catch((error) => {
    console.error(`prerender failed: ${error.message}`);
    process.exit(1);
});
