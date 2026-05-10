#!/usr/bin/env node
// @ts-check
/**
 * Build the release-notes asset bundle that will be published to
 * `happier-dev/happier-assets` under the rolling `release-notes` tag.
 *
 * Inputs:
 *   - apps/ui/sources/changelog/releaseNotes/manifest.generated.json (committed)
 *   - apps/ui/release-notes/assets/<releaseId>/**                    (authored)
 *
 * Outputs (in --out-dir):
 *   - release-notes__manifest.json        (copy of generated manifest)
 *   - release-notes__assets-index.json    (with sha256 + size for each asset)
 *   - release-notes__<releaseId>__<path>  (one file per authored asset, prefixed)
 *
 * The publish step uploads everything in --out-dir verbatim using `gh release upload --clobber`.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';

const REPO_ROOT = resolve(new URL('../../../..', import.meta.url).pathname);
const MANIFEST_PATH = join(REPO_ROOT, 'apps/ui/sources/changelog/releaseNotes/manifest.generated.json');
const AUTHORED_ASSETS_DIR = join(REPO_ROOT, 'apps/ui/release-notes/assets');

function parseFlags(argv) {
    const map = new Map();
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const eq = arg.indexOf('=');
        if (eq !== -1) {
            map.set(arg.slice(2, eq), arg.slice(eq + 1));
        } else {
            map.set(arg.slice(2), argv[i + 1] ?? '');
            i += 1;
        }
    }
    return map;
}

async function listFilesRecursive(rootDir) {
    const out = [];
    if (!existsSync(rootDir)) return out;
    async function walk(dir) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else {
                out.push(full);
            }
        }
    }
    await walk(rootDir);
    return out;
}

function inferContentType(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    switch (ext) {
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'mp4': return 'video/mp4';
        case 'mov': return 'video/quicktime';
        case 'json': return 'application/json';
        default: return 'application/octet-stream';
    }
}

async function sha256OfFile(filePath) {
    const buffer = await readFile(filePath);
    return createHash('sha256').update(buffer).digest('hex');
}

function collectManifestMediaRefs(manifest) {
    const refs = new Set();
    for (const release of Array.isArray(manifest?.releases) ? manifest.releases : []) {
        const releaseId = String(release?.releaseId ?? '').trim();
        if (!releaseId) continue;
        for (const card of Array.isArray(release?.cards) ? release.cards : []) {
            if (card?.kind === 'image') {
                const key = String(card?.media?.key ?? '').trim();
                if (key) refs.add(key.startsWith(`${releaseId}/`) ? key : `${releaseId}/${key}`);
            } else if (card?.kind === 'video') {
                for (const mediaKey of [card?.media?.key, card?.media?.posterKey]) {
                    const key = String(mediaKey ?? '').trim();
                    if (key) refs.add(key.startsWith(`${releaseId}/`) ? key : `${releaseId}/${key}`);
                }
            }
        }
    }
    return refs;
}

async function main() {
    const flags = parseFlags(process.argv.slice(2));
    const manifestPath = resolve(flags.get('manifest') ?? MANIFEST_PATH);
    const assetsDir = resolve(flags.get('assets-dir') ?? AUTHORED_ASSETS_DIR);
    const outDir = resolve(flags.get('out-dir') ?? join(REPO_ROOT, 'dist/release-notes-assets'));
    const assetBaseUrl = (flags.get('assets-base-url')
        ?? 'https://github.com/happier-dev/happier-assets/releases/download/release-notes/').replace(/\/?$/, '/');

    if (!existsSync(manifestPath)) {
        throw new Error(`Generated manifest not found at ${manifestPath}. Run parseReleaseNotes.ts first.`);
    }

    await mkdir(outDir, { recursive: true });

    // Copy the generated manifest verbatim.
    const manifestRaw = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    const referencedAssets = collectManifestMediaRefs(manifest);
    await writeFile(join(outDir, 'release-notes__manifest.json'), manifestRaw, 'utf-8');

    // Walk authored assets and emit prefixed copies + asset index.
    const authoredFiles = await listFilesRecursive(assetsDir);
    const authoredByKey = new Map();
    for (const fullPath of authoredFiles) {
        authoredByKey.set(relative(assetsDir, fullPath).split(/[\\/]/).join('/'), fullPath);
    }
    const missingAssets = Array.from(referencedAssets).filter((key) => !authoredByKey.has(key));
    if (missingAssets.length > 0) {
        throw new Error(`Generated manifest references missing asset file(s): ${missingAssets.join(', ')}`);
    }
    const unreferencedAssets = Array.from(authoredByKey.keys())
        .filter((key) => !referencedAssets.has(key))
        .sort((a, b) => a.localeCompare(b));
    if (unreferencedAssets.length > 0) {
        throw new Error(`Found unreferenced authored asset file(s): ${unreferencedAssets.join(', ')}`);
    }

    /** @type {Record<string, { assetKey: string; releaseId: string; path: string; fileName: string; sha256: string; contentType: string; sizeBytes: number }>} */
    const indexAssets = {};

    const filesToCopy = Array.from(referencedAssets).map((key) => authoredByKey.get(key));

    for (const fullPath of filesToCopy) {
        if (!fullPath) continue;
        const rel = relative(assetsDir, fullPath);
        const segments = rel.split(/[\\/]/);
        if (segments.length < 2) continue;
        const releaseId = segments[0];
        const logicalPath = segments.slice(1).join('/');
        const logicalKey = `${releaseId}/${logicalPath}`;
        const flatName = `release-notes__${releaseId}__${logicalPath.replace(/\//g, '__')}`;
        const targetPath = join(outDir, flatName);
        await mkdir(dirname(targetPath), { recursive: true });
        await copyFile(fullPath, targetPath);
        const fileStat = await stat(fullPath);
        const sha256 = await sha256OfFile(fullPath);
        indexAssets[logicalKey] = {
            assetKey: logicalKey,
            releaseId,
            path: logicalPath,
            fileName: flatName,
            sha256,
            contentType: inferContentType(flatName),
            sizeBytes: fileStat.size,
        };
    }

    const assetIndex = {
        schemaVersion: 'v1',
        generatedAt: new Date().toISOString(),
        assetsBaseUrl: assetBaseUrl,
        assets: indexAssets,
    };
    await writeFile(
        join(outDir, 'release-notes__assets-index.json'),
        `${JSON.stringify(assetIndex, null, 2)}\n`,
        'utf-8',
    );

    console.log(`[release-notes] built ${Object.keys(indexAssets).length} asset(s) into ${outDir}`);
}

main().catch((error) => {
    console.error('[release-notes] build failed:', error?.message ?? error);
    process.exit(1);
});
