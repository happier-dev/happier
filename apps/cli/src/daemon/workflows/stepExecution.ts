import type { StoredCredentials } from '@/persistence';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import {
  sendSessionMessage,
  waitForSessionInputResult,
  type SessionInputResultObservationV1,
  type SessionInputResultV1,
  type SessionInputUsageV1,
  type WaitForSessionInputResult,
} from '@/session/services/sendSessionMessage';
import type { SessionMessageModelSelectionInput } from '@/session/services/resolveSessionMessageModel';
import {
  buildWorkflowSessionInputAdmissionV2,
} from '@/session/services/sessionInputAdmissionIdentity';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { MentionRefV1, PortableComposerAttachmentV1, ExecutionRunResultContractV1, SessionInputAdmissionResultV1, SessionInputSourceAuthorityV1, SessionInputWorkflowV2 } from '@happier-dev/protocol';

export type WorkflowSessionInputObservation =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'completed'; result: string; usage?: SessionInputUsageV1 }>
  | Readonly<{ kind: 'failed'; code: string; message: string; usage?: SessionInputUsageV1 }>
  | Readonly<{ kind: 'cancelled'; usage?: SessionInputUsageV1 }>;

/** Classifies the exact Session outcome; cancellation custody stays with its caller. */
export function classifyWorkflowSessionInputResult(
  result: SessionInputResultV1,
): WorkflowSessionInputObservation {
  switch (result.kind) {
    case 'pending': return { kind: 'pending' };
    case 'final_text': return {
      kind: 'completed', result: result.text,
      ...(result.usage ? { usage: result.usage } : {}),
    };
    case 'terminal_no_result': return {
      kind: 'completed', result: '',
      ...(result.usage ? { usage: result.usage } : {}),
    };
    case 'failed': return {
      kind: 'failed', code: 'session_input_failed', message: result.message,
      ...(result.usage ? { usage: result.usage } : {}),
    };
    case 'cancelled': return {
      kind: 'cancelled',
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
}

export type WorkflowDetachedExecutionRunObservation =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'completed'; result: string | import('@happier-dev/protocol').JsonValue }>
  | Readonly<{ kind: 'failed'; code: string }>
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

/**
 * Sends one workflow-authored turn through the canonical detached Run API.
 * The workflow local id and execution-owned result contract cross together;
 * this adapter owns neither provider delivery nor result decoding.
 */
export async function sendWorkflowDetachedExecutionRunInput(params: Readonly<{
  runId: string;
  text: string;
  localInputId: string;
  resultContract: ExecutionRunResultContractV1;
  send: (request: Readonly<{
    runId: string;
    message: string;
    delivery: 'prompt';
    localInputId: string;
    resultContract: ExecutionRunResultContractV1;
  }>) => Promise<Readonly<{ ok: boolean; errorCode?: string; error?: string }>>;
}>): Promise<Readonly<{ ok: boolean; errorCode?: string; error?: string }>> {
  return await params.send({
    runId: params.runId,
    message: params.text,
    delivery: 'prompt',
    localInputId: params.localInputId,
    resultContract: params.resultContract,
  });
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
    // An attached Workflow input is first durably admitted by Session Pending.
    // Until that owner delivers it into the retained Run, absence from the
    // Run's current/last projection is not proof of lost custody.
    if (response.run.status === 'running') return { kind: 'pending' };
    return { kind: 'outcome_uncertain', code: 'execution_run_input_not_observed' };
  }
  if (turn.state === 'active') return { kind: 'pending' };
  // Host-owned terminal truth for the exact input: the run owner retired its
  // custody. This is not a claim that the provider process has exited.
  if (turn.state === 'cancelled') return { kind: 'cancelled', code: 'execution_run_input_cancelled' };
  if (turn.state === 'failed') {
    return {
      kind: 'failed',
      code: response.run.error?.code === 'workflow_interaction_capacity_exceeded'
        ? response.run.error.code
        : 'execution_run_input_failed',
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
  /** Coordinator-resolved authoring selection; Session owns model normalization. */
  modelSelectionInput?: SessionMessageModelSelectionInput;
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
      ...(requestedPermissionCeiling ? { requestedPermissionCeiling } : {}),
      ...(params.sourceAuthority ? { sourceAuthority: params.sourceAuthority } : {}),
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
    credentials: params.credentials,
    idOrPrefix: params.sessionId,
    message: params.text,
    wait: false,
    timeoutMs: 30_000,
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
    inputAdmission,
    machineAdmissionTransport: params.machineAdmissionTransport,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return result.admissionResult
    ?? { status: 'outcomeUnknown', localId, code: 'session_input_admission_result_missing' };
}

/** Observe an already-authored Workflow Session input without resetting time. */
export async function observeWorkflowSessionInputResult(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  localId: string;
  deadlineMs?: number;
  timeoutAfterInputMs?: number;
  beforeInputObservation?: () => Promise<void>;
  onInputMaterialized?: (acceptedAtMs: number) => Promise<void>;
  signal?: AbortSignal;
}>): Promise<WaitForSessionInputResult> {
  const observation: SessionInputResultObservationV1 = params.deadlineMs === undefined
    ? params.timeoutAfterInputMs === undefined ? { kind: 'no_deadline' }
      : { kind: 'after_input', timeoutMs: params.timeoutAfterInputMs }
    : { kind: 'absolute_deadline', deadlineMs: params.deadlineMs };
  return await waitForSessionInputResult({
    credentials: params.credentials,
    idOrPrefix: params.sessionId,
    localId: params.localId,
    observation,
    ...(params.beforeInputObservation ? { beforeInputObservation: params.beforeInputObservation } : {}),
    ...(params.onInputMaterialized ? { onInputMaterialized: params.onInputMaterialized } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
}
