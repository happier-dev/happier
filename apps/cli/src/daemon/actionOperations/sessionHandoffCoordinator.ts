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

type Failure = Readonly<{ ok: false; errorCode: string; error: string }>;
type RpcResult = unknown;

type HandoffInput = Readonly<{
  sessionId: string;
  targetMachineId: string;
  targetSessionStorageMode?: SessionHandoffStorageMode;
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
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
    workspaceReplicationReverseSourceRootPath?: string;
    workspaceReplicationReverseTargetRootPath?: string;
  }>, signal: AbortSignal) => Promise<RpcResult>;
  abort: (request: Readonly<{ machineId: string; handoffId: string; reason: string }>) => Promise<unknown>;
  publishOwnerUpdate: (update: ActionOperationOwnerUpdate) => void;
  wait?: (signal: AbortSignal) => Promise<void>;
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
  try {
  const source = await input.resolveSource(input.input.sessionId, input.signal);
  if (!source.ok) return source;
  cancellationSourceMachineId = source.sourceMachineId;

  const startedAction = await input.start();
  if (!startedAction.ok) return startedAction;
  const startedFailure = readFailure(startedAction.result, 'session_handoff_start_failed');
  if (startedFailure) return startedFailure;
  const started = SessionHandoffStartResponseSchema.safeParse(startedAction.result);
  if (!started.success) {
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
    await abortBoth(input, source.sourceMachineId, handoffId, 'transport_unavailable');
    return { ok: false, errorCode: 'transport_unavailable', error: 'transport_unavailable' };
  }

  const preparedRaw = await input.prepareTarget({
    handoffId,
    sourceMachineId: source.sourceMachineId,
    targetMachineId: input.input.targetMachineId,
    targetPath: started.data.targetPath,
    negotiatedTransportStrategy,
    sourceSessionStorageMode: source.sessionStorageMode,
    ...(input.input.targetSessionStorageMode
      ? { targetSessionStorageMode: input.input.targetSessionStorageMode }
      : {}),
    endpointCandidates: started.data.endpointCandidates,
    ...(started.data.handoffMetadataV2 ? { handoffMetadataV2: started.data.handoffMetadataV2 } : {}),
    ...(input.input.workspaceTransfer ? { workspaceTransfer: input.input.workspaceTransfer } : {}),
  }, input.signal);
  const prepareFailure = readFailure(preparedRaw, 'session_handoff_prepare_failed');
  if (prepareFailure && !isPrepareObservationPending(prepareFailure.errorCode)) {
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
    input.publishOwnerUpdate({
      progress: targetStatus.status.status === 'awaiting_user_resume'
        ? { phase: 'awaiting_user_resume', label: 'Waiting for Resume' }
        : { phase: 'preparing_target', label: targetStatus.status.phase },
    });
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
    await abortBoth(input, source.sourceMachineId, handoffId, failure.errorCode);
    return failure;
  }

  publishPhase(input.publishOwnerUpdate, 'committing_target', 'Committing target');
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
    ...(input.input.workspaceTransfer?.enabled === true
      ? { workspaceReplicationReverseSourceRootPath: prepared.data.resume.directory }
      : {}),
    ...(input.input.workspaceTransfer?.enabled === true
      && started.data.handoffMetadataV2?.workspaceReplicationSourceRootPath
      ? {
          workspaceReplicationReverseTargetRootPath:
            started.data.handoffMetadataV2.workspaceReplicationSourceRootPath,
        }
      : {}),
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
