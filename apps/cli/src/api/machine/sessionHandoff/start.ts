import { randomUUID } from 'node:crypto';
import os from 'node:os';

import {
  type SessionHandoffMetadataV2,
  type SessionHandoffStartRequest,
  SessionHandoffStartRequestSchema,
  type SessionHandoffStatus,
  type TransferEndpointCandidate,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { SessionHandoffPrepareTargetJobRecordInput } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import type { SessionHandoffSourceExportRecord } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import type { SessionHandoffProviderBundle } from '../../../session/handoff/types';
import { validateSessionHandoffWorkspaceTransferSourcePath } from '../../../session/handoff/workspaceReplication/validateSessionHandoffWorkspaceTransferSourcePath';
import { validateSessionHandoffWorkspaceTransferStrategy } from '../../../session/handoff/workspaceReplication/validateSessionHandoffWorkspaceTransferStrategy';
import { buildSessionHandoffWorkspaceManifestTransferId } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted';
import type { RpcHandlerManager } from '../../rpc/RpcHandlerManager';
import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';
import {
  prepareDeferredDirectPeerStart,
  type DeferredDirectPeerPreExportedProviderBundle,
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
  writeProviderBundleFile: (params: Readonly<{
    handoffId: string;
    providerBundle: SessionHandoffProviderBundle;
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
  rpcHandlerManager: RpcHandlerManager;
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
    preExportedProviderBundle?: DeferredDirectPeerPreExportedProviderBundle;
  }>) => Promise<PrepareStartedStateResult>;
  exportSessionBundle: (
    metadata: Record<string, unknown>,
  ) => Promise<Readonly<{
    providerBundle: SessionHandoffProviderBundle;
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
  }>) => SessionHandoffPrepareTargetJobRecordInput;
  invalidRequest: () => Readonly<{
    ok: false;
    errorCode: 'invalid_request';
  }>;
}>;

