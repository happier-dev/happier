import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { resolveStackBaseDir } from '../utils/paths/paths.mjs';
import { readStackRuntimeStateFile } from '../utils/stack/runtime_state.mjs';
import { resolveVerifiedStackUiEndpoint } from '../utils/stack/verified_endpoints.mjs';

export const WEB_BUNDLE_GRAPH = Object.freeze({ id: 'ui-web-bundle', entry: 'apps/ui/babel.config.js' });

export async function loadWebBundle({ repoDir, signal, env = process.env }) {
  const started = performance.now();
  const base = { graph: WEB_BUNDLE_GRAPH.id, entry: WEB_BUNDLE_GRAPH.entry, basis: 'loaded-expo' };
  const failed = (code, details = {}) => ({ ...base, status: 'failed', elapsedMs: performance.now() - started,
    loadError: { name: 'TransformError', code, message: '' }, ...details });
  try {
    const { baseDir } = resolveStackBaseDir(null, env);
    const runtimeState = await readStackRuntimeStateFile(join(baseDir, 'stack.runtime.json'));
    const endpoint = await resolveVerifiedStackUiEndpoint({ baseDir, runtimeState,
      expectedProjectDir: join(repoDir, 'apps/ui'), requireExpoOwnership: false });
    if (!endpoint.running || !endpoint.url) return failed('expo_unavailable');
    const page = await fetch(endpoint.url, { signal });
    if (!page.ok) { await page.body?.cancel(); return failed(`expo_http_${page.status}`); }
    const html = await page.text();
    const src = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
      .map(match => match[1].replaceAll('&amp;', '&')).find(value => value.split('?')[0].endsWith('.bundle'));
    if (!src) return failed('expo_bundle_missing');
    const url = new URL(src, endpoint.url);
    // The page chooses the entry/options, but the check stays on its Expo host.
    if (url.origin !== new URL(endpoint.url).origin) return failed('expo_bundle_origin_mismatch');
    const response = await fetch(url, { signal });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      const detail = error?.errors?.[0];
      const filename = error?.filename ?? detail?.filename;
      const message = error?.message ?? detail?.description ?? '';
      const location = String(message).match(/(?:^|\n)([^\n]+?\.[cm]?[jt]sx?):\s*[^\n]*?\((\d+):\d+\)/);
      const line = [error?.lineNumber, detail?.lineNumber, location?.[2],
        String(message).match(/>\s*(\d+)\s*\|/)?.[1]].map(Number)
        .find(value => Number.isSafeInteger(value) && value > 0);
      return failed(`expo_http_${response.status}`, {
        firstFailingModule: typeof filename === 'string' ? filename
          : location?.[1] ?? String(message).match(/^(.+?\.[cm]?[jt]sx?):/)?.[1],
        failureLine: Number.isSafeInteger(line) && line > 0 ? line : null,
      });
    }
    // Drain without retaining the large bundle; completion observes transform errors.
    for await (const _chunk of response.body) { signal?.throwIfAborted(); }
    return { ...base, status: 'passed', elapsedMs: performance.now() - started };
  } catch (error) {
    if (signal?.aborted) throw error;
    return failed('expo_request_failed');
  }
}
