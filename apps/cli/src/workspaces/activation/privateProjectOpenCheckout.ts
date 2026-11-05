import { isDeepStrictEqual } from 'node:util';
import { basename } from 'node:path';
import type { OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import type { HostAgentIsolationLaunchContext, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { createAgentIsolationOperationContext } from '@/daemon/agentIsolation/agentIsolationSessionContext';
import { readAgentIsolationMemberWorkspaceRoot } from '@/daemon/agentIsolation/agentIsolationNativeIdentity';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import { preparePrivateProjectCheckout, admitPrivateProjectCheckoutDestination, privateProjectCheckoutRefusal } from './privateProjectCheckout';
import { prepareWorkspaceCheckoutEffect } from './workspaceEffect';
import { materializePrivateProjectCheckoutProcess, startPrivateProjectSyncProcess } from './privateProjectCheckoutProcess';
import type { PrivateProjectNativeSync, PrivateProjectSyncEffectConfiguration, PrivateProjectSyncNetwork } from './privateProjectSyncEffect';

type OperationMaterial = ReturnType<Parameters<typeof createAgentIsolationOperationContext>[0]['readMaterial']>;
export type PrivateProjectCheckoutOpenRuntime = Readonly<{
  /** Parent-owned common native producer, also consumed by filesystem effects.
   * It returns the common owner's already-prepared context, never a snapshot
   * assembled by Workspace and never an Account bootstrap. */
  prepareNativeOperation(input: Readonly<{
    requesterIdentity: HostRequesterExecutionIdentity;
    requesterAccount?: RequesterAccountActionContext;
    retainedRequesterCustody?: ReturnType<NonNullable<RequesterAccountActionContext['retainCustody']>>;
    ingress?: RpcHandlerContext;
    resolveRequesterIdentity: NonNullable<HostAgentIsolationLaunchContext['resolveRequesterIdentity']>;
    readMaterial(): OperationMaterial;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    agentIsolation: HostAgentIsolationLaunchContext;
    dispose(): Promise<void>;
    /** Existing exact-requester port captured by the same parent invocation.
     * Absence remains missing auth, never the daemon owner as a fallback. */
    connectedAccounts?: Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'listAccounts' | 'materialize'>;
  }>>;
}>;

/** Open's existing native invocation lifetime owns all captures here. The
 * accepted WorkspaceRef remains data, never native directory authority. */
export async function preparePrivateProjectOpenCheckout(input: Readonly<{
  runtime: PrivateProjectCheckoutOpenRuntime;
  requesterAccount?: RequesterAccountActionContext;
  retainedRequesterCustody?: ReturnType<NonNullable<RequesterAccountActionContext['retainCustody']>>;
  ingress?: RpcHandlerContext;
  request: OpenProjectInputV1;
  requesterIdentity: HostRequesterExecutionIdentity;
  workspaceRefs: readonly WorkspaceRefV1[];
  existingWorkspaceRefId?: string;
  /** Actual existing Action/native invocation key; no new identity is minted. */
  materializationKey: string;
  signal: AbortSignal;
  resolveRequesterIdentity: NonNullable<HostAgentIsolationLaunchContext['resolveRequesterIdentity']>;
  onEffectsIssued(): void;
}>) {
  const refuse = (): never => { throw privateProjectCheckoutRefusal(); };
  if (input.requesterIdentity.kind !== 'isolated' || !input.materializationKey) return refuse();
  const selected = input.requesterIdentity;
  const sync = input.request.materialization.kind === 'sync';
  const lifetime = new AbortController();
  let retained = false;
  const cancelOpen = () => { if (!retained) lifetime.abort(input.signal.reason); };
  input.signal.addEventListener('abort', cancelOpen, { once: true });
  if (input.signal.aborted) cancelOpen();
  const signal = sync ? lifetime.signal : input.signal;
  const releaseAccount = sync ? input.requesterAccount?.retain() : undefined;
  let live = true;
  const material = Object.freeze({ materializationKey: input.materializationKey,
    environment: Object.freeze({}), selectedMaterials: Object.freeze([]) });
  const native = await input.runtime.prepareNativeOperation({ requesterIdentity: selected, requesterAccount: input.requesterAccount,
    ...(input.retainedRequesterCustody ? { retainedRequesterCustody: input.retainedRequesterCustody } : {}),
    ingress: input.ingress ? { ...input.ingress, signal } : undefined,
    resolveRequesterIdentity: sync ? async () => { signal.throwIfAborted(); return selected; } : input.resolveRequesterIdentity,
    readMaterial: () => live && !signal.aborted ? material : undefined, signal }).catch(async error => {
      input.signal.removeEventListener('abort', cancelOpen);
      await releaseAccount?.();
      throw error;
    });
  let retainedRegistry: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | undefined;
  let nativeSync: PrivateProjectNativeSync | undefined;
  try {
  const agentIsolation = native.agentIsolation;
  const snapshot = agentIsolation.read();
  if (!snapshot?.memberIdentity || !snapshot.launch
    || !isDeepStrictEqual(snapshot.memberIdentity.requester, selected.requester)) return refuse();
  const memberRoot = await readAgentIsolationMemberWorkspaceRoot(snapshot.memberIdentity, undefined,
    { signal, daemonObservation: snapshot.daemonObservation });
  const materialization = input.request.materialization;
  const attach = materialization.kind === 'attach' && input.request.source.kind === 'workspace' && !!input.existingWorkspaceRefId;
  const existing = attach || sync && !!input.existingWorkspaceRefId;
  const prepared = preparePrivateProjectCheckout({ requesterIdentity: selected, memberRoot,
    workspaceRefs: input.workspaceRefs, ...(existing ? { workspaceRefId: input.existingWorkspaceRefId } : {}),
    createId: () => materialization.kind === 'clone' ? materialization.destinationDirectoryName
      : materialization.kind === 'sync' ? basename(materialization.targetPath) : refuse() });
  if (!attach) admitPrivateProjectCheckoutDestination({ prepared, materialization });
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  retainedRegistry = lease;
  let assertPluginCurrent = () => {};
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (!live) throw privateProjectCheckoutRefusal('workspace_private_checkout_retired');
    assertPluginCurrent();
    // Common owner checks the captured material and held Machine policy.
    agentIsolation.read();
  };
  const verifyCurrent = async () => {
    assertCurrent();
  };
  let disposal: Promise<void> | undefined;
  const release = () => disposal ??= (async () => {
    live = false;
    input.signal.removeEventListener('abort', cancelOpen);
    try { await nativeSync?.dispose(); }
    finally {
      lifetime.abort();
      try { await lease.release(); }
      finally { try { await native.dispose(); } finally { await releaseAccount?.(); } }
    }
  })();
  return {
    prepared,
    /** The existing relationship owner takes the admitted native lifetime. */
    retainForRelationship() { assertCurrent(); retained = true; input.signal.removeEventListener('abort', cancelOpen); },
    release,
    async startSync(configuration: PrivateProjectSyncEffectConfiguration, network: PrivateProjectSyncNetwork) {
      if (!sync || nativeSync) return refuse();
      await verifyCurrent();
      const child = await prepareWorkspaceCheckoutEffect({ request: input.request, workspaceRefId: prepared.workspaceRefId,
        workspaceRoot: memberRoot.workspaceRoot, registry: lease.registry });
      assertPluginCurrent = child.assertCurrent;
      nativeSync = await startPrivateProjectSyncProcess({ prepared, memberRoot, effect: child.effect,
        launch: { agentIsolation, requesterIdentity: selected, signal, assertCurrent },
        managedHappierBinaryPath: snapshot.launch!.managedHappierBinaryPath,
        connectedAccounts: native.connectedAccounts, verifyCurrent, onEffectsIssued: input.onEffectsIssued,
        configuration, network });
      return nativeSync;
    },
    validateCurrentRows(workspaceRefs: readonly WorkspaceRefV1[]) {
      preparePrivateProjectCheckout({ requesterIdentity: selected, memberRoot, workspaceRefs,
        ...(existing ? { workspaceRefId: prepared.workspaceRefId } : {}), createId: () => prepared.workspaceRefId });
    },
    async materialize() {
      await verifyCurrent();
      if (sync) {
        if (!nativeSync) return refuse();
        return nativeSync.inspectCheckout(input.request.subdir);
      }
      const child = await prepareWorkspaceCheckoutEffect({ request: input.request, workspaceRefId: prepared.workspaceRefId,
        workspaceRoot: memberRoot.workspaceRoot, ...(attach ? { existingRootPath: prepared.rootPath } : {}), registry: lease.registry });
      assertPluginCurrent = child.assertCurrent;
      return materializePrivateProjectCheckoutProcess({ prepared, memberRoot, effect: child.effect,
        launch: { agentIsolation, requesterIdentity: selected, signal: input.signal, assertCurrent },
        managedHappierBinaryPath: snapshot.launch!.managedHappierBinaryPath,
        connectedAccounts: native.connectedAccounts, verifyCurrent, onEffectsIssued: input.onEffectsIssued });
    },
    async dispose() { if (!retained) await release(); },
  };
  } catch (error) {
    live = false;
    input.signal.removeEventListener('abort', cancelOpen);
    lifetime.abort();
    try {
      try { await retainedRegistry?.release(); }
      finally { try { await native.dispose(); } finally { await releaseAccount?.(); } }
    } catch {
      // Failed preparation must preserve its primary typed refusal. No cleanup
      // diagnostic includes native paths, requester attribution or credentials.
      logger.warnLocalFile('[Project Open] Cleanup failed', {
        code: 'workspace_private_checkout_cleanup_failed', phase: 'native_execution_cleanup',
      });
    }
    throw error;
  }
}

/** Reconnect consumes the relationship owner's captured native requester. The
 * ordinary preparation owner still proves the persisted target's private root;
 * no new Open, Action admission or requester selection is manufactured. */
export async function recoverPrivateProjectSyncCheckout(input: Readonly<{
  runtime: PrivateProjectCheckoutOpenRuntime;
  requesterIdentity: HostRequesterExecutionIdentity;
  requesterAccount?: RequesterAccountActionContext;
  retainedRequesterCustody?: ReturnType<NonNullable<RequesterAccountActionContext['retainCustody']>>;
  ingress?: RpcHandlerContext;
  target: WorkspaceRefV1;
  relationship: WorkspaceSyncRelationshipV1;
  configuration: PrivateProjectSyncEffectConfiguration;
  network: PrivateProjectSyncNetwork;
  signal: AbortSignal;
  onEffectsIssued?(): void;
}>): Promise<Readonly<{ native: PrivateProjectNativeSync; release(): Promise<void> }>> {
  const { relationship, target } = input;
  const sourceWorkspaceRefId = target.id === relationship.betaWorkspaceRefId ? relationship.alphaWorkspaceRefId
    : target.id === relationship.alphaWorkspaceRefId ? relationship.betaWorkspaceRefId : null;
  if (!sourceWorkspaceRefId || input.requesterIdentity.kind !== 'isolated') throw privateProjectCheckoutRefusal();
  const selected = input.requesterIdentity;
  const prepared = await preparePrivateProjectOpenCheckout({ runtime: input.runtime,
    requesterIdentity: selected, requesterAccount: input.requesterAccount,
    ...(input.retainedRequesterCustody ? { retainedRequesterCustody: input.retainedRequesterCustody } : {}),
    ingress: input.ingress, workspaceRefs: input.configuration.snapshot.workspaceRefs, existingWorkspaceRefId: target.id,
    request: { serverId: input.configuration.serverId, machineId: input.configuration.machineId,
      source: { kind: 'workspace', workspaceId: sourceWorkspaceRefId },
      materialization: { kind: 'sync', targetPath: target.rootPath,
        workspaceAction: { kind: 'relationship', relationshipId: relationship.relationshipId, flushBeforeCommit: false } } },
    materializationKey: relationship.relationshipId, signal: input.signal,
    resolveRequesterIdentity: async () => { input.signal.throwIfAborted(); return selected; },
    onEffectsIssued: input.onEffectsIssued ?? (() => {}),
  });
  try {
    const native = await prepared.startSync(input.configuration, input.network);
    return { native, release: prepared.release };
  } catch (error) { await prepared.release(); throw error; }
}
