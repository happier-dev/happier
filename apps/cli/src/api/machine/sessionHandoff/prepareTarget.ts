import {
  type RuntimeDescriptorV1,
  type SessionHandoffResumePlan,
} from '@happier-dev/protocol';

import type { MachineTransferChannel } from '../../../machines/transfer/serverRoutedTransport';
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
import type { RunSessionHandoffPrepareTargetJobInput } from './prepareTargetRunJob';
import type { ResolvePrepareTargetBootstrapInput } from './prepareTargetBootstrap';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { SessionHandoffPrepareTargetRequestSchema } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;

export type RegisterSessionHandoffPrepareTargetRpcHandlerInput = Readonly<{
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  activePrepareJobs: Map<string, Promise<void>>;
  prepareTargetJobLeaseOwnerId: string;
  runtimeConfig: SessionHandoffRuntimeConfig;
  machineTransferChannel: MachineTransferChannel | undefined;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle | undefined;
  existingStateSupported?: boolean;
  prepareManagedDirectoryPlacement?: (request: Parameters<NonNullable<ResolvePrepareTargetBootstrapInput['prepareManagedDirectoryPlacement']>>[0], context?: RpcHandlerContext) => ReturnType<NonNullable<ResolvePrepareTargetBootstrapInput['prepareManagedDirectoryPlacement']>>;
  resolveExistingSessionState?: (request: Parameters<NonNullable<RunSessionHandoffPrepareTargetJobInput['resolveExistingSessionState']>>[0], targetPath: string, context?: RpcHandlerContext) => ReturnType<NonNullable<RunSessionHandoffPrepareTargetJobInput['resolveExistingSessionState']>>;
  prepareMemberImport?: (context?: RpcHandlerContext) => Promise<RunSessionHandoffPrepareTargetJobInput['memberImport']>;
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
}>;

export type RegisterSessionHandoffPrepareTargetRpcHandlerResult = Readonly<{
  handle: (raw: unknown, context?: RpcHandlerContext) => ReturnType<SessionHandoffPrepareTargetWorkflow['handlePrepareTargetRaw']>;
  resumePersistedPrepareTarget: (record: Parameters<SessionHandoffPrepareTargetWorkflow['resumePersistedPrepareTarget']>[0], context?: RpcHandlerContext) => Promise<void>;
}>;

export function createSessionHandoffPrepareTargetActionHandler(
  params: RegisterSessionHandoffPrepareTargetRpcHandlerInput,
): RegisterSessionHandoffPrepareTargetRpcHandlerResult {
  const createWorkflow = (context?: RpcHandlerContext) => createSessionHandoffPrepareTargetWorkflow({ ...params,
    ...(params.prepareManagedDirectoryPlacement ? { prepareManagedDirectoryPlacement: request => params.prepareManagedDirectoryPlacement!(request, context) } : {}),
    ...(params.resolveExistingSessionState ? { resolveExistingSessionState: (request, targetPath) => params.resolveExistingSessionState!(request, targetPath, context) } : {}),
    ...(params.prepareMemberImport ? { prepareMemberImport: () => params.prepareMemberImport!(context) } : {}),
  });

  return {
    handle: async (raw: unknown, context?: RpcHandlerContext) => {
      if (hasUnsupportedWorkspaceAction(raw)) return workspaceSyncUpdateRequired();
      const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse(raw);
      if (parsed.success && parsed.data.stateTransfer === 'existing') {
        if (params.existingStateSupported !== true) return { ok: false, errorCode: 'handoff_existing_state_update_required' } as const;
        return createWorkflow(context).handlePrepareTargetRaw(raw);
      }
      return await createWorkflow(context).handlePrepareTargetRaw(raw);
    },
    resumePersistedPrepareTarget: async (record, context) => {
      await createWorkflow(context).resumePersistedPrepareTarget(record);
    },
  };
}
