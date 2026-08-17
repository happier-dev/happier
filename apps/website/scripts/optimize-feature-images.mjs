#!/usr/bin/env node
/**
 * Optimize feature-showcase art for the website.
 *
 * Reads full-resolution PNGs from  apps/website/assets/features/*.png
 * and emits responsive, optimized variants into
 *   apps/website/public/images/features/:
 *     <name>.png      (@1x, <=1000w, fallback)
 *     <name>@2x.png   (@2x, <=2000w, fallback)
 *     <name>.webp     (@1x, smaller)
 *     <name>@2x.webp  (@2x, smaller)
 *
 * The renderer (the feature panels in src/sections/AlternatingFeatures.tsx)
 * prefers .webp and falls back to .png; a missing file simply falls back to the
 * generic device mockup, so it is always safe to run this — or to reference art
 * that has not been generated yet.
 *
 * Sources are expected to be TRANSPARENT cut-outs of real app UI: the panel
 * supplies the background and the shadow, so any baked-in plate reads as a
 * sticker pasted onto it. Alpha is carried through to both outputs.
 *
 * Workflow: drop a full-res PNG into apps/website/assets/features/, named after
 * the image BASENAME referenced in src/data/features.ts (the path basename, NOT
 * the feature id) — e.g. anywhere.png, existing-sessions.png, terminal.png,
 * one-tap-away.png, subscriptions.png, voice.png — then run:
 *     npm run optimize:images        # from apps/website
 *
 * sharp is declared in this package's devDependencies (and hoisted from the
 * monorepo root).
 */
import { readdir, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // apps/website
const SRC_DIR = path.join(root, 'assets', 'features');
const OUT_DIR = path.join(root, 'public', 'images', 'features');

const WIDTH_1X = 1000;
const WIDTH_2X = 2000;
const WEBP_QUALITY = 82;

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

async function main() {
    let entries;
    try {
        entries = (await readdir(SRC_DIR)).filter((f) => /\.png$/i.test(f));
    } catch {
        console.error(`No source dir at ${SRC_DIR}.\nDrop full-res PNGs there (named <feature-id>.png) and re-run.`);
        return;
    }
    if (entries.length === 0) {
        console.log(`No source PNGs in ${SRC_DIR}. Nothing to do.`);
        return;
    }
    await mkdir(OUT_DIR, { recursive: true });

    let failures = 0;
    for (const file of entries) {
        const name = file.replace(/\.png$/i, '');
        const srcPath = path.join(SRC_DIR, file);
        try {
            const meta = await sharp(srcPath).metadata();
            const targets = [
                { w: Math.min(WIDTH_1X, meta.width ?? WIDTH_1X), png: `${name}.png`, webp: `${name}.webp` },
                { w: Math.min(WIDTH_2X, meta.width ?? WIDTH_2X), png: `${name}@2x.png`, webp: `${name}@2x.webp` },
            ];
            for (const t of targets) {
                const pipeline = sharp(srcPath).resize({ width: t.w, withoutEnlargement: true });
                await pipeline.clone().png({ compressionLevel: 9, palette: false }).toFile(path.join(OUT_DIR, t.png));
                await pipeline.clone().webp({ quality: WEBP_QUALITY }).toFile(path.join(OUT_DIR, t.webp));
                const pngSize = (await stat(path.join(OUT_DIR, t.png))).size;
                const webpSize = (await stat(path.join(OUT_DIR, t.webp))).size;
                console.log(`  ${t.png.padEnd(42)} png ${kb(pngSize).padStart(8)}   webp ${kb(webpSize).padStart(8)}`);
            }
            console.log(`✓ ${name}  (source ${meta.width}x${meta.height})`);
        } catch (err) {
            failures += 1;
            console.error(`✗ ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    console.log(`\nDone → ${OUT_DIR}${failures ? `  (${failures} failed)` : ''}`);
    if (failures) process.exitCode = 1;
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
