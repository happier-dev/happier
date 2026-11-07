import type { PluginClientApi, PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import type { ForgeCiMountedIntentInputV1, ForgeCiMountedIntentResultV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiMountedViewV1 } from '@happier-dev/forge-ci/ui';

export const GITHUB_CI_MOUNTED_ACTION_ID_V1 = 'ui/ci-view-v1';
type Binding = { view: ForgeCiMountedViewV1 | null };
function acquire(scope: PluginEphemeralSharedScope, mountId: string) {
  return scope.acquire<Binding>(`github.ci.mounted.v1:${mountId}`, () => {
    const value: Binding = { view: null };
    return { value, dispose: () => { value.view = null; } };
  });
}
/** Holds only the addressed callback. L02 remains the sole controlled-state owner. */
export function bindGithubCiMountedViewV1(scope: PluginEphemeralSharedScope, view: ForgeCiMountedViewV1, signal?: AbortSignal): () => void {
  if (signal?.aborted) return () => {};
  const lease = acquire(scope, view.mountId);
  if (lease === null) return () => {};
  lease.value.view = view;
  let released = false;
  const release = () => { if (released) return; released = true; signal?.removeEventListener('abort', release); if (lease.value.view === view) lease.value.view = null; lease.release(); };
  signal?.addEventListener('abort', release, { once: true });
  return release;
}
export async function invokeGithubCiMountedViewV1(scope: PluginEphemeralSharedScope, input: ForgeCiMountedIntentInputV1, signal: AbortSignal): Promise<ForgeCiMountedIntentResultV1> {
  const lease = acquire(scope, input.mountId);
  if (lease === null) return { status: 'unavailable' };
  try { return signal.aborted || lease.value.view === null ? { status: 'unavailable' } : await lease.value.view.invoke(input); }
  finally { lease.release(); }
}
/** Shared artifact activation; the Opus renderer reuses this export. */
export function activate(api: PluginClientApi): void {
  api.actions.register(GITHUB_CI_MOUNTED_ACTION_ID_V1, async (raw, context) => {
    const { ForgeCiMountedIntentInputV1Schema } = await import('@happier-dev/triage-protocol/ci/v1');
    const input = ForgeCiMountedIntentInputV1Schema.parse(raw);
    if (context.ephemeralSharedScope === null || context.signal.aborted) return { status: 'unavailable' };
    return invokeGithubCiMountedViewV1(context.ephemeralSharedScope, input, context.signal);
  });
}
