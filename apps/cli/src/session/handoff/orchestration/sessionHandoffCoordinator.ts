import {
  SessionHandoffCommitResponseSchema,
  SessionHandoffPrepareTargetResultGetResponseSchema,
  SessionHandoffStartResponseSchema,
  SessionHandoffStatusSchema,
  SessionHandoffTargetResumeResponseV2Schema,
  type ActionExecuteResult,
  type ActionOperationDomainRefV1,
  type ActionOperationProgressV1,
  type SessionHandoffMetadataV2,
  type SessionHandoffPrepareTargetResultGetResponse,
  type SessionHandoffStartResponse,
  type SessionHandoffStatus,
  type SessionHandoffWorkspaceTransfer,
} from '@happier-dev/protocol';

export type SessionHandoffCoordinatorInput = Readonly<{
  sessionId: string;
  sourceMachineId: string;
  targetMachineId: string;
  targetPath?: string;
  sessionStorageMode: 'direct' | 'persisted';
  targetSessionStorageMode?: 'direct' | 'persisted';
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  connectedServices?: unknown;
}>;

type OperationUpdate = Readonly<{
  progress?: ActionOperationProgressV1;
  domainRef?: ActionOperationDomainRefV1;
}>;

type CoordinatorFailure = Readonly<{
  ok: false;
  errorCode: string;
  error: string;
}>;

type CoordinatorExecutionResult = ActionExecuteResult | Readonly<{ kind: 'cancelled' }>;

type TargetCapability = Readonly<{
  protocolVersion: 2;
  atomicTargetResume: boolean;
  targetCleanup: boolean;
}>;

