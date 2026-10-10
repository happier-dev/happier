/** One MIME classifier for packaged and workspace-acquired hosted-web assets. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

export function resolveHostedWebAssetContentTypeV1(path: string): string | null {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const lastDot = basename.lastIndexOf('.');
  const extension = lastDot > 0 ? basename.slice(lastDot).toLowerCase() : '';
  return MIME_BY_EXTENSION[extension] ?? null;
}
