import type { Duplex } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { authorizeWorkspaceEffectLaunch, runWorkspaceEffectChild, runWorkspaceEffectChannel } from './workspaceEffectProcess';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { readAgentIsolationMemberWorkspaceRoot } from '@/daemon/agentIsolation/agentIsolationNativeIdentity';
import type { PrivateProjectCheckout } from './privateProjectCheckout';
import type { MaterializedProjectCheckout } from './materializeProjectCheckout';
import type { WorkspaceCheckoutEffect } from './workspaceEffect';
import { createWorkspaceEffectConnectedAccounts } from './workspaceEffectServices';
import type { PrivateProjectNativeSync, PrivateProjectNativeSyncProcessPort, PrivateProjectSyncEffectConfiguration, PrivateProjectSyncNetwork } from './privateProjectSyncEffect';

type Launch = Parameters<typeof authorizeResolvedProjectExecLaunchForHost>[0];
type MemberRoot = Awaited<ReturnType<typeof readAgentIsolationMemberWorkspaceRoot>>;

export type PrivateProjectNativeProcessInput = Readonly<{
  prepared: PrivateProjectCheckout;
  memberRoot: MemberRoot;
  effect: WorkspaceCheckoutEffect;
  launch: Omit<Launch, 'launch'>;
  managedHappierBinaryPath: string;
  connectedAccounts?: Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'listAccounts' | 'materialize'>;
  verifyCurrent(): Promise<void>;
  onEffectsIssued(): void;
}>;

async function prepareNativeWorkspaceEffectLaunch(input: PrivateProjectNativeProcessInput) {
  const selected = input.launch.requesterIdentity;
  if (selected?.kind !== 'isolated' || !isDeepStrictEqual(selected.requester, input.memberRoot.identity.requester)
    || input.prepared.destinationParentPath !== input.memberRoot.workspaceRoot
    || input.effect.workspaceRefId !== input.prepared.workspaceRefId) throw new PluginError({ code: 'workspace_private_checkout_required',
      message: 'The private checkout operation is unavailable' });
  input.launch.signal.throwIfAborted();
  await input.verifyCurrent();
  return authorizeWorkspaceEffectLaunch({ ...input.launch, managedHappierBinaryPath: input.managedHappierBinaryPath,
    workspaceRoot: input.memberRoot.workspaceRoot });
}

/** The existing Workspace operation retains its exact native/material leases.
 * This is transport for that owner, not a checkout engine or grant producer. */
export async function materializePrivateProjectCheckoutProcess(input: PrivateProjectNativeProcessInput): Promise<MaterializedProjectCheckout> {
  const refusal = (code = 'workspace_private_checkout_required') => new PluginError({ code,
    message: 'The private checkout operation is unavailable',
    details: { reason: code, phase: 'native_execution_preparation' } });
  const launch = await prepareNativeWorkspaceEffectLaunch(input);
  let result: MaterializedProjectCheckout | undefined;
  let failure: unknown;
  let issued = false;
  const onEffectsIssued = () => { if (!issued) { issued = true; input.onEffectsIssued(); } };
  const outcome = await runWorkspaceEffectChild({ launch, signal: input.launch.signal, refusal,
    // One invocation per pipe; the existing checkout id is sufficient routing.
    id: input.prepared.workspaceRefId, effect: input.effect,
    beforeSpawn: async () => { await input.verifyCurrent(); input.launch.assertCurrent(); },
    services: {
      ...(input.connectedAccounts ? { connectedAccounts: createWorkspaceEffectConnectedAccounts({
        effect: input.effect, owner: input.connectedAccounts, signal: input.launch.signal, assertCurrent: input.verifyCurrent,
      }) } : {}),
      onEffectsIssued: async () => { onEffectsIssued(); },
      fail: async (error: Error, effectsIssued: boolean) => {
        if (effectsIssued) onEffectsIssued();
        failure = error;
      },
      complete: async (checkout: MaterializedProjectCheckout) => {
        await input.verifyCurrent();
        // The captured native child already verified physical paths as the
        // member. The daemon must not traverse that private checkout again.
        if (checkout.rootPath !== input.prepared.rootPath
          || !isCanonicalAbsolutePathInsideRoot(input.prepared.rootPath, checkout.directory)) throw refusal();
        result = checkout;
      },
    } });
  // A settled canonical child can attest no-effect auth/admission refusal.
  // Abrupt transport loss cannot: clone may already have reserved its path.
  if (!outcome.settled && input.effect.request.materialization.kind === 'clone') onEffectsIssued();
  if (outcome.failure !== undefined) throw outcome.failure;
  if (failure) throw failure;
  if (!outcome.settled || !result || !outcome.exitedCleanly) throw refusal('workspace_effect_outcome_unknown');
  await input.verifyCurrent();
  return result;
}

/** The existing native invocation keeps the private pipe until the incumbent
 * relationship owner disposes it; no transfer re-selects a requester. */
