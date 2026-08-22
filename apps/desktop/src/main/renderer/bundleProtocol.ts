import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

/**
 * Serves the exported web bundle on a private scheme rather than over loopback HTTP.
 *
 * The scheme matters to the product, not just to the transport. `getWebSameOriginServerUrl` in
 * `apps/ui/sources/sync/domains/server/serverProfiles.ts` treats an `http(s)` page origin as a
 * candidate relay, so hosting the bundle on `http://127.0.0.1:<port>` makes the app offer its own
 * asset server as the relay and fail with "Relay not supported". The Tauri target avoids that by
 * living on `tauri://localhost`, whose protocol the same function rejects; `happier://localhost`
 * gives this target the same behaviour.
 *
 * The origin is fixed, so storage — the signed-in session included — survives a restart.
 */
export const BUNDLE_SCHEME = 'happier';
export const BUNDLE_ORIGIN = `${BUNDLE_SCHEME}://localhost`;

/**
 * `standard` gives the scheme an origin (required for storage and relative URLs), `secure` makes it
 * a secure context (`crypto.subtle`), and the fetch/stream privileges let the bundle load its own
 * chunks and stream large assets.
 */
export const BUNDLE_SCHEME_PRIVILEGES = {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
} as const;

const CONTENT_TYPES = new Map<string, string>([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.otf', 'font/otf'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.ttf', 'font/ttf'],
    ['.txt', 'text/plain; charset=utf-8'],
    ['.wasm', 'application/wasm'],
    ['.webp', 'image/webp'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
]);

export function resolveContentType(filePath: string): string {
    return CONTENT_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

/**
 * Maps a request pathname onto a file inside `rootDir`. Returns `null` for a path that cannot be
 * decoded, and never returns a path outside `rootDir`.
 */
export function resolveRequestPath(rootDir: string, requestPath: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(requestPath.split('?')[0]?.split('#')[0] ?? '/');
    } catch {
        return null;
    }

    const normalizedRoot = resolve(rootDir);
    const candidate = resolve(normalizedRoot, `.${normalize(decoded)}`);
    if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + sep)) {
        return null;
    }
    return candidate;
}

async function resolveExistingFile(candidate: string): Promise<string | null> {
    try {
        const stats = await stat(candidate);
        if (stats.isDirectory()) {
            return resolveExistingFile(join(candidate, 'index.html'));
        }
        return stats.isFile() ? candidate : null;
    } catch {
        return null;
    }
}

/**
 * Builds the handler for {@link BUNDLE_SCHEME}. Unknown paths fall back to `index.html` so
 * client-side routes (expo-router deep links, `/terminal/connect`, …) resolve as they do on the web.
 */
export function createBundleResponder(rootDir: string): (url: string) => Promise<Response> {
    const indexPath = join(rootDir, 'index.html');

    return async (url: string): Promise<Response> => {
        let requestPath: string;
        try {
            requestPath = new URL(url).pathname;
        } catch {
            return new Response('Bad request', { status: 400 });
        }

        const candidate = resolveRequestPath(rootDir, requestPath);
        const filePath =
            candidate === null
                ? await resolveExistingFile(indexPath)
                : ((await resolveExistingFile(candidate)) ?? (await resolveExistingFile(indexPath)));

        if (filePath === null) {
            return new Response('Not found', { status: 404 });
        }

        const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
        return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': resolveContentType(filePath) },
        });
    };
}
