#!/usr/bin/env node
/**
 * The website's image pipeline. Runs in the build, not by hand.
 *
 * WHY THIS EXISTS AS A BUILD STEP
 * scripts/optimize-feature-images.mjs (which this replaces) was a manual
 * `yarn optimize:images` that read from apps/website/assets/ — a directory that
 * is 111 MB and is NOT what the page loads. Nothing enforced that its output
 * existed, nothing enforced that it was current, and nothing covered the two
 * images that actually decide the page's weight: the 6144x4096 hero backdrops
 * and the 3248x2000 desktop screenshot. Those three files alone are 2.9 MB of
 * the 4.1 MB first load. A pipeline that can be skipped is a pipeline that has
 * already regressed.
 *
 * WHAT IT DOES
 *   for every entry in scripts/imageRecipes.mjs:
 *     encode AVIF + WebP at each declared width  -> public/images/_opt/
 *     encode ONE fallback (jpeg/png) at fallbackWidth
 *   then write src/data/generatedImages.ts — a typed manifest carrying the
 *   intrinsic width/height (so every <img> can reserve its box and CLS is
 *   structurally impossible) and ready-made srcSet strings.
 *
 * IT IS INCREMENTAL. A content hash of the source + the recipe is stored in
 * public/images/_opt/.manifest.json; unchanged inputs are skipped, so the
 * common `vite build` pays ~0ms. Pass --force to re-encode everything.
 *
 * The _opt directory is generated and gitignored; the manifest .ts is
 * committed so a typecheck without a prior image build still passes.
 */
