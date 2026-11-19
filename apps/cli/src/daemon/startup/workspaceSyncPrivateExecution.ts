import { assertWorkspaceSyncSeedExportSucceeded, prepareSignedWorkspaceSyncSeed } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { TransferEndpointCandidateSchema } from '@happier-dev/protocol/machines/transfer/transferStream';
import { buildDirectPeerTransferEndpointPath } from '@/machines/transfer/directPeerTransport';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import type { PrepareWorkspaceSyncPrivateExecutionInput, WorkspaceSyncPrivateExecution } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import type { PrivateProjectSyncNetwork } from '@/workspaces/activation/privateProjectSyncEffect';
import type { WorkspaceSyncMachineTunnelOpen } from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import type { ProductionDaemonWorkspaceSyncFactories, createProductionDaemonWorkspaceSyncRuntime } from './createProductionDaemonWorkspaceSyncRuntime';
import type { RpcHandlerContext } from '@/api/rpc/types';

type PrivateExecutionDependencies = Readonly<{
  resolveNativeAgent(): Promise<Readonly<{ executablePath: string }>>;
  refreshProjectRows: ProductionDaemonWorkspaceSyncFactories['refreshProjectRows'];
  callMachineRpc: ProductionDaemonWorkspaceSyncFactories['callMachineRpc'];
  openMachineCarrierTunnel?: WorkspaceSyncMachineTunnelOpen;
  callWorkspaceSeedExport?: Parameters<typeof createProductionDaemonWorkspaceSyncRuntime>[0]['callWorkspaceSeedExport'];
  readChildMachineFacts: NonNullable<PrivateProjectSyncNetwork['readChildMachineFacts']>;
}>;

function unavailable(): Error {
  return Object.assign(new Error('The private Workspace Sync source is unavailable'), { code: 'target_bootstrap_offline' });
}

/** One signed SOURCE export owner for host and managed-member receivers. */
export function createPrivateWorkspaceSyncSourceSeedPreparation(request: Readonly<{
  targetMachineId: string;
  credentials: PrepareWorkspaceSyncPrivateExecutionInput['credentials'];
  getTargetPhaseContext(): RpcHandlerContext | undefined;
}>, dependencies: Pick<PrivateExecutionDependencies, 'openMachineCarrierTunnel' | 'callWorkspaceSeedExport' | 'callMachineRpc'>): PrivateProjectSyncNetwork['prepareSourceSeed'] {
  return async seed => {
    const openCarrier = dependencies.openMachineCarrierTunnel;
    const context = request.getTargetPhaseContext();
    if ((seed.sourceMachineId !== request.targetMachineId && !openCarrier) || !context || !dependencies.callWorkspaceSeedExport) throw unavailable();
    const { result: raw, tunnel: issuedTunnel } = await prepareSignedWorkspaceSyncSeed({
      sourceMachineId: seed.sourceMachineId,
      request: { t: 'workspace_sync_seed_v1', operationId: seed.operationId, sourceWorkspaceRefId: seed.sourceWorkspaceRefId,
        targetMachineId: request.targetMachineId, contentPolicy: seed.contentPolicy,
        ...(seed.exclusionCandidates ? { exclusionCandidates: seed.exclusionCandidates } : {}) },
      context, callExport: dependencies.callWorkspaceSeedExport, openTunnel: openCarrier,
      ...(seed.signal ? { signal: seed.signal } : {}),
    });
    try {
      assertWorkspaceSyncSeedExportSucceeded(raw);
      if (!raw || typeof raw !== 'object' || !('success' in raw) || raw.success !== true
        || !('transferId' in raw) || raw.transferId !== seed.operationId || !('sizeBytes' in raw)
        || typeof raw.sizeBytes !== 'number' || !Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 0
        || !('manifestHash' in raw) || typeof raw.manifestHash !== 'string'
        || !('endpointCandidates' in raw) || !Array.isArray(raw.endpointCandidates)) throw unavailable();
      const source = raw.endpointCandidates.map(candidate => TransferEndpointCandidateSchema.parse(candidate))[0];
      if (!source) throw unavailable();
      return {
        transferId: seed.operationId, sizeBytes: raw.sizeBytes, manifestHash: raw.manifestHash,
        openPayload: async payload => {
          const tunnel = issuedTunnel ?? (seed.sourceMachineId === request.targetMachineId ? null : await openCarrier!({ sourceMachineId: request.targetMachineId,
            targetMachineId: seed.sourceMachineId, flow: 'file_transfer', ...(payload.signal ? { signal: payload.signal } : {}) }));
          const url = new URL(source.url);
          url.protocol = 'http:'; url.hostname = '127.0.0.1';
          if (tunnel) url.port = String(tunnel.localPort);
          url.pathname = buildDirectPeerTransferEndpointPath(payload.transferId);
          return { endpointCandidates: [{ ...source, kind: 'http' as const, url: url.toString() }], dispose: async () => { if (!issuedTunnel) await tunnel?.close(); } };
        },
        dispose: async () => {
          if (issuedTunnel) {
            // SOURCE retains and expires this publication with its existing bounded export lifecycle.
            await issuedTunnel.close();
            return;
        }
          await dependencies.callMachineRpc({ credentials: request.credentials, machineId: seed.sourceMachineId,
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE, request: { transferId: seed.operationId }, timeoutMs: null });
        },
      };
    } catch (error) {
      await issuedTunnel?.close();
      throw error;
    }
  };
}

