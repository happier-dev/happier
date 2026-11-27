import { VENDOR_HANDOFF_UNSUPPORTED } from '@happier-dev/agents';
import { logger } from '@/ui/logger';
import { isActionExecuteFailure, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveSessionHandoffLocalDirectory } from '../../../session/handoff/paths/sessionHandoffPathNormalization';
import { resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { SessionHandoffMetadataV2, SessionHandoffStartRequest, SessionHandoffStatus, TransferEndpointCandidate } from '@happier-dev/protocol';
import { SessionHandoffStartRequestSchema } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { resolveMachineTransferRoute } from '@happier-dev/transfers';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { SessionHandoffPrepareTargetJobRecordInput } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import type { SessionHandoffSourceExportRecord } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';
import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';
import type {
  ExternalSessionOperationClaim,
  ExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { SessionHandoffExistingStateCheckRequestV3 } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import type { PreparedSessionHandoffAgentBundleExport } from '@/session/handoff/agentBundle/export';
import { hasUnsupportedWorkspaceAction, workspaceSyncUpdateRequired } from './workspaceSyncGuard';

type SessionHandoffSourceStopState = 'stopped' | 'already_inactive' | 'failed';

type SessionHandoffPrepareJobStoreLike = Readonly<{
  write: (record: SessionHandoffPrepareTargetJobRecordInput) => Promise<void>;
}>;

type SessionHandoffSourceExportStoreLike = Readonly<{
  save: (record: Readonly<Omit<SessionHandoffSourceExportRecord, 't' | 'schemaVersion'>>) => Promise<void>;
  writeAgentBundleFile: (params: Readonly<{
    handoffId: string;
    agentBundle: SessionHandoffAgentBundle;
    onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
  }>) => Promise<Readonly<{
    transferId: string;
    filePath: string;
    sizeBytes: number;
    manifestHash: string;
    endpointCandidates?: readonly TransferEndpointCandidate[];
  }>>;
}>;

type PrepareStartedStateResult = Readonly<{
  nextState: Readonly<{
    status: SessionHandoffStatus;
    handoffMetadataV2?: SessionHandoffMetadataV2;
  }>;
  endpointCandidates: readonly TransferEndpointCandidate[];
  targetPath: string;
}>;

export type RegisterSessionHandoffStartRpcHandlerInput = Readonly<{
  activeServerDir: string;
  createUuid: () => string;
  loadSessionMetadata: (
    sessionId: string,
    sourceMachineId?: string,
    context?: RpcHandlerContext,
  ) => Promise<Record<string, unknown> | null>;
  machineTransferChannelPresent: boolean;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle | undefined;
  resolveServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
  admitExistingSessionState?: (peerMachineId: string, context?: RpcHandlerContext, checkRequest?: SessionHandoffExistingStateCheckRequestV3) => Promise<Readonly<{ ok: false; errorCode: string; error?: string }> | null>;
  stopSessionForHandoff?: (sessionId: string) => Promise<SessionHandoffSourceStopState>;
  prepareJobStore: SessionHandoffPrepareJobStoreLike;
  sourceExportStore: SessionHandoffSourceExportStoreLike;
  prepareStartedState: (params: Readonly<{
    handoffId: string;
    request: SessionHandoffStartRequest;
    metadata: Record<string, unknown>;
    sourceStopState: Exclude<SessionHandoffSourceStopState, 'failed'>;
    exportSessionBundle?: PreparedSessionHandoffAgentBundleExport;
    onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
  }>) => Promise<PrepareStartedStateResult>;
  exportSessionBundle: (
    metadata: Record<string, unknown>,
  ) => Promise<Readonly<{
    agentBundle: SessionHandoffAgentBundle;
    targetPath: string;
  }>>;
  /** `requester` is the Account bound to this Session at admission; absent for the Machine's own Sessions. */
  prepareSessionBundleExport?: (
    metadata: Record<string, unknown>,
    requester?: Readonly<{ accountId: string }>,
  ) => Promise<PreparedSessionHandoffAgentBundleExport>;
  buildStartPendingStatus: (input: Readonly<{
    handoffId: string;
    sourceStopState: 'stopped' | 'already_inactive';
  }>) => SessionHandoffStatus;
  buildStartRecoveryStatus: (handoffId: string) => SessionHandoffStatus;
  buildPrepareJobRecord: (input: Readonly<{
    jobId: string;
    handoffId: string;
    status: SessionHandoffStatus;
    createdAtMs: number;
    updatedAtMs?: number;
    failedAtMs?: number;
    lastErrorMessage?: string;
    lastErrorCode?: string;
  }>) => SessionHandoffPrepareTargetJobRecordInput;
  invalidRequest: () => Readonly<{
    ok: false;
    errorCode: 'invalid_request';
  }>;
  sessionOperationExclusion: ExternalSessionOperationExclusion;
  retainSessionOperationClaim: (
    handoffId: string,
    claim: ExternalSessionOperationClaim,
  ) => void;
  releaseSessionOperationClaim: (handoffId: string) => Promise<void>;
}>;

function resolveSessionHandoffTargetPathFromMetadata(metadata: Record<string, unknown>): string | null {
  const targetPath = typeof metadata.path === 'string' ? metadata.path.trim() : '';
  return targetPath.length > 0 ? targetPath : null;
}

function serializeSessionHandoffSemanticRequest(request: SessionHandoffStartRequest): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalize(entryValue)]),
    );
  };
  return JSON.stringify(normalize(request));
}

