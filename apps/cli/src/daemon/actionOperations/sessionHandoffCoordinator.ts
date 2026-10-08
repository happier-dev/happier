import { SessionHandoffPrepareTargetResponseSchema, SessionHandoffPrepareTargetResultGetSuccessResponseSchema, SessionHandoffAbortResponseSchema, SessionHandoffCommitResponseSchema, SessionHandoffStartResponseSchema } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { SessionHandoffStatusSchema } from '@happier-dev/protocol/sessions/control/handoff/handoffStatus';
import { HandoffWorkspaceOutcomeV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ActionExecuteResult, HandoffWorkspaceOutcomeV1, WorkspaceSyncCleanupWarningV1, SessionHandoffPrepareTargetResponse, SessionHandoffStatus, SessionHandoffStorageMode, HandoffWorkspaceActionV1, HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol';

import type { ActionOperationOwnerUpdate } from './actionOperationTypes';
import type {
  PrepareWorkspaceSyncHandoffInput,
  WorkspaceSyncHandoffCommitted,
  WorkspaceSyncHandoffAdapter,
  WorkspaceSyncHandoffPrepared,
} from '@/workspaces/sync/workspaceSyncHandoffAdapter';

type Failure = Extract<ActionExecuteResult, { ok: false }>;
type RpcResult = unknown;

type HandoffInput = Readonly<{
  operationId?: string;
  sessionId: string;
  targetMachineId: string;
  targetPath?: string;
  targetDirectory?: Readonly<{ kind: 'managed' }>;
  targetSessionStorageMode?: SessionHandoffStorageMode;
  /** Canonical wire action. */
  workspaceAction?: HandoffWorkspaceActionV1;
  accountServerId?: string;
  targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
  targetReplacementApprovalReceiptId?: string;
  targetReplacementApprovalActionInput?: unknown;
  workspaceSyncSourceRootPath?: string;
  workspaceSyncTargetRootPath?: string;
  workspaceSyncTargetSessionRelativeCwd?: string;
  workspaceSyncSourceWorkspaceRefId?: string;
  workspaceSyncTargetWorkspaceRefId?: string;
}>;

type SourceContext =
  | Readonly<{
      ok: true;
      sourceMachineId: string;
      sourceRootPath?: string;
      sessionStorageMode: SessionHandoffStorageMode;
    }>
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
  workspaceSyncAdapter: WorkspaceSyncHandoffAdapter;
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

function readThrownFailure(error: unknown, fallback: string): Failure {
  const record = asRecord(error);
  const errorCode = typeof record?.code === 'string' && record.code.trim()
    ? record.code.trim()
    : typeof record?.errorCode === 'string' && record.errorCode.trim()
      ? record.errorCode.trim()
      : fallback;
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : typeof record?.error === 'string' && record.error.trim()
      ? record.error.trim()
      : errorCode;
  return {
    ok: false,
    errorCode,
    error: message,
    ...(record?.details === undefined ? {} : { details: record.details }),
  };
}

function cleanupFailureMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map((failure) => cleanupFailureMessage(failure)).join('; ');
  }
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const record = asRecord(error);
  return typeof record?.error === 'string' && record.error.trim()
    ? record.error.trim()
    : String(error);
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
  const machineIds = new Set([input.input.targetMachineId, sourceMachineId]);
  const responses = await Promise.allSettled([...machineIds].map((machineId) =>
    input.abort({ machineId, handoffId, reason }),
  ));
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

/**
 * Projects the adapter's committed result onto the one strict terminal outcome
 * the Action result carries to the UI. Copy materialization, relationship
 * creation versus reuse, the engine status observed at commit, and post-commit
 * cleanup debt are all preserved here rather than being flattened into an
 * untyped bag or a second workspace store.
 */