function resolveSessionHandoffTargetPathFromMetadata(metadata: Record<string, unknown>): string | null {
  const targetPath = typeof metadata.path === 'string' ? metadata.path.trim() : '';
  return targetPath.length > 0 ? targetPath : null;
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

export function registerSessionHandoffStartRpcHandler(
  params: RegisterSessionHandoffStartRpcHandlerInput,
): void {
  const {
    rpcHandlerManager,
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
  } = params;

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, async (raw: unknown) => {
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

    const handoffId = `handoff_${randomUUID()}`;
    const hasServerRoutedFallback =
      machineTransferChannelPresent
      && parsed.data.preferredTransportStrategies.includes('server_routed_stream');
    let shouldDefer = shouldDeferSourcePreparation(parsed.data, { hasServerRoutedFallback });
    let deferredStartWorkPromise: Promise<void> | null = null;
    let deferredMarkerWritten = false;

    const recordDeferredStartFailure = (error: unknown): void => {
      const nowMs = Date.now();
      const jobId = `start_${handoffId}`;
      const errorMessage = error instanceof Error ? error.message : 'Failed to export session handoff state';
      void prepareJobStore.write(
        buildPrepareJobRecord({
          jobId,
          handoffId,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          failedAtMs: nowMs,
          lastErrorMessage: errorMessage,
          status: {
            ...buildStartRecoveryStatus(handoffId),
            jobId,
          },
        }),
      ).catch(() => undefined);
    };

    const buildDeferredResponseTargetPath = (): string | null => {
      const targetPath = resolveSessionHandoffTargetPathFromMetadata(metadata);
      return targetPath ?? null;
    };

    const ensureDeferredMarker = async (targetPath: string): Promise<void> => {
      if (deferredMarkerWritten) return;
      deferredMarkerWritten = true;
      // Persist a minimal durable marker so `status.get` can immediately report "pending"
      // for deferred handoffs (instead of racing to `not_found` before export writes).
      await sourceExportStore.save({
        handoffId,
        sessionId: parsed.data.sessionId,
        sourceMachineId: parsed.data.sourceMachineId,
        targetMachineId: parsed.data.targetMachineId,
        exportedAtMs: Date.now(),
        workspaceSourceRootPath: targetPath,
      });
    };

    const attemptDeferredStartFastPath = async (
      targetPath: string,
    ): Promise<SessionHandoffStartFastPathResult | null> => {
      await ensureDeferredMarker(targetPath);

      const fastPathPromise = (async (): Promise<SessionHandoffStartFastPathResult> => {
        const sourceStopState =
          stopSessionForHandoff
            ? await stopSessionForHandoff(parsed.data.sessionId)
            : 'already_inactive';
        if (sourceStopState === 'failed') {
          return {
            ok: false,
            errorCode: 'source_stop_failed',
            error: 'Failed to stop the active source session before handoff cutover',
          } as const;
        }
        const prepared = await prepareStartedState({
          handoffId,
          request: parsed.data,
          metadata,
          sourceStopState,
        });

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

      deferredStartWorkPromise = fastPathPromise.then(() => undefined);
      void fastPathPromise.catch(recordDeferredStartFailure);
      shouldDefer = true;
      return null;
    };

    const shouldAttemptServerRoutedFastPath =
      !shouldDefer
      && parsed.data.negotiatedTransportStrategy === 'server_routed_stream'
      && parsed.data.workspaceTransfer?.enabled === true
      && parsed.data.sourceMachineId !== parsed.data.targetMachineId;

    if (shouldAttemptServerRoutedFastPath) {
      const targetPath = buildDeferredResponseTargetPath();
      if (!targetPath) {
        return {
          ok: false,
          errorCode: 'source_export_failed',
          error: 'Session path is unavailable for handoff',
        } as const;
      }
      const fastPathOutcome = await attemptDeferredStartFastPath(targetPath);
      if (fastPathOutcome !== null) {
        if ('ok' in fastPathOutcome && fastPathOutcome.ok === false) {
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
      let preExportedProviderBundle: DeferredDirectPeerPreExportedProviderBundle | undefined;

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
        const deferredDirectPeerStart = await prepareDeferredDirectPeerStart({
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
          resolveSourceStopState: async () =>
            stopSessionForHandoff
              ? await stopSessionForHandoff(parsed.data.sessionId)
              : 'already_inactive',
          recordDeferredStartFailure,
        });
        deferredStartEndpointCandidates = deferredDirectPeerStart.deferredStartEndpointCandidates;
        deferredStartWorkPromise = deferredDirectPeerStart.deferredStartWorkPromise;
        preExportedProviderBundle = deferredDirectPeerStart.preExportedProviderBundle;
      }

      startDeferredWork({
        deferredStartWorkPromise,
        sessionId: parsed.data.sessionId,
        handoffId,
        request: parsed.data,
        metadata,
        ...(preExportedProviderBundle ? { preExportedProviderBundle } : {}),
        stopSessionForHandoff,
        prepareStartedState,
        recordDeferredStartFailure,
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
          ? await stopSessionForHandoff(parsed.data.sessionId)
          : 'already_inactive';
      if (stopState === 'failed') {
        return {
          ok: false,
          errorCode: 'source_stop_failed',
          error: 'Failed to stop the active source session before handoff cutover',
        } as const;
      }
      exportAfterStop = stopState === 'stopped';
      const prepared = await prepareStartedState({
        handoffId,
        request: parsed.data,
        metadata,
        sourceStopState: stopState,
      });

      return {
        handoffId,
        status: prepared.nextState.status,
        endpointCandidates: prepared.endpointCandidates,
        targetPath: prepared.targetPath,
        ...(prepared.nextState.handoffMetadataV2 ? { handoffMetadataV2: prepared.nextState.handoffMetadataV2 } : {}),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to export session handoff state';
      if (!exportAfterStop) {
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
  });
}
