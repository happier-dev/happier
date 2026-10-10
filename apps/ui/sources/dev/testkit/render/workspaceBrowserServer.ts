import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

/** HTTP/asset boundary for the shared real Metro source browser journeys. */
export function createWorkspaceBrowserServer(readBundle: () => string,
    handleRequest?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>,
) {
    return createServer(async (request, response) => {
        if (handleRequest && await handleRequest(request, response)) return;
        const fontName = /^\/fonts\/([A-Za-z0-9-]+\.ttf)$/.exec(request.url ?? '')?.[1];
        if (fontName) {
            void readFile(new URL(`../../../assets/fonts/${fontName}`, import.meta.url)).then(font => {
                response.setHeader('Content-Type', 'font/ttf');
                response.end(font);
            }).catch(() => { response.statusCode = 404; response.end(); });
            return;
        }
        response.setHeader('Content-Type', request.url === '/bundle.js' ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8');
        response.end(request.url === '/bundle.js' ? readBundle() : '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>');
    });
}
