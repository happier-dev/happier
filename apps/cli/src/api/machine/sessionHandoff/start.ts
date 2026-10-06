import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { SessionHandoffMetadataV2, SessionHandoffStartRequest, SessionHandoffStatus, TransferEndpointCandidate } from '@happier-dev/protocol';
import { SessionHandoffStartRequestSchema } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { resolveMachineTransferRoute } from '@happier-dev/transfers';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { SessionHandoffPrepareTargetJobRecordInput } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import type { SessionHandoffSourceExportRecord } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';
import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';
import type {
  ExternalSessionOperationClaimMaintenance,
  ExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import type { RpcHandlerContext } from '@/api/rpc/types';
import {
  ExternalSessionOperationClaimLostError,
  maintainExternalSessionOperationClaim,
} from '@/session/external/operationExclusion';
import {
  prepareDeferredDirectPeerStart,
  type DeferredDirectPeerPreExportedAgentBundle,
} from './startDeferredDirectPeer';
import { startDeferredWork } from './startDeferredWork';
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
  ) => Promise<Record<string, unknown> | null>;
  machineTransferChannelPresent: boolean;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle | undefined;
  resolveServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
  stopSessionForHandoff?: (sessionId: string) => Promise<SessionHandoffSourceStopState>;
  prepareJobStore: SessionHandoffPrepareJobStoreLike;
  sourceExportStore: SessionHandoffSourceExportStoreLike;
  prepareStartedState: (params: Readonly<{
    handoffId: string;
    request: SessionHandoffStartRequest;
    metadata: Record<string, unknown>;
    sourceStopState: Exclude<SessionHandoffSourceStopState, 'failed'>;
    preExportedAgentBundle?: DeferredDirectPeerPreExportedAgentBundle;
    onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
  }>) => Promise<PrepareStartedStateResult>;
  exportSessionBundle: (
    metadata: Record<string, unknown>,
  ) => Promise<Readonly<{
    agentBundle: SessionHandoffAgentBundle;
    targetPath: string;
  }>>;
  waitForPersistedSourceExport: (
    handoffId: string,
    predicate: (record: SessionHandoffSourceExportRecord) => boolean,
    transferTimeoutMsOverride?: number,
  ) => Promise<SessionHandoffSourceExportRecord | null>;
  invalidateDirectPeerRouteCacheForHandoffMachines: (
    machineIds: readonly (string | undefined)[],
  ) => void;
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
    maintenance: ExternalSessionOperationClaimMaintenance,
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

function shouldDeferSourcePreparation(
  request: SessionHandoffStartRequest,
  options: Readonly<{
    hasServerRoutedFallback: boolean;
  }>,
): boolean {
  const crossMachine = request.sourceMachineId !== request.targetMachineId;
  // Managed preparation publishes its workspace seed before the target consumer starts.
  if (!crossMachine || request.targetDirectory?.kind === 'managed') {
    return false;
  }

  // Cross-daemon direct-peer starts with a server-routed fallback should still acknowledge quickly
  // and publish direct-peer endpoint candidates through the deferred path even without workspace sync.
  return request.negotiatedTransportStrategy === 'direct_peer' && options.hasServerRoutedFallback;
}

