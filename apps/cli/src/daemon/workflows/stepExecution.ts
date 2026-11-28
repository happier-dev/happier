import type { SessionInputAttention } from '@/session/services/sessionInputAttention';
import type { StoredCredentials } from '@/persistence';
import type { ActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { sanitizeSessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { SessionTeamCredentialBindingMutationRejectionV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingRejectionV1';
export { readProjectSetupConsentHoldV1 as readWorkflowProjectSetupConsentHold } from '@happier-dev/protocol/actions/projectActionFamily';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import {
  sendSessionMessage,
  waitForSessionInputResult,
  type SessionInputResultObservationV1,
  type SessionInputUsageV1,
  type WaitForSessionInputReplyResult,
} from '@/session/services/sendSessionMessage';
import type { SessionMessageModelSelectionInput } from '@/session/services/resolveSessionMessageModel';
import { containsTranscriptSecretMask } from '@/api/session/client/transport/transcriptSecretRedaction';
import { WORKFLOW_SESSION_REPLY_SECRET_MASKED_CODE } from '@happier-dev/protocol/workflows/workflowResultFieldsV1';
import type { SessionMessageReplyOutcomeV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/references';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import {
  buildWorkflowSessionInputAdmissionV2,
} from '@/session/services/sessionInputAdmissionIdentity';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { MentionRefV1, PortableComposerAttachmentV1, ExecutionRunResultContractV1, SessionInputAdmissionResultV1, SessionInputSourceAuthorityV1, SessionInputWorkflowV2 } from '@happier-dev/protocol';

export type WorkflowSessionInputObservation = (
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'completed'; result: string; usage?: SessionInputUsageV1 }>
  | Readonly<{ kind: 'failed'; code: string; message: string; runtimeIssueV1?: SessionRuntimeIssueV1; usage?: SessionInputUsageV1 }>
  | Readonly<{ kind: 'cancelled'; usage?: SessionInputUsageV1 }>
  | Readonly<{ kind: 'needs_attention'; code: string; message?: string; runtimeIssueV1?: SessionRuntimeIssueV1; usage?: SessionInputUsageV1 }>
) & Readonly<{ replyOutcome?: SessionMessageReplyOutcomeV1 }>;

/**
 * A Session step's result is read from the stored reply, which the transcript writer masked. When that
 * text no longer decodes and carries the masker's marker, the cause is the masking, not the authored contract.
 */
export function readWorkflowSessionReplyFailureCode(storedReply: unknown, fallback: string): string {
  return typeof storedReply === 'string' && containsTranscriptSecretMask(storedReply)
    ? WORKFLOW_SESSION_REPLY_SECRET_MASKED_CODE : fallback;
}

export function workflowRuntimeFailureKind(issue: SessionRuntimeIssueV1 | undefined): 'failed' | 'needs_attention' {
  return issue?.source === 'usage_limit' ? 'needs_attention' : 'failed';
}

/** Classifies the exact Session outcome; cancellation custody stays with its caller. */
export function classifyWorkflowSessionInputResult(
  result: Extract<WaitForSessionInputReplyResult, { ok: true }>['result'],
  replyOutcome = result.kind === 'fulfilled' ? result.outcome : undefined,
): WorkflowSessionInputObservation {
  const reply = replyOutcome ? { replyOutcome } : {};
  switch (result.kind) {
    case 'fulfilled': {
      const outcome = result.outcome;
      switch (outcome.kind) {
        case 'pass':
          return { kind: 'completed', result: '', ...reply };
        case 'terminal_no_result': return { kind: 'needs_attention', code: 'session_input_result_unavailable', ...reply };
        case 'cancelled': return { kind: 'cancelled', ...reply };
        case 'failed': {
          const runtimeIssueV1 = 'runtimeIssueV1' in outcome ? sanitizeSessionRuntimeIssueV1(outcome.runtimeIssueV1) : null;
          return { kind: workflowRuntimeFailureKind(runtimeIssueV1 ?? undefined), code: 'session_input_failed', message: 'The requested session failed.',
            ...(runtimeIssueV1 ? { runtimeIssueV1 } : {}), ...reply };
        }
        case 'declined': return { kind: 'failed', code: 'session_input_declined', message: 'The requested session declined.', ...reply };
        case 'answer': return { kind: 'needs_attention', code: 'session_input_result_unavailable', ...reply };
      }
    }
    case 'pending': return { kind: 'pending' };
    case 'final_text': return {
      kind: 'completed', result: result.text,
      ...reply,
      ...(result.usage ? { usage: result.usage } : {}),
    };
    case 'terminal_no_result': return {
      kind: 'needs_attention', code: 'session_input_result_unavailable',
      ...reply,
      ...(result.usage ? { usage: result.usage } : {}),
    };
    case 'failed': return {
      kind: workflowRuntimeFailureKind(result.runtimeIssueV1), code: 'session_input_failed', message: result.message,
      ...reply,
      ...(result.runtimeIssueV1 ? { runtimeIssueV1: result.runtimeIssueV1 } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
    case 'cancelled': return {
      kind: 'cancelled',
      ...reply,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
}

export type WorkflowDetachedExecutionRunObservation =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'completed'; result: string | import('@happier-dev/protocol').JsonValue }>
  | Readonly<{ kind: 'failed'; code: string; message?: string; failureCause?: ActionFailureCauseV1; runtimeIssueV1?: SessionRuntimeIssueV1 }>
  | Readonly<{ kind: 'needs_attention'; code: string; message?: string; runtimeIssueV1?: SessionRuntimeIssueV1 }>
  | Readonly<{ kind: 'cancelled'; code?: string }>
  | Readonly<{ kind: 'outcome_uncertain'; code: string }>;

export type WorkflowPendingExecutionRunStopObservation = Readonly<{
  kind: 'unresolved';
  code: string;
}>;

/**
 * A successful host stop retires host custody, but does not prove that the
 * provider/process reached a terminal state. Both live execution and recovery
 * consume this same classification and project it into their own result union.
 */
function classifyWorkflowPendingExecutionRunStop(
  stopped: Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode: string }>,
): WorkflowPendingExecutionRunStopObservation {
  return {
    kind: 'unresolved',
    code: stopped.ok ? 'workflow_outcome_unresolved' : stopped.errorCode,
  };
}

export type WorkflowPendingExecutionRunStopSettlement =
  | Exclude<WorkflowDetachedExecutionRunObservation, Readonly<{ kind: 'pending' | 'outcome_uncertain' }>>
  | WorkflowPendingExecutionRunStopObservation;

/**
 * Stops one owned pending input through the canonical `execution.run.stop`
 * owner, then reads the exact input once more through the canonical Run
 * projection. Only a definitive fact observed there — the committed result,
 * a failed turn, or the host-cancelled turn — becomes the step outcome. Stop
 * acceptance alone never does, so a still-active or unobservable input stays
 * unresolved stop custody for recovery. Live execution and recovery share
 * this one settlement so a cancelled step never loses a result the host had
 * already committed.
 */
export async function stopWorkflowPendingExecutionRunInput(params: Readonly<{
  runId: string;
  localInputId: string;
  stop: () => Promise<Parameters<typeof classifyWorkflowPendingExecutionRunStop>[0]>;
  get: Parameters<typeof observeWorkflowDetachedExecutionRunInput>[0]['get'];
  observe?: typeof observeWorkflowDetachedExecutionRunInput;
}>): Promise<WorkflowPendingExecutionRunStopSettlement> {
  const stopped = await params.stop();
  let observed: WorkflowDetachedExecutionRunObservation;
  try {
    observed = await (params.observe ?? observeWorkflowDetachedExecutionRunInput)({
      runId: params.runId,
      localInputId: params.localInputId,
      get: params.get,
    });
  } catch {
    return classifyWorkflowPendingExecutionRunStop(stopped);
  }
  if (observed.kind === 'pending' || observed.kind === 'outcome_uncertain') {
    return classifyWorkflowPendingExecutionRunStop(stopped);
  }
  return observed;
}

/** Current/last turn correspondence belongs to the native observation owner. */
export function resolveWorkflowDetachedExecutionRunInputTurn(
  run: ReturnType<typeof ExecutionRunGetResponseSchema.parse>['run'],
  runId: string,
  localInputId: string,
) {
  if (run.runId !== runId) return null;
  const turns = run.inputTurns;
  return turns?.current?.inputIds.includes(localInputId)
    ? turns.current
    : turns?.last?.inputIds.includes(localInputId) ? turns.last : null;
}

/** One-shot exact-turn observation for restart/rejoin; scheduling and polling stay outside. */
export async function observeWorkflowDetachedExecutionRunInput(params: Readonly<{
  runId: string;
  localInputId: string;
  get: (request: Readonly<{ runId: string; includeStructured: false }>) => Promise<unknown>;
  /** Only exact-input evidence may reach the current Workflow claim's writer. */
  onRunObserved?: (run: ReturnType<typeof ExecutionRunGetResponseSchema.parse>['run']) => Promise<void>;
}>): Promise<WorkflowDetachedExecutionRunObservation> {
  const response = ExecutionRunGetResponseSchema.parse(await params.get({
    runId: params.runId,
    includeStructured: false,
  }));
  if (response.run.runId !== params.runId) {
    return { kind: 'outcome_uncertain', code: 'execution_run_correspondence_mismatch' };
  }
  const turn = resolveWorkflowDetachedExecutionRunInputTurn(response.run, params.runId, params.localInputId);
  if (!turn) {
    // A different retained turn says nothing about this input's outcome.
    // Pre-native refusal is correlated by startExecutionRun at the initial-input producer.
    if (response.run.inputTurns?.current || response.run.inputTurns?.last) {
      return { kind: 'outcome_uncertain', code: 'execution_run_input_not_observed' };
    }
    // An attached Workflow input is first durably admitted by Session Pending.
    // Until that owner delivers it into the retained Run, absence from the
    // Run's current/last projection is not proof of lost custody.
    if (response.run.status === 'running') return { kind: 'pending' };
    return { kind: 'outcome_uncertain', code: 'execution_run_input_not_observed' };
  }
  await params.onRunObserved?.(response.run);
  if (turn.state === 'active') return { kind: 'pending' };
  // Host-owned terminal truth for the exact input: the run owner retired its
  // custody. This is not a claim that the provider process has exited.
  if (turn.state === 'cancelled') return { kind: 'cancelled', code: 'execution_run_input_cancelled' };
  if (turn.state === 'failed') {
    const error = turn.error ?? response.run.error;
    const teamRefusal = error?.details && SessionTeamCredentialBindingMutationRejectionV1Schema.safeParse({
      code: error.code, reason: error.details.reason,
    });
    return {
      kind: workflowRuntimeFailureKind(error?.runtimeIssueV1),
      code: error?.code ?? 'execution_run_input_failed',
      ...(error?.message ? { message: error.message } : {}),
      ...(error?.runtimeIssueV1 ? { runtimeIssueV1: error.runtimeIssueV1 } : {}),
      ...(teamRefusal?.success ? { failureCause: {
        phase: 'execution.run.start', errorClass: 'Error', errorCode: teamRefusal.data.code,
        nativeErrorReason: teamRefusal.data.reason, httpStatus: null,
      } satisfies ActionFailureCauseV1 } : {}),
    };
  }
  if (!turn.result) {
    return { kind: 'outcome_uncertain', code: 'execution_run_result_not_observed' };
  }
  return { kind: 'completed', result: turn.result.value };
}

export type WorkflowSessionInputAdmissionOutcomeV2 = SessionInputAdmissionResultV1;

/**
 * Session arm for a workflow child invocation. Pending admission and permission
 * settlement remain owned by the incumbent Session sender/materializer.
 */
export async function enqueueWorkflowSessionInput(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  workflow: SessionInputWorkflowV2;
  /** Accepted Workflow depth supplied by the host, not portable authored input. */
  workDepth?: number;
  executionRunTarget?: Readonly<{
    runId: string;
    resultContract: ExecutionRunResultContractV1;
  }>;
  text: string;
  displayText?: string;
  mentions?: readonly MentionRefV1[];
  attachments?: readonly PortableComposerAttachmentV1[];
  /** Coordinator-resolved authoring selection; Session owns validation/application. */
  permissionMode?: string | null;
  /** Immutable mediated source retained by the accepted Workflow Run. */
  sourceAuthority?: SessionInputSourceAuthorityV1;
  /** Original accepted request cause, independent of the executing Session's owner. */
  actionRequestAttributionV1?: ActionRequestAttributionV1;
  discussionAddressing?: DiscussionAddressingV1;
  /** Coordinator-resolved authoring selection; Session owns model normalization. */
  modelSelectionInput?: SessionMessageModelSelectionInput;
  modelSelectionUpdatedAt?: number;
  incomingResumeOptions?: Parameters<typeof sendSessionMessage>[0]['incomingResumeOptions'];
  /** Frozen Session placement; input admission rechecks it against current owner metadata. */
  targetMachineId?: string;
  /** Frozen identity from the accepted Run. When supplied it must equal the canonical derivation. */
  localInputId?: string;
  signal?: AbortSignal;
  machineAdmissionTransport: NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>;
}>): Promise<WorkflowSessionInputAdmissionOutcomeV2> {
  if (!params.text.trim()) return { status: 'rejected', code: 'session_input_invalid' };
  const derivedLocalId = deriveWorkflowSessionInputLocalIdV2(params.workflow);
  if (params.localInputId !== undefined && params.localInputId !== derivedLocalId) {
    return { status: 'rejected', code: 'session_input_invalid' };
  }
  const localId = params.localInputId ?? derivedLocalId;
  const requestedPermissionCeiling = params.permissionMode
    ? parsePermissionIntentAlias(params.permissionMode)
    : null;
  if (params.permissionMode && !requestedPermissionCeiling) {
    return { status: 'rejected', code: 'session_input_invalid' };
  }
  const inputAdmission = buildWorkflowSessionInputAdmissionV2(
    params.workDepth !== undefined
      ? { ...params.workflow, workDepth: params.workDepth }
      : params.workflow,
    {
      replyIntent: { mode: 'wait' },
      ...(params.discussionAddressing ? { discussionAddressing: params.discussionAddressing } : {}),
      ...(requestedPermissionCeiling ? { requestedPermissionCeiling } : {}),
      ...(params.sourceAuthority ? { sourceAuthority: params.sourceAuthority } : {}),
      ...(params.actionRequestAttributionV1 ? { actionRequestAttributionV1: params.actionRequestAttributionV1 } : {}),
    },
  );
  const displayText = typeof params.displayText === 'string' && params.displayText.trim().length > 0
    ? params.displayText
    : undefined;
  const mentions = params.mentions ?? [];
  const attachments = params.attachments ?? [];
  const messageMeta = {
    ...(displayText ? { displayText } : {}),
    ...(mentions.length > 0 || attachments.length > 0
      ? {
          [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
            v: 1,
            ...(mentions.length > 0 ? { mentions: [...mentions] } : {}),
            ...(attachments.length > 0 ? { composerAttachments: [...attachments] } : {}),
          },
        }
      : {}),
  };
  const result = await sendSessionMessage({
    explicitMessageSend: true,
    credentials: params.credentials,
    idOrPrefix: params.sessionId,
    message: params.text,
    wait: false,
    timeoutMs: resolveSessionMessageAdmissionTimeoutMs(),
    localId,
    requestedAction: { v: 1, kind: 'enqueue' },
    ...(params.executionRunTarget
      ? {
          recipient: { kind: 'execution_run' as const, runId: params.executionRunTarget.runId },
          resultContract: params.executionRunTarget.resultContract,
        }
      : {}),
    ...(Object.keys(messageMeta).length > 0 ? { messageMeta } : {}),
    ...(params.modelSelectionInput === undefined ? {} : { modelSelectionInput: params.modelSelectionInput }),
    ...(params.modelSelectionUpdatedAt === undefined ? {} : { modelSelectionUpdatedAt: params.modelSelectionUpdatedAt }),
    ...(params.incomingResumeOptions ? { incomingResumeOptions: params.incomingResumeOptions } : {}),
    inputAdmission,
    ...(params.targetMachineId ? { targetMachineId: params.targetMachineId } : {}),
    machineAdmissionTransport: params.machineAdmissionTransport,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return (!result.ok && result.settlementResult?.status === 'held' ? result.settlementResult : result.admissionResult)
    ?? { status: 'outcomeUnknown', localId, code: 'session_input_admission_result_missing' };
}

/** Observe an already-authored Workflow Session input without resetting time. */
export async function observeWorkflowSessionInputResult(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  localId: string;
  /** Read current state for recovery without expiring the reply obligation. */
  snapshotAtMs?: number;
  deadlineMs?: number;
  timeoutAfterInputMs?: number;
  /** Physical cancellation custody is independent of original reply publication. */
  observeReply?: boolean;
  beforeInputObservation?: () => Promise<void>;
  onInputMaterialized?: (acceptedAtMs: number) => Promise<void>;
  onAttentionRequired?: (attention: SessionInputAttention) => Promise<void>;
  signal?: AbortSignal;
}>): Promise<WaitForSessionInputReplyResult> {
  const observation: SessionInputResultObservationV1 = params.snapshotAtMs !== undefined
    ? { kind: 'snapshot', atMs: params.snapshotAtMs }
    : params.deadlineMs === undefined
    ? params.timeoutAfterInputMs === undefined ? { kind: 'no_deadline' }
      : { kind: 'after_input', timeoutMs: params.timeoutAfterInputMs }
    : { kind: 'absolute_deadline', deadlineMs: params.deadlineMs };
  return await waitForSessionInputResult({
    credentials: params.credentials,
    idOrPrefix: params.sessionId,
    localId: params.localId,
    observeReply: params.observeReply !== false,
    observation,
    ...(params.beforeInputObservation ? { beforeInputObservation: params.beforeInputObservation } : {}),
    ...(params.onInputMaterialized ? { onInputMaterialized: params.onInputMaterialized } : {}),
    ...(params.onAttentionRequired ? { onAttentionRequired: params.onAttentionRequired } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
}
