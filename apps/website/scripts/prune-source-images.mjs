#!/usr/bin/env node
/**
 * Keep source art in public/ for the encoder, but never ship those originals.
 *
 * Vite copies public/ verbatim. Without this gate every optimized AVIF/WebP is
 * deployed alongside the 22 MB of PNG/JPEG sources it replaces. The script
 * first rejects any built reference to a raw raster, then removes only the
 * dist/images files that are neither generated variants nor explicit public
 * metadata assets.
 */
import { readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const IMAGES = path.join(DIST, 'images');
const ALLOWED_RAW = new Set(['favicon.png', 'og.png']);
const TEXT_EXT = /\.(?:css|html|js|json|txt|xml)$/i;
const RAW_REFERENCE = /\/images\/(?!_opt\/)([^"'()\s]+\.(?:png|jpe?g|webp))/gi;

async function walk(dir, files = []) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file, files);
        else files.push(file);
    }
    return files;
}

const files = await walk(DIST);
const invalid = new Set();
for (const file of files.filter((candidate) => TEXT_EXT.test(candidate))) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(RAW_REFERENCE)) {
        if (!ALLOWED_RAW.has(match[1])) invalid.add(match[0]);
    }
}

if (invalid.size > 0) {
    throw new Error(
        'Built output still references unoptimized raster sources:\n' +
            [...invalid].sort().map((value) => `  ${value}`).join('\n'),
    );
}

let removed = 0;
for (const file of await walk(IMAGES)) {
    const relative = path.relative(IMAGES, file);
    if (relative.startsWith(`_opt${path.sep}`) || ALLOWED_RAW.has(relative)) continue;
    await rm(file);
    removed += 1;
}

console.log(`prune-source-images: removed ${removed} source/legacy image files from dist/.`);
