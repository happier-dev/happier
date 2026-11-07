import type { PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import type { TriageMountedUiOperationV1, TriageMountedUiResultV1 } from '../actions/mountedUiProtocol.js';
import { TriageSourcePanelOperationV1Schema, triageSourcePanelIntentKeyV1, type TriageSourcePanelOperationV1 } from '@happier-dev/triage-sources/runtime';
import type { TriageSourcePanelHandlerV1 } from '@happier-dev/triage-sources/ui';

type MountedHandler = (operation: TriageMountedUiOperationV1, signal: AbortSignal) => Promise<TriageMountedUiResultV1>;
type MountedBinding = { invoke: MountedHandler | null; source: Map<string, TriageSourcePanelHandlerV1> };

function acquire(scope: PluginEphemeralSharedScope, mountId: string) {
  return scope.acquireExecutionBound?.<MountedBinding>(`triage.mounted-ui.v1:${mountId}`, () => {
    const value: MountedBinding = { invoke: null, source: new Map() };
    return { value, dispose: () => { value.invoke = null; value.source.clear(); } };
  }) ?? null;
}

/** Source callbacks join the same addressed mounted dispatcher, without mirroring source state. */
export function bindTriageMountedSourcePanelAction(scope: PluginEphemeralSharedScope, mountId: string,
  key: string, invoke: TriageSourcePanelHandlerV1): () => void {
  const lease = acquire(scope, mountId);
  if (lease === null) return () => {};
  lease.value.source.set(key, invoke);
  return () => {
    if (lease.value.source.get(key) === invoke) lease.value.source.delete(key);
    lease.release();
  };
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
  operation: TriageMountedUiOperationV1 | TriageSourcePanelOperationV1, signal: AbortSignal): Promise<TriageMountedUiResultV1> {
  const lease = acquire(scope, mountId);
  if (lease === null) return { status: 'unavailable' };
  try {
    if (signal.aborted || lease.value.invoke === null) return { status: 'unavailable' };
    const source = TriageSourcePanelOperationV1Schema.safeParse(operation);
    if (source.success) return await lease.value.source.get(triageSourcePanelIntentKeyV1(source.data))?.(source.data, signal) ?? { status: 'unavailable' };
    return await lease.value.invoke(operation as TriageMountedUiOperationV1, signal);
  } finally { lease.release(); }
}