export async function startPrivateProjectSyncProcess(input: PrivateProjectNativeProcessInput & Readonly<{
  configuration: PrivateProjectSyncEffectConfiguration;
  network: PrivateProjectSyncNetwork;
}>): Promise<PrivateProjectNativeSync> {
  const launch = await prepareNativeWorkspaceEffectLaunch(input);
  return startPrivateProjectSyncInvocation({ ...input, signal: input.launch.signal,
    services: input.connectedAccounts ? { connectedAccounts: createWorkspaceEffectConnectedAccounts({ effect: input.effect,
      owner: input.connectedAccounts, signal: input.launch.signal, assertCurrent: input.verifyCurrent }) } : {},
  }, services =>
    runWorkspaceEffectChild({ launch, signal: input.launch.signal, id: input.effect.workspaceRefId,
      effect: { kind: 'native_sync', checkout: input.effect, memberHome: input.memberRoot.identity.home },
      refusal: code => new PluginError({ code, message: 'The private workspace process is unavailable' }), services,
      beforeSpawn: async () => { await input.verifyCurrent(); input.launch.assertCurrent(); },
    }));
}


function retainNativeSyncPort(native: PrivateProjectNativeSyncProcessPort, disposeProcess: () => Promise<void>): PrivateProjectNativeSync {
  let closing: Promise<void> | undefined;
  return { ...native, borrowSourceRootForCopy: async request => {
        const loan = await native.borrowSourceRootForCopy(request);
        return loan && { ...loan, release: () => loan.dispose() };
      }, acquireWorkspaceSyncMachineIngress: async request => {
        const ingress = await native.acquireWorkspaceSyncMachineIngress(request);
        return { ...ingress, close: () => ingress.dispose() };
      }, openLocalWorkspaceAgentIngress: async request => {
        const ingress = await native.openLocalWorkspaceAgentIngress(request);
        return { ...ingress, close: () => ingress.dispose() };
      }, acquireLocalRoot: async request => {
        const result = await native.acquireLocalRoot(request);
        return 'kind' in result ? result : { ...result, release: () => result.dispose() };
      }, getPreparedBootstrapOwnership: async request => {
        const handle = await native.getPreparedBootstrapOwnership(request);
        return { ...handle, release: () => handle.dispose() };
      }, prepareBootstrapAtTarget: async (request, context) => {
        const result = await native.prepareBootstrapAtTarget(request, context);
        return { ...result, ...(result.ownershipHandles ? { ownershipHandles: result.ownershipHandles.map(handle => ({ ...handle, release: () => handle.dispose() })) } : {}) };
      }, dispose: () => closing ??= (async () => {
        try { await native.dispose(); } finally { await disposeProcess(); }
      })() };
}

/** A daemon-free guest uses the same credential-free worker and framed service
 * pipe as a native member. Its provider keeps the admitted channel alive. */
export async function startPrivateProjectSyncChannel(input: Readonly<{
  channel: Duplex;
  signal: AbortSignal;
  effect: WorkspaceCheckoutEffect;
  memberHome: string;
  configuration: PrivateProjectSyncEffectConfiguration;
  network: PrivateProjectSyncNetwork;
  onEffectsIssued(): void;
}>): Promise<PrivateProjectNativeSync> {
  return startPrivateProjectSyncInvocation(input, services => runWorkspaceEffectChannel({
    channel: input.channel, signal: input.signal, id: input.effect.workspaceRefId,
    effect: { kind: 'native_sync', checkout: input.effect, memberHome: input.memberHome }, services,
    refusal: code => new PluginError({ code, message: 'The native workspace process is unavailable' }),
  }));
}

async function startPrivateProjectSyncInvocation(input: Readonly<{
  services?: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  configuration: PrivateProjectSyncEffectConfiguration;
  network: PrivateProjectSyncNetwork;
  onEffectsIssued(): void;
}>, run: (services: Readonly<Record<string, unknown>>) => ReturnType<typeof runWorkspaceEffectChannel>): Promise<PrivateProjectNativeSync> {
  let resolveReady!: (value: PrivateProjectNativeSyncProcessPort) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<PrivateProjectNativeSyncProcessPort>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let completeNativeSync!: () => void;
  const nativeLifetime = new Promise<void>(resolve => { completeNativeSync = resolve; });
  const running = run({
    ...input.services,
    onEffectsIssued: async () => { input.onEffectsIssued(); },
    readNativeSyncConfiguration: async () => ({ configuration: input.configuration, network: input.network }),
    completeNativeSync: async (native: PrivateProjectNativeSyncProcessPort) => { resolveReady(native); await nativeLifetime; },
    fail: async (error: Error) => { rejectReady(error); },
  });
  const ended = running.then(outcome => {
    if (outcome.failure !== undefined) throw outcome.failure;
    throw new PluginError({ code: 'workspace_effect_outcome_unknown', message: 'The native workspace process ended' });
  });
  void ended.catch(() => {});
  const disposeProcess = async () => { completeNativeSync(); await running; };
  try { return retainNativeSyncPort(await Promise.race([ready, ended]), disposeProcess); }
  catch (error) { completeNativeSync(); await running.catch(() => {}); throw error; }
}
