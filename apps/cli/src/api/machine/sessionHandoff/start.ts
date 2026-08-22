import os from 'node:os';

import {
  type SessionHandoffMetadataV2,
  type SessionHandoffStartRequest,
  SessionHandoffStartRequestSchema,
  type SessionHandoffStatus,
  type TransferEndpointCandidate,
} from '@happier-dev/protocol';

import type { SessionHandoffPrepareTargetJobRecordInput } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import type { SessionHandoffSourceExportRecord } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';
import { validateSessionHandoffWorkspaceTransferSourcePath } from '../../../session/handoff/workspaceReplication/validateSessionHandoffWorkspaceTransferSourcePath';
import { validateSessionHandoffWorkspaceTransferStrategy } from '../../../session/handoff/workspaceReplication/validateSessionHandoffWorkspaceTransferStrategy';
import { buildSessionHandoffWorkspaceManifestTransferId } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted';
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

const START_JOB_FAST_PATH_BUDGET_MS = 750;

type SessionHandoffSourceStopState = 'stopped' | 'already_inactive' | 'failed';

type SessionHandoffStartFastPathResult =
  | Readonly<{
      handoffId: string;
      status: SessionHandoffStatus;
      endpointCandidates: readonly TransferEndpointCandidate[];
      targetPath: string;
      handoffMetadataV2?: SessionHandoffMetadataV2;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'source_stop_failed';
      error: string;
    }>;

type SessionHandoffPrepareJobStoreLike = Readonly<{
  write: (record: SessionHandoffPrepareTargetJobRecordInput) => Promise<void>;
}>;

