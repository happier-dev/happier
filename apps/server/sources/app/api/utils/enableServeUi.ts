import type { FastifyInstance, FastifyRequest } from "fastify";
import type { UiConfig } from "@/app/api/uiConfig";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { warn } from "@/utils/logging/log";
import { createReadStream, existsSync } from "node:fs";

type AnyFastifyInstance = FastifyInstance<any, any, any, any, any>;
type UiEncoding = 'br' | 'gzip';

function isWithinRoot(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel === '' || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
}

function parseAcceptedEncodings(header: unknown): Map<string, number> {
    const raw = Array.isArray(header) ? header.join(',') : typeof header === 'string' ? header : '';
    const result = new Map<string, number>();
    for (const part of raw.split(',')) {
        const [encodingRaw, ...params] = part.trim().split(';');
        const encoding = encodingRaw.trim().toLowerCase();
        if (!encoding) continue;
        let q = 1;
        for (const param of params) {
            const [key, value] = param.trim().split('=');
            if (key?.toLowerCase() !== 'q') continue;
            const parsed = Number.parseFloat(value ?? '');
            q = Number.isFinite(parsed) ? parsed : 0;
        }
        result.set(encoding, Math.max(0, Math.min(1, q)));
    }
    return result;
}

function acceptedQuality(accepted: Map<string, number>, encoding: UiEncoding): number {
    return accepted.get(encoding) ?? accepted.get('*') ?? 0;
}

async function statFile(path: string) {
    const info = await stat(path).catch(() => null);
    return info?.isFile() ? info : null;
}

async function selectPrecompressedSidecar(
    candidate: string,
    request: FastifyRequest,
): Promise<{ path: string; encoding: UiEncoding; size: number } | null> {
    const accepted = parseAcceptedEncodings(request.headers['accept-encoding']);
    const candidates = [
        { encoding: 'br' as const, quality: acceptedQuality(accepted, 'br'), path: `${candidate}.br`, preference: 0 },
        { encoding: 'gzip' as const, quality: acceptedQuality(accepted, 'gzip'), path: `${candidate}.gz`, preference: 1 },
    ].filter((entry) => entry.quality > 0)
        .sort((a, b) => b.quality - a.quality || a.preference - b.preference);

    for (const entry of candidates) {
        const info = await statFile(entry.path);
        if (info) {
            return { path: entry.path, encoding: entry.encoding, size: info.size };
        }
    }
    return null;
}

