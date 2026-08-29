import {
  SessionHandoffPrepareTargetResponseSchema,
  SessionHandoffPrepareTargetResultGetSuccessResponseSchema,
  SessionHandoffAbortResponseSchema,
  SessionHandoffCommitResponseSchema,
  SessionHandoffStartResponseSchema,
  SessionHandoffStatusSchema,
  type ActionExecuteResult,
  type SessionHandoffPrepareTargetResponse,
  type SessionHandoffStatus,
  type SessionHandoffStorageMode,
  type SessionHandoffWorkspaceTransfer,
} from '@happier-dev/protocol';

import type { ActionOperationOwnerUpdate } from './actionOperationTypes';
import type {
  PrepareWorkspaceSyncHandoffInput,
  WorkspaceSyncHandoffAdapter,
  WorkspaceSyncHandoffPrepared,
} from '@/workspaces/sync/workspaceSyncHandoffAdapter';

type Failure = Readonly<{ ok: false; errorCode: string; error: string }>;
type RpcResult = unknown;

type HandoffInput = Readonly<{
  sessionId: string;
  targetMachineId: string;
  targetPath?: string;
  targetSessionStorageMode?: SessionHandoffStorageMode;
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  workspaceSyncAction?: Parameters<WorkspaceSyncHandoffAdapter['prepare']>[0]['action'];
  workspaceSyncSourceRootPath?: string;
  workspaceSyncTargetRootPath?: string;
  workspaceSyncSourceWorkspaceRefId?: string;
  workspaceSyncTargetWorkspaceRefId?: string;
}>;

type SourceContext =
  | Readonly<{ ok: true; sourceMachineId: string; sessionStorageMode: SessionHandoffStorageMode }>
  | Failure;

