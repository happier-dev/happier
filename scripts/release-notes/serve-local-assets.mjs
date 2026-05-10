#!/usr/bin/env node
// @ts-check
/**
 * Serve `apps/ui/release-notes/assets/` over HTTP for local previews of release notes
 * media before they are published to `happier-assets`.
 *
 * Usage:
 *   node scripts/release-notes/serve-local-assets.mjs [--port 4173] [--host 127.0.0.1]
 *
 * Then in your local Expo env:
 *   EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_LOCAL_ASSETS_BASE_URL=http://127.0.0.1:4173/
 *
 * The server expects requests using the same flat naming convention as production:
 *   release-notes__<releaseId>__<logicalPathWith__>.<ext>
 * It maps that back to apps/ui/release-notes/assets/<releaseId>/<logicalPath>.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseUrl } from 'node:url';

const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const ASSETS_DIR = join(REPO_ROOT, 'apps/ui/release-notes/assets');

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

function decodeAssetPath(requestPath) {
    // Accept three forms:
    //   /release-notes__<releaseId>__<path>.<ext>
    //   /<releaseId>/<path>
    //   /<full path within assets dir>
    let path = requestPath.replace(/^\/+/, '');
    if (!path) return null;
    try { path = decodeURIComponent(path); } catch { return null; }

    const flatMatch = path.match(/^release-notes__([^_]+)__(.+)$/);
    if (flatMatch) {
        const releaseId = flatMatch[1];
        const logical = flatMatch[2].replace(/__/g, '/');
        return join(releaseId, logical);
    }
    return path;
}

function startServer({ host, port }) {
    const server = createServer((req, res) => {
        const url = parseUrl(req.url ?? '/');
        const decoded = decodeAssetPath(url.pathname ?? '/');
        if (!decoded) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        const fullPath = join(ASSETS_DIR, decoded);
        if (!fullPath.startsWith(ASSETS_DIR) || !existsSync(fullPath)) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        const stats = statSync(fullPath);
        if (!stats.isFile()) {
            res.statusCode = 404;
            res.end('not a file');
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', inferContentType(fullPath));
        res.setHeader('Content-Length', String(stats.size));
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        createReadStream(fullPath).pipe(res);
    });

    server.listen(port, host, () => {
        console.log(`[release-notes] serving ${ASSETS_DIR}`);
        console.log(`[release-notes] http://${host}:${port}/`);
        console.log('[release-notes] Set EXPO_PUBLIC_HAPPIER_RELEASE_NOTES_LOCAL_ASSETS_BASE_URL to use it.');
    });
}

const flags = parseFlags(process.argv.slice(2));
const host = flags.get('host') ?? '127.0.0.1';
const port = Number(flags.get('port') ?? 4173);
startServer({ host, port });