export function createSessionHandoffStartActionHandler(
  params: RegisterSessionHandoffStartRpcHandlerInput,
): (raw: unknown, context?: RpcHandlerContext) => Promise<unknown> {
  const {
    activeServerDir,
    createUuid,
    loadSessionMetadata,
    machineTransferChannelPresent,
    directPeerTransfer,
    resolveServerFeaturesSnapshot,
    stopSessionForHandoff,
    prepareJobStore,
    sourceExportStore,
    prepareStartedState,
    exportSessionBundle,
    waitForPersistedSourceExport,
    invalidateDirectPeerRouteCacheForHandoffMachines,
    buildStartPendingStatus,
    buildStartRecoveryStatus,
    buildPrepareJobRecord,
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
    const transport = resolveMachineTransferRoute({
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
    const request: SessionHandoffStartRequest = {
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

    const metadata = await loadSessionMetadata(request.sessionId, request.sourceMachineId);
    if (!metadata) {
      return { ok: false, errorCode: 'session_not_found' } as const;
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
    invalidateDirectPeerRouteCacheForHandoffMachines([request.sourceMachineId, request.targetMachineId]);

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
    const claimMaintenance = maintainExternalSessionOperationClaim({
      claim: exclusion.claim,
    });
    retainSessionOperationClaim(handoffId, claimMaintenance);
    let claimLossPersistence: Promise<void> | null = null;
    const hasServerRoutedFallback =
      machineTransferChannelPresent
      && request.preferredTransportStrategies.includes('server_routed_stream');
    let shouldDefer = shouldDeferSourcePreparation(request, { hasServerRoutedFallback });
    let deferredStartWorkPromise: Promise<void> | null = null;
    let deferredMarkerWritten = false;

    const recordDeferredStartFailure = async (error: unknown): Promise<void> => {
      const nowMs = Date.now();
      const jobId = `start_${handoffId}`;
      const structuredError = error && typeof error === 'object'
        ? error as { errorCode?: unknown; error?: unknown; message?: unknown }
        : null;
      const errorMessage =
        error instanceof Error
          ? error.message
          : typeof structuredError?.error === 'string'
            ? structuredError.error
            : 'Failed to export session handoff state';
      const lastErrorCode =
        typeof structuredError?.errorCode === 'string' && structuredError.errorCode.trim()
          ? structuredError.errorCode.trim()
          : errorMessage.includes('stop the active source session')
            ? 'source_stop_failed'
            : error instanceof ExternalSessionOperationClaimLostError
              ? 'session_operation_claim_lost'
              : 'source_export_failed';
      const recoveryStatus = buildStartRecoveryStatus(handoffId);
      try {
        await prepareJobStore.write(
          buildPrepareJobRecord({
            jobId,
            handoffId,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            failedAtMs: nowMs,
            lastErrorMessage: errorMessage,
            lastErrorCode,
            status: {
              ...recoveryStatus,
              ...(error instanceof ExternalSessionOperationClaimLostError
                ? { status: 'awaiting_user_resume' as const }
                : {}),
              jobId,
            },
          }),
        );
      } catch (persistenceError) {
        process.emitWarning(
          persistenceError instanceof Error ? persistenceError : String(persistenceError),
          {
            code: 'HAPPIER_SESSION_HANDOFF_DEFERRED_FAILURE_PERSISTENCE',
            detail: `handoffId=${handoffId} errorCode=${lastErrorCode}`,
          },
        );
      }
    };
    const persistClaimLoss = (
      error: ExternalSessionOperationClaimLostError,
    ): Promise<void> => {
      claimLossPersistence ??= recordDeferredStartFailure(error).catch(() => undefined);
      return claimLossPersistence;
    };
    void claimMaintenance.lost.then(persistClaimLoss);
    const claimLostResponse = async (
      error: ExternalSessionOperationClaimLostError,
    ) => {
      await persistClaimLoss(error);
      await releaseSessionOperationClaim(handoffId);
      return {
        ok: false,
        errorCode: 'session_operation_claim_lost',
        error: error.code,
        handoffId,
        status: {
          ...buildStartRecoveryStatus(handoffId),
          status: 'awaiting_user_resume' as const,
        },
      } as const;
    };

    const ensureDeferredMarker = async (targetPath: string): Promise<void> => {
      if (deferredMarkerWritten) return;
      claimMaintenance.throwIfLost();
      deferredMarkerWritten = true;
      // Persist a minimal durable marker so `status.get` can immediately report "pending"
      // for deferred handoffs (instead of racing to `not_found` before export writes).
      await claimMaintenance.race(() => sourceExportStore.save({
        handoffId,
        sessionId: request.sessionId,
        sourceMachineId: request.sourceMachineId,
        targetMachineId: request.targetMachineId,
        exportedAtMs: Date.now(),
      }));
    };

    try {
    const pendingStatus: SessionHandoffStatus = {
      ...buildStartPendingStatus({
        handoffId,
        sourceStopState: 'already_inactive',
      }),
      transportStrategy: request.negotiatedTransportStrategy,
    };
    if (shouldDefer) {
      const targetPath = resolveSessionHandoffTargetPathFromMetadata(metadata);
      if (!targetPath) {
        await releaseSessionOperationClaim(handoffId);
        return {
          ok: false,
          errorCode: 'source_export_failed',
          error: 'Session path is unavailable for handoff',
        } as const;
      }

      await ensureDeferredMarker(targetPath);

      // Deferred direct-peer starts must still publish endpoint candidates when direct peer
      // was negotiated so the target can remain on the direct-peer path even if a server-routed
      // fallback also exists.
      const isDirectPeerDeferredStart =
        request.negotiatedTransportStrategy === 'direct_peer'
        && request.preferredTransportStrategies.includes('direct_peer')
        && directPeerTransfer !== undefined;

      let deferredStartEndpointCandidates: readonly TransferEndpointCandidate[] = [];
      let preExportedAgentBundle: DeferredDirectPeerPreExportedAgentBundle | undefined;

      const deferredHandoffMetadataV2: SessionHandoffMetadataV2 | undefined =
        isDirectPeerDeferredStart ? {} : undefined;

      if (isDirectPeerDeferredStart && directPeerTransfer) {
        const sourceStopState =
          stopSessionForHandoff
            ? await claimMaintenance.race(() => stopSessionForHandoff(request.sessionId))
            : 'already_inactive';
        if (sourceStopState === 'failed') {
          await releaseSessionOperationClaim(handoffId);
          return {
            ok: false,
            errorCode: 'source_stop_failed',
            error: 'Failed to stop the active source session before handoff cutover',
          } as const;
        }

        try {
          const deferredDirectPeerStart = await claimMaintenance.race(() => prepareDeferredDirectPeerStart({
            handoffId,
            request,
            metadata,
            hasServerRoutedFallback,
            directPeerTransfer,
            deferredHandoffMetadataV2,
            sourceExportStore,
            waitForPersistedSourceExport,
            exportSessionBundle,
            prepareStartedState,
            sourceStopState,
            recordDeferredStartFailure,
            claimMaintenance,
            onProgress: reportBundleProgress('Packaging session state'),
          }));
          deferredStartEndpointCandidates = deferredDirectPeerStart.deferredStartEndpointCandidates;
          deferredStartWorkPromise = deferredDirectPeerStart.deferredStartWorkPromise;
          preExportedAgentBundle = deferredDirectPeerStart.preExportedAgentBundle;
        } catch (error) {
          if (error instanceof ExternalSessionOperationClaimLostError) throw error;
          const errorMessage = error instanceof Error ? error.message : 'Failed to export session handoff state';
          if (sourceStopState !== 'stopped') {
            await releaseSessionOperationClaim(handoffId);
            return {
              ok: false,
              errorCode: 'source_export_failed',
              error: errorMessage,
            } as const;
          }
          const status = buildStartRecoveryStatus(handoffId);
          return {
            ok: false,
            errorCode: 'source_export_failed',
            error: errorMessage,
            handoffId,
            status,
          } as const;
        }
      }

      startDeferredWork({
        deferredStartWorkPromise,
        sessionId: request.sessionId,
        handoffId,
        request,
        metadata,
        ...(preExportedAgentBundle ? { preExportedAgentBundle } : {}),
        stopSessionForHandoff,
        prepareStartedState,
        recordDeferredStartFailure,
        claimMaintenance,
        onProgress: reportBundleProgress('Packaging session state'),
      });

      return {
        handoffId,
        status: pendingStatus,
        endpointCandidates: deferredStartEndpointCandidates,
        targetPath,
        ...(deferredHandoffMetadataV2 ? { handoffMetadataV2: deferredHandoffMetadataV2 } : {}),
      };
    }

    let exportAfterStop = false;
    try {
      const stopState =
        stopSessionForHandoff
          ? await claimMaintenance.race(() => stopSessionForHandoff(request.sessionId))
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
      claimMaintenance.throwIfLost();
      const prepared = await claimMaintenance.race(() => prepareStartedState({
        handoffId,
        request,
        metadata,
        sourceStopState: stopState,
        onProgress: reportBundleProgress('Packaging session state'),
      }));

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
      if (error instanceof ExternalSessionOperationClaimLostError) throw error;
      const errorMessage = error instanceof Error ? error.message : 'Failed to export session handoff state';
      const errorCode = error !== null && typeof error === 'object' && 'code' in error
        && error.code === 'SESSION_DIRECTORY_MISSING' ? error.code : 'source_export_failed';
      if (!exportAfterStop) {
        await releaseSessionOperationClaim(handoffId);
        return {
          ok: false,
          errorCode,
          error: errorMessage,
        } as const;
      }
      const status = buildStartRecoveryStatus(handoffId);
      return {
        ok: false,
        errorCode,
        error: errorMessage,
        handoffId,
        status,
      } as const;
    }
    } catch (error) {
      if (error instanceof ExternalSessionOperationClaimLostError) {
        return await claimLostResponse(error);
      }
      throw error;
    }
  };
}
