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
  type SessionHandoffDirectPeerTransferHandle,
} from './prepareTransport';
import type { SessionHandoffRuntimeConfig } from './runtimeConfig';
import {
  createSessionHandoffPrepareTargetWorkflow,
  type SessionHandoffPrepareTargetWorkflow,
} from './prepareTargetWorkflow';
import { hasUnsupportedWorkspaceAction, workspaceSyncUpdateRequired } from './workspaceSyncGuard';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
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
    importSessionBundle,
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
    importSessionBundle,
    getTransferRouteCache,
    invalidateDirectPeerRouteCacheForHandoffMachines,
  });

  return {
    handle: async (raw: unknown) => {
      if (hasUnsupportedWorkspaceAction(raw)) return workspaceSyncUpdateRequired();
      return await workflow.handlePrepareTargetRaw(raw);
    },
    resumePersistedPrepareTarget: workflow.resumePersistedPrepareTarget,
  };
}
