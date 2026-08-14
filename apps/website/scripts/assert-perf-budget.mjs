#!/usr/bin/env node
/**
 * Fail the build when the page gets heavier than it is allowed to be.
 *
 * WHY A BUDGET AND NOT A LIGHTHOUSE SCORE
 * Core Web Vitals is a weak Google ranking signal — it is a tie-breaker between
 * pages of comparable relevance, and it has never moved a page more than a
 * position or two. Nothing in here is justified on rankings. It is justified on
 * two things that are not weak at all:
 *
 *   1. CONVERSION. This page's job is to hand an install command to a desktop
 *      browser. Every second of LCP is measured, repeatedly and across
 *      industries, as single-digit-percent bounce. The funnel already loses 44%
 *      of installs to people who open the app once for a median of 2 minutes;
 *      it cannot also lose the desktop visitors who never see the command.
 *   2. THE MOBILE EXPERIENCE OF A 24 MB ARTIFACT. Measured on Slow 4G + 4x CPU,
 *      an iPhone-class client pulled 4,167 KB and had not finished at 15 s.
 *      1,766 of the devices in the funnel are Chinese-locale, on networks where
 *      a Google Fonts round trip is not merely slow. A budget is the only thing
 *      that keeps a one-person project from re-adding a 1.4 MB screenshot.
 *
 * Everything asserted here is a STATIC property of dist/ — no browser, no
 * network, no flake. Run `node scripts/measure-page.mjs` for the real LCP/CLS
 * numbers when you want them; this is the gate.
 *
 *   node scripts/assert-perf-budget.mjs          # gate dist/
 *   node scripts/assert-perf-budget.mjs --json   # machine-readable
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/**
 * THE BUDGET.
 *
 * Each number is "what the page costs after the work in this lane, plus a
 * deliberate margin". They are not aspirational: a build that lands the
 * changes described in HeroBackdrop.tsx / Picture.tsx / fonts.css comes in
 * under every one of them. Raising a number is a decision someone has to make
 * in a diff, which is the entire point.
 */
export const BUDGET = {
    /**
     * Gzipped static entry graph. The 21-route prerendered site hydrates from
     * one route registry, so its localized product/agent copy is currently in
     * the entry; PostHog remains a separately loaded dynamic chunk.
     */
    jsGzipKB: 160,
    /** Gzipped CSS. Today: 7.5 KB. */
    cssGzipKB: 14,
    /** Self-hosted woff2. Three latin variable faces = 121.8 KB. */
    fontKB: 130,
    /**
     * Bytes a cold, dark-theme, 390px-wide phone must download before the hero
     * is complete: HTML + JS + CSS + fonts + the hero backdrop's phone-width
     * AVIF. This is the number that decides whether the install command is ever
     * seen. Measured after this lane: ~1.6 KB + 86 + 8 + 122 + 1.3 = ~219 KB.
     */
    criticalPathKB: 330,
    /** No single shipped image may exceed this. The old desktop.png was 1,386 KB. */
    maxImageKB: 200,
    /** Every image in dist/. Today 22,528 KB; after the pipeline ~5,500 KB. */
    totalImageKB: 7000,
    /** The whole deploy artifact. Today 24 MB. */
    totalDistMB: 9,
};

const kb = (n) => n / 1024;
const fmt = (n) => `${n.toFixed(1)} KB`;

const failures = [];
const notes = [];
function assert(ok, label, actual, limit, unit = 'KB') {
    const line = `${label.padEnd(46)} ${String(actual).padStart(9)} ${unit}  (budget ${limit} ${unit})`;
    if (ok) notes.push(`  ok   ${line}`);
    else failures.push(`  FAIL ${line}`);
}

async function walk(dir, acc = []) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p, acc);
        else acc.push(p);
    }
    return acc;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif|svg)$/i;

