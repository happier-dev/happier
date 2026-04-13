import {
  type AgentRuntimeDescriptorV1,
  type SessionHandoffResumePlan,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { MachineTransferChannel } from '../../../machines/transfer/serverRoutedTransport';
import { createMachineTransferRouteCache } from '../../../machines/transfer/transferRouteCache';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import {
  createSessionHandoffPrepareTargetJobStore,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import type { SessionHandoffProviderBundle } from '../../../session/handoff/types';
import {
  createSessionHandoffWorkspaceReplicationAdapter,
} from '../../../workspace/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter';

import type { RpcHandlerManager } from '../../rpc/RpcHandlerManager';
import {
  type SessionHandoffDirectPeerTransferHandle,
} from './rpcHandlers.sessionHandoff.prepareTransportResolution';
import {
  createSessionHandoffPrepareTargetWorkflow,
  type SessionHandoffPrepareTargetWorkflow,
} from './rpcHandlers.sessionHandoff.prepareTargetWorkflow';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
type SessionHandoffWorkspaceReplicationAdapter = ReturnType<typeof createSessionHandoffWorkspaceReplicationAdapter>;
type SessionHandoffWorkspaceReplicationTransfers = ReturnType<SessionHandoffWorkspaceReplicationAdapter['createReplicationTransfers']>;
type SessionHandoffTransportRouteCache = ReturnType<typeof createMachineTransferRouteCache>;

export type RegisterSessionHandoffPrepareTargetRpcHandlerInput = Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  activePrepareJobs: Map<string, Promise<void>>;
  prepareTargetJobLeaseOwnerId: string;
  prepareTargetJobLeaseTtlMs: number;
  machineTransferChannel: MachineTransferChannel | undefined;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle | undefined;
  workspaceReplicationAdapter: SessionHandoffWorkspaceReplicationAdapter;
  workspaceReplicationTransfers: SessionHandoffWorkspaceReplicationTransfers;
  importSessionBundle: (
    bundle: SessionHandoffProviderBundle,
    targetPath: string,
    sessionStorageMode: 'direct' | 'persisted',
  ) => Promise<Readonly<{
    remoteSessionId: string;
    directSource: Record<string, unknown>;
    agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
    resume: SessionHandoffResumePlan;
  }>>;
  savePreparedTargetLocalMetadata?: (input: Readonly<{
    remoteSessionId: string;
    exportMetadataOverlay: Record<string, unknown>;
  }>) => Promise<void> | void;
  getTransferRouteCache: (
    machineTransferChannel: MachineTransferChannel | undefined,
  ) => SessionHandoffTransportRouteCache;
  invalidateDirectPeerRouteCacheForHandoffMachines: (
    machineIds: readonly (string | undefined)[],
  ) => void;
}>;

export type RegisterSessionHandoffPrepareTargetRpcHandlerResult = Readonly<{
  restartPrepareTargetJobFromPersistedRequest: SessionHandoffPrepareTargetWorkflow['handlePrepareTargetRaw'];
}>;

export function registerSessionHandoffPrepareTargetRpcHandler(
  params: RegisterSessionHandoffPrepareTargetRpcHandlerInput,
): RegisterSessionHandoffPrepareTargetRpcHandlerResult {
  const {
    rpcHandlerManager,
    prepareJobStore,
    sourceExportStore,
    activePrepareJobs,
    prepareTargetJobLeaseOwnerId,
    prepareTargetJobLeaseTtlMs,
    machineTransferChannel,
    directPeerTransfer,
    workspaceReplicationAdapter,
    workspaceReplicationTransfers,
    importSessionBundle,
    savePreparedTargetLocalMetadata,
    getTransferRouteCache,
    invalidateDirectPeerRouteCacheForHandoffMachines,
  } = params;

  const workflow: SessionHandoffPrepareTargetWorkflow = createSessionHandoffPrepareTargetWorkflow({
    prepareJobStore,
    sourceExportStore,
    activePrepareJobs,
    prepareTargetJobLeaseOwnerId,
    prepareTargetJobLeaseTtlMs,
    machineTransferChannel,
    directPeerTransfer,
    workspaceReplicationAdapter,
    workspaceReplicationTransfers,
    importSessionBundle,
    savePreparedTargetLocalMetadata,
    getTransferRouteCache,
    invalidateDirectPeerRouteCacheForHandoffMachines,
  });

  rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
    workflow.handlePrepareTargetRaw,
  );

  return {
    restartPrepareTargetJobFromPersistedRequest: workflow.handlePrepareTargetRaw,
  };
}