export type SessionHandoffCoordinatorPort = Readonly<{
  probeTargetCapability: (input: SessionHandoffCoordinatorInput) => Promise<unknown>;
  startSource: (request: Readonly<{
    sessionId: string;
    sourceMachineId: string;
    targetMachineId: string;
    sessionStorageMode: 'direct' | 'persisted';
    preferredTransportStrategies: readonly ['server_routed_stream'] | readonly ['direct_peer'];
    negotiatedTransportStrategy: 'server_routed_stream' | 'direct_peer';
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  }>) => Promise<unknown>;
  prepareTarget: (request: Readonly<{
    handoffId: string;
    sessionId: string;
    sourceMachineId: string;
    targetMachineId: string;
    negotiatedTransportStrategy: 'server_routed_stream' | 'direct_peer';
    allowServerRoutedFallback: boolean;
    sourceSessionStorageMode: 'direct' | 'persisted';
    targetSessionStorageMode?: 'direct' | 'persisted';
    targetPath: string;
    endpointCandidates: SessionHandoffStartResponse['endpointCandidates'];
    handoffMetadataV2?: SessionHandoffMetadataV2;
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  }>) => Promise<unknown>;
  getTargetPrepareResult: (request: Readonly<{ handoffId: string; sessionId: string }>) => Promise<unknown>;
  getTargetStatus?: (request: Readonly<{ handoffId: string }>) => Promise<unknown>;
  resumeTarget: (request: Readonly<{
    handoffId: string;
    sessionId: string;
    attemptId: string;
    connectedServices?: unknown;
  }>) => Promise<unknown>;
  confirmTarget: (request: Readonly<{ handoffId: string; sessionId: string; attemptId: string }>) => Promise<unknown>;
  bindTarget: (input: Readonly<{
    request: SessionHandoffCoordinatorInput;
    started: SessionHandoffStartResponse;
    prepared: SessionHandoffPrepareTargetResultGetResponse;
    completedAtMs: number;
  }>) => Promise<void>;
  commitTarget: (request: Readonly<{ handoffId: string; sessionId: string; attemptId: string; mode: 'target' }>) => Promise<unknown>;
  cleanupSource: (request: Readonly<{
    handoffId: string;
    mode: 'source_cleanup';
    workspaceReplicationReverseSourceRootPath?: string;
    workspaceReplicationReverseTargetRootPath?: string;
  }>) => Promise<unknown>;
  abortTarget: (request: Readonly<{ handoffId: string; sessionId: string; reason: string }>) => Promise<unknown>;
  abortSource: (request: Readonly<{ handoffId: string; reason: string }>) => Promise<unknown>;
  wait: (signal?: AbortSignal) => Promise<void>;
  transportStrategy?: 'server_routed_stream' | 'direct_peer';
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNestedString(value: unknown, keys: readonly string[], depth = 0): string | null {
  if (depth > 4) return null;
  const candidate = record(value);
  if (!candidate) return typeof value === 'string' && value.trim() ? value.trim() : null;
  for (const key of keys) {
    const raw = candidate[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  for (const key of ['error', 'details', 'cause', 'status']) {
    const nested = readNestedString(candidate[key], keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function failure(value: unknown, fallbackCode: string, fallbackMessage: string): CoordinatorFailure {
  return {
    ok: false,
    errorCode: (readNestedString(value, ['errorCode', 'code']) ?? fallbackCode).slice(0, 200),
    error: (readNestedString(value, ['errorMessage', 'message', 'error']) ?? fallbackMessage).slice(0, 10_000),
  };
}

function isFailure(value: unknown): boolean {
  return record(value)?.ok === false;
}

function isAbortAcknowledged(value: unknown): boolean {
  return record(record(value)?.status)?.status === 'aborted';
}

function phase(update: (value: OperationUpdate) => void, value: string, label: string): void {
  update({ progress: { kind: 'phase', phase: value, label } });
}

function workspaceProgressLabel(status: SessionHandoffStatus): string | null {
  const checkpoint = status.progress?.checkpoint;
  if (checkpoint === 'scan_source') return 'Scanning source workspace';
  if (checkpoint === 'plan') return 'Planning workspace transfer';
  if (checkpoint === 'transfer_blobs') return 'Transferring workspace';
  if (checkpoint === 'stage_target') return 'Staging target workspace';
  if (checkpoint === 'apply') return 'Applying workspace changes';
  if (checkpoint === 'import_session') return 'Importing session state';
  if (checkpoint === 'finalize') return 'Finalizing handoff';
  return null;
}

function projectTargetStatusProgress(update: (value: OperationUpdate) => void, value: unknown): void {
  const candidate = record(value);
  const parsed = SessionHandoffStatusSchema.safeParse(candidate?.status ?? value);
  if (!parsed.success) return;
  const status = parsed.data;
  const progress = status.progress;
  if (!progress) return;
  const label = workspaceProgressLabel(status);
  if (!label) return;
  if (
    progress.checkpoint === 'transfer_blobs'
    && typeof progress.planned.totalBytes === 'number'
    && progress.planned.totalBytes > 0
    && typeof progress.transferred.bytes === 'number'
  ) {
    const relativePath = progress.current?.relativePath?.trim();
    update({
      progress: {
        kind: 'determinate',
        current: Math.min(progress.transferred.bytes, progress.planned.totalBytes),
        total: progress.planned.totalBytes,
        label: relativePath ? `${label} · ${relativePath}` : label,
      },
    });
    return;
  }
  phase(update, `workspace_${progress.checkpoint}`, label);
}

function readCapability(value: unknown): TargetCapability | null {
  const candidate = record(value);
  return candidate?.protocolVersion === 2
    && candidate.atomicTargetResume === true
    && candidate.targetCleanup === true
    ? { protocolVersion: 2, atomicTargetResume: true, targetCleanup: true }
    : null;
}

export function createSessionHandoffCoordinator(port: SessionHandoffCoordinatorPort) {
  const admit = async (input: SessionHandoffCoordinatorInput) => {
    if (!input.sessionId.trim() || !input.sourceMachineId.trim() || !input.targetMachineId.trim()) {
      throw new Error('Invalid session handoff operation input');
    }
    if (input.sourceMachineId === input.targetMachineId) {
      throw new Error('Session handoff target must differ from the source machine');
    }
    const capability = readCapability(await port.probeTargetCapability(input));
    if (!capability) {
      throw new Error('Target daemon does not support safe atomic session handoff v2');
    }

    return {
      execute: async ({ update, signal }: Readonly<{
        update: (value: OperationUpdate) => void;
        signal?: AbortSignal;
      }>): Promise<CoordinatorExecutionResult> => {
        const strategy = port.transportStrategy ?? 'server_routed_stream';
        let handoffId: string | null = null;
        let targetCommitted = false;
        let cancellationClosed = false;
        let targetWasAddressed = false;
        const abortBeforeCommit = async (reason: string) => {
          if (!handoffId || targetCommitted) return;
          await Promise.allSettled([
            port.abortTarget({ handoffId, sessionId: input.sessionId, reason }),
            port.abortSource({ handoffId, reason }),
          ]);
        };
        const acknowledgeCancellation = async (): Promise<CoordinatorExecutionResult | null> => {
          if (!signal?.aborted || cancellationClosed) return null;
          if (!handoffId) return { kind: 'cancelled' };
          const [targetAbort, sourceAbort] = await Promise.allSettled([
            targetWasAddressed
              ? port.abortTarget({ handoffId, sessionId: input.sessionId, reason: 'action_cancelled' })
              : Promise.resolve(null),
            port.abortSource({ handoffId, reason: 'action_cancelled' }),
          ]);
          if (
            (!targetWasAddressed || (targetAbort.status === 'fulfilled' && isAbortAcknowledged(targetAbort.value)))
            && sourceAbort.status === 'fulfilled'
            && isAbortAcknowledged(sourceAbort.value)
          ) {
            return { kind: 'cancelled' };
          }
          return {
            ok: false,
            errorCode: 'handoff_cancel_failed',
            error: 'Session handoff cancellation could not be confirmed',
          };
        };

        try {
          const cancelledBeforeStart = await acknowledgeCancellation();
          if (cancelledBeforeStart) return cancelledBeforeStart;
          phase(update, 'starting_source', 'Preparing source');
          const startedRaw = await port.startSource({
            sessionId: input.sessionId,
            sourceMachineId: input.sourceMachineId,
            targetMachineId: input.targetMachineId,
            sessionStorageMode: input.sessionStorageMode,
            preferredTransportStrategies: [strategy],
            negotiatedTransportStrategy: strategy,
            ...(input.workspaceTransfer ? { workspaceTransfer: input.workspaceTransfer } : {}),
          });
          if (isFailure(startedRaw)) return failure(startedRaw, 'handoff_start_failed', 'Failed to start session handoff');
          const startedParsed = SessionHandoffStartResponseSchema.safeParse(startedRaw);
          if (!startedParsed.success) return failure(startedRaw, 'invalid_handoff_start_response', 'Invalid source handoff response');
          const started = startedParsed.data;
          handoffId = started.handoffId;
          update({ domainRef: { kind: 'handoff', id: handoffId } });
          const cancelledAfterStart = await acknowledgeCancellation();
          if (cancelledAfterStart) return cancelledAfterStart;

          phase(update, 'preparing_target', 'Preparing target');
          targetWasAddressed = true;
          const preparedRaw = await port.prepareTarget({
            handoffId,
            sessionId: input.sessionId,
            sourceMachineId: input.sourceMachineId,
            targetMachineId: input.targetMachineId,
            negotiatedTransportStrategy: strategy,
            allowServerRoutedFallback: false,
            sourceSessionStorageMode: input.sessionStorageMode,
            ...(input.targetSessionStorageMode ? { targetSessionStorageMode: input.targetSessionStorageMode } : {}),
            targetPath: input.targetPath ?? started.targetPath,
            endpointCandidates: started.endpointCandidates,
            ...(started.handoffMetadataV2 ? { handoffMetadataV2: started.handoffMetadataV2 } : {}),
            ...(input.workspaceTransfer ? { workspaceTransfer: input.workspaceTransfer } : {}),
          });
          projectTargetStatusProgress(update, preparedRaw);
          const cancelledAfterPrepare = await acknowledgeCancellation();
          if (cancelledAfterPrepare) return cancelledAfterPrepare;
          if (isFailure(preparedRaw)) {
            const preparedFailure = failure(preparedRaw, 'target_prepare_failed', 'Failed to prepare handoff target');
            await abortBeforeCommit(preparedFailure.errorCode);
            return preparedFailure;
          }

          let prepared = SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(preparedRaw);
          while (!prepared.success) {
            const cancelledBeforePoll = await acknowledgeCancellation();
            if (cancelledBeforePoll) return cancelledBeforePoll;
            const statusRaw = port.getTargetStatus ? await port.getTargetStatus({ handoffId }) : null;
            projectTargetStatusProgress(update, statusRaw);
            const statusRecord = record(statusRaw);
            // Result-get `not_found` only means the final payload is not ready. Status-get owns
            // durable target-job reconciliation, so its `not_found` means there is no execution
            // left for this coordinator to observe and the staged source must be recovered.
            if (isFailure(statusRaw) && readNestedString(statusRaw, ['errorCode', 'code']) === 'not_found') {
              const statusFailure = failure(
                statusRaw,
                'not_found',
                'Target preparation status is unavailable',
              );
              await abortBeforeCommit(statusFailure.errorCode);
              return statusFailure;
            }
            const statusParsed = SessionHandoffStatusSchema.safeParse(statusRecord?.status ?? statusRaw);
            if (statusParsed.success && (statusParsed.data.status === 'failed' || statusParsed.data.status === 'aborted')) {
              const statusFailure = failure(statusRaw, 'target_prepare_failed', 'Target preparation failed');
              await abortBeforeCommit(statusFailure.errorCode);
              return statusFailure;
            }
            await port.wait(signal);
            const cancelledAfterWait = await acknowledgeCancellation();
            if (cancelledAfterWait) return cancelledAfterWait;
            const resultRaw = await port.getTargetPrepareResult({ handoffId, sessionId: input.sessionId });
            if (isFailure(resultRaw) && readNestedString(resultRaw, ['errorCode', 'code']) !== 'not_found') {
              const resultFailure = failure(resultRaw, 'target_prepare_failed', 'Target preparation failed');
              await abortBeforeCommit(resultFailure.errorCode);
              return resultFailure;
            }
            prepared = SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(resultRaw);
          }

          const targetAttemptId = `target_${handoffId}`;
          phase(update, 'resuming_target', 'Resuming target session');
          const resumedRaw = await port.resumeTarget({
            handoffId,
            sessionId: input.sessionId,
            attemptId: targetAttemptId,
            ...(input.connectedServices !== undefined ? { connectedServices: input.connectedServices } : {}),
          });
          const cancelledAfterResume = await acknowledgeCancellation();
          if (cancelledAfterResume) return cancelledAfterResume;
          const resumedParsed = SessionHandoffTargetResumeResponseV2Schema.safeParse(resumedRaw);
          if (!resumedParsed.success) {
            const resumedFailure = failure(resumedRaw, 'target_resume_failed', 'Failed to resume handoff target');
            await abortBeforeCommit(resumedFailure.errorCode);
            return resumedFailure;
          }
          if (resumedParsed.data.disposition === 'preexisting_or_adopted') {
            const alreadyRunningFailure = {
              ok: false,
              errorCode: 'target_session_already_running',
              error: 'This session is already running on the selected target',
            } as const;
            await abortBeforeCommit(alreadyRunningFailure.errorCode);
            return alreadyRunningFailure;
          }

          phase(update, 'confirming_target', 'Confirming target session');
          const confirmedRaw = await port.confirmTarget({ handoffId, sessionId: input.sessionId, attemptId: targetAttemptId });
          const cancelledAfterConfirm = await acknowledgeCancellation();
          if (cancelledAfterConfirm) return cancelledAfterConfirm;
          if (isFailure(confirmedRaw) || !SessionHandoffStatusSchema.safeParse(confirmedRaw).success) {
            const confirmedFailure = failure(confirmedRaw, 'target_confirm_failed', 'Failed to confirm handoff target');
            await abortBeforeCommit(confirmedFailure.errorCode);
            return confirmedFailure;
          }

          const completedAtMs = Date.now();
          phase(update, 'binding_target', 'Updating session binding');
          // Once canonical session metadata begins moving to the target there is
          // no rollback contract. A late request remains requested, but the
          // coordinator must finish commit/cleanup instead of fabricating cancel.
          cancellationClosed = true;
          await port.bindTarget({ request: input, started, prepared: prepared.data, completedAtMs });

          phase(update, 'committing_target', 'Committing target');
          const committedRaw = await port.commitTarget({ handoffId, sessionId: input.sessionId, attemptId: targetAttemptId, mode: 'target' });
          const committedParsed = SessionHandoffCommitResponseSchema.safeParse(committedRaw);
          if (!committedParsed.success) {
            const committedFailure = failure(committedRaw, 'target_commit_failed', 'Failed to commit handoff target');
            await abortBeforeCommit(committedFailure.errorCode);
            return committedFailure;
          }
          targetCommitted = true;

          phase(update, 'cleaning_source', 'Cleaning up source');
          const cleanupRaw = await port.cleanupSource({
            handoffId,
            mode: 'source_cleanup',
            workspaceReplicationReverseSourceRootPath: prepared.data.resume.directory,
            ...(started.handoffMetadataV2?.workspaceReplicationSourceRootPath
              ? { workspaceReplicationReverseTargetRootPath: started.handoffMetadataV2.workspaceReplicationSourceRootPath }
              : {}),
          });
          const cleanupParsed = SessionHandoffCommitResponseSchema.safeParse(cleanupRaw);
          if (!cleanupParsed.success) {
            const cleanupFailure = failure(cleanupRaw, 'source_cleanup_failed', 'Source cleanup requires attention');
            return {
              ok: true,
              result: {
                handoffId,
                status: committedParsed.data.status,
                warning: { code: cleanupFailure.errorCode, message: cleanupFailure.error },
              },
            };
          }
          phase(update, 'finalizing_target', 'Finalizing target binding');
          await port.bindTarget({ request: input, started, prepared: prepared.data, completedAtMs });
          return { ok: true, result: { handoffId, status: committedParsed.data.status } };
        } catch (error) {
          const cancelled = await acknowledgeCancellation();
          if (cancelled) return cancelled;
          const unexpected = failure(error, 'handoff_failed', 'Session handoff failed');
          await abortBeforeCommit(unexpected.errorCode);
          return unexpected;
        }
      },
    };
  };

  return { admit };
}