export function createSessionHandoffStartActionHandler(
  params: RegisterSessionHandoffStartRpcHandlerInput,
): (raw: unknown, context?: RpcHandlerContext) => Promise<unknown> {
  const {
    createUuid,
    loadSessionMetadata,
    machineTransferChannelPresent,
    directPeerTransfer,
    resolveServerFeaturesSnapshot,
    stopSessionForHandoff,
    sourceExportStore,
    prepareStartedState,
    buildStartRecoveryStatus,
    invalidRequest,
    sessionOperationExclusion,
    retainSessionOperationClaim,
    releaseSessionOperationClaim,
  } = params;

  return async (raw: unknown, context?: RpcHandlerContext) => {
    if (hasUnsupportedWorkspaceAction(raw)) return workspaceSyncUpdateRequired();
    const parsed = SessionHandoffStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();
    context?.signal?.throwIfAborted();
    const serverFeaturesSnapshot = await resolveServerFeaturesSnapshot?.();
    context?.signal?.throwIfAborted();
    const serverFeatures = serverFeaturesSnapshot?.status === 'ready'
      ? serverFeaturesSnapshot.features
      : null;
    if (!serverFeatures) {
      return {
        ok: false,
        errorCode: 'server_features_unavailable',
        error: 'Machine transfer policy is unavailable on the selected server',
      } as const;
    }
    if (readServerEnabledBit(serverFeatures, 'sessions.handoff') !== true) {
      return {
        ok: false,
        errorCode: 'handoff_disabled',
        error: 'Session handoff is disabled on the selected server',
      } as const;
    }
    const sameMachine = parsed.data.sourceMachineId === parsed.data.targetMachineId;
    if (parsed.data.stateTransfer === 'existing' && !params.admitExistingSessionState) {
      return { ok: false, errorCode: 'handoff_existing_state_update_required' } as const;
    }
    const transport = sameMachine
      ? { kind: 'available' as const, strategy: 'direct_peer' as const }
      : resolveMachineTransferRoute({
      serverFeatures,
      preferredStrategies: parsed.data.negotiatedTransportStrategy
        ? [parsed.data.negotiatedTransportStrategy, ...parsed.data.preferredTransportStrategies]
        : parsed.data.preferredTransportStrategies,
      directPeerAvailable: directPeerTransfer !== undefined,
    });
    if (transport.kind === 'unavailable') {
      return {
        ok: false,
        errorCode: transport.reasonCode,
        error: 'Machine transfer is disabled on the selected server',
      } as const;
    }
    if (transport.strategy === 'server_relay_stream' && !machineTransferChannelPresent) {
      return {
        ok: false,
        errorCode: 'transport_unavailable',
        error: 'transport_unavailable',
      } as const;
    }
    const negotiatedTransportStrategy = transport.strategy === 'server_relay_stream'
      ? 'server_routed_stream'
      : transport.strategy;
    let request: SessionHandoffStartRequest = {
      ...parsed.data,
      negotiatedTransportStrategy,
    };

    const reportBundleProgress = (label: string) => (
      progress: Readonly<{ currentBytes: number; totalBytes: number }>,
    ) => {
      context?.localActionContext?.operationOwnerUpdate?.update({
        progress: progress.totalBytes > 0
          ? {
              phase: 'packaging_session_state',
              current: Math.min(progress.currentBytes, progress.totalBytes),
              total: progress.totalBytes,
              label,
            }
          : { phase: 'packaging_session_state', label },
      });
    };

    const metadata = await loadSessionMetadata(request.sessionId, request.sourceMachineId, context);
    if (!metadata) {
      return { ok: false, errorCode: 'session_not_found' } as const;
    }
    const sourcePath = resolveSessionWorkspaceRootForMachine({ metadata, machineId: request.sourceMachineId,
      candidatePath: typeof metadata.path === 'string' ? metadata.path : '' }).machinePath;
    if (sameMachine && request.stateTransfer === 'existing' && typeof request.targetPath !== 'string') {
      request = { ...request, targetPath: sourcePath };
    }
    if (sameMachine && request.targetDirectory?.kind !== 'managed') {
      const homeDir = resolveHomeDirFromEnvironment();
      const targetDirectory = await resolveSessionHandoffLocalDirectory({ path: typeof request.targetPath === 'string' ? request.targetPath : '', homeDir });
      const sourceDirectory = await resolveSessionHandoffLocalDirectory({ path: sourcePath, homeDir });
      if (!targetDirectory || !sourceDirectory || (request.stateTransfer !== 'existing' && targetDirectory === sourceDirectory)) {
        return { ok: false, errorCode: 'invalid_target_path', error: 'Choose a different working directory for same-machine handoff' } as const;
      }
    }
    // Storage authority is the SOURCE daemon's to derive, from the full owner
    // metadata it just loaded, and it is derived HERE — before the operation
    // claim, before any stop, before any export. Every stop below is
    // irreversible for the caller, so a Session whose link cannot be resolved
    // must produce zero effect rather than be carried through as "persisted".
    const sourceTranscriptAuthority = resolveLinkedExternalSessionAuthorityV1(metadata);
    if (!sourceTranscriptAuthority.ok) {
      return {
        ok: false,
        errorCode: sourceTranscriptAuthority.error,
        error: `${sourceTranscriptAuthority.error}:${sourceTranscriptAuthority.reason}`,
      } as const;
    }
    if (sourceTranscriptAuthority.transcriptStorage !== request.sessionStorageMode) {
      return {
        ok: false,
        errorCode: 'session_storage_mode_mismatch',
        error: 'The source Session storage mode changed before handoff started',
      } as const;
    }
    if (request.stateTransfer === 'existing') {
      const targetPath = typeof request.targetPath === 'string' ? request.targetPath : resolveSessionHandoffTargetPathFromMetadata(metadata);
      if (!targetPath) return { ok: false, errorCode: 'invalid_target_path' } as const;
      const refusal = await params.admitExistingSessionState!(request.targetMachineId, context, {
        sessionId: request.sessionId, sourceMachineId: request.sourceMachineId, targetMachineId: request.targetMachineId,
        targetPath, sourceSessionStorageMode: request.sessionStorageMode,
      });
      if (refusal) return refusal;
      context?.signal?.throwIfAborted();
    }
    let preparedExport: PreparedSessionHandoffAgentBundleExport | undefined;
    if (request.stateTransfer !== 'existing' && params.prepareSessionBundleExport) {
      try {
        // The admission owner already marked the custodian's own bootstrap (native credentials allowed).
        const bound = context?.requesterSessionBootstrap;
        const requester = bound?.getBoundSessionId() === request.sessionId && !bound.allowNativeAccountCredentials
          ? bound.attribution : undefined;
        preparedExport = await params.prepareSessionBundleExport(metadata, requester);
      } catch (error) {
        const failureCause = projectActionFailureCauseV1(error, 'session_handoff.source_export');
        logger.warnLocalFile('[session-handoff] source_export_failed', { catch: 'preparation',
          errorClass: failureCause.errorClass, errorCode: failureCause.errorCode,
          ...('nativeErrorCode' in failureCause ? { nativeErrorCode: failureCause.nativeErrorCode } : {}),
          ...(context?.transportRequestId ? { requestId: context.transportRequestId } : {}),
        });
        if (isActionExecuteFailure(error) && error.errorCode === VENDOR_HANDOFF_UNSUPPORTED) {
          return { ...error, effectAttempted: false };
        }
        return { ok: false, errorCode: 'source_export_failed', effectAttempted: false, error: error instanceof Error ? error.message : 'Failed to prepare session handoff export',
          failureCause,
          ...(isActionExecuteFailure(error) && error.details !== undefined ? { details: error.details } : {}),
        } as const;
      }
    }
    const prepareAdmittedState = (callInput: Parameters<typeof prepareStartedState>[0]) => prepareStartedState({
      ...callInput,
      ...(preparedExport ? { exportSessionBundle: preparedExport } : {}),
    });

    const handoffId = `handoff_${createUuid()}`;
    const operationRequestId = `handoff:${request.sessionId}:${request.sourceMachineId}:${request.targetMachineId}:${request.sessionStorageMode}:${request.negotiatedTransportStrategy}`;
    const exclusionRequest = {
      kind: 'handoff',
      sessionId: request.sessionId,
      requestId: operationRequestId,
      sourceMachineId: request.sourceMachineId,
      targetMachineId: request.targetMachineId,
      semanticRequest: serializeSessionHandoffSemanticRequest(request),
    } as const;
    const exclusion = context?.signal
      ? await sessionOperationExclusion.acquire(exclusionRequest, {
        signal: context.signal,
      })
      : await sessionOperationExclusion.acquire(exclusionRequest);
    if (exclusion.status !== 'acquired') {
      return {
        ok: false,
        errorCode: 'session_operation_in_progress',
        error: 'Another session operation is already in progress',
      } as const;
    }
    retainSessionOperationClaim(handoffId, exclusion.claim);
    try {
    if (context?.callerInputAuthorization || context?.requesterSessionBootstrap) {
      // Accept the original Home root before quiescing its Session publisher.
      // Later phases derive their authority from this same protected record.
      await sourceExportStore.save({ handoffId,
        sessionId: request.sessionId, sourceMachineId: request.sourceMachineId,
        targetMachineId: request.targetMachineId, exportedAtMs: Date.now(),
        ...(context.callerInputAuthorization ? { acceptedHandoffAuthorization: context.callerInputAuthorization } : {}),
        ...(context.requesterSessionBootstrap?.getBoundSessionId() === request.sessionId ? {
          requesterSessionCredentialBinding: { sessionId: request.sessionId, attribution: context.requesterSessionBootstrap.attribution },
        } : {}),
      });
    }
    let exportAfterStop = false;
    try {
      const stopState =
        stopSessionForHandoff
          ? await stopSessionForHandoff(request.sessionId)
          : 'already_inactive';
      if (stopState === 'failed') {
        await releaseSessionOperationClaim(handoffId);
        return {
          ok: false,
          errorCode: 'source_stop_failed',
          error: 'Failed to stop the active source session before handoff cutover',
        } as const;
      }
      exportAfterStop = stopState === 'stopped';
      const prepared = await prepareAdmittedState({
        handoffId,
        request,
        metadata,
        sourceStopState: stopState,
        onProgress: reportBundleProgress('Packaging session state'),
      });

      return {
        handoffId,
        status: {
          ...prepared.nextState.status,
          transportStrategy: request.negotiatedTransportStrategy,
        },
        endpointCandidates: prepared.endpointCandidates,
        targetPath: prepared.targetPath,
        ...(prepared.nextState.handoffMetadataV2 ? { handoffMetadataV2: prepared.nextState.handoffMetadataV2 } : {}),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to export session handoff state';
      const failureCause = projectActionFailureCauseV1(error, 'session_handoff.source_export');
      logger.warnLocalFile('[session-handoff] source_export_failed', { catch: 'export',
        errorClass: failureCause.errorClass, errorCode: failureCause.errorCode,
        ...('nativeErrorCode' in failureCause ? { nativeErrorCode: failureCause.nativeErrorCode } : {}),
        ...(context?.transportRequestId ? { requestId: context.transportRequestId } : {}),
      });
      const errorCode = error !== null && typeof error === 'object' && 'code' in error
        && error.code === 'SESSION_DIRECTORY_MISSING' ? error.code : 'source_export_failed';
      const failure = isActionExecuteFailure(error) && error.errorCode === VENDOR_HANDOFF_UNSUPPORTED
        ? { ...error }
        : {
          ok: false,
          errorCode,
          error: errorMessage,
          failureCause,
          ...(isActionExecuteFailure(error) && error.details !== undefined ? { details: error.details } : {}),
        } as const;
      if (!exportAfterStop) {
        await releaseSessionOperationClaim(handoffId);
        return failure;
      }
      const status = buildStartRecoveryStatus(handoffId);
      return {
        ...failure,
        handoffId,
        status,
      } as const;
    }
    } catch (error) {
      await releaseSessionOperationClaim(handoffId);
      throw error;
    }
  };
}
