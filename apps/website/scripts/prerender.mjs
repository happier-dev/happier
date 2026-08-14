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
const SSR_DIR = path.join(DIST, '.ssr');
const SSR_ENTRY = path.join(SSR_DIR, 'entry-server.js');

/** The exact empty container the client build leaves behind. */
const ROOT_DIV = /<div id="root">\s*<\/div>/;

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

    const routes = routeManifest();
    const written = [];

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

        const file = path.join(DIST, route.file);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, out, 'utf8');

        const words = visibleText(out).split(' ').length;
        written.push({ ...route, bytes: out.length, words });
    }

    await rm(SSR_DIR, { recursive: true, force: true });

    // The sitemap is written HERE, not from a Vite plugin, because only here do
    // all the route files exist. As a closeBundle hook on the client build it
    // ran before the prerenderer had emitted anything, so its "every route has a
    // built page" assertion could only ever be true for the one page Vite itself
    // emitted. Same module, same assertions, correct moment.
    const sitemapResult = writeSitemap({ dist: DIST, routes });

    for (const route of written) {
        console.log(
            `prerender: ${route.file.padEnd(38)} ${(route.bytes / 1024).toFixed(1).padStart(6)}KB  ~${route.words} words`,
        );
    }
    console.log(`prerender: ${written.length} route(s); sitemap lists ${sitemapResult.count}.`);
}

main().catch((error) => {
    console.error(`prerender failed: ${error.message}`);
    process.exit(1);
});
