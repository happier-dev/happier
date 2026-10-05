import type { PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import type { TriageMountedUiOperationV1, TriageMountedUiResultV1 } from '../actions/mountedUiProtocol.js';

type MountedHandler = (operation: TriageMountedUiOperationV1, signal: AbortSignal) => Promise<TriageMountedUiResultV1>;
type MountedBinding = { invoke: MountedHandler | null };

function acquire(scope: PluginEphemeralSharedScope, mountId: string) {
  return scope.acquire<MountedBinding>(`triage.mounted-ui.v1:${mountId}`, () => {
    const value: MountedBinding = { invoke: null };
    return { value, dispose: () => { value.invoke = null; } };
  });
}

/** The existing Account/plugin/generation scope carries only the mounted callback, never UI state. */
export function bindTriageMountedUiActions(scope: PluginEphemeralSharedScope, mountId: string, invoke: MountedHandler): () => void {
  const lease = acquire(scope, mountId);
  if (lease === null) return () => {};
  lease.value.invoke = invoke;
  return () => {
    if (lease.value.invoke === invoke) lease.value.invoke = null;
    lease.release();
  };
}

export async function invokeTriageMountedUiAction(scope: PluginEphemeralSharedScope, mountId: string,
  operation: TriageMountedUiOperationV1, signal: AbortSignal): Promise<TriageMountedUiResultV1> {
  const lease = acquire(scope, mountId);
  if (lease === null) return { status: 'unavailable' };
  try {
    if (signal.aborted || lease.value.invoke === null) return { status: 'unavailable' };
    return await lease.value.invoke(operation, signal);
  } finally { lease.release(); }
}