function setUiFileHeaders(reply: any, ext: string): void {
    if (ext === '.html') {
        reply.header('content-type', 'text/html; charset=utf-8');
        reply.header('cache-control', 'no-cache');
    } else if (ext === '.js') {
        reply.header('content-type', 'text/javascript; charset=utf-8');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.css') {
        reply.header('content-type', 'text/css; charset=utf-8');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.json') {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.map') {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.svg') {
        reply.header('content-type', 'image/svg+xml');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.ico') {
        reply.header('content-type', 'image/x-icon');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.wasm') {
        reply.header('content-type', 'application/wasm');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.ttf') {
        reply.header('content-type', 'font/ttf');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.woff') {
        reply.header('content-type', 'font/woff');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.woff2') {
        reply.header('content-type', 'font/woff2');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.png') {
        reply.header('content-type', 'image/png');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.jpg' || ext === '.jpeg') {
        reply.header('content-type', 'image/jpeg');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.webp') {
        reply.header('content-type', 'image/webp');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else if (ext === '.gif') {
        reply.header('content-type', 'image/gif');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else {
        reply.header('content-type', 'application/octet-stream');
        reply.header('cache-control', 'public, max-age=31536000, immutable');
    }
}

export function enableServeUi(app: AnyFastifyInstance, ui: UiConfig) {
    const uiDir = ui.dir;
    if (!uiDir) {
        return;
    }

    const root = resolve(uiDir);
    if (ui.required) {
        const indexPath = resolve(root, 'index.html');
        if (!existsSync(indexPath)) {
            throw new Error(`UI index.html not found at ${indexPath}`);
        }
    }

    async function sendUiFile(relPath: string, request: FastifyRequest, reply: any) {
        const candidate = resolve(root, relPath);
        if (!isWithinRoot(root, candidate)) {
            return reply.code(404).send({ error: 'Not found' });
        }

        const originalInfo = await statFile(candidate);
        if (!originalInfo) {
            return reply.code(404).send({ error: 'Not found' });
        }
        const ext = extname(candidate).toLowerCase();
        const sidecar = await selectPrecompressedSidecar(candidate, request);

        setUiFileHeaders(reply, ext);
        reply.header('vary', 'Accept-Encoding');
        if (sidecar) {
            reply.header('content-encoding', sidecar.encoding);
            reply.header('content-length', String(sidecar.size));
            return reply.send(createReadStream(sidecar.path));
        }

        reply.header('content-length', String(originalInfo.size));
        return reply.send(createReadStream(candidate));
    }

    async function sendIndexHtml(reply: any) {
        const indexPath = resolve(root, 'index.html');
        let html: string;
        try {
            html = (await readFile(indexPath, 'utf-8')) + '\n<!-- Welcome to Happier Server! -->\n';
        } catch (err) {
            warn({ err, indexPath }, 'UI index.html not found (check UI build dir configuration)');
            const isProduction = process.env.NODE_ENV === "production";
            const revealPathInFallback = !isProduction || process.env.HAPPIER_SERVER_UI_DEBUG_PATH === "1";
            const escapedIndexPath = String(indexPath)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            const missingBundleDetails = revealPathInFallback
                ? `<p>The backend is running, but the web UI bundle is missing:</p>\n  <pre>${escapedIndexPath}</pre>\n`
                : `<p>The backend is running, but the UI bundle is missing for this environment.</p>\n`;
            html =
                `<!doctype html>\n` +
                `<html>\n` +
                `<head>\n` +
                `  <meta charset="utf-8" />\n` +
                `  <meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
                `  <title>Happier UI not built</title>\n` +
                `  <style>body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.45;padding:24px;max-width:840px;margin:0 auto}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto}</style>\n` +
                `</head>\n` +
                `<body>\n` +
                `  <h1>Happier UI is not built</h1>\n` +
                `  ${missingBundleDetails}` +
                `  <p>Fix:</p>\n` +
                `  <pre>hstack build</pre>\n` +
                `  <p>If the stack is already running via a service, you may need:</p>\n` +
                `  <pre>hstack service restart</pre>\n` +
                `  <p style="color:#6a737d">If you are developing the UI, use <code>hstack dev</code> instead.</p>\n` +
                `</body>\n` +
                `</html>\n` +
                `<!-- Welcome to Happier Server! -->\n`;
        }
        reply.header('content-type', 'text/html; charset=utf-8');
        reply.header('cache-control', 'no-cache');
        return reply.send(html);
    }

    if (ui.mountRoot) {
        app.get('/', async (_request, reply) => await sendIndexHtml(reply));
        // SPA deep links (e.g. /terminal/connect) should render the same index.html bundle.
        // Exact API/static routes should still win routing precedence.
        app.get('/*', async (request, reply) => {
            try {
                const rawUrl = typeof request.url === 'string' ? request.url : '';
                const pathname = rawUrl ? new URL(rawUrl, 'http://localhost').pathname : '/';
                const lowerPathname = pathname.toLowerCase();
                const isApiPath =
                    lowerPathname === '/v1' ||
                    lowerPathname.startsWith('/v1/') ||
                    lowerPathname === '/api' ||
                    lowerPathname.startsWith('/api/');
                if (isApiPath) {
                    return reply.code(404).send({ error: 'Not found' });
                }
                const decoded = decodeURIComponent(pathname || '/').replace(/^\/+/, '');
                if (!decoded) {
                    return await sendIndexHtml(reply);
                }
                // Best-effort: if it looks like a UI asset request, try serving the file.
                // (Avoid treating dot-containing SPA routes like "/user.profile" as static files.)
                const ext = extname(decoded).toLowerCase();
                const isStaticAsset = Boolean(ext) && [
                    '.html',
                    '.js',
                    '.css',
                    '.json',
                    '.svg',
                    '.ico',
                    '.wasm',
                    '.ttf',
                    '.woff',
                    '.woff2',
                    '.png',
                    '.jpg',
                    '.jpeg',
                    '.webp',
                    '.gif',
                    '.map',
                ].includes(ext);
                if (isStaticAsset) {
                    return await sendUiFile(decoded, request, reply);
                }
                return await sendIndexHtml(reply);
            } catch {
                return reply.code(404).send({ error: 'Not found' });
            }
        });
        app.get('/ui', async (_request, reply) => reply.redirect('/', 302));
        app.get('/ui/', async (_request, reply) => reply.redirect('/', 302));
        app.get('/ui/*', async (request, reply) => {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
            return reply.redirect(`/${decoded}`, 302);
        });
    } else {
        const prefix = ui.prefix;
        app.get(prefix, async (_request, reply) => reply.redirect(`${prefix}/`, 302));
        app.get(`${prefix}/*`, async (request, reply) => {
            try {
                const raw = (request.params as { '*': string | undefined })['*'] || '';
                const decoded = decodeURIComponent(raw);
                const rel = decoded.replace(/^\/+/, '');

                const candidate = resolve(root, rel || 'index.html');
                if (!isWithinRoot(root, candidate)) {
                    return reply.code(404).send({ error: 'Not found' });
                }

                let filePath = candidate;
                try {
                    const st = await stat(filePath);
                    if (st.isDirectory()) {
                        filePath = resolve(root, 'index.html');
                    }
                } catch {
                    filePath = resolve(root, 'index.html');
                }

                const relPath = filePath.slice(root.length + 1);
                if (relPath === 'index.html') {
                    return await sendIndexHtml(reply);
                }
                return await sendUiFile(relPath, request, reply);
            } catch {
                return reply.code(404).send({ error: 'Not found' });
            }
        });
    }

    // Expo export (metro) emits absolute URLs like `/_expo/...` and `/favicon.ico` even when served from a subpath.
    // To keep `/ui` working without rewriting builds, also serve these static assets from the root.
    app.get('/_expo/*', async (request, reply) => {
        try {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
            return await sendUiFile(`_expo/${decoded}`, request, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/assets/*', async (request, reply) => {
        try {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
            return await sendUiFile(`assets/${decoded}`, request, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/.well-known/*', async (request, reply) => {
        try {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
            return await sendUiFile(`.well-known/${decoded}`, request, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/favicon.ico', async (request, reply) => {
        try {
            return await sendUiFile('favicon.ico', request, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/favicon-active.ico', async (request, reply) => {
        try {
            return await sendUiFile('favicon-active.ico', request, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/canvaskit.wasm', async (request, reply) => {
        try {
            return await sendUiFile('canvaskit.wasm', request, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/metadata.json', async (request, reply) => {
        try {
            return await sendUiFile('metadata.json', request, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
}
