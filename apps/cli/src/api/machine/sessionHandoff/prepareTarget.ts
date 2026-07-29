import {
  type RuntimeDescriptorV1,
  type SessionHandoffResumePlan,
} from '@happier-dev/protocol';

import type { MachineTransferChannel } from '../../../machines/transfer/serverRoutedTransport';
import { createMachineTransferRouteCache } from '../../../machines/transfer/transferRouteCache';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import {
  createSessionHandoffPrepareTargetJobStore,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';
import {
  createSessionHandoffWorkspaceReplicationAdapter,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';

import {
  type SessionHandoffDirectPeerTransferHandle,
} from './prepareTransport';
import type { SessionHandoffRuntimeConfig } from './runtimeConfig';
import {
  createSessionHandoffPrepareTargetWorkflow,
  type SessionHandoffPrepareTargetWorkflow,
} from './prepareTargetWorkflow';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
type SessionHandoffWorkspaceReplicationAdapter = ReturnType<typeof createSessionHandoffWorkspaceReplicationAdapter>;
type SessionHandoffWorkspaceReplicationTransfers = ReturnType<SessionHandoffWorkspaceReplicationAdapter['createReplicationTransfers']>;
type SessionHandoffTransportRouteCache = ReturnType<typeof createMachineTransferRouteCache>;

export type RegisterSessionHandoffPrepareTargetRpcHandlerInput = Readonly<{
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  activePrepareJobs: Map<string, Promise<void>>;
  prepareTargetJobLeaseOwnerId: string;
  prepareTargetJobLeaseTtlMs: number;
  runtimeConfig: SessionHandoffRuntimeConfig;
  machineTransferChannel: MachineTransferChannel | undefined;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle | undefined;
  workspaceReplicationAdapter: SessionHandoffWorkspaceReplicationAdapter;
  workspaceReplicationTransfers: SessionHandoffWorkspaceReplicationTransfers;
  importSessionBundle: (
    bundle: SessionHandoffAgentBundle,
    targetPath: string,
    sessionStorageMode: 'direct' | 'persisted',
  ) => Promise<Readonly<{
    remoteSessionId: string;
    directSource: Record<string, unknown>;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
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
  handle: SessionHandoffPrepareTargetWorkflow['handlePrepareTargetRaw'];
  resumePersistedPrepareTarget: SessionHandoffPrepareTargetWorkflow['resumePersistedPrepareTarget'];
}>;

export function createSessionHandoffPrepareTargetActionHandler(
  params: RegisterSessionHandoffPrepareTargetRpcHandlerInput,
): RegisterSessionHandoffPrepareTargetRpcHandlerResult {
  const {
    prepareJobStore,
    sourceExportStore,
    activePrepareJobs,
    prepareTargetJobLeaseOwnerId,
    prepareTargetJobLeaseTtlMs,
    runtimeConfig,
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
    runtimeConfig,
    machineTransferChannel,
    directPeerTransfer,
    workspaceReplicationAdapter,
    workspaceReplicationTransfers,
    importSessionBundle,
    savePreparedTargetLocalMetadata,
    getTransferRouteCache,
    invalidateDirectPeerRouteCacheForHandoffMachines,
  });

  return {
    handle: workflow.handlePrepareTargetRaw,
    resumePersistedPrepareTarget: workflow.resumePersistedPrepareTarget,
  };
}