async function main() {
    const files = await walk(DIST);
    const sized = await Promise.all(
        files.map(async (f) => ({ f, rel: path.relative(DIST, f), bytes: (await stat(f)).size })),
    );

    // ---- bundles ----------------------------------------------------------
    const manifest = JSON.parse(await readFile(path.join(DIST, '.vite', 'manifest.json'), 'utf8'));
    const entry = manifest['index.html'];
    if (!entry) throw new Error('Vite manifest has no index.html entry');
    const initialKeys = new Set();
    const visitStaticImport = (key) => {
        if (initialKeys.has(key)) return;
        initialKeys.add(key);
        for (const imported of manifest[key]?.imports ?? []) visitStaticImport(imported);
    };
    visitStaticImport('index.html');
    const initialFiles = new Set([...initialKeys].map((key) => manifest[key]?.file).filter(Boolean));
    const js = sized.filter((s) => initialFiles.has(s.rel));
    const css = sized.filter((s) => s.rel.startsWith('assets/') && s.rel.endsWith('.css'));
    const jsGzip = (await Promise.all(js.map(async (s) => gzipSync(await readFile(s.f), { level: 9 }).length)))
        .reduce((a, b) => a + b, 0);
    const cssGzip = (await Promise.all(css.map(async (s) => gzipSync(await readFile(s.f), { level: 9 }).length)))
        .reduce((a, b) => a + b, 0);
    assert(kb(jsGzip) <= BUDGET.jsGzipKB, 'JS (gzip)', fmt(kb(jsGzip)).replace(' KB', ''), BUDGET.jsGzipKB);
    assert(kb(cssGzip) <= BUDGET.cssGzipKB, 'CSS (gzip)', fmt(kb(cssGzip)).replace(' KB', ''), BUDGET.cssGzipKB);

    // ---- fonts ------------------------------------------------------------
    const fonts = sized.filter((s) => /\.(woff2?|ttf|otf)$/i.test(s.rel));
    const fontBytes = fonts.reduce((a, s) => a + s.bytes, 0);
    assert(kb(fontBytes) <= BUDGET.fontKB, 'Self-hosted fonts', fmt(kb(fontBytes)).replace(' KB', ''), BUDGET.fontKB);
    const ttf = fonts.filter((s) => /\.(ttf|otf)$/i.test(s.rel));
    if (ttf.length) failures.push(`  FAIL unhinted ${ttf.length} TTF/OTF font(s) shipped; woff2 only: ${ttf.map((t) => t.rel).join(', ')}`);

    // ---- images -----------------------------------------------------------
    const images = sized.filter((s) => IMAGE_EXT.test(s.rel));
    const imageBytes = images.reduce((a, s) => a + s.bytes, 0);
    assert(kb(imageBytes) <= BUDGET.totalImageKB, 'All images in dist', fmt(kb(imageBytes)).replace(' KB', ''), BUDGET.totalImageKB);
    const oversize = images.filter((s) => kb(s.bytes) > BUDGET.maxImageKB).sort((a, b) => b.bytes - a.bytes);
    for (const o of oversize) {
        failures.push(`  FAIL oversized image  ${fmt(kb(o.bytes)).padStart(10)}  ${o.rel}`);
    }

    // ---- total artifact ---------------------------------------------------
    const total = sized.reduce((a, s) => a + s.bytes, 0);
    assert(kb(total) / 1024 <= BUDGET.totalDistMB, 'dist/ total', (kb(total) / 1024).toFixed(2), BUDGET.totalDistMB, 'MB');

    // ---- head hygiene -----------------------------------------------------
    const html = await readFile(path.join(DIST, 'index.html'), 'utf8');

    if (/<link[^>]+href=["']https?:\/\/fonts\.googleapis\.com/i.test(html)) {
        failures.push('  FAIL render-blocking third-party stylesheet: fonts.googleapis.com is still linked in <head>');
    }
    const thirdParty = [...html.matchAll(/<(?:link|script)[^>]+(?:href|src)=["'](https?:\/\/[^"']+)/gi)]
        .map((m) => new URL(m[1]).host)
        .filter((h) => !h.endsWith('happier.dev'));
    if (thirdParty.length) {
        failures.push(`  FAIL third-party render-path origin(s) in <head>: ${[...new Set(thirdParty)].join(', ')}`);
    }
    if (!/<link[^>]+rel=["']preload["'][^>]+as=["']font["']/i.test(html)) {
        failures.push('  FAIL no <link rel=preload as=font> — the self-hosted face is discovered a round trip late');
    }
    if (!/<link[^>]+rel=["']preload["'][^>]+as=["']image["'][^>]+imagesrcset=/i.test(html)) {
        failures.push('  FAIL no responsive <link rel=preload as=image imagesrcset> for the LCP backdrop');
    }

    // ---- every <img> in the prerendered HTML must reserve its box ----------
    const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    const unsized = imgTags.filter((t) => !/\bwidth=/.test(t) || !/\bheight=/.test(t));
    if (unsized.length) {
        failures.push(
            `  FAIL ${unsized.length} prerendered <img> without width+height (layout shift on load):\n` +
                unsized.slice(0, 5).map((t) => `         ${t.slice(0, 120)}`).join('\n'),
        );
    }
    const eager = imgTags.filter((t) => !/loading=["']lazy["']/.test(t));
    if (eager.length > 1) {
        failures.push(
            `  FAIL ${eager.length} eager <img> in the prerendered HTML; exactly one (the LCP backdrop) may be eager`,
        );
    }

    // ---- critical path ----------------------------------------------------
    // HTML + gzipped JS/CSS + fonts + the phone-width LCP candidate.
    const htmlGz = gzipSync(Buffer.from(html), { level: 9 }).length;
    const lcpCandidate =
        images
            .filter((s) => /_opt\/background5_black[^/]*-640\.avif$/.test(s.rel))
            .map((s) => s.bytes)[0] ?? 0;
    const critical = htmlGz + jsGzip + cssGzip + fontBytes + lcpCandidate;
    assert(kb(critical) <= BUDGET.criticalPathKB, 'Cold phone critical path', fmt(kb(critical)).replace(' KB', ''), BUDGET.criticalPathKB);

    // ---- report -----------------------------------------------------------
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ jsGzip, cssGzip, fontBytes, imageBytes, total, critical, failures }, null, 2));
    } else {
        for (const n of notes) console.log(n);
        if (failures.length) {
            console.error('\nPERFORMANCE BUDGET EXCEEDED\n');
            for (const f of failures) console.error(f);
            console.error(
                '\nRaising a number in BUDGET (scripts/assert-perf-budget.mjs) is a deliberate\n' +
                    'decision. Do it in the same diff as the thing that needs it, with a reason.\n',
            );
        } else {
            console.log('\nAll performance budgets met.');
        }
    }
    if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