type SessionHandoffSourceExportStoreLike = Readonly<{
  save: (record: Readonly<Omit<SessionHandoffSourceExportRecord, 't' | 'schemaVersion'>>) => Promise<void>;
  writeAgentBundleFile: (params: Readonly<{
    handoffId: string;
    agentBundle: SessionHandoffAgentBundle;
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
  stopSessionForHandoff?: (sessionId: string) => Promise<SessionHandoffSourceStopState>;
  prepareJobStore: SessionHandoffPrepareJobStoreLike;
  sourceExportStore: SessionHandoffSourceExportStoreLike;
  prepareStartedState: (params: Readonly<{
    handoffId: string;
    request: SessionHandoffStartRequest;
    metadata: Record<string, unknown>;
    sourceStopState: Exclude<SessionHandoffSourceStopState, 'failed'>;
    preExportedAgentBundle?: DeferredDirectPeerPreExportedAgentBundle;
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
  resolveWorkspaceReplicationHandoffBackTargetRootPath: (input: Readonly<{
    metadata: Record<string, unknown>;
    workspaceTransfer: SessionHandoffStartRequest['workspaceTransfer'] | undefined;
    requestedTargetMachineId: string;
  }>) => string | null;
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
  if (!crossMachine) {
    return false;
  }

  const workspaceEnabled = request.workspaceTransfer?.enabled === true;
  const negotiated = request.negotiatedTransportStrategy;

  // Cross-daemon direct-peer starts with a server-routed fallback should still acknowledge quickly
  // and publish direct-peer endpoint candidates through the deferred path even without workspace sync.
  if (!workspaceEnabled) {
    return negotiated === 'direct_peer' && options.hasServerRoutedFallback;
  }

  // When workspace transfer is enabled and transport is undecided or explicitly direct-peer,
  // start() must return quickly without waiting for potentially expensive workspace scans/publications.
  // In these cases the daemon proceeds in the background and callers poll `status.get`.
  if (negotiated === undefined) return true;
  if (negotiated === 'direct_peer') return true;

  // For server-routed handoffs, allow a synchronous fast path (bounded by a budget in the handler).
  return false;
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
    stopSessionForHandoff,
    prepareJobStore,
    sourceExportStore,
    prepareStartedState,
    exportSessionBundle,
    waitForPersistedSourceExport,
    invalidateDirectPeerRouteCacheForHandoffMachines,
    resolveWorkspaceReplicationHandoffBackTargetRootPath,
    buildStartPendingStatus,
    buildStartRecoveryStatus,
    buildPrepareJobRecord,
    invalidRequest,
    sessionOperationExclusion,
    retainSessionOperationClaim,
    releaseSessionOperationClaim,
  } = params;

  return async (raw: unknown, context?: RpcHandlerContext) => {
    const parsed = SessionHandoffStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const metadata = await loadSessionMetadata(parsed.data.sessionId, parsed.data.sourceMachineId);
    if (!metadata) {
      return { ok: false, errorCode: 'session_not_found' } as const;
    }
    const workspaceTransferValidation = validateSessionHandoffWorkspaceTransferSourcePath({
      metadata,
      fallbackSourceHomeDir: os.homedir(),
      workspaceTransfer: parsed.data.workspaceTransfer,
    });
    if (!workspaceTransferValidation.ok) {
      return workspaceTransferValidation;
    }
    const workspaceTransferStrategyValidation = validateSessionHandoffWorkspaceTransferStrategy({
      workspaceTransfer: parsed.data.workspaceTransfer,
      negotiatedTransportStrategy: parsed.data.negotiatedTransportStrategy,
      hasServerRoutedTransferChannel: machineTransferChannelPresent,
      hasDirectPeerTransfer: directPeerTransfer !== undefined,
      allowLocalPrepareReuse: true,
    });
    if (!workspaceTransferStrategyValidation.ok) {
      return workspaceTransferStrategyValidation;
    }
    invalidateDirectPeerRouteCacheForHandoffMachines([parsed.data.sourceMachineId, parsed.data.targetMachineId]);

    const workspaceReplicationHandoffBackTargetRootPath =
      resolveWorkspaceReplicationHandoffBackTargetRootPath({
        metadata,
        workspaceTransfer: parsed.data.workspaceTransfer,
        requestedTargetMachineId: parsed.data.targetMachineId,
      }) ?? undefined;

    const handoffId = `handoff_${createUuid()}`;
    const operationRequestId = `handoff:${parsed.data.sessionId}:${parsed.data.sourceMachineId}:${parsed.data.targetMachineId}:${parsed.data.sessionStorageMode}:${parsed.data.negotiatedTransportStrategy ?? 'unselected'}`;
    const exclusionRequest = {
      kind: 'handoff',
      sessionId: parsed.data.sessionId,
      requestId: operationRequestId,
      sourceMachineId: parsed.data.sourceMachineId,
      targetMachineId: parsed.data.targetMachineId,
      semanticRequest: serializeSessionHandoffSemanticRequest(parsed.data),
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
      && parsed.data.preferredTransportStrategies.includes('server_routed_stream');
    let shouldDefer = shouldDeferSourcePreparation(parsed.data, { hasServerRoutedFallback });
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

    const buildDeferredResponseTargetPath = (): string | null => {
      const targetPath = resolveSessionHandoffTargetPathFromMetadata(metadata);
      return targetPath ?? null;
    };

    const ensureDeferredMarker = async (targetPath: string): Promise<void> => {
      if (deferredMarkerWritten) return;
      claimMaintenance.throwIfLost();
      deferredMarkerWritten = true;
      // Persist a minimal durable marker so `status.get` can immediately report "pending"
      // for deferred handoffs (instead of racing to `not_found` before export writes).
      await claimMaintenance.race(() => sourceExportStore.save({
        handoffId,
        sessionId: parsed.data.sessionId,
        sourceMachineId: parsed.data.sourceMachineId,
        targetMachineId: parsed.data.targetMachineId,
        exportedAtMs: Date.now(),
        workspaceSourceRootPath: targetPath,
      }));
    };

    const attemptDeferredStartFastPath = async (
      targetPath: string,
    ): Promise<SessionHandoffStartFastPathResult | null> => {
      await ensureDeferredMarker(targetPath);

      const fastPathPromise = (async (): Promise<SessionHandoffStartFastPathResult> => {
        claimMaintenance.throwIfLost();
        const sourceStopState =
          stopSessionForHandoff
            ? await claimMaintenance.race(() => stopSessionForHandoff(parsed.data.sessionId))
            : 'already_inactive';
        if (sourceStopState === 'failed') {
          return {
            ok: false,
            errorCode: 'source_stop_failed',
            error: 'Failed to stop the active source session before handoff cutover',
          } as const;
        }
        claimMaintenance.throwIfLost();
        const prepared = await claimMaintenance.race(() => prepareStartedState({
          handoffId,
          request: parsed.data,
          metadata,
          sourceStopState,
        }));

        return {
          handoffId,
          status: prepared.nextState.status,
          endpointCandidates: prepared.endpointCandidates,
          targetPath: prepared.targetPath,
          ...(prepared.nextState.handoffMetadataV2 ? { handoffMetadataV2: prepared.nextState.handoffMetadataV2 } : {}),
        };
      })();

      const fastPathOutcome = await Promise.race([
        fastPathPromise,
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), START_JOB_FAST_PATH_BUDGET_MS);
        }),
      ]);

      if (fastPathOutcome !== null) {
        return fastPathOutcome;
      }

      deferredStartWorkPromise = fastPathPromise.then((outcome) => {
        if ('ok' in outcome && outcome.ok === false) {
          throw Object.assign(new Error(outcome.error), {
            errorCode: outcome.errorCode,
            error: outcome.error,
          });
        }
      });
      void fastPathPromise.catch(recordDeferredStartFailure);
      shouldDefer = true;
      return null;
    };

    try {
    const shouldAttemptServerRoutedFastPath =
      !shouldDefer
      && parsed.data.negotiatedTransportStrategy === 'server_routed_stream'
      && parsed.data.workspaceTransfer?.enabled === true
      && parsed.data.sourceMachineId !== parsed.data.targetMachineId;

    if (shouldAttemptServerRoutedFastPath) {
      const targetPath = buildDeferredResponseTargetPath();
      if (!targetPath) {
        await releaseSessionOperationClaim(handoffId);
        return {
          ok: false,
          errorCode: 'source_export_failed',
          error: 'Session path is unavailable for handoff',
        } as const;
      }
      const fastPathOutcome = await attemptDeferredStartFastPath(targetPath);
      if (fastPathOutcome !== null) {
        if ('ok' in fastPathOutcome && fastPathOutcome.ok === false) {
          await releaseSessionOperationClaim(handoffId);
          return fastPathOutcome;
        }
        return fastPathOutcome;
      }
    }

    const pendingStatus = buildStartPendingStatus({
      handoffId,
      sourceStopState: 'already_inactive',
    });
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
        parsed.data.negotiatedTransportStrategy === 'direct_peer'
        && parsed.data.preferredTransportStrategies.includes('direct_peer')
        && directPeerTransfer !== undefined;

      let deferredStartEndpointCandidates: readonly TransferEndpointCandidate[] = [];
      let preExportedAgentBundle: DeferredDirectPeerPreExportedAgentBundle | undefined;

      const deferredHandoffMetadataV2: SessionHandoffMetadataV2 | undefined =
        isDirectPeerDeferredStart || parsed.data.workspaceTransfer?.enabled === true
          ? {
              ...(parsed.data.workspaceTransfer?.enabled === true
                ? {
                    workspaceReplicationSourceRootPath: targetPath,
                    ...(workspaceReplicationHandoffBackTargetRootPath
                      ? { workspaceReplicationHandoffBackTargetRootPath: workspaceReplicationHandoffBackTargetRootPath }
                      : {}),
                    workspaceReplicationManifestTransferPublication: {
                      transferId: buildSessionHandoffWorkspaceManifestTransferId({ handoffId }),
                    },
                  }
                : {}),
            }
          : undefined;

      if (isDirectPeerDeferredStart && directPeerTransfer) {
        const sourceStopState =
          stopSessionForHandoff
            ? await claimMaintenance.race(() => stopSessionForHandoff(parsed.data.sessionId))
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
            activeServerDir,
            handoffId,
            request: parsed.data,
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
        sessionId: parsed.data.sessionId,
        handoffId,
        request: parsed.data,
        metadata,
        ...(preExportedAgentBundle ? { preExportedAgentBundle } : {}),
        stopSessionForHandoff,
        prepareStartedState,
        recordDeferredStartFailure,
        claimMaintenance,
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
          ? await claimMaintenance.race(() => stopSessionForHandoff(parsed.data.sessionId))
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
        request: parsed.data,
        metadata,
        sourceStopState: stopState,
      }));

      return {
        handoffId,
        status: prepared.nextState.status,
        endpointCandidates: prepared.endpointCandidates,
        targetPath: prepared.targetPath,
        ...(prepared.nextState.handoffMetadataV2 ? { handoffMetadataV2: prepared.nextState.handoffMetadataV2 } : {}),
      };
    } catch (error) {
      if (error instanceof ExternalSessionOperationClaimLostError) throw error;
      const errorMessage = error instanceof Error ? error.message : 'Failed to export session handoff state';
      if (!exportAfterStop) {
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
    } catch (error) {
      if (error instanceof ExternalSessionOperationClaimLostError) {
        return await claimLostResponse(error);
      }
      throw error;
    }
  };
}