import { readFile, writeFile, mkdir, stat, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import { RECIPES } from './imageRecipes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT_DIR = path.join(PUBLIC, 'images', '_opt');
const CACHE_FILE = path.join(OUT_DIR, '.manifest.json');
const TS_OUT = path.join(ROOT, 'src', 'data', 'generatedImages.ts');

const FORCE = process.argv.includes('--force');
const CHECK = process.argv.includes('--check');

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/** Stable identity for "this source, encoded by this recipe, by this encoder". */
async function recipeHash(recipe, srcPath) {
    const bytes = await readFile(srcPath);
    return createHash('sha256')
        .update(bytes)
        .update(JSON.stringify({ ...recipe, v: 2, sharp: sharp.versions.vips }))
        .digest('hex')
        .slice(0, 16);
}

async function loadCache() {
    try {
        return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    } catch {
        return {};
    }
}

/** `images/demo/screenshots/mobile.png` -> `demo-screenshots-mobile` */
function flatName(src) {
    return src.replace(/^images\//, '').replace(/\.[^.]+$/, '').replace(/[/]/g, '-');
}

async function encodeOne(recipe, srcPath) {
    const meta = await sharp(srcPath).metadata();
    const base = flatName(recipe.src);
    const formats = recipe.formats ?? ['avif', 'webp'];
    const emitted = [];

    // Never upscale: a width above the source is a bigger file for no pixels.
    const widths = recipe.widths.filter((w) => w <= (meta.width ?? Infinity));
    if (widths.length === 0) widths.push(meta.width);

    for (const w of widths) {
        // lanczos3 is sharp's default kernel, named here because downscaling UI
        // screenshots is the whole job: a softer kernel reads as a blurry panel
        // long before the codec gets a chance to.
        const pipe = sharp(srcPath).resize({ width: w, withoutEnlargement: true, kernel: 'lanczos3' });
        for (const fmt of formats) {
            const file = `${base}-${w}.${fmt}`;
            const buf =
                fmt === 'avif'
                    ? await pipe
                          .clone()
                          .avif({
                              quality: recipe.quality?.avif ?? 50,
                              effort: 6,
                              // 4:4:4, not 4:2:0. Chroma subsampling throws away
                              // three quarters of the colour resolution, which is
                              // invisible on photographs and very visible on what
                              // this site actually ships: screenshots full of
                              // coloured syntax highlighting, thin UI strokes and
                              // small text on dark panels. 4:2:0 is what made the
                              // panel art look smeared even where the pixel
                              // dimensions were right.
                              chromaSubsampling: '4:4:4',
                          })
                          .toBuffer()
                    : await pipe.clone().webp({ quality: recipe.quality?.webp ?? 80, effort: 6 }).toBuffer();
            await writeFile(path.join(OUT_DIR, file), buf);
            emitted.push({ file, w, fmt, bytes: buf.length });
        }
    }

    // One fallback for browsers with neither AVIF nor WebP (Safari < 14 /
    // very old Android WebView). Single width — this path is a rounding error
    // in traffic and does not deserve a srcset.
    const fbW = Math.min(recipe.fallbackWidth ?? widths.at(-1), meta.width ?? Infinity);
    const fbFmt = recipe.fallbackFormat ?? (meta.hasAlpha ? 'png' : 'jpeg');
    const fbFile = `${base}-${fbW}.${fbFmt === 'jpeg' ? 'jpg' : 'png'}`;
    const fbPipe = sharp(srcPath).resize({ width: fbW, withoutEnlargement: true });
    const fbBuf =
        fbFmt === 'jpeg'
            ? await fbPipe.jpeg({ quality: 74, mozjpeg: true }).toBuffer()
            : await fbPipe.png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
    await writeFile(path.join(OUT_DIR, fbFile), fbBuf);
    emitted.push({ file: fbFile, w: fbW, fmt: fbFmt, bytes: fbBuf.length, fallback: true });

    // Intrinsic aspect of the SOURCE, carried into the manifest so every <img>
    // gets width/height and reserves its box before a byte of image arrives.
    return { emitted, width: meta.width, height: meta.height, srcBytes: (await stat(srcPath)).size };
}

function srcSet(emitted, fmt) {
    return emitted
        .filter((e) => e.fmt === fmt && !e.fallback)
        .sort((a, b) => a.w - b.w)
        .map((e) => `/images/_opt/${e.file} ${e.w}w`)
        .join(', ');
}

function renderManifest(entries) {
    const body = entries
        .map(
            (e) => `    ${e.id}: {
        width: ${e.width},
        height: ${e.height},
        sizes: ${JSON.stringify(e.sizes)},
        avif: ${JSON.stringify(e.avif)},
        webp: ${JSON.stringify(e.webp)},
        fallback: ${JSON.stringify(e.fallback)},
    },`,
        )
        .join('\n');

    return `// GENERATED by scripts/optimize-images.mjs — do not edit.
// Run \`yarn optimize:images\` (or any \`yarn build\`) to regenerate.
//
// Every entry carries the SOURCE's intrinsic width/height. <Picture> writes
// those onto the <img>, which is what makes the layout box exist before the
// bytes do — the reason this page cannot shift.

export type OptimizedImage = {
    /** Intrinsic width of the source, for the width/height attribute pair. */
    width: number;
    height: number;
    /** The \`sizes\` attribute declared in scripts/imageRecipes.mjs. */
    sizes: string;
    avif: string;
    webp: string;
    /** Single-width last resort for browsers with neither AVIF nor WebP. */
    fallback: string;
};

export const IMAGES = {
${body}
} as const satisfies Record<string, OptimizedImage>;

export type ImageId = keyof typeof IMAGES;
`;
}

async function main() {
    await mkdir(OUT_DIR, { recursive: true });
    const cache = FORCE ? {} : await loadCache();
    const nextCache = {};
    const entries = [];
    let encoded = 0;
    let srcTotal = 0;
    let bestTotal = 0;

    for (const recipe of RECIPES) {
        const srcPath = path.join(PUBLIC, recipe.src);
        let hash;
        try {
            hash = await recipeHash(recipe, srcPath);
        } catch {
            console.error(`  ! missing source: public/${recipe.src}  (recipe ${recipe.id})`);
            process.exitCode = 1;
            continue;
        }

        const cached = cache[recipe.id];
        let result;
        if (cached && cached.hash === hash && (await outputsExist(cached.emitted))) {
            result = cached;
        } else {
            if (CHECK) {
                console.error(`  ! stale: ${recipe.id} (public/${recipe.src}) — run \`yarn optimize:images\``);
                process.exitCode = 1;
                continue;
            }
            result = { hash, ...(await encodeOne(recipe, srcPath)) };
            encoded += 1;
        }
        nextCache[recipe.id] = result;

        const avif = srcSet(result.emitted, 'avif');
        const webp = srcSet(result.emitted, 'webp');
        const fb = result.emitted.find((e) => e.fallback);
        entries.push({
            id: recipe.id,
            width: result.width,
            height: result.height,
            sizes: recipe.sizes,
            avif,
            webp,
            fallback: `/images/_opt/${fb.file}`,
        });

        const smallestAvif = Math.min(...result.emitted.filter((e) => e.fmt === 'avif').map((e) => e.bytes));
        const largestAvif = Math.max(...result.emitted.filter((e) => e.fmt === 'avif').map((e) => e.bytes));
        srcTotal += result.srcBytes;
        bestTotal += largestAvif;
        console.log(
            `  ${recipe.id.padEnd(26)} ${String(result.width).padStart(5)}px src ${kb(result.srcBytes).padStart(10)}` +
                ` -> avif ${kb(smallestAvif).padStart(9)} … ${kb(largestAvif).padStart(9)}`,
        );
    }

    await writeFile(CACHE_FILE, JSON.stringify(nextCache, null, 0));
    const ts = renderManifest(entries);
    const prev = await readFile(TS_OUT, 'utf8').catch(() => '');
    if (prev !== ts) {
        if (CHECK) {
            console.error('  ! src/data/generatedImages.ts is out of date — run `yarn optimize:images`');
            process.exitCode = 1;
        } else {
            await writeFile(TS_OUT, ts);
        }
    }

    await pruneOrphans(new Set(Object.values(nextCache).flatMap((r) => r.emitted.map((e) => e.file))));

    console.log(
        `\n${entries.length} images (${encoded} re-encoded). ` +
            `Widest-variant total ${kb(bestTotal)} vs ${kb(srcTotal)} of sources ` +
            `(${(srcTotal / Math.max(bestTotal, 1)).toFixed(1)}x).`,
    );
}

async function outputsExist(emitted) {
    for (const e of emitted) {
        try {
            await stat(path.join(OUT_DIR, e.file));
        } catch {
            return false;
        }
    }
    return true;
}

/** Delete variants no recipe claims, so a renamed source cannot leave 2 MB behind. */
async function pruneOrphans(keep) {
    for (const f of await readdir(OUT_DIR)) {
        if (f.startsWith('.')) continue;
        if (!keep.has(f)) await rm(path.join(OUT_DIR, f));
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