function buildWorkspaceOutcome(
  committed: WorkspaceSyncHandoffCommitted | undefined,
  cleanupWarning: WorkspaceSyncCleanupWarningV1 | null,
): HandoffWorkspaceOutcomeV1 {
  if (!committed || committed.kind === 'none') return { kind: 'none' };
  const shared = {
    ...(committed.status === undefined ? {} : { status: committed.status }),
    ...(cleanupWarning ? { cleanupWarning } : {}),
  };
  if (committed.kind === 'copy_once') {
    return HandoffWorkspaceOutcomeV1Schema.parse({
      kind: 'copied',
      operationId: committed.operationId,
      ...shared,
    });
  }
  if (committed.kind === 'linked_workspace') {
    return HandoffWorkspaceOutcomeV1Schema.parse({
      kind: 'linked_workspace',
      traversed: committed.traversed,
      ...(cleanupWarning ? { cleanupWarning } : {}),
    });
  }
  if (!committed.relationshipId) return { kind: 'none' };
  return HandoffWorkspaceOutcomeV1Schema.parse({
    kind: 'relationship',
    relationshipId: committed.relationshipId,
    created: committed.relationshipCreated ?? committed.kind === 'create_relationship',
    ...shared,
  });
}

export async function coordinateTrackedSessionHandoff(
  input: CoordinatorInput,
): Promise<ActionExecuteResult> {
  let cancellationSourceMachineId: string | null = null;
  let cancellationHandoffId: string | null = null;
  let cancellationClosed = false;
  let preparedWorkspace: WorkspaceSyncHandoffPrepared | undefined;
  let finalizedWorkspace: WorkspaceSyncHandoffCommitted | undefined;
  let committedTarget: Readonly<{ handoffId: string; status: SessionHandoffStatus }> | null = null;
  let committedWorkspaceOutcome: HandoffWorkspaceOutcomeV1 | null = null;
  let workspaceAbortFailure: unknown;
  const workspaceOperationId = input.input.operationId?.trim() ?? '';
  const abortWorkspace = async (): Promise<void> => {
    if (!preparedWorkspace) return;
    const prepared = preparedWorkspace;
    preparedWorkspace = undefined;
    try {
      await input.workspaceSyncAdapter.abort({
        operationId: workspaceOperationId,
        prepared,
      });
    } catch (error) {
      workspaceAbortFailure = error;
    }
  };
  const withWorkspaceAbortFailure = <T extends Failure>(failure: T): T => workspaceAbortFailure === undefined
    ? failure
    : {
        ...failure,
        error: `${failure.error}; workspace cleanup failed: ${cleanupFailureMessage(workspaceAbortFailure)}`,
      };
  try {
  const source = await input.resolveSource(input.input.sessionId, input.signal);
  if (!source.ok) return source;
  cancellationSourceMachineId = source.sourceMachineId;

  // Normalize the wire action once at the coordinator boundary.  The adapter
  // receives this same canonical action; no legacy workspace-transfer shape is
  // interpreted or forwarded.
  const workspaceSyncAction = input.input.workspaceAction;

  // Workspace preparation is intentionally before source stop (start()). The adapter owns
  // bootstrap/readiness and never falls back to the retired replication engine.
  if (
    workspaceSyncAction
    && workspaceSyncAction.kind !== 'none'
  ) {
    const sourceWorkspaceRefId = input.input.workspaceSyncSourceWorkspaceRefId?.trim();
    const targetWorkspaceRefId = input.input.workspaceSyncTargetWorkspaceRefId?.trim();
    if (!workspaceOperationId || (
      (workspaceSyncAction.kind === 'relationship' || workspaceSyncAction.kind === 'linked_workspace')
      && (!sourceWorkspaceRefId || !targetWorkspaceRefId)
    )) {
      return {
        ok: false,
        errorCode: 'workspace_ref_not_ready',
        error: 'workspace_ref_not_ready',
      };
    }
    const sourceRootPath = input.input.workspaceSyncSourceRootPath?.trim();
    const targetRootPath = input.input.workspaceSyncTargetRootPath?.trim();
    if (!sourceRootPath || !targetRootPath) {
      return {
        ok: false,
        errorCode: 'workspace_root_unsafe',
        error: 'workspace_root_unsafe',
      };
    }
    const workspaceInput: PrepareWorkspaceSyncHandoffInput = {
      operationId: workspaceOperationId,
      ...(input.input.accountServerId ? { accountServerId: input.input.accountServerId } : {}),
      ...(input.input.targetReplacementApproval ? { targetReplacementApproval: input.input.targetReplacementApproval } : {}),
      ...(input.input.targetReplacementApprovalReceiptId ? {
        targetReplacementApprovalReceiptId: input.input.targetReplacementApprovalReceiptId,
        targetReplacementApprovalActionInput: input.input.targetReplacementApprovalActionInput,
      } : {}),
      action: workspaceSyncAction,
      sourceMachineId: source.sourceMachineId,
      targetMachineId: input.input.targetMachineId,
      ...(sourceWorkspaceRefId ? { sourceWorkspaceRefId } : {}),
      ...(targetWorkspaceRefId ? { targetWorkspaceRefId } : {}),
      sourceRootPath,
      targetRootPath,
      signal: input.signal,
    };
    try {
      if (workspaceSyncAction.kind === 'linked_workspace') {
        publishPhase(input.publishOwnerUpdate, 'preparing_linked_workspace', 'Updating linked workspace');
      }
      preparedWorkspace = await input.workspaceSyncAdapter.prepare(workspaceInput);
    } catch (error) {
      return readThrownFailure(error, 'workspace_sync_prepare_failed');
    }
  }

  publishPhase(input.publishOwnerUpdate, 'packaging_session_state', 'Preparing session state');
  const startedAction = await input.start();
  if (!startedAction.ok) {
    await abortWorkspace();
    return withWorkspaceAbortFailure(startedAction);
  }
  const startedFailure = readFailure(startedAction.result, 'session_handoff_start_failed');
  if (startedFailure) {
    await abortWorkspace();
    return withWorkspaceAbortFailure(startedFailure);
  }
  const started = SessionHandoffStartResponseSchema.safeParse(startedAction.result);
  if (!started.success) {
    await abortWorkspace();
    return withWorkspaceAbortFailure({ ok: false, errorCode: 'session_handoff_start_invalid', error: 'session_handoff_start_invalid' });
  }

  const handoffId = started.data.handoffId;
  cancellationHandoffId = handoffId;
  input.publishOwnerUpdate({
    domainRef: { kind: 'handoff', id: handoffId, targetMachineId: input.input.targetMachineId },
    progress: { phase: 'preparing_target', label: 'Preparing target' },
  });

  const negotiatedTransportStrategy = started.data.status.transportStrategy;
  if (negotiatedTransportStrategy !== 'direct_peer' && negotiatedTransportStrategy !== 'server_routed_stream') {
    await abortWorkspace();
    await abortBoth(input, source.sourceMachineId, handoffId, 'transport_unavailable');
    return withWorkspaceAbortFailure({ ok: false, errorCode: 'transport_unavailable', error: 'transport_unavailable' });
  }

  // `start()` has now quiesced the source session. Move the final workspace
  // delta before preparing or resuming the target so the target never observes
  // an empty/stale root. Finalize also durably publishes a newly-created
  // relationship; the post-target adapter commit only releases its fence.
  if (preparedWorkspace) {
    publishPhase(input.publishOwnerUpdate, 'finalizing_workspace', workspaceSyncAction?.kind === 'linked_workspace'
      ? 'Updating linked destination'
      : 'Finalizing workspace');
    try {
      finalizedWorkspace = await input.workspaceSyncAdapter.finalize({
        operationId: workspaceOperationId,
        prepared: preparedWorkspace,
        signal: input.signal,
      });
    } catch (error) {
      const failure = readThrownFailure(error, 'workspace_sync_finalize_failed');
      if (failure.errorCode === 'indeterminate') {
        // The settings mutation may have published the relationship. Preserve
        // the stable operation/transaction authority for an idempotent retry;
        // aborting here could terminate the only runtime behind a durable row.
        return failure;
      }
      await abortWorkspace();
      await abortBoth(input, source.sourceMachineId, handoffId, failure.errorCode);
      return withWorkspaceAbortFailure(failure);
    }
  }

  const preparedRaw = await input.prepareTarget({
    handoffId,
    sourceMachineId: source.sourceMachineId,
    targetMachineId: input.input.targetMachineId,
    ...(input.input.targetDirectory?.kind === 'managed'
      ? { targetDirectory: input.input.targetDirectory, operationId: input.input.operationId, sessionId: input.input.sessionId }
      : { targetPath: input.input.targetPath ?? started.data.targetPath }),
    ...(input.input.workspaceSyncTargetRootPath
      && input.input.workspaceSyncTargetSessionRelativeCwd !== undefined
      ? {
          workspaceRootPath: input.input.workspaceSyncTargetRootPath,
          workspaceSessionRelativeCwd: input.input.workspaceSyncTargetSessionRelativeCwd,
        }
      : {}),
    negotiatedTransportStrategy,
    sourceSessionStorageMode: source.sessionStorageMode,
    ...(input.input.targetSessionStorageMode
      ? { targetSessionStorageMode: input.input.targetSessionStorageMode }
      : {}),
    endpointCandidates: started.data.endpointCandidates,
    ...(started.data.handoffMetadataV2 ? { handoffMetadataV2: started.data.handoffMetadataV2 } : {}),
    ...(workspaceSyncAction ? { workspaceAction: workspaceSyncAction } : {}),
  }, input.signal);
  publishTargetStatusProgress(input.publishOwnerUpdate, preparedRaw);
  const prepareFailure = readFailure(preparedRaw, 'session_handoff_prepare_failed');
  if (prepareFailure && !isPrepareObservationPending(prepareFailure.errorCode)) {
    await abortWorkspace();
    await abortBoth(input, source.sourceMachineId, handoffId, prepareFailure.errorCode);
    return withWorkspaceAbortFailure(prepareFailure);
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
      await abortWorkspace();
      await abortBoth(input, source.sourceMachineId, handoffId, resultFailure.errorCode);
      return withWorkspaceAbortFailure(resultFailure);
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
      await abortWorkspace();
      await abortBoth(input, source.sourceMachineId, handoffId, targetStatus.errorCode);
      return withWorkspaceAbortFailure(targetStatus);
    }
    const terminalFailure = readTerminalPrepareStatusFailure(targetStatus.status);
    if (terminalFailure) {
      await abortWorkspace();
      await abortBoth(input, source.sourceMachineId, handoffId, terminalFailure.errorCode);
      return withWorkspaceAbortFailure(terminalFailure);
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
    await abortWorkspace();
    await abortBoth(input, source.sourceMachineId, handoffId, 'session_handoff_prepare_invalid');
    return withWorkspaceAbortFailure({ ok: false, errorCode: 'session_handoff_prepare_invalid', error: 'session_handoff_prepare_invalid' });
  }

  publishPhase(input.publishOwnerUpdate, 'resuming_target', 'Resuming target session');
  input.signal.throwIfAborted();
  // Resume publishes replacement runtime metadata during startup. There is no rollback
  // contract after binding begins, so late cancellation must finish custody and commit.
  cancellationClosed = true;
  const completionSignal = new AbortController().signal;
  const resumed = await input.resumeTarget({
    sessionId: input.input.sessionId,
    targetMachineId: input.input.targetMachineId,
    prepared: prepared.data,
  }, completionSignal);
  const resumeFailure = readFailure(resumed, 'session_handoff_resume_failed');
  if (resumeFailure || asRecord(resumed)?.ok !== true) {
    const failure = resumeFailure ?? {
      ok: false as const,
      errorCode: 'session_handoff_resume_failed',
      error: 'session_handoff_resume_failed',
    };
    await abortWorkspace();
    await abortBoth(input, source.sourceMachineId, handoffId, failure.errorCode);
    return withWorkspaceAbortFailure(failure);
  }

  publishPhase(input.publishOwnerUpdate, 'confirming_target', 'Confirming target custody');
  const confirmed = await input.confirmTarget({
    sessionId: input.input.sessionId,
    targetMachineId: input.input.targetMachineId,
    handoffId,
  }, completionSignal);
  const confirmFailure = readFailure(confirmed, 'session_handoff_target_unconfirmed');
  if (confirmFailure || asRecord(confirmed)?.ok !== true) {
    const failure = confirmFailure ?? {
      ok: false as const,
      errorCode: 'session_handoff_target_unconfirmed',
      error: 'session_handoff_target_unconfirmed',
    };
    await abortWorkspace();
    await abortBoth(input, source.sourceMachineId, handoffId, failure.errorCode);
    return withWorkspaceAbortFailure(failure);
  }

  publishPhase(input.publishOwnerUpdate, 'committing_target', 'Committing target');
  const committed = await input.commitTarget({
    machineId: input.input.targetMachineId,
    handoffId,
    mode: 'target',
  }, completionSignal);
  const commitFailure = readFailure(committed, 'session_handoff_commit_failed');
  const committedResponse = SessionHandoffCommitResponseSchema.safeParse(committed);
  if (commitFailure || !committedResponse.success) {
    const failure = commitFailure ?? {
      ok: false as const,
      errorCode: 'session_handoff_commit_invalid',
      error: 'session_handoff_commit_invalid',
    };
    await abortWorkspace();
    await abortBoth(input, source.sourceMachineId, handoffId, failure.errorCode);
    return withWorkspaceAbortFailure(failure);
  }
  committedTarget = committedResponse.data;

  let workspaceCommitted: WorkspaceSyncHandoffCommitted | undefined;
  let workspaceCleanupFailure: Failure | null = null;
  if (preparedWorkspace) {
    try {
      workspaceCommitted = await input.workspaceSyncAdapter.commit({
        operationId: workspaceOperationId,
        prepared: preparedWorkspace,
        signal: completionSignal,
      });
    } catch (error) {
      workspaceCleanupFailure = readThrownFailure(error, 'workspace_sync_commit_failed');
      workspaceCommitted = finalizedWorkspace;
      // Durable relationship publication completed during finalize and target
      // custody is committed. Only fence release remains, so this is cleanup
      // debt and must not invoke abort/relationship compensation.
    } finally {
      preparedWorkspace = undefined;
    }
  }

  publishPhase(input.publishOwnerUpdate, 'cleaning_source', 'Cleaning up source');
  let cleanupWarning: Failure | null = null;
  try {
    const cleanup = await input.cleanupSource({
      machineId: source.sourceMachineId,
      handoffId,
      mode: 'source_cleanup',
    }, completionSignal);
    const cleanupFailure = readFailure(cleanup, 'session_handoff_source_cleanup_failed');
    const cleanupResponse = SessionHandoffCommitResponseSchema.safeParse(cleanup);
    cleanupWarning = cleanupFailure ?? (!cleanupResponse.success
      ? {
          ok: false as const,
          errorCode: 'session_handoff_source_cleanup_invalid',
          error: 'session_handoff_source_cleanup_invalid',
        }
      : null);
  } catch (error) {
    // Target custody is already committed. Source cleanup is an idempotent
    // source-side commit mode, so a throw or cancellation is explicit cleanup
    // debt for a later retry, never authority to abort the committed target.
    cleanupWarning = readThrownFailure(error, 'session_handoff_source_cleanup_failed');
  }
  // Workspace cleanup debt belongs to the workspace outcome; the top-level
  // warning stays the source-cleanup owner so neither is reported as the other.
  committedWorkspaceOutcome = buildWorkspaceOutcome(
    workspaceCommitted,
    workspaceCleanupFailure
      ? { code: workspaceCleanupFailure.errorCode, message: workspaceCleanupFailure.error }
      : null,
  );

  return {
    ok: true,
    result: {
      handoffId,
      status: committedResponse.data.status,
      workspace: committedWorkspaceOutcome,
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
    if (committedTarget) {
      // Target custody is irreversible at this point. Any later failure leaves
      // only idempotent source/fence cleanup debt; it must never re-enter the
      // pre-commit abort path and terminate the now-authoritative target.
      const cleanupFailure = readThrownFailure(error, 'session_handoff_source_cleanup_failed');
      return {
        ok: true,
        result: {
          handoffId: committedTarget.handoffId,
          status: committedTarget.status,
          ...(committedWorkspaceOutcome ? { workspace: committedWorkspaceOutcome } : {}),
          warning: {
            code: 'source_cleanup_failed',
            message: cleanupFailure.error,
          },
        },
      };
    }
    if (!input.signal.aborted || cancellationClosed) {
      await abortWorkspace();
      if (workspaceAbortFailure !== undefined) {
        throw Object.assign(
          new AggregateError([error, workspaceAbortFailure], 'Session handoff and workspace cleanup both failed'),
          { cause: error },
        );
      }
      throw error;
    }
    await abortWorkspace();
    if (!cancellationSourceMachineId || !cancellationHandoffId) {
      return withWorkspaceAbortFailure({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    }
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
        error: workspaceAbortFailure === undefined
          ? 'session_handoff_cancellation_unconfirmed'
          : `session_handoff_cancellation_unconfirmed; workspace cleanup failed: ${cleanupFailureMessage(workspaceAbortFailure)}`,
      };
    }
    return withWorkspaceAbortFailure({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
  }
}
