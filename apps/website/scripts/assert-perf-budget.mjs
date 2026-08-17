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
import { readFileSync } from 'node:fs';
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
     * WHAT ONE VISITOR DOWNLOADS — the heaviest single route, gzipped. NOT the
     * sum over routes.
     *
     * The site used to ship one bundle for all 21 pages, so "the JS" was one
     * number and summing was the same as measuring. It now ships one entry per
     * prerendered page (src/entries/, vite.config.ts), and a sum would be a
     * budget that gets WORSE every time a page is split off — the opposite of
     * the thing being optimised, and a number nobody could act on. Nobody
     * downloads the sum. Somebody downloads the worst page, so that is the gate:
     * the entry chunk plus its transitive STATIC imports (the shared react
     * vendor chunk, the shared shell), which is exactly the bytes that must
     * arrive before that page can hydrate.
     *
     * PostHog remains a separately loaded dynamic chunk and is excluded by
     * construction — only `imports` is walked, never `dynamicImports`.
     *
     * 160 is the pre-split ceiling, held unchanged so this lane cannot claim a
     * win it has not measured. RATCHET IT DOWN to just above the real
     * "heaviest route" number the first build after the split reports — a
     * ceiling 2x above the artifact is not a budget.
     */
    jsGzipKB: 160,
    /**
     * The same ceiling for a page in one of the nine non-English languages.
     *
     * Higher than jsGzipKB because a localised entry carries its locale's
     * overlay — the translated catalogue — and English pages carry none. That is
     * the deliberate shape: the alternative was one glob that shipped all nine
     * languages to everybody, which measured 570 KB on every route.
     *
     * Set just above the current worst (Russian, the longest of the nine) so it
     * still catches a regression. It is NOT a target: the honest number is far
     * lower, and reaching it means giving a page only the strings it renders
     * instead of the whole catalogue. See the shared-floor note in this file.
     */
    jsGzipLocalisedKB: 230,
    /** Gzipped CSS. Today: 7.5 KB. */
    cssGzipKB: 14,
    /** Self-hosted woff2. Three latin variable faces = 121.8 KB. */
    fontKB: 130,
    /**
     * Bytes a cold, dark-theme, 390px-wide phone must download before the hero
     * is complete: HTML + JS + CSS + fonts + the hero backdrop's phone-width
     * AVIF. This is the number that decides whether the install command is ever
     * seen. Measured after this lane: ~1.6 KB + 86 + 8 + 122 + 1.3 = ~219 KB.
     *
     * The JS term is the HEAVIEST ROUTE's, not the homepage's — see the
     * computation below for why the ceiling is deliberately a composite.
     */
    /**
     * NOT raised for the locales, because it did not need to be. The JS term in
     * this composite is the heaviest DEFAULT-locale route, and English pages
     * carry no overlay — so the cold path came back to 309 KB once the budget
     * stopped folding localised entries into the same number. A localised page
     * is heavier and is gated by BUDGET.jsGzipLocalisedKB instead.
     */
    criticalPathKB: 330,
    /**
     * No single shipped image may exceed this. The old desktop.png was 1,386 KB.
     *
     * Raised from 200 when the feature art was fixed. The pipeline had been
     * pointed at the 1000px @1x sources, so `widths.filter(w <= meta.width)`
     * silently dropped the 1400 and 1800 variants and the largest panel image
     * anyone could receive was 900px — half resolution on every 2x display.
     * With 2000px sources the declared widths are actually emitted, and a
     * 1800px WebP of a dense UI screenshot lands around 240 KB.
     *
     * This ceiling does not describe what a visitor downloads. `sizes` is
     * `min(61vw, 890px)`, so a phone picks the 480 or 720px variant and the
     * 1800px file is only ever fetched by a 2x desktop that asked for it. The
     * budget that governs perceived speed is criticalPathKB above, which is
     * unchanged and still passing.
     */
    maxImageKB: 280,
    /**
     * Every image in dist/. Today 22,528 KB; after the pipeline ~5,500 KB.
     *
     * Raised from 7000 for the same fix, plus two new feature panels
     * (sessions-team, what-needs-you) and a lossless backdrop source. This is a
     * disk-hygiene number, not a user-experienced one: no visitor loads every
     * image on the site, every panel is lazy, and the per-route cost is bounded
     * by criticalPathKB. Sized to the current total with room for a couple more
     * panels, not to a round figure.
     */
    totalImageKB: 11000,
    /** The whole deploy artifact. Today 24 MB. */
    /**
     * Raised from 9 when the site went from 21 pages to 210.
     *
     * Ten languages x 21 routes is 9.26 MB of prerendered HTML on its own, and
     * that HTML is the product: it is what a crawler reads and what a reader
     * sees before any JavaScript runs. The number is sized to the current 19.17
     * MB with room for a couple more pages, not to a round figure — a budget
     * with slack in it stops being a budget.
     *
     * Raised again from 22 when the feature art started emitting the 1400 and
     * 1800px variants it had always declared, and two panels were added. The
     * HTML term is unchanged; the growth is all lazily-fetched raster.
     */
    totalDistMB: 26,
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
    const byRel = new Map(sized.map((s) => [s.rel, s]));
    const gzipCache = new Map();
    /** Gzipped size of one emitted file, measured once however many routes share it. */
    const gzipOf = async (rel) => {
        if (gzipCache.has(rel)) return gzipCache.get(rel);
        const hit = byRel.get(rel);
        const bytes = hit ? gzipSync(await readFile(hit.f), { level: 9 }).length : 0;
        gzipCache.set(rel, bytes);
        return bytes;
    };

    const manifest = JSON.parse(await readFile(path.join(DIST, '.vite', 'manifest.json'), 'utf8'));

    /**
     * The chunks a page must have before it hydrates: its entry, plus every
     * chunk that entry STATICALLY imports, transitively.
     *
     * `dynamicImports` is deliberately not followed — that is what keeps
     * lazily loaded analytics out of the first-paint number, and it is the same
     * walk scripts/prerender.mjs uses to write the modulepreloads, so the gate
     * measures precisely the set of files the HTML asks for.
     */
    const closureOf = (key, seen = new Set()) => {
        if (seen.has(key)) return seen;
        seen.add(key);
        for (const imported of manifest[key]?.imports ?? []) closureOf(imported, seen);
        return seen;
    };
    const filesOf = (key) =>
        new Set([...closureOf(key)].map((k) => manifest[k]?.file).filter(Boolean));

    /**
     * ONE ENTRY PER PRERENDERED PAGE. Not counted, not hard-coded: read off the
     * manifest, so a new route or a new locale is measured the day it lands.
     */
    const routeEntryKeys = Object.keys(manifest).filter(
        (k) => manifest[k].isEntry && k.startsWith('src/entries/'),
    );
    if (!routeEntryKeys.length) {
        throw new Error(
            'Vite manifest has no src/entries/* entries. The per-route bundle split is not ' +
                'in the build — check rollupOptions.input in vite.config.ts.',
        );
    }

    /**
     * MAX OVER ENTRIES, NOT SUM. See BUDGET.jsGzipKB: no visitor downloads every
     * route, so the sum measures nothing anyone experiences and would rise on
     * every split. The gate is the worst page somebody can land on.
     */
    const perEntry = [];
    for (const key of routeEntryKeys) {
        const files = filesOf(key);
        let bytes = 0;
        for (const rel of files) bytes += await gzipOf(rel);
        perEntry.push({ key, route: key.replace(/^src\/entries\/|\.tsx$/g, ''), files, bytes });
    }
    perEntry.sort((a, b) => b.bytes - a.bytes);

    /**
     * ENGLISH AND LOCALISED ROUTES ARE BUDGETED SEPARATELY, on purpose.
     *
     * A localised entry statically imports its own overlay JSON — that is how
     * src/i18n/siteData.ts gets translations without a glob that would put all
     * nine languages in every visitor's download. The overlay is real weight:
     * ~200 KB raw for Russian, and it lands in that locale's chunk.
     *
     * Folding both into one number would mean either failing the build on a cost
     * that is understood and accepted, or raising the English ceiling to
     * accommodate translations English readers never download. Neither is honest.
     * So `/` and every other default-locale page keeps the pre-translation
     * ceiling, and localised pages get their own — visible, separately, so a
     * regression in one cannot hide inside the other.
     *
     * The way to lower the localised number is not here: it is to stop shipping
     * the whole catalogue to a page that renders a fraction of it. See the note
     * on the shared floor below — the same `siteData.ts` import graph is why.
     */
    const localePrefixes = [...readFileSync(new URL('../src/i18n/locales.ts', import.meta.url), 'utf8')
        .matchAll(/pathPrefix:\s*'\/([^']+)'/g)].map((m) => m[1]);
    const isLocalised = (route) =>
        localePrefixes.some((p) => route === p || route.startsWith(`${p}--`));

    const defaultEntries = perEntry.filter((e) => !isLocalised(e.route));
    const localisedEntries = perEntry.filter((e) => isLocalised(e.route));

    const heaviest = defaultEntries[0] ?? perEntry[0];
    const lightest = defaultEntries[defaultEntries.length - 1] ?? perEntry[perEntry.length - 1];
    const jsGzip = heaviest.bytes;

    /**
     * REACT MUST BE EMITTED ONCE, NOT ONCE PER ROUTE.
     *
     * This is the failure mode that would make the split worse than no split:
     * 21 entries each carrying their own react-dom is a site that got slower for
     * everyone while the report showed smaller numbers per page. vite.config.ts
     * pins react/react-dom/scheduler to a `vendor-react` chunk; this is the
     * check that it worked, and that every page really does share the same one.
     */
    const vendorFiles = sized.filter((s) => /^assets\/vendor-react-[^/]*\.js$/.test(s.rel));
    if (vendorFiles.length !== 1) {
        failures.push(
            `  FAIL react is emitted in ${vendorFiles.length} chunk(s), expected exactly 1: ` +
                `${vendorFiles.map((v) => v.rel).join(', ') || '(none found)'} — check ` +
                'manualChunks in vite.config.ts',
        );
    } else {
        const vendorRel = vendorFiles[0].rel;
        const missing = perEntry.filter((e) => !e.files.has(vendorRel));
        if (missing.length) {
            failures.push(
                `  FAIL ${missing.length} route entr${missing.length === 1 ? 'y does' : 'ies do'} not ` +
                    `share ${vendorRel}: ${missing.map((m) => m.route).join(', ')}`,
            );
        } else {
            notes.push(
                `  ok   react shared by all ${perEntry.length} route entries in one chunk  ${vendorRel}`,
            );
        }
    }

    /**
     * The chunks EVERY page pays for. Not budgeted — reported, because it is the
     * number that tells you whether the split is doing anything: a shared floor
     * equal to the heaviest route means nothing was actually split.
     *
     * IT WILL NOT DROP BELOW THE SITE COPY UNTIL src/i18n/siteData.ts CHANGES.
     * That module does `import * as … from '../data/…'` for all fourteen data
     * modules and exposes them through one `MODULES` record, and
     * src/sections/Footer.tsx (line 108) calls `useSiteData()` — so every page on
     * the site, having a footer, statically reaches every page's copy. Splitting
     * by route cannot fix that: it is one module, in the shared chunk, by
     * construction. Whoever lowers this number does it there, not here.
     */
    const sharedRels = [...heaviest.files].filter((rel) => perEntry.every((e) => e.files.has(rel)));
    let sharedGzip = 0;
    for (const rel of sharedRels) sharedGzip += await gzipOf(rel);

    const css = sized.filter((s) => s.rel.startsWith('assets/') && s.rel.endsWith('.css'));
    const cssGzip = (await Promise.all(css.map(async (s) => gzipSync(await readFile(s.f), { level: 9 }).length)))
        .reduce((a, b) => a + b, 0);
    assert(
        kb(jsGzip) <= BUDGET.jsGzipKB,
        `JS (gzip, worst route: ${heaviest.route})`,
        fmt(kb(jsGzip)).replace(' KB', ''),
        BUDGET.jsGzipKB,
    );
    if (localisedEntries.length) {
        const worstLocalised = localisedEntries[0];
        assert(
            kb(worstLocalised.bytes) <= BUDGET.jsGzipLocalisedKB,
            `JS (gzip, worst localised route: ${worstLocalised.route})`,
            fmt(kb(worstLocalised.bytes)).replace(' KB', ''),
            BUDGET.jsGzipLocalisedKB,
        );
    }
    notes.push(
        `  ..   ${`JS (gzip, best route: ${lightest.route})`.padEnd(46)} ` +
            `${fmt(kb(lightest.bytes)).replace(' KB', '').padStart(9)} KB  (no budget)`,
    );
    notes.push(
        `  ..   ${'JS (gzip, shared by every route)'.padEnd(46)} ` +
            `${fmt(kb(sharedGzip)).replace(' KB', '').padStart(9)} KB  (no budget)`,
    );
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
    //
    // The JS term is the WORST route's, not the homepage's, while the image term
    // is the homepage's hero backdrop — deliberately a composite upper bound
    // rather than one real page. It is a ceiling, and a ceiling that tracks the
    // heaviest thing on the site is the one worth defending; pinning it to `/`
    // would let a 300 KB /agents/<slug> pass a gate named "cold phone".
    const htmlGz = gzipSync(Buffer.from(html), { level: 9 }).length;
    const lcpCandidate =
        images
            .filter((s) => /_opt\/background5_black[^/]*-640\.avif$/.test(s.rel))
            .map((s) => s.bytes)[0] ?? 0;
    const critical = htmlGz + jsGzip + cssGzip + fontBytes + lcpCandidate;
    assert(kb(critical) <= BUDGET.criticalPathKB, 'Cold phone critical path', fmt(kb(critical)).replace(' KB', ''), BUDGET.criticalPathKB);

    // ---- report -----------------------------------------------------------
    if (process.argv.includes('--json')) {
        console.log(
            JSON.stringify(
                {
                    // `jsGzip` keeps its name and changes its meaning: it is now
                    // the heaviest single route, which is what one visitor
                    // downloads. `jsGzipByRoute` is the whole distribution, so a
                    // regression can be attributed to a page rather than to
                    // "the bundle".
                    jsGzip,
                    jsGzipWorstRoute: heaviest.route,
                    jsGzipSharedByEveryRoute: sharedGzip,
                    jsGzipByRoute: Object.fromEntries(perEntry.map((e) => [e.route, e.bytes])),
                    cssGzip,
                    fontBytes,
                    imageBytes,
                    total,
                    critical,
                    failures,
                },
                null,
                2,
            ),
        );
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
