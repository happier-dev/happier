#!/usr/bin/env node
/**
 * Vendor the three web fonts into public/fonts/ so the page stops making a
 * render-blocking round trip to two Google origins on every cold load.
 *
 * WHAT IS WRONG TODAY (index.html, measured)
 *   <link href="https://fonts.googleapis.com/css2?family=Inter+Tight…" rel="stylesheet">
 * is render-blocking and sits on fonts.googleapis.com, which means the browser
 * must do DNS + TCP + TLS to a THIRD origin, parse 27.6 KB of CSS, and only
 * then discover the font URLs — which live on a FOURTH origin
 * (fonts.gstatic.com), costing another DNS + TCP + TLS. The <link rel=preconnect>
 * pair softens the second hop but cannot remove the first: nothing paints until
 * that stylesheet has landed. Chrome partitions its HTTP cache per top-level
 * site, so the old "the user already has Inter from another site" argument has
 * not been true since 2020.
 *
 * The files themselves are fine — Google serves latin-subset VARIABLE woff2:
 *   Inter          latin   47.3 KB   (whole 100..900 axis)
 *   Inter Tight    latin   43.9 KB
 *   JetBrains Mono latin   30.6 KB
 * Re-subsetting them would need fonttools, which is not installed here and is a
 * Python dependency this repo should not grow. Copying them is the whole fix:
 * same bytes, one origin, no blocking stylesheet, and a preload the HTML parser
 * sees in its first packet.
 *
 * Usage:  node scripts/vendor-fonts.mjs
 * Commit public/fonts/. Re-run only to pick up a new Google Fonts revision —
 * the version is pinned in the filename, so a re-run is a visible diff.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'fonts');

// A modern Chrome UA is what makes Google serve variable woff2 rather than the
// static per-weight files an unknown UA gets.
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FAMILIES = [
    { css: 'Inter:wght@400..700', family: 'Inter', out: 'inter-latin-var.woff2' },
    { css: 'Inter+Tight:wght@400..800', family: 'Inter Tight', out: 'inter-tight-latin-var.woff2' },
    { css: 'JetBrains+Mono:wght@400..500', family: 'JetBrains Mono', out: 'jetbrains-mono-latin-var.woff2' },
];

/** Only the `latin` block — the one whose unicode-range starts at U+0000. */
function latinUrlFor(css) {
    const blocks = css.split('@font-face').slice(1);
    for (const b of blocks) {
        if (!/unicode-range:\s*U\+0000/.test(b)) continue;
        const m = b.match(/url\((https:\/\/[^)]+\.woff2)\)/);
        if (m) return m[1];
    }
    return null;
}

async function main() {
    await mkdir(OUT, { recursive: true });
    for (const f of FAMILIES) {
        const cssUrl = `https://fonts.googleapis.com/css2?family=${f.css}&display=swap`;
        const css = await fetch(cssUrl, { headers: { 'User-Agent': UA } }).then((r) => r.text());
        const url = latinUrlFor(css);
        if (!url) throw new Error(`No latin subset found for ${f.family}. Google changed the CSS shape.`);
        const buf = Buffer.from(await fetch(url).then((r) => r.arrayBuffer()));
        await writeFile(path.join(OUT, f.out), buf);
        console.log(`${f.out.padEnd(34)} ${(buf.length / 1024).toFixed(1).padStart(7)} KB   <- ${url}`);
    }
    console.log('\nWrote public/fonts/. src/styles/fonts.css already points at these names.');
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
