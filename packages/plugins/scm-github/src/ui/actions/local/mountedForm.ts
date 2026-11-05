import { PluginError, type PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import type { PluginClientActionUi } from '@happier-dev/plugin-sdk/actions';
import { LocalActRunFormInputV1Schema, type LocalActRunFormInput, type LocalActRunFormResult, type LocalActRunSeedV1 } from '../../../actions/local/contracts.js';
import type { LocalRunController } from './localRunController.js';
import { GITHUB_PLUGIN_ID } from '../../../observations/githubProviderContracts.js';
import { GITHUB_LOCAL_ACT_SESSION_VIEW_ID_V1, GITHUB_LOCAL_ACT_PROJECT_VIEW_ID_V1 } from '../../forge/surfaceIds.js';

type Binding = { controller: LocalRunController | null };
type Opening = { mountId: string | null; listeners: Set<(mountId: string | null) => void> };
const scopeKey = (seed: LocalActRunSeedV1) => JSON.stringify([seed.workspace.serverId, seed.workspace.workspaceId,
  seed.workspace.machineId, seed.workspace.rootPath, seed.target.kind,
  seed.target.kind === 'session' ? seed.target.sessionId : seed.target.projectId,
  seed.workflowPath ?? '', seed.event ?? '', seed.yamlJobId ?? '', seed.sourceHeadSha ?? '']);
function mounted(scope: PluginEphemeralSharedScope, mountId: string) {
  return scope.acquire<Binding>(`github.local-act.mounted.v1:${mountId}`, () => {
    const value: Binding = { controller: null }; return { value, dispose: () => { value.controller = null; } };
  });
}
function opening(scope: PluginEphemeralSharedScope, seed: LocalActRunSeedV1) {
  return scope.acquire<Opening>(`github.local-act.open.v1:${scopeKey(seed)}`, () => {
    const value: Opening = { mountId: null, listeners: new Set() };
    return { value, dispose() { for (const listener of value.listeners) listener(null); value.listeners.clear(); value.mountId = null; } };
  });
}

/** Called only by an actual committed presentation, with its own mount identity. */
export function bindLocalActFormV1(scope: PluginEphemeralSharedScope, mountId: string, seed: LocalActRunSeedV1,
  controller: LocalRunController): () => void {
  const mount = mounted(scope, mountId);
  const open = opening(scope, seed);
  if (!mount || !open) { mount?.release(); open?.release(); return () => {}; }
  mount.value.controller = controller; open.value.mountId = mountId;
  for (const listener of open.value.listeners) listener(mountId);
  return () => {
    if (mount.value.controller === controller) mount.value.controller = null;
    if (open.value.mountId === mountId) open.value.mountId = null;
    mount.release(); open.release();
  };
}

export async function invokeLocalActFormV1(scope: PluginEphemeralSharedScope, input: unknown): Promise<LocalActRunFormResult> {
  const parsed = LocalActRunFormInputV1Schema.parse(input);
  if (!('mountId' in parsed)) throw new TypeError('mounted_operation_required');
  const lease = mounted(scope, parsed.mountId);
  if (!lease) return { status: 'unavailable' };
  try { return await lease.value.controller?.invoke(parsed.operation) ?? { status: 'unavailable' }; }
  finally { lease.release(); }
}

/** Waits for presentation's real registration; it never invents a mount id. */
export async function openLocalActFormV1(scope: PluginEphemeralSharedScope, seed: LocalActRunSeedV1,
  ui: Pick<PluginClientActionUi, 'openSurface'>, signal: AbortSignal): Promise<LocalActRunFormResult> {
  const lease = opening(scope, seed);
  if (!lease || signal.aborted) { lease?.release(); throw new PluginError({ code: 'client_context_required' }); }
  let observe: ((mountId: string | null) => void) | undefined;
  let cancel: (() => void) | undefined;
  try {
    const ready = new Promise<string>((resolve, reject) => {
      observe = mountId => mountId ? resolve(mountId) : reject(new PluginError({ code: 'client_context_required' }));
      cancel = () => reject(new PluginError({ code: 'client_context_required' }));
      lease.value.listeners.add(observe); signal.addEventListener('abort', cancel, { once: true });
    });
    // Observe retirement/cancellation while navigation is still pending.
    void ready.catch(() => {});
    const localId = seed.target.kind === 'session' ? GITHUB_LOCAL_ACT_SESSION_VIEW_ID_V1 : GITHUB_LOCAL_ACT_PROJECT_VIEW_ID_V1;
    await ui.openSurface({ pluginId: GITHUB_PLUGIN_ID, localId }, { seed }, { signal });
    if (lease.value.mountId) return { kind: 'opened', mountId: lease.value.mountId };
    return { kind: 'opened', mountId: await ready };
  } finally {
    if (observe) lease.value.listeners.delete(observe);
    if (cancel) signal.removeEventListener('abort', cancel);
    lease.release();
  }
}
export async function executeLocalActFormIntentV1(input: LocalActRunFormInput, context: Readonly<{
  ephemeralSharedScope: PluginEphemeralSharedScope | null; ui: Pick<PluginClientActionUi, 'openSurface'>; signal: AbortSignal;
}>) {
  const admitted = LocalActRunFormInputV1Schema.parse(input);
  if ('mountId' in admitted) return !context.ephemeralSharedScope || context.signal.aborted ? { status: 'unavailable' as const }
    : await invokeLocalActFormV1(context.ephemeralSharedScope, admitted);
  if (!context.ephemeralSharedScope || context.signal.aborted) throw new PluginError({ code: 'client_context_required' });
  return await openLocalActFormV1(context.ephemeralSharedScope, admitted.operation.seed, context.ui, context.signal);
}
