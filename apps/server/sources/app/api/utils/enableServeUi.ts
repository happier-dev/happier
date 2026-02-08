import type { FastifyInstance } from "fastify";
import type { UiConfig } from "@/app/api/uiConfig";
import { extname, resolve, sep } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { warn } from "@/utils/log";
import { existsSync } from "node:fs";

type AnyFastifyInstance = FastifyInstance<any, any, any, any, any>;

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

    async function sendUiFile(relPath: string, reply: any) {
        const candidate = resolve(root, relPath);
        if (!(candidate === root || candidate.startsWith(root + sep))) {
            return reply.code(404).send({ error: 'Not found' });
        }

        const bytes = await readFile(candidate);
        const ext = extname(candidate).toLowerCase();

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

        return reply.send(Buffer.from(bytes));
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
                    return await sendUiFile(decoded, reply);
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
                if (!(candidate === root || candidate.startsWith(root + sep))) {
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
                return await sendUiFile(relPath, reply);
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
            return await sendUiFile(`_expo/${decoded}`, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/assets/*', async (request, reply) => {
        try {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
            return await sendUiFile(`assets/${decoded}`, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/.well-known/*', async (request, reply) => {
        try {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
            return await sendUiFile(`.well-known/${decoded}`, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/favicon.ico', async (_request, reply) => {
        try {
            return await sendUiFile('favicon.ico', reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/favicon-active.ico', async (_request, reply) => {
        try {
            return await sendUiFile('favicon-active.ico', reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/canvaskit.wasm', async (_request, reply) => {
        try {
            return await sendUiFile('canvaskit.wasm', reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/metadata.json', async (_request, reply) => {
        try {
            return await sendUiFile('metadata.json', reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
}