/** Requester network custody stays in the host; target bytes stay in the member. */
export async function preparePrivateWorkspaceSyncExecution(request: PrepareWorkspaceSyncPrivateExecutionInput,
  dependencies: PrivateExecutionDependencies): Promise<WorkspaceSyncPrivateExecution> {
  let snapshot: ActiveProjectAccountRowsSnapshot = request.snapshot;
  let targetPhaseContext: RpcHandlerContext | undefined = request.context;
  const projectSnapshot = (next: ActiveProjectAccountRowsSnapshot): ActiveProjectAccountRowsSnapshot => {
    if (request.input.action.kind !== 'copy_once'
      || next.workspaceRefs.some(ref => ref.id === request.input.targetWorkspaceRefId && ref.serverId === request.accountRowsCustody.serverId)) return next;
    // The finite Open accepts this already prepared native identity after its
    // copy finishes. Its operation capture owns that initial projection.
    const target = request.snapshot.workspaceRefs.find(ref => ref.id === request.input.targetWorkspaceRefId
      && ref.serverId === request.accountRowsCustody.serverId);
    return target ? { ...next, workspaceRefs: [...next.workspaceRefs, target] } : next;
  };
  const network: PrivateProjectSyncNetwork = {
    refreshProjectSnapshot: async signal => {
      snapshot = projectSnapshot(await dependencies.refreshProjectRows({ credentials: request.credentials,
        sessionCustody: request.accountRowsCustody, serverId: request.accountRowsCustody.serverId,
        selection: { kinds: ['workspace-ref', 'relationship-graph'] }, ...(signal ? { signal } : {}) }));
      return snapshot;
    },
    readChildMachineFacts: dependencies.readChildMachineFacts,
    callMachineRpc: async call => dependencies.callMachineRpc({ credentials: request.credentials,
      machineId: call.machineId, method: call.method, request: call.request, timeoutMs: null,
      ...(call.signal ? { signal: call.signal } : {}) }),
    ...(request.callTargetPhase ? { callWorkspaceTargetPhase: request.callTargetPhase } : {}),
    prepareSourceSeed: createPrivateWorkspaceSyncSourceSeedPreparation({ targetMachineId: request.input.targetMachineId,
      credentials: request.credentials, getTargetPhaseContext: () => targetPhaseContext }, dependencies),
  };
  const nativeSync = await request.createNativeSync({ configuration: { serverId: request.accountRowsCustody.serverId,
    machineId: request.executionIdentity?.kind === 'isolated'
      ? request.executionIdentity.requester.machineId : request.input.targetMachineId,
    accountId: request.accountRowsCustody.accountId,
    snapshot, agent: await dependencies.resolveNativeAgent() }, network });
  return { credentials: request.credentials, accountRowsCustody: request.accountRowsCustody,
    ...(request.callTargetPhase ? { callTargetPhase: request.callTargetPhase } : {}),
    ...(request.recoverConflictResolutionAtTarget ? { recoverConflictResolutionAtTarget: request.recoverConflictResolutionAtTarget } : {}),
    ...(request.executionIdentity ? { executionIdentity: request.executionIdentity } : {}), nativeSync,
    getSnapshot: () => snapshot,
    bindTargetPhaseContext: context => { targetPhaseContext = context; },
    replaceSnapshot: async next => { snapshot = projectSnapshot(next); await nativeSync.replaceSnapshot(snapshot); },
    assertTransferCurrent: request.assertTransferCurrent,
    ...(request.retainRelationship ? { retainRelationship: request.retainRelationship } : {}),
    release: request.release };
}
