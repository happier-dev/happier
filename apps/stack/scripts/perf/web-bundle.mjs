import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { resolveStackBaseDir, getStacksStorageRoot } from '../utils/paths/paths.mjs';
import { resolveRepoStackIdentity } from '../utils/stack/repo_stack_identity.mjs';
import { readStackRuntimeStateFile } from '../utils/stack/runtime_state.mjs';
import { resolveVerifiedStackUiEndpoint } from '../utils/stack/verified_endpoints.mjs';

export const WEB_BUNDLE_GRAPH = Object.freeze({ id: 'ui-web-bundle', entry: 'apps/ui/babel.config.js' });

// Two measured cold builds (~8 minutes under shared load) allow a cold
// transform plus scheduling headroom; one deadline covers headers and body.
const BROWSER_BUNDLE_TIMEOUT_MS = 2 * 8 * 60 * 1000;
const BROWSER_BUNDLE_ENTRY = '/apps/ui/index.ts.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=.%2Fsources%2Fapp&unstable_transformProfile=hermes-stable';

export async function loadWebBundle({ repoDir, signal, env = process.env }) {
  const started = performance.now();
  const base = { graph: WEB_BUNDLE_GRAPH.id, entry: WEB_BUNDLE_GRAPH.entry, basis: 'loaded-expo' };
  const failed = (code, details = {}, status = 'failed') => ({ ...base, status, elapsedMs: performance.now() - started,
    loadError: { name: status === 'failed' ? 'TransformError' : 'EndpointUnavailable', code, message: '' }, ...details });
  try {
    // The wrapper need not select a stack. Follow the checkout's existing
    // identity rather than silently probing main in that cold entry state.
    const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim() || resolveRepoStackIdentity({
      repoRoot: repoDir, stacksStorageRoot: getStacksStorageRoot(env), createIfMissing: false,
    }).stackName;
    const { baseDir } = resolveStackBaseDir(stackName, env);
    const runtimeState = await readStackRuntimeStateFile(join(baseDir, 'stack.runtime.json'));
    const endpoint = await resolveVerifiedStackUiEndpoint({ baseDir, runtimeState,
      expectedProjectDir: join(repoDir, 'apps/ui'), requireExpoOwnership: false });
    if (!endpoint.running || !endpoint.url) return failed('expo_unavailable', {}, 'unavailable');
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const deadline = setTimeout(() => controller.abort(), BROWSER_BUNDLE_TIMEOUT_MS);
    deadline.unref?.();
    try {
      const response = await fetch(new URL(BROWSER_BUNDLE_ENTRY, endpoint.url), { signal: requestSignal });
      if (!response.ok) {
        if (response.status < 500) { await response.body?.cancel(); return failed(`expo_http_${response.status}`, {}, 'unavailable'); }
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
      if (controller.signal.aborted) return failed('expo_bundle_timeout');
      throw error;
    } finally { clearTimeout(deadline); }
  } catch (error) {
    if (signal?.aborted) throw error;
    return failed('expo_request_failed', {}, 'unavailable');
  }
}
