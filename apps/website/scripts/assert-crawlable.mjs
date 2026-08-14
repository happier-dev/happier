#!/usr/bin/env node
/**
 * Fail the build if any route would ship without crawlable text or a correct head.
 *
 * This is the guard on the regressions that publishing this prerendered site
 * could cause. A plain `vite build` emits `<div id="root"></div>` and zero
 * words; if scripts/prerender.mjs is ever skipped, reordered, or silently broken
 * by a Vite upgrade, this script stops the deploy instead of letting the site
 * lose every ranking it has.
 *
 * It now runs PER ROUTE, and adds the two cross-route assertions that only
 * became possible — and only became necessary — when the site grew past one
 * page:
 *
 *   * No two routes may share a <title>. Duplicate titles are the classic
 *     signal of a templated doorway set, and they make every page compete with
 *     its siblings for the same query.
 *   * No two routes may share a page-scoped JSON-LD `@id`. This was a live bug
 *     the moment a second page existed: the WebPage node's `@id` was hardcoded
 *     to `https://happier.dev/#webpage`, so every page would have claimed to be
 *     the same document. Site-scoped nodes (#org, #site, #app, #source) are
 *     SUPPOSED to be shared — that is how a schema graph refers to one
 *     organisation from many pages — so they are exempt by name.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** The homepage has ~3,100 words. A content route under this is a stub. */
const MIN_TEXT_CHARS = 2000;

/** Google truncates a title past ~600px and a description past ~155 chars. */
const MAX_TITLE = 60;
const MAX_DESCRIPTION = 155;

/**
 * JSON-LD nodes that are deliberately identical on every page. They describe
 * the organisation, the site, the application and its source — one of each
 * exists in the world, and repeating the `@id` is how the graph refers back to
 * it rather than a duplication defect.
 */
const SITE_SCOPED_IDS = new Set([
    'https://happier.dev/#org',
    'https://happier.dev/#site',
    'https://happier.dev/#app',
    'https://happier.dev/#app-ios',
    'https://happier.dev/#app-android',
    'https://happier.dev/#source',
]);

/** Substrings that must survive into every shipped page. */
const REQUIRED_MARKERS = [
    { label: 'canonical link', pattern: /<link[^>]+rel=["']canonical["']/i },
    { label: 'og:image', pattern: /property=["']og:image["']/i },
    { label: 'og:url', pattern: /property=["']og:url["']/i },
    { label: 'JSON-LD block', pattern: /application\/ld\+json/i },
    { label: 'hydration markers', pattern: /<!--\$-->|data-reactroot|<div id="root">\s*</ },
];

/** Text content, the way a non-JS crawler would extract it. */
export function extractText(html) {
    return html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * <RollingNumber> renders a ten-deep digit stack per column once hydrated.
 * Those glyphs are aria-hidden and clipped, but they are text in the DOM, so
 * they must not count toward the crawlable-word budget or the assertion passes
 * on garbage. The prerendered markup no longer contains them (the component
 * renders the plain formatted number until it mounts), so this is a belt-and-
 * braces guard against that regressing.
 */
function stripDigitStacks(text) {
    return text.replace(/(?:\b\d\b[ ,]*){8,}/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Every built HTML file except the intentionally-noindex 404 page. */
async function builtPages(dir, base = '') {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) files.push(...(await builtPages(path.join(dir, entry.name), rel)));
        else if (entry.name.endsWith('.html') && rel !== '404.html') files.push(rel);
    }
    return files;
}

async function waitForBuiltPages(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const pages = await builtPages(DIST).catch(() => []);
        if (pages.length > 0) return pages;
        if (Date.now() >= deadline) return [];
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

function decode(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function pageScopedIds(html) {
    const ids = [];
    for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
        let parsed;
        try {
            parsed = JSON.parse(block[1].replace(/\\u003c/g, '<'));
        } catch {
            // A malformed block is its own failure, reported by the caller.
            return null;
        }
        const nodes = Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed];
        for (const node of nodes) {
            const id = node?.['@id'];
            if (typeof id === 'string' && !SITE_SCOPED_IDS.has(id)) ids.push(id);
        }
    }
    return ids;
}

const failures = [];
const titles = new Map();
const seenIds = new Map();

const pages = await waitForBuiltPages();

if (pages.length === 0) {
    console.error('assert-crawlable: dist/ contains no HTML pages at all.');
    process.exit(1);
}

const report = [];

for (const page of pages.sort()) {
    const file = path.join(DIST, page);
    const html = await readFile(file, 'utf8');
    const where = `dist/${page}`;
    const text = stripDigitStacks(extractText(html));

    if (text.length < MIN_TEXT_CHARS) {
        failures.push(
            `${where}: only ${text.length} chars of crawlable text (need >= ${MIN_TEXT_CHARS}). ` +
                'The prerender step did not run, or the page is a stub.',
        );
    }

    for (const { label, pattern } of REQUIRED_MARKERS) {
        if (!pattern.test(html)) failures.push(`${where}: missing ${label}`);
    }

    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decode(titleMatch[1].trim()) : '';
    if (!title) failures.push(`${where}: no <title>`);
    else if (title.length > MAX_TITLE) {
        failures.push(`${where}: <title> is ${title.length} chars (max ${MAX_TITLE}): "${title}"`);
    }
    if (title) {
        const previous = titles.get(title);
        if (previous) {
            failures.push(
                `${where} and ${previous} share the title "${title}". Two pages competing for ` +
                    'the same query is two pages losing it.',
            );
        } else titles.set(title, where);
    }

    const descMatch = html.match(/<meta name="description" content="([^"]*)"/i);
    const description = descMatch ? decode(descMatch[1]) : '';
    if (!description) failures.push(`${where}: no meta description`);
    else if (description.length > MAX_DESCRIPTION) {
        failures.push(
            `${where}: meta description is ${description.length} chars (max ${MAX_DESCRIPTION}).`,
        );
    }

    const h1s = [...html.matchAll(/<h1\b/gi)].length;
    if (h1s !== 1) failures.push(`${where}: has ${h1s} <h1> elements, expected exactly 1`);

    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
    const expectedUrl =
        page === 'index.html'
            ? 'https://happier.dev/'
            : `https://happier.dev/${page.replace(/\/index\.html$/, '')}`;
    if (canonical && canonical[1] !== expectedUrl) {
        failures.push(
            `${where}: canonical points at ${canonical[1]}, not its own URL ${expectedUrl}.`,
        );
    }

    const ids = pageScopedIds(html);
    if (ids === null) failures.push(`${where}: a JSON-LD block is not valid JSON`);
    else {
        for (const id of ids) {
            const previous = seenIds.get(id);
            if (previous) {
                failures.push(
                    `${where} and ${previous} both declare JSON-LD @id "${id}". A page-scoped ` +
                        'node must be unique per URL or both pages claim to be the same document.',
                );
            } else seenIds.set(id, where);
        }
    }

    report.push({ where, words: text.split(' ').length, chars: text.length, title });
}

if (failures.length > 0) {
    console.error('assert-crawlable FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\n  Fix before deploying — publishing this would zero out happier.dev SEO.');
    process.exit(1);
}

console.log(`assert-crawlable: OK — ${report.length} route(s), all titles and @ids unique.`);
for (const row of report) {
    console.log(`  ${row.where.padEnd(46)} ${String(row.words).padStart(5)} words   ${row.title}`);
}