type CoordinatorInput = Readonly<{
  input: HandoffInput;
  signal: AbortSignal;
  start: () => Promise<ActionExecuteResult>;
  resolveSource: (sessionId: string, signal: AbortSignal) => Promise<SourceContext>;
  prepareTarget: (request: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<RpcResult>;
  getPreparedTargetResult: (request: Readonly<{ handoffId: string }>, signal: AbortSignal) => Promise<RpcResult>;
  getTargetStatus: (request: Readonly<{ handoffId: string }>, signal: AbortSignal) => Promise<RpcResult>;
  resumeTarget: (request: Readonly<{
    sessionId: string;
    targetMachineId: string;
    prepared: SessionHandoffPrepareTargetResponse;
  }>, signal: AbortSignal) => Promise<RpcResult>;
  confirmTarget: (request: Readonly<{
    sessionId: string;
    targetMachineId: string;
    handoffId: string;
  }>, signal: AbortSignal) => Promise<RpcResult>;
  commitTarget: (request: Readonly<{ machineId: string; handoffId: string; mode: 'target' }>, signal: AbortSignal) => Promise<RpcResult>;
  cleanupSource: (request: Readonly<{
    machineId: string;
    handoffId: string;
    mode: 'source_cleanup';
  }>, signal: AbortSignal) => Promise<RpcResult>;
  abort: (request: Readonly<{ machineId: string; handoffId: string; reason: string }>) => Promise<unknown>;
  publishOwnerUpdate: (update: ActionOperationOwnerUpdate) => void;
  wait?: (signal: AbortSignal) => Promise<void>;
  workspaceSyncAdapter?: WorkspaceSyncHandoffAdapter;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readFailure(value: unknown, fallback: string): Failure | null {
  const record = asRecord(value);
  if (record?.ok !== false) return null;
  const errorCode = typeof record.errorCode === 'string' && record.errorCode.trim()
    ? record.errorCode.trim()
    : fallback;
  const error = typeof record.error === 'string' && record.error.trim()
    ? record.error.trim()
    : errorCode;
  return { ok: false, errorCode, error };
}

function readTargetStatus(
  value: unknown,
): Readonly<{ ok: true; status: SessionHandoffStatus }> | Failure {
  const failure = readFailure(value, 'session_handoff_status_failed');
  if (failure) return failure;
  const parsed = SessionHandoffStatusSchema.safeParse(asRecord(value)?.status);
  return parsed.success
    ? { ok: true, status: parsed.data }
    : {
        ok: false,
        errorCode: 'session_handoff_status_invalid',
        error: 'session_handoff_status_invalid',
      };
}

function isPrepareObservationPending(errorCode: string): boolean {
  return errorCode === 'not_found' || errorCode === 'awaiting_user_resume';
}

function readTerminalPrepareStatusFailure(status: SessionHandoffStatus): Failure | null {
  if (
    status.status !== 'aborted'
    && status.status !== 'failed'
    && status.status !== 'awaiting_recovery'
    && status.status !== 'reconciliation_required'
  ) {
    return null;
  }
  return {
    ok: false,
    errorCode: status.status,
    error: status.failure?.message ?? `Prepare-target job is ${status.status}`,
  };
}

function publishPhase(
  publishOwnerUpdate: CoordinatorInput['publishOwnerUpdate'],
  phase: string,
  label: string,
): void {
  publishOwnerUpdate({ progress: { phase, label } });
}

function publishTargetStatusProgress(
  publishOwnerUpdate: CoordinatorInput['publishOwnerUpdate'],
  value: unknown,
): boolean {
  const parsed = SessionHandoffStatusSchema.safeParse(asRecord(value)?.status ?? value);
  if (!parsed.success || !parsed.data.progress) return false;
  const progress = parsed.data.progress;
  const labels: Readonly<Record<typeof progress.checkpoint, string>> = {
    scan_source: 'Scanning source workspace',
    plan: 'Planning workspace transfer',
    transfer_blobs: 'Transferring workspace',
    stage_target: 'Staging target workspace',
    apply: 'Applying workspace changes',
    import_session: 'Importing session state',
    finalize: 'Finalizing handoff',
  };
  const isSessionTransfer = progress.checkpoint === 'import_session'
    && typeof progress.planned.totalBytes === 'number'
    && progress.planned.totalBytes > 0
    && typeof progress.transferred.bytes === 'number'
    && progress.transferred.bytes < progress.planned.totalBytes;
  const label = isSessionTransfer ? 'Transferring session data' : labels[progress.checkpoint];
  if (
    (progress.checkpoint === 'transfer_blobs' || isSessionTransfer)
    && typeof progress.planned.totalBytes === 'number'
    && progress.planned.totalBytes > 0
    && typeof progress.transferred.bytes === 'number'
  ) {
    const relativePath = progress.current?.relativePath?.trim();
    publishOwnerUpdate({ progress: {
      phase: isSessionTransfer ? 'session_transfer' : 'workspace_transfer_blobs',
      current: Math.min(progress.transferred.bytes, progress.planned.totalBytes),
      total: progress.planned.totalBytes,
      label: relativePath ? `${label} · ${relativePath}` : label,
    } });
    return true;
  }
  publishPhase(publishOwnerUpdate, `workspace_${progress.checkpoint}`, label);
  return true;
}

async function abortBoth(
  input: CoordinatorInput,
  sourceMachineId: string,
  handoffId: string,
  reason: string,
): Promise<boolean> {
  const responses = await Promise.allSettled([
    input.abort({ machineId: input.input.targetMachineId, handoffId, reason }),
    input.abort({ machineId: sourceMachineId, handoffId, reason }),
  ]);
  return responses.every((response) => {
    if (response.status !== 'fulfilled') return false;
    const parsed = SessionHandoffAbortResponseSchema.safeParse(response.value);
    return parsed.success && parsed.data.status.status === 'aborted';
  });
}

function defaultWait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, 500);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Session handoff operation aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function coordinateTrackedSessionHandoff(
  input: CoordinatorInput,
): Promise<ActionExecuteResult> {
  let cancellationSourceMachineId: string | null = null;
  let cancellationHandoffId: string | null = null;
  let preparedWorkspace: WorkspaceSyncHandoffPrepared | undefined;
  try {
  const source = await input.resolveSource(input.input.sessionId, input.signal);
  if (!source.ok) return source;
  cancellationSourceMachineId = source.sourceMachineId;

  // Workspace preparation is intentionally before source stop (start()). The adapter owns
  // bootstrap/readiness and never falls back to the retired replication engine.
  if (input.workspaceSyncAdapter && input.input.workspaceSyncAction) {
    const workspaceInput: PrepareWorkspaceSyncHandoffInput = {
      operationId: input.input.sessionId,
      action: input.input.workspaceSyncAction,
      sourceMachineId: source.sourceMachineId,
      targetMachineId: input.input.targetMachineId,
      sourceWorkspaceRefId: input.input.workspaceSyncSourceWorkspaceRefId ?? input.input.sessionId,
      targetWorkspaceRefId: input.input.workspaceSyncTargetWorkspaceRefId ?? input.input.targetMachineId,
      sourceRootPath: input.input.workspaceSyncSourceRootPath ?? '',
      targetRootPath: input.input.workspaceSyncTargetRootPath ?? input.input.targetPath ?? '',
      ...(input.input.workspaceSyncAction.kind === 'copy_once'
        ? { contentPolicy: input.input.workspaceSyncAction.contentPolicy }
        : {}),
      signal: input.signal,
    };
    preparedWorkspace = await input.workspaceSyncAdapter.prepare(workspaceInput);
  }

  publishPhase(input.publishOwnerUpdate, 'packaging_session_state', 'Preparing session state');
  const startedAction = await input.start();
  if (!startedAction.ok) {
    if (preparedWorkspace && input.workspaceSyncAdapter) {
      await input.workspaceSyncAdapter.abort({ operationId: input.input.sessionId, prepared: preparedWorkspace });
    }
    return startedAction;
  }
  const startedFailure = readFailure(startedAction.result, 'session_handoff_start_failed');
  if (startedFailure) {
    await input.workspaceSyncAdapter?.abort({ operationId: input.input.sessionId, prepared: preparedWorkspace }).catch(() => undefined);
    return startedFailure;
  }
  const started = SessionHandoffStartResponseSchema.safeParse(startedAction.result);
  if (!started.success) {
    await input.workspaceSyncAdapter?.abort({ operationId: input.input.sessionId, prepared: preparedWorkspace }).catch(() => undefined);
    return { ok: false, errorCode: 'session_handoff_start_invalid', error: 'session_handoff_start_invalid' };
  }

  const handoffId = started.data.handoffId;
  cancellationHandoffId = handoffId;
  input.publishOwnerUpdate({
    domainRef: { kind: 'handoff', id: handoffId, targetMachineId: input.input.targetMachineId },
    progress: { phase: 'preparing_target', label: 'Preparing target' },
  });

  const negotiatedTransportStrategy = started.data.status.transportStrategy;
  if (negotiatedTransportStrategy !== 'direct_peer' && negotiatedTransportStrategy !== 'server_routed_stream') {
    await input.workspaceSyncAdapter?.abort({ operationId: input.input.sessionId, prepared: preparedWorkspace }).catch(() => undefined);
    await abortBoth(input, source.sourceMachineId, handoffId, 'transport_unavailable');
    return { ok: false, errorCode: 'transport_unavailable', error: 'transport_unavailable' };
  }

  const preparedRaw = await input.prepareTarget({
    handoffId,
    sourceMachineId: source.sourceMachineId,
    targetMachineId: input.input.targetMachineId,
    targetPath: input.input.targetPath ?? started.data.targetPath,
    negotiatedTransportStrategy,
    sourceSessionStorageMode: source.sessionStorageMode,
    ...(input.input.targetSessionStorageMode
      ? { targetSessionStorageMode: input.input.targetSessionStorageMode }
      : {}),
    endpointCandidates: started.data.endpointCandidates,
    ...(started.data.handoffMetadataV2 ? { handoffMetadataV2: started.data.handoffMetadataV2 } : {}),
    ...(input.input.workspaceTransfer ? { workspaceTransfer: input.input.workspaceTransfer } : {}),
  }, input.signal);
  publishTargetStatusProgress(input.publishOwnerUpdate, preparedRaw);
  const prepareFailure = readFailure(preparedRaw, 'session_handoff_prepare_failed');
  if (prepareFailure && !isPrepareObservationPending(prepareFailure.errorCode)) {
    await input.workspaceSyncAdapter?.abort({ operationId: input.input.sessionId, prepared: preparedWorkspace }).catch(() => undefined);
    await abortBoth(input, source.sourceMachineId, handoffId, prepareFailure.errorCode);
    return prepareFailure;
  }

  let prepared = SessionHandoffPrepareTargetResponseSchema.safeParse(preparedRaw);
  const wait = input.wait ?? defaultWait;
  while (!prepared.success || !prepared.data.resume || !prepared.data.remoteSessionId || !prepared.data.directSource) {
    input.signal.throwIfAborted();
    if (prepared.success) {
      input.publishOwnerUpdate({ progress: {
        phase: 'preparing_target',
        label: prepared.data.status.phase,
      } });
    }
    const resultRaw = await input.getPreparedTargetResult({ handoffId }, input.signal);
    const resultFailure = readFailure(resultRaw, 'session_handoff_prepare_failed');
    if (resultFailure && !isPrepareObservationPending(resultFailure.errorCode)) {
      await abortBoth(input, source.sourceMachineId, handoffId, resultFailure.errorCode);
      return resultFailure;
    }
    const result = SessionHandoffPrepareTargetResultGetSuccessResponseSchema.safeParse(resultRaw);
    if (result.success) {
      prepared = SessionHandoffPrepareTargetResponseSchema.safeParse(result.data);
      break;
    }
    const targetStatus = readTargetStatus(
      await input.getTargetStatus({ handoffId }, input.signal),
    );
    if (!targetStatus.ok) {
      await abortBoth(input, source.sourceMachineId, handoffId, targetStatus.errorCode);
      return targetStatus;
    }
    const terminalFailure = readTerminalPrepareStatusFailure(targetStatus.status);
    if (terminalFailure) {
      await abortBoth(input, source.sourceMachineId, handoffId, terminalFailure.errorCode);
      return terminalFailure;
    }
    if (!publishTargetStatusProgress(input.publishOwnerUpdate, targetStatus.status)) {
      input.publishOwnerUpdate({
        progress: targetStatus.status.status === 'awaiting_user_resume'
          ? { phase: 'awaiting_user_resume', label: 'Waiting for Resume' }
          : { phase: 'preparing_target', label: targetStatus.status.phase },
      });
    }
    await wait(input.signal);
  }
  if (!prepared.success || !prepared.data.resume || !prepared.data.remoteSessionId || !prepared.data.directSource) {
    await abortBoth(input, source.sourceMachineId, handoffId, 'session_handoff_prepare_invalid');
    return { ok: false, errorCode: 'session_handoff_prepare_invalid', error: 'session_handoff_prepare_invalid' };
  }

  publishPhase(input.publishOwnerUpdate, 'resuming_target', 'Resuming target session');
  const resumed = await input.resumeTarget({
    sessionId: input.input.sessionId,
    targetMachineId: input.input.targetMachineId,
    prepared: prepared.data,
  }, input.signal);
  const resumeFailure = readFailure(resumed, 'session_handoff_resume_failed');
  if (resumeFailure || asRecord(resumed)?.ok !== true) {
    const failure = resumeFailure ?? {
      ok: false as const,
      errorCode: 'session_handoff_resume_failed',
      error: 'session_handoff_resume_failed',
    };
    await input.workspaceSyncAdapter?.abort({ operationId: input.input.sessionId, prepared: preparedWorkspace });
    await abortBoth(input, source.sourceMachineId, handoffId, failure.errorCode);
    return failure;
  }

  publishPhase(input.publishOwnerUpdate, 'confirming_target', 'Confirming target custody');
  const confirmed = await input.confirmTarget({
    sessionId: input.input.sessionId,
    targetMachineId: input.input.targetMachineId,
    handoffId,
  }, input.signal);
  const confirmFailure = readFailure(confirmed, 'session_handoff_target_unconfirmed');
  if (confirmFailure || asRecord(confirmed)?.ok !== true) {
    const failure = confirmFailure ?? {
      ok: false as const,
      errorCode: 'session_handoff_target_unconfirmed',
      error: 'session_handoff_target_unconfirmed',
    };
    await input.workspaceSyncAdapter?.abort({ operationId: input.input.sessionId, prepared: preparedWorkspace });
    await abortBoth(input, source.sourceMachineId, handoffId, failure.errorCode);
    return failure;
  }

  publishPhase(input.publishOwnerUpdate, 'committing_target', 'Committing target');
  const workspaceCommitted = preparedWorkspace && input.workspaceSyncAdapter
    ? await input.workspaceSyncAdapter.commit({ operationId: input.input.sessionId, prepared: preparedWorkspace, signal: input.signal })
    : undefined;
  const committed = await input.commitTarget({
    machineId: input.input.targetMachineId,
    handoffId,
    mode: 'target',
  }, input.signal);
  const commitFailure = readFailure(committed, 'session_handoff_commit_failed');
  const committedResponse = SessionHandoffCommitResponseSchema.safeParse(committed);
  if (commitFailure || !committedResponse.success) {
    const failure = commitFailure ?? {
      ok: false as const,
      errorCode: 'session_handoff_commit_invalid',
      error: 'session_handoff_commit_invalid',
    };
    await abortBoth(input, source.sourceMachineId, handoffId, failure.errorCode);
    return failure;
  }

  publishPhase(input.publishOwnerUpdate, 'cleaning_source', 'Cleaning up source');
  const cleanup = await input.cleanupSource({
    machineId: source.sourceMachineId,
    handoffId,
    mode: 'source_cleanup',
  }, input.signal);
  const cleanupFailure = readFailure(cleanup, 'session_handoff_source_cleanup_failed');
  const cleanupResponse = SessionHandoffCommitResponseSchema.safeParse(cleanup);
  const cleanupWarning = cleanupFailure ?? (!cleanupResponse.success
    ? {
        ok: false as const,
        errorCode: 'session_handoff_source_cleanup_invalid',
        error: 'session_handoff_source_cleanup_invalid',
      }
    : null);

  return {
    ok: true,
    result: {
      handoffId,
      status: committedResponse.data.status,
      ...(workspaceCommitted ? { workspace: workspaceCommitted } : {}),
      ...(cleanupWarning
        ? {
            warning: {
              code: 'source_cleanup_failed',
              message: cleanupWarning.error,
            },
          }
        : {}),
    },
  };
  } catch (error) {
    if (!input.signal.aborted) throw error;
    if (!cancellationSourceMachineId || !cancellationHandoffId) throw error;
    const acknowledged = await abortBoth(
      input,
      cancellationSourceMachineId,
      cancellationHandoffId,
      'action_operation_cancelled',
    );
    if (preparedWorkspace && input.workspaceSyncAdapter) {
      await input.workspaceSyncAdapter.abort({ operationId: input.input.sessionId, prepared: preparedWorkspace }).catch(() => undefined);
    }
    if (!acknowledged) {
      return {
        ok: false,
        errorCode: 'session_handoff_cancellation_unconfirmed',
        error: 'session_handoff_cancellation_unconfirmed',
      };
    }
    return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  }
}
