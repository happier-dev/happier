import {
  classifyWorkflowHoldV1,
  classifyWorkflowReviewEntryV1,
  freezeWorkflowLoopLimitsV1,
  deriveWorkflowReplacementId,
  sameStrictJsonValue,
  resolveWorkflowInvocationStructureV1,
  resolveWorkflowRetainedConversationAttemptV1,
  type WorkflowAuthoredInputV1,
  type WorkflowAuthoredProducerRef,
  type WorkflowBlock,
  type WorkflowAcceptedAuthorizationV1,
  type WorkflowCheckpointEnvelopeV1,
  type WorkflowDefinitionV1,
  type WorkflowMaterializedLeafV1,
  type WorkflowFinalResultV1,
  type WorkflowInvocationLifecycleV1,
  type WorkflowRunInvocationIndexV1,
  type WorkflowContainerProgressV1,
  type WorkflowContainerResultSelectorV1,
  type WorkflowInvocationFrameV1,
  type WorkflowLoopSourceSelectionV1,
  type WorkflowLoopOutcomeV1,
  type WorkflowRunExecutionTargetV1,
  type WorkflowProgressEnvelopeV1,
  type WorkflowUsageV1,
  type WorkflowStep,
  type WorkflowWaitLeafV1,
  type WorkflowActionLeafV1,
  type WorkflowNestedLeafV1,
  type WorkflowStepExecutionSelection,
  type WorkflowValueReference,
  type WorkflowWorkspaceDescriptorV1,
  type WorkflowWorkspaceProgressV1,
  type WorkflowWorkspaceResolutionV1,
} from '@happier-dev/protocol/workflows';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { prepareActionCompletionV1, resumeActionCompletionV1, type createActionExecutor, type ActionExecutorContext,
  type ActionCompletionRun, type ExecutionRunTerminalObservation } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions';
import { validateExecutionRunProfileResult } from '@happier-dev/protocol/execution/runs/resultContract';
import { decodeExecutionRunResultObservation, type ExecutionRunResultDecodeResult } from '@happier-dev/protocol/execution/runs/resultContract';
import { isAuthoritativeAutomationRunCancellation } from '@/daemon/automation/automationRunCancellation';
import type { AutomationRunCause } from '@happier-dev/protocol/automations/run-cause';

import {
  evaluateWorkflowCondition,
  bindAutomationWorkflowInputs,
  evaluateWorkflowStopCondition,
  selectWorkflowResultPath,
  materializeWorkflowStepInput,
  resolveWorkflowValueReference,
  isWorkflowJsonObject,
  WorkflowInputResolutionError,
  type MaterializedWorkflowStepInput,
  type WorkflowJsonValue,
  type WorkflowValueResolutionRuntime,
} from './input';
import { findWorkflowStepById } from './workflowDefinitionTraversal';
import type { WorkflowWorkspaceSource } from './resolveWorkflowWorkspace';
import {
  resolveWorkflowConversationBinding,
  workflowConversationAdmissionKey,
  sameWorkflowConversationTarget,
  workflowBodyOwnsConversation,
  type WorkflowConversationBinding,
  type WorkflowConversationTargetClass,
} from './workflowConversation';
import {
  createWorkflowProducerBinding,
  readWorkflowLoopBodyFrame,
  resolveWorkflowProducerInFrame,
  resolveWorkflowInvocationStructure,
  type WorkflowInvocationBindingRow,
  type WorkflowProducerBinding,
  type WorkflowScopeFrame,
} from './workflowScopeBinding';

type WorkflowInvocationPath = WorkflowProgressEnvelopeV1['invocationPath'];
export type WorkflowConversationWorkspace = Pick<WorkflowWorkspaceDescriptorV1, 'machineId' | 'directory'>;

export type WorkflowCoordinatorInvocation = Readonly<{
  key: string;
  /** Opaque persisted row id. It is deliberately distinct from the deterministic invocation key. */
  recordId: string;
  sequence?: string;
  /** Stable logical identity retained across explicit retry attempts. */
  logicalInvocationRecordId?: string;
  runId: string;
  blockId: string;
  /** Internal structural parent key; never projected into authored JSON. */
  parentKey?: string;
  /** Deterministic structural slot under parent, encoded as canonical decimal. */
  memberOrdinal?: string;
  path: WorkflowInvocationPath;
  attempt: number;
  acceptedAtMs: number;
  contentRevision?: string;
  blockKind?: WorkflowProgressEnvelopeV1['blockKind'];
  review?: WorkflowProgressEnvelopeV1['review'];
  lifecycle: WorkflowInvocationLifecycleV1;
  result?: WorkflowJsonValue;
  usage?: WorkflowUsageV1;
  reason?: string;
  reasonMessage?: string;
  validationIssues?: WorkflowProgressEnvelopeV1['validationIssues'];
  execution?: WorkflowProgressEnvelopeV1['execution'];
  sharedConversationInvocationRecordId?: WorkflowProgressEnvelopeV1['sharedConversationInvocationRecordId'];
  observationDeadline?: WorkflowProgressEnvelopeV1['observationDeadline'];
  previousAttemptRecordId?: string;
  recovery?: WorkflowProgressEnvelopeV1['recovery'];
  input?: WorkflowAuthoredInputV1;
  resultContract?: WorkflowProgressEnvelopeV1['resultContract'];
  workspace?: WorkflowWorkspaceProgressV1;
  frame?: WorkflowInvocationFrameV1;
  container?: WorkflowContainerProgressV1;
  containerResult?: WorkflowContainerResultSelectorV1;
}>;

export type WorkflowCoordinatorStore = Readonly<{
  /** Parent read precedes exact row reads; this revision alone authorizes park. */
  confirmReviewHolds: (params: Readonly<{ runId: string; recordIds: readonly string[] }>) => Promise<Readonly<{
    revision: number;
    control: 'running' | 'pause_requested' | 'cancel_requested';
    rows: readonly WorkflowCoordinatorInvocation[];
  }>>;
  admitReviewReplacement: (params: Readonly<{ prior: WorkflowCoordinatorInvocation; recordId: string;
    input: WorkflowAuthoredInputV1 }>) => Promise<WorkflowCoordinatorInvocation>;
  read: (key: string) => WorkflowCoordinatorInvocation | undefined | Promise<WorkflowCoordinatorInvocation | undefined>;
  readCurrent: (params: Readonly<{
    runId: string;
    blockId: string;
    scope: WorkflowInvocationPath['scope'];
    parentKey?: string;
    memberOrdinal: string;
  }>) => WorkflowCoordinatorInvocation | undefined | Promise<WorkflowCoordinatorInvocation | undefined>;
  readByLogicalInvocation: (logicalInvocationRecordId: string) => WorkflowCoordinatorInvocation | undefined | Promise<WorkflowCoordinatorInvocation | undefined>;
  readInvocationBindingRow: (recordId: string) => Promise<WorkflowInvocationBindingRow | undefined>;
  /** Opaque current member indices, ordered by structural ordinal; no result content is opened. */
  listCurrentMembers: (parentKey: string) => Promise<readonly WorkflowRunInvocationIndexV1[]>;
  listByLifecycle: (params: Readonly<{
    runId: string;
    lifecycles: readonly WorkflowInvocationLifecycleV1[];
  }>) => readonly WorkflowCoordinatorInvocation[] | Promise<readonly WorkflowCoordinatorInvocation[]>;
  ensureIntent: (invocation: WorkflowCoordinatorInvocation & Readonly<{ blockKind: WorkflowProgressEnvelopeV1['blockKind'] }>) => Promise<WorkflowCoordinatorInvocation>;
  commitFact: (params: Readonly<{
    key: string;
    lifecycle: WorkflowInvocationLifecycleV1;
    review?: WorkflowProgressEnvelopeV1['review'];
    result?: WorkflowJsonValue;
    usage?: WorkflowUsageV1;
    /** Private invocation-scoped request state; never a selected step result. */
    interaction?: WorkflowJsonValue;
    reason?: string;
    reasonMessage?: string;
    validationIssues?: WorkflowProgressEnvelopeV1['validationIssues'];
    execution?: WorkflowProgressEnvelopeV1['execution'];
    sharedConversationInvocationRecordId?: WorkflowProgressEnvelopeV1['sharedConversationInvocationRecordId'];
    observationDeadline?: WorkflowProgressEnvelopeV1['observationDeadline'];
    input?: WorkflowAuthoredInputV1;
    resultContract?: WorkflowProgressEnvelopeV1['resultContract'];
    workspace?: WorkflowWorkspaceProgressV1;
    container?: WorkflowContainerProgressV1;
    containerResult?: WorkflowContainerResultSelectorV1;
  }>) => Promise<WorkflowCoordinatorInvocation>;
  readContainerResult: (record: WorkflowCoordinatorInvocation,
    resolveWorkflowOutput?: (record: WorkflowCoordinatorInvocation) => Promise<WorkflowJsonValue>,
  ) => WorkflowJsonValue | undefined | Promise<WorkflowJsonValue | undefined>;
  commitContainerResult: (params: Readonly<{ key: string }>) => Promise<WorkflowCoordinatorInvocation>;
  commitSharedConversation: (params: Readonly<{
    scopeOwnerKey: string;
    targetClass: WorkflowConversationTargetClass;
    invocationRecordId: string;
    replacesExecution?: WorkflowProgressEnvelopeV1['execution'];
  }>) => Promise<void>;
  readFrontier: () => WorkflowCheckpointEnvelopeV1['frontier'] | Promise<WorkflowCheckpointEnvelopeV1['frontier']>;
  commitFrontier: (params: Readonly<{ nextBlockOrdinal: number }>) => Promise<void>;
  readControl: (runId: string) => Promise<'running' | 'pause_requested' | 'cancel_requested'>;
}>;

export type WorkflowStepExecutionResult =
  | Readonly<{
      kind: 'completed';
      result?: WorkflowJsonValue;
      usage?: WorkflowUsageV1;
      /** Native Execution Run results are already decoded; Session results remain exact assistant text. */
      resultEncoding?: 'raw_text' | 'typed';
    }>
  | Readonly<{ kind: 'failed'; code: string; message?: string; usage?: WorkflowUsageV1 }>
  | Readonly<{ kind: 'needs_attention'; code: string; usage?: WorkflowUsageV1 }>
  | Readonly<{ kind: 'cancelled'; code?: string; usage?: WorkflowUsageV1 }>
  | Readonly<{ kind: 'outcome_uncertain'; code: string; usage?: WorkflowUsageV1 }>;

export type WorkflowStepExecutor = (params: Readonly<{
  runId: string;
  step: WorkflowStep;
  /** Role projected by the same source-qualified materialized leaf as execution selection. */
  role?: WorkflowMaterializedLeafV1['role'];
  memberOrdinal?: string;
  invocation: WorkflowProgressEnvelopeV1;
  /** Physical attempt row; exact input identities change across retries. */
  invocationRecordId?: string;
  recoveryPreviousExecution?: WorkflowProgressEnvelopeV1['execution'];
  recoveryPreviousWorkspace?: WorkflowWorkspaceDescriptorV1;
  input: MaterializedWorkflowStepInput;
  execution: WorkflowStepExecutionSelection;
  /** One immutable execution placement frozen at Run admission. */
  executionTarget: WorkflowRunExecutionTargetV1;
  workspace: WorkflowWorkspaceDescriptorV1;
  /** Opaque preparation produced by the target's canonical conversation owner before workspace effects. */
  preparedStep?: unknown;
  producerBinding?: WorkflowProducerBinding;
  conversationBinding?: WorkflowConversationBinding;
  originSessionId?: string;
  /** Supplied only when ORC's real offered-row consumer is wired. */
  onOriginInputOffered?: (execution: Extract<NonNullable<WorkflowProgressEnvelopeV1['execution']>, { kind: 'session' }>, renderedText: string) => Promise<void>;
  /** Immutable authority admitted with the Run; leaf adapters reject broader effective requests. */
  authorization: WorkflowAcceptedAuthorizationV1;
  /** Reconstructed admission has no durable correspondence and may only locate/observe prior effects. */
  observationOnly?: boolean;
  item?: Readonly<{ value: WorkflowJsonValue; index: number; position: number; count: number }>;
  iteration?: Readonly<{ index: number; position: number; count: number; stopReason: WorkflowJsonValue | null }>;
  onInputAccepted: (execution: NonNullable<WorkflowProgressEnvelopeV1['execution']>, acceptedAtMs?: number) => Promise<void>;
  /** Origin observation reads the canonical Run control before waiting for host dispatch. */
  readOriginInputControl?: () => Promise<'running' | 'pause_requested' | 'cancel_requested'>;
  /** Durable admission fence after preparation, immediately before releasing input. */
  beforeInputAdmission: () => Promise<void>;
  /** Exact pre-terminal Workflow fact emitted by a detached Execution Run. */
  onExecutionObservation?: (observation: Readonly<{
    execution: Extract<NonNullable<WorkflowProgressEnvelopeV1['execution']>, { kind: 'detached_run' }>;
    usage?: WorkflowUsageV1;
  }>) => Promise<void>;
  signal?: AbortSignal;
}>) => Promise<WorkflowStepExecutionResult>;

export type WorkflowStepPreparer = (params: Readonly<{
  runId: string;
  step: WorkflowStep;
  role?: WorkflowMaterializedLeafV1['role'];
  memberOrdinal?: string;
  invocation: WorkflowProgressEnvelopeV1;
  invocationRecordId?: string;
  recoveryPreviousExecution?: WorkflowProgressEnvelopeV1['execution'];
  recoveryPreviousWorkspace?: WorkflowWorkspaceDescriptorV1;
  execution: WorkflowStepExecutionSelection;
  executionTarget: WorkflowRunExecutionTargetV1;
  producerBinding: WorkflowProducerBinding;
  conversationBinding?: WorkflowConversationBinding;
  originSessionId?: string;
  onOriginInputOffered?: NonNullable<Parameters<WorkflowStepExecutor>[0]['onOriginInputOffered']>;
  authorization: WorkflowAcceptedAuthorizationV1;
  item?: Readonly<{ value: WorkflowJsonValue; index: number; position: number; count: number }>;
  iteration?: Readonly<{ index: number; position: number; count: number; stopReason: WorkflowJsonValue | null }>;
  signal?: AbortSignal;
}>) => Promise<Readonly<{
  conversationWorkspace?: WorkflowConversationWorkspace;
  preparedStep?: unknown;
  failure?: Readonly<{ kind: 'failed' | 'needs_attention'; code: string }>;
}>>;

export type WorkflowWorkspaceResolver = (params: Readonly<{
  runId: string;
  definition: WorkflowDefinitionV1;
  step: Pick<WorkflowStep, 'id' | 'execution'>;
  invocation: WorkflowCoordinatorInvocation;
  scope: WorkflowInvocationPath['scope'];
  producerBinding: WorkflowProducerBinding;
  conversationBinding?: WorkflowConversationBinding;
  defaultWorkspaceOwner?: WorkflowCoordinatorInvocation;
  useConversationWorkspace?: boolean;
  conversationWorkspace?: WorkflowConversationWorkspace;
  projectWorkspace?: WorkflowWorkspaceSource;
}>) => Promise<WorkflowWorkspaceResolutionV1>;

export type WorkflowActionExecutor = Readonly<{
  executor: Pick<ReturnType<typeof createActionExecutor>, 'prepare'>;
  buildContext: (params: Readonly<{ runId: string; authorization: WorkflowAcceptedAuthorizationV1;
    workDepth: number; originSessionId?: string; workspace: WorkflowWorkspaceDescriptorV1;
    role?: WorkflowMaterializedLeafV1['role'];
    signal?: AbortSignal }>) => Promise<ActionExecutorContext>;
  observeRun: (run: ActionCompletionRun, params: Readonly<{ workspace: WorkflowWorkspaceDescriptorV1;
    signal?: AbortSignal }>) => Promise<ExecutionRunTerminalObservation>;
}>;

export type WorkflowAcceptedAuthorizationCurrentness = (params: Readonly<{
  authorization: WorkflowAcceptedAuthorizationV1;
  signal?: AbortSignal;
}>) => boolean | Promise<boolean>;

export type WorkflowCoordinatorResult = Readonly<{
  state: 'succeeded' | 'interrupted' | 'paused' | 'cancelled' | 'outcome_uncertain' | 'failed' | 'waiting_for_review';
  parkRevision?: number;
  completedWithFailures?: boolean;
  finalOutput?: WorkflowJsonValue;
  finalResult?: WorkflowFinalResultV1;
  reason?: string;
}>;

type Frame = WorkflowScopeFrame & {
  scopeRunId: string;
  conversationOwnerKey: string;
  resultContext: Readonly<{ definition: WorkflowDefinitionV1; frozenChildren: Readonly<Record<string, WorkflowDefinitionV1>> }>;
  parent?: Frame;
  collectedFailures: boolean;
  item?: Readonly<{ value: WorkflowJsonValue; index: number; position: number; count: number }>;
  iteration?: Readonly<{ index: number; position: number; count: number; stopReason: WorkflowJsonValue | null }>;
};

export class WorkflowControlBoundary extends Error {
  constructor(readonly state: 'paused' | 'cancelled' | 'waiting_for_review') {
    super(state);
  }
}

/** Exact abort reason shared with the incumbent claimed-Run heartbeat. */
export const WORKFLOW_AUTHORIZATION_NOT_CURRENT_ABORT_REASON = 'workflow_authorization_not_current';
/** Exact abort reason the incumbent claimed-Run heartbeat uses for a persisted cancel request. */
export const WORKFLOW_CANCEL_REQUESTED_ABORT_REASON = 'workflow_cancel_requested';

class WorkflowLeafFailure extends Error {
  constructor(
    readonly state: 'interrupted' | 'cancelled' | 'outcome_uncertain' | 'failed',
    readonly code: string,
    readonly collectable = false,
    readonly resultFailureReason?: Extract<ExecutionRunResultDecodeResult, { ok: false }>['reason'],
  ) {
    super(code);
  }
}

class WorkflowFailStopClosure extends WorkflowLeafFailure {
  constructor(code: string, readonly original: unknown) {
    super('interrupted', code);
  }
}

class WorkflowGenerationRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}

function failStopCausalReason(signal: AbortSignal | undefined): string {
  return signal?.reason instanceof WorkflowFailStopClosure
    ? signal.reason.code
    : 'container_fail_stop';
}

/**
 * This claim attempt lost its currentness (daemon shutdown, lease-heartbeat
 * loss, stale-attempt invalidation) without any cancellation authority. It
 * unwinds exactly like a crash: no leaf, container or parent fact is written
 * and no owned work is stopped, so the incumbent reclaim rejoins the durable
 * correspondence and observes whatever survived.
 */
export class WorkflowRuntimeInterruption extends Error {
  constructor() {
    super('runtime_interrupted');
  }
}

export type WorkflowAbortClassification =
  | 'none'
  | 'cancelled'
  | 'fail_stop'
  | 'authorization_revoked'
  | 'waiting_for_review'
  | 'interrupted';

/**
 * The one reading of a claim/coordinator abort. Only an authoritative or
 * persisted cancel request, a fail-stop sibling closure, or authority
 * revocation may stop owned work or close the frontier; every other abort is
 * a runtime interruption of this attempt.
 */
export function classifyWorkflowAbort(signal: AbortSignal | undefined): WorkflowAbortClassification {
  if (!signal?.aborted) return 'none';
  const reason: unknown = signal.reason;
  if (reason instanceof WorkflowControlBoundary && reason.state === 'waiting_for_review') return 'waiting_for_review';
  if (reason === WORKFLOW_AUTHORIZATION_NOT_CURRENT_ABORT_REASON) return 'authorization_revoked';
  if (reason === WORKFLOW_CANCEL_REQUESTED_ABORT_REASON || isAuthoritativeAutomationRunCancellation(signal)) {
    return 'cancelled';
  }
  if (reason instanceof WorkflowLeafFailure || reason instanceof WorkflowInputResolutionError) return 'fail_stop';
  return 'interrupted';
}

export function workflowInvocationKey(params: Readonly<{
  runId: string;
  blockId: string;
  scope: WorkflowInvocationPath['scope'];
  attempt: number;
}>): string {
  const scope = params.scope.map((part) => part.kind === 'branch'
    ? `b:${part.blockId}:${part.branchId}`
    : part.kind === 'iteration' ? `i:${part.blockId}:${part.index}`
    // Workflow frames have no index; preserve their existing internal lookup representation.
    : `i:${part.blockId}:undefined`).join('|');
  return `workflow:${params.runId}:${scope}:${params.blockId}:attempt:${params.attempt}`;
}


function childFrame(parent: Frame, overrides: Partial<Pick<Frame, 'item' | 'iteration'>> = {}): Frame {
  return {
    parent,
    scopeRunId: parent.scopeRunId,
    conversationOwnerKey: parent.conversationOwnerKey,
    resultContext: parent.resultContext,
    blocks: [],
    scope: parent.scope,
    collectedFailures: false,
    ...(overrides.item !== undefined
      ? { item: overrides.item }
      : parent.item !== undefined
        ? { item: parent.item }
        : {}),
    ...(overrides.iteration !== undefined
      ? { iteration: overrides.iteration }
      : parent.iteration !== undefined
        ? { iteration: parent.iteration }
        : {}),
  };
}

/** Frozen sidecars own runtime selection/placement; authored fields retain lexical intent. */
function effectiveLeaf(input: Readonly<{
  definition: WorkflowDefinitionV1;
  authoredDefinition: WorkflowDefinitionV1;
  executionTarget: WorkflowRunExecutionTargetV1;
  materializedLeaves: readonly WorkflowMaterializedLeafV1[];
  sourceKey?: string;
}>, step: WorkflowStep) {
  const authoredDefinition = input.authoredDefinition;
  const authoredStep = findWorkflowStepById(authoredDefinition.blocks, step.id);
  if (!authoredStep) return undefined;
  const leaf = input.materializedLeaves.find((candidate) => candidate.sourceKey === (input.sourceKey ?? '$root')
    && candidate.blockId === step.id && candidate.kind === 'step');
  if (!leaf) return undefined;
  const selection = leaf.selection;
  // Flattened defaults cannot establish explicit workspace intent. Keep every
  // frozen runtime field, while explicit inheritance stays lazy scope inheritance.
  const workspace = leaf.authoredWorkspace;
  return { selection: { ...selection, workspace },
    role: leaf.role,
    executionTarget: leaf.executionTarget, authoredDefinition,
    authoredStep: { ...authoredStep, execution: { ...authoredStep.execution, workspace } } };
}

/**
 * Conservatively projects only a directly addressable next top-level Session
 * binding. Structural reachability remains with the coordinator; callers must
 * treat `false` as "not proven equal", never as proof that no later step can
 * use the Session.
 */
export function doesWorkflowImmediateEligibleStepTargetSession(input: Readonly<{
  definition: WorkflowDefinitionV1;
  checkpoint: WorkflowCheckpointEnvelopeV1 | null;
  executionTarget: WorkflowRunExecutionTargetV1;
  materializedLeaves: readonly WorkflowMaterializedLeafV1[];
  sessionId: string;
}>): boolean {
  if (input.checkpoint?.frontier.paused) return false;
  const block = input.definition.blocks[input.checkpoint?.frontier.nextBlockOrdinal ?? 0];
  if (!block || block.kind !== 'step' || block.onlyWhen) return false;
  const leaf = effectiveLeaf({ ...input, authoredDefinition: input.definition }, block);
  if (!leaf || leaf.executionTarget.kind !== 'session') return false;
  const conversation = leaf.selection.conversation;
  return conversation?.kind === 'existing_session' && conversation.sessionId === input.sessionId;
}

async function readInvocationResult(
  record: WorkflowCoordinatorInvocation | undefined,
  store: WorkflowCoordinatorStore,
  frame: Frame,
  sessionContext?: Pick<WorkflowValueResolutionRuntime, 'resolveSessionContext' | 'resolveSessionContextField'>,
): Promise<WorkflowJsonValue> {
  if (record?.lifecycle !== 'completed') throw new WorkflowInputResolutionError('missing_reference');
  const result = record.result !== undefined ? record.result : await store.readContainerResult(record, async (workflow) => {
    const invocation = await store.readInvocationBindingRow(workflow.recordId);
    if (!invocation) throw new WorkflowInputResolutionError('missing_reference');
    const structure = await resolveWorkflowInvocationStructureV1({ ...frame.resultContext, invocation,
      readInvocation: store.readInvocationBindingRow,
      keyOfInvocation: (row) => workflowInvocationKey({ runId: row.index.runId, blockId: row.progress.invocationPath.blockId,
        scope: row.progress.invocationPath.scope, attempt: Number(row.index.attempt) }),
    });
    const child = structure?.leaf.kind === 'workflow' ? frame.resultContext.frozenChildren[structure.leaf.workflowRef] : undefined;
    if (!child) throw new WorkflowInputResolutionError('missing_reference');
    if (!child.finalOutput) return null;
    const childFrame: Frame = { scopeRunId: workflow.runId, structuralKey: workflow.key,
      conversationOwnerKey: workflow.recordId, resultContext: frame.resultContext, blocks: child.blocks,
      scope: [...workflow.path.scope, { kind: 'workflow', blockId: workflow.blockId }],
      collectedFailures: false };
    const childInputs = workflow.container?.kind === 'body' ? workflow.container.frameInputs ?? {} : {};
    return await resolveWorkflowValueReference(child.finalOutput, createResolutionRuntime(childInputs, childFrame, store, sessionContext));
  });
  if (result === undefined) throw new WorkflowInputResolutionError('missing_reference');
  return result;
}

async function readInvocationResultPath(
  record: WorkflowCoordinatorInvocation | undefined,
  path: readonly (string | number)[],
  store: WorkflowCoordinatorStore,
  frame: Frame,
  sessionContext?: Pick<WorkflowValueResolutionRuntime, 'resolveSessionContext' | 'resolveSessionContextField'>,
): Promise<WorkflowJsonValue> {
  if (record?.lifecycle !== 'completed') throw new WorkflowInputResolutionError('missing_reference');
  if (record.container?.kind === 'loop' && path[0] === 'outcome') {
    const outcome = record.container.closing?.outcome;
    if (!outcome) throw new WorkflowInputResolutionError('missing_reference');
    return selectWorkflowResultPath(outcome, path.slice(1));
  }
  return selectWorkflowResultPath(await readInvocationResult(record, store, frame, sessionContext), path);
}

function createResolutionRuntime(
  inputs: Readonly<Record<string, WorkflowJsonValue>>,
  frame: Frame,
  store: WorkflowCoordinatorStore,
  sessionContext?: Pick<WorkflowValueResolutionRuntime, 'resolveSessionContext' | 'resolveSessionContextField'>,
): WorkflowValueResolutionRuntime {
  const runId = frame.scopeRunId;
  const binding = createWorkflowProducerBinding({ runId, frame, store });
  const resultOf = async (record: WorkflowCoordinatorInvocation | undefined) => await readInvocationResult(record, store, frame, sessionContext);
  return {
    inputs,
    ...sessionContext,
    ...(frame.item ? { item: frame.item } : {}),
    ...(frame.iteration ? { iteration: frame.iteration } : {}),
    resolveResult: async (producer) => await resultOf(await binding.resolve(producer)),
    resolveResultPath: async (producer, path) => await readInvocationResultPath(await binding.resolve(producer), path, store, frame, sessionContext),
    resolveWorkspace: async (producer) => {
      const record = await binding.resolve(producer);
      const workspace = record?.blockKind === 'workflow' && record.container?.kind === 'body'
        ? record.container.frameProjectWorkspace?.descriptor : record?.workspace?.descriptor;
      if (!workspace) throw new WorkflowInputResolutionError('missing_reference');
      return workspace;
    },
    resolveLoopTrailingCount: async (reference) => {
      let loopFrame: WorkflowScopeFrame | undefined = frame;
      while (loopFrame && !loopFrame.loop) loopFrame = loopFrame.parent;
      if (!loopFrame?.loop) throw new WorkflowInputResolutionError('invalid_reference_scope');
      let count = 0;
      for (let index = loopFrame.loop.index; index >= 0; index -= 1) {
        const body = index === loopFrame.loop.index ? loopFrame
          : await readWorkflowLoopBodyFrame({ runId, store, frame: loopFrame, index });
        if (!body) break;
        const record = await resolveWorkflowProducerInFrame({ runId, store, frame: body, blockId: reference.producer.blockId });
        try {
          const value = await resolveWorkflowValueReference({ kind: 'result', producer: reference.producer, path: reference.path }, {
            inputs, resolveResult: async () => await resultOf(record), resolveWorkspace: async () => { throw new WorkflowInputResolutionError('missing_reference'); },
          });
          if (!sameStrictJsonValue(value, reference.equals)) break;
          count += 1;
        } catch (error) {
          if (error instanceof WorkflowInputResolutionError && (error.code === 'missing_reference' || error.code === 'invalid_reference_scope')) break;
          throw error;
        }
      }
      return count;
    },
  };
}

async function resolveLoopSourceSelection(
  reference: WorkflowValueReference,
  frame: Frame,
  context: ExecutionContext,
): Promise<WorkflowLoopSourceSelectionV1> {
  if (reference.kind === 'literal' || reference.kind === 'input') {
    return { kind: 'definition', reference };
  }
  if (reference.kind !== 'result') {
    const value = await resolveWorkflowValueReference(reference, createResolutionRuntime(context.inputs, frame, context.deps.store, context.deps.sessionContext));
    return { kind: 'definition', reference: { kind: 'literal', value } };
  }
  const record = await createWorkflowProducerBinding({ runId: context.runId, frame, store: context.deps.store }).resolve(reference.producer);
  if (!record) throw new WorkflowInputResolutionError('missing_reference');
  return { kind: 'result', recordId: record.recordId, path: reference.path };
}

async function resolveSelectedLoopSource(
  selection: WorkflowLoopSourceSelectionV1,
  frame: Frame,
  context: ExecutionContext,
): Promise<WorkflowJsonValue> {
  const runtime = createResolutionRuntime(context.inputs, frame, context.deps.store, context.deps.sessionContext);
  if (selection.kind === 'definition') {
    return await resolveWorkflowValueReference(selection.reference, runtime);
  }
  return await readInvocationResultPath(await context.deps.store.readByLogicalInvocation(selection.recordId), selection.path, context.deps.store, frame, context.deps.sessionContext);
}

class OptionalSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly maximum: number | undefined) {}
  async run<T>(operation: () => Promise<T>, onWaiting?: () => Promise<void>, assertOpen?: () => void): Promise<T> {
    if (this.maximum !== undefined && this.active >= this.maximum) {
      await onWaiting?.();
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    assertOpen?.();
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

type WorkflowAdmissionGateEntry = {
  tail: Promise<{ error: unknown } | undefined>;
  reservation?: { recordId: string; release: (failure?: { error: unknown }) => void };
};

class KeyedAdmissionGate {
  private readonly tails = new Map<string, WorkflowAdmissionGateEntry>();
  async reserve(key: string, recordId: string): Promise<void> {
    if (this.tails.has(key)) throw new WorkflowLeafFailure('interrupted', 'continuation_unavailable');
    const release = await this.acquire(key);
    this.tails.get(key)!.reservation = { recordId, release };
  }
  closeUnclaimedReservations(error: unknown): void {
    for (const entry of this.tails.values()) entry.reservation?.release({ error });
  }
  async acquire(key: string, recordId?: string): Promise<(failure?: { error: unknown }) => void> {
    const entry: WorkflowAdmissionGateEntry = this.tails.get(key) ?? { tail: Promise.resolve(undefined) };
    if (entry.reservation && entry.reservation.recordId === recordId) {
      const release = entry.reservation.release;
      delete entry.reservation;
      return release;
    }
    const previous = entry.tail;
    let releaseCurrent!: (failure?: { error: unknown }) => void;
    const current = new Promise<{ error: unknown } | undefined>((resolve) => { releaseCurrent = resolve; });
    const tail = previous.then((failure) => failure ?? current);
    entry.tail = tail;
    this.tails.set(key, entry);
    const previousFailure = await previous;
    if (previousFailure) {
      releaseCurrent(previousFailure);
      throw previousFailure.error;
    }
    let released = false;
    return (failure) => {
      if (released) return;
      released = true;
      releaseCurrent(failure);
      if (!failure && entry.tail === tail) this.tails.delete(key);
    };
  }
}

function withAbortSignal(context: ExecutionContext, signal: AbortSignal): ExecutionContext {
  if (!context.signal) return { ...context, signal };
  const combined = new AbortController();
  const relay = (source: AbortSignal) => {
    if (!combined.signal.aborted) combined.abort(source.reason);
  };
  if (context.signal.aborted) relay(context.signal);
  else context.signal.addEventListener('abort', () => relay(context.signal!), { once: true });
  if (signal.aborted) relay(signal);
  else signal.addEventListener('abort', () => relay(signal), { once: true });
  return { ...context, signal: combined.signal };
}

function persistedFailure(record: WorkflowCoordinatorInvocation): WorkflowLeafFailure | undefined {
  const code = record.reason ?? record.lifecycle;
  switch (record.lifecycle) {
    case 'cancelled':
      if (code.startsWith('container_fail_stop')) {
        return new WorkflowLeafFailure('interrupted', code);
      }
      return new WorkflowLeafFailure('cancelled', code);
    case 'cancel_requested':
      return new WorkflowLeafFailure('interrupted', code);
    case 'outcome_uncertain':
      return new WorkflowLeafFailure(record.execution ? 'interrupted' : 'outcome_uncertain', code);
    case 'failed':
      if (code === 'invalid_reference_scope' || code === 'missing_reference') {
        return new WorkflowLeafFailure('failed', code);
      }
      // A persisted definitive leaf failure remains collectable after process
      // reconstruction. The authored parent policy decides whether that fact
      // is collected or fail-stops; the leaf row does not encode that policy.
      return new WorkflowLeafFailure('interrupted', code, true);
    default:
      return undefined;
  }
}

function createWorkflowFinalResult(
  step: WorkflowStep | undefined,
  value: WorkflowJsonValue,
  producerInvocationRecordId: string,
): WorkflowFinalResultV1 {
  // Container and branch outputs are structural JSON values. Only a leaf Step
  // carries an authored scalar result contract.
  if (!step) {
    return {
      kind: 'happier.workflow-final-result.v1',
      result: { kind: 'json', value },
      producerInvocation: { recordId: producerInvocationRecordId },
    };
  }
  switch (step.result.kind) {
    case 'text':
    case 'decision':
      if (typeof value !== 'string') throw new WorkflowInputResolutionError('invalid_reference_scope');
      return {
        kind: 'happier.workflow-final-result.v1',
        result: { kind: step.result.kind, value },
        producerInvocation: { recordId: producerInvocationRecordId },
      };
    case 'json':
      return {
        kind: 'happier.workflow-final-result.v1',
        result: { kind: 'json', value },
        producerInvocation: { recordId: producerInvocationRecordId },
      };
  }
}

async function assertAcceptedAuthorizationCurrent(context: ExecutionContext): Promise<void> {
  const isCurrent = await context.deps.isAcceptedAuthorizationCurrent({
    authorization: context.authorization,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (!isCurrent) throw new WorkflowLeafFailure('interrupted', 'workflow_authorization_not_current');
}

function holdReadiness(row: WorkflowCoordinatorInvocation) {
  return classifyWorkflowHoldV1({ isCurrent: row.lifecycle !== 'superseded', lifecycle: row.lifecycle, progress: { review: row.review } });
}

/** Dependency calls and exact held-row reads share this run-local quiescence owner. */
class WorkflowReviewHolds {
  readonly controller = new AbortController();
  readonly waiters = new Map<string, { resolve: (row: WorkflowCoordinatorInvocation) => void; reject: (error: unknown) => void }>();
  confirm?: () => ReturnType<WorkflowCoordinatorStore['confirmReviewHolds']>;
  parkRevision?: number;
  private inFlight = 0;
  private scheduled?: NodeJS.Immediate;
  private refreshing?: Promise<void>;
  private closed = false;
  constructor(readonly runId: string) {}

  async track<T>(operation: () => T | Promise<T>): Promise<T> {
    this.inFlight += 1;
    try { return await operation(); }
    finally { this.inFlight -= 1; this.schedule(); }
  }

  private schedule(): void {
    if (this.closed || this.parkRevision !== undefined || this.scheduled || this.refreshing
      || this.inFlight !== 0 || this.waiters.size === 0) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      void this.refresh().catch((error: unknown) => {
        for (const waiter of this.waiters.values()) waiter.reject(error);
      });
    });
  }

  async refresh(): Promise<void> {
    if (this.closed || this.parkRevision !== undefined || this.waiters.size === 0) return;
    if (this.refreshing) return await this.refreshing;
    this.refreshing = (async () => {
      if (!this.confirm) throw new Error('workflow_review_confirmation_missing');
      const snapshot = await this.confirm();
      if (this.parkRevision !== undefined || this.closed) return;
      if (snapshot.control !== 'running') {
        const boundary = new WorkflowControlBoundary(snapshot.control === 'cancel_requested' ? 'cancelled' : 'paused');
        for (const waiter of this.waiters.values()) waiter.reject(boundary);
        return;
      }
      let resolved = false;
      for (const [recordId, waiter] of this.waiters) {
        const row = snapshot.rows.find((candidate) => candidate.recordId === recordId);
        if (!row) throw new Error('workflow_invocation_intent_missing');
        if (holdReadiness(row) !== 'awaiting_person') { resolved = true; waiter.resolve(row); }
      }
      if (!resolved && this.inFlight === 0 && this.waiters.size > 0) {
        this.parkRevision = snapshot.revision;
        const boundary = new WorkflowControlBoundary('waiting_for_review');
        this.controller.abort(boundary);
        for (const waiter of this.waiters.values()) waiter.reject(boundary);
      }
    })();
    try { await this.refreshing; }
    finally { this.refreshing = undefined; this.schedule(); }
  }

  async wait(row: WorkflowCoordinatorInvocation, signal?: AbortSignal): Promise<WorkflowCoordinatorInvocation> {
    if (holdReadiness(row) !== 'awaiting_person') return row;
    assertWorkflowAdmissionSignal(signal);
    let detach = () => {};
    try {
      return await new Promise<WorkflowCoordinatorInvocation>((resolve, reject) => {
        const abort = () => {
          try { assertWorkflowAdmissionSignal(signal); }
          catch (error) { reject(error); }
        };
        signal?.addEventListener('abort', abort, { once: true });
        detach = () => signal?.removeEventListener('abort', abort);
        this.waiters.set(row.recordId, { resolve, reject });
        this.schedule();
      });
    } finally { detach(); this.waiters.delete(row.recordId); }
  }

  close(): void { this.closed = true; if (this.scheduled) clearImmediate(this.scheduled); }
}

export function createWorkflowCoordinator(deps: Readonly<{
  store: WorkflowCoordinatorStore;
  sessionContext?: Pick<WorkflowValueResolutionRuntime, 'resolveSessionContext' | 'resolveSessionContextField'>;
  executeStep: WorkflowStepExecutor;
  prepareStep?: WorkflowStepPreparer;
  action?: WorkflowActionExecutor;
  resolveWorkspace: WorkflowWorkspaceResolver;
  /** Revalidates the accepted Account/authority binding before a new leaf effect. */
  isAcceptedAuthorizationCurrent: WorkflowAcceptedAuthorizationCurrentness;
  /** The production worker supplies the full live controller/current-authority gate for Generate. */
  checkReviewGenerationAuthority?: (params: Readonly<{ signal?: AbortSignal }>) => Promise<string | undefined>;
  allocateInvocationRecordId?: () => string;
  rootInvocationRecordId?: string;
  onReviewEntered?: (params: Readonly<{ runId: string; invocation: WorkflowCoordinatorInvocation }>) => Promise<void>;
}>): Readonly<{
  refreshReviewHolds: () => Promise<void>;
  run: (params: Readonly<{
    runId: string;
    definition: WorkflowDefinitionV1;
    authoredDefinition: WorkflowDefinitionV1;
    inputs: Readonly<Record<string, WorkflowJsonValue>>;
    executionTarget: WorkflowRunExecutionTargetV1;
    materializedLeaves: readonly WorkflowMaterializedLeafV1[];
    frozenChildren: Readonly<Record<string, WorkflowDefinitionV1>>;
    workDepth: number;
    authorization: WorkflowAcceptedAuthorizationV1;
    originSessionId?: string;
    automationCause?: AutomationRunCause;
    signal?: AbortSignal;
  }>) => Promise<WorkflowCoordinatorResult>;
}> {
  let activeHolds: WorkflowReviewHolds | undefined;
  return {
    refreshReviewHolds: async () => { await activeHolds?.refresh(); },
    run: async ({ runId, definition, authoredDefinition, inputs, executionTarget, materializedLeaves, frozenChildren, workDepth, authorization, originSessionId, automationCause, signal }) => {
      const root: Frame = {
        scopeRunId: runId,
        conversationOwnerKey: deps.rootInvocationRecordId ?? workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 }),
        resultContext: { definition, frozenChildren },
        blocks: definition.blocks,
        scope: [],
        collectedFailures: false,
      };
      const holds = new WorkflowReviewHolds(runId);
      activeHolds = holds;
      const trackedStore = new Proxy(deps.store, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function'
            ? (...args: unknown[]) => holds.track(() => Reflect.apply(value, target, args))
            : value;
        },
      });
      holds.confirm = () => trackedStore.confirmReviewHolds({ runId, recordIds: [...holds.waiters.keys()] });
      try {
        const context = withAbortSignal({
          runId, definition, authoredDefinition, inputs, executionTarget, materializedLeaves, frozenChildren,
          workDepth, sourceKey: '$root', authorization, originSessionId, automationCause, rootOwnerKey: root.conversationOwnerKey,
          deps: { ...deps, store: trackedStore,
            ...(deps.sessionContext ? { sessionContext: {
              ...(deps.sessionContext.resolveSessionContext ? { resolveSessionContext: (recentTurns: number) =>
                holds.track(() => deps.sessionContext!.resolveSessionContext!(recentTurns)) } : {}),
              ...(deps.sessionContext.resolveSessionContextField ? { resolveSessionContextField: (field: 'usage.tokensUsed' | 'goal.tokenBudget') =>
                holds.track(() => deps.sessionContext!.resolveSessionContextField!(field)) } : {}),
            } } : {}),
            executeStep: (input) => holds.track(() => deps.executeStep(input)),
            ...(deps.prepareStep ? { prepareStep: (input: Parameters<WorkflowStepPreparer>[0]) => holds.track(() => deps.prepareStep!(input)) } : {}),
            resolveWorkspace: (input) => holds.track(() => deps.resolveWorkspace(input)),
            isAcceptedAuthorizationCurrent: (input) => holds.track(() => deps.isAcceptedAuthorizationCurrent(input)),
            ...(deps.checkReviewGenerationAuthority ? { checkReviewGenerationAuthority: (input: Readonly<{ signal?: AbortSignal }>) =>
              holds.track(() => deps.checkReviewGenerationAuthority!(input)) } : {}),
            ...(deps.onReviewEntered ? { onReviewEntered: (input: Parameters<NonNullable<typeof deps.onReviewEntered>>[0]) => holds.track(() => deps.onReviewEntered!(input)) } : {}),
            allocateInvocationRecordId: deps.allocateInvocationRecordId ?? randomUUID },
          admissionGate: new KeyedAdmissionGate(), signal, holds,
        } satisfies ExecutionContext, holds.controller.signal);
        await reserveOwnedNativeInputs(context);
        const frontier = await context.deps.store.readFrontier();
        for (let index = frontier.nextBlockOrdinal; index < definition.blocks.length; index += 1) {
          await executeBlock(definition.blocks[index]!, [], root, context, undefined, String(index));
          await context.deps.store.commitFrontier({ nextBlockOrdinal: index + 1 });
        }
        // A reclaimed pause drains already-owned input, then hands off paused
        // even when that input was the last leaf in the definition.
        await assertAdmissionOpen(context);
        const finalOutput = definition.finalOutput
          ? await resolveWorkflowValueReference(definition.finalOutput, createResolutionRuntime(inputs, root, deps.store, deps.sessionContext))
          : undefined;
        const selectedStep = definition.finalOutput
          ? findWorkflowStepById(definition.blocks, definition.finalOutput.producer.blockId)
          : undefined;
        const finalOutputInvocationRecordId = definition.finalOutput
          ? (await createWorkflowProducerBinding({ runId, frame: root, store: deps.store }).resolve(definition.finalOutput.producer))?.recordId
          : undefined;
        const finalResult = finalOutput === undefined || !finalOutputInvocationRecordId
          ? undefined
          : createWorkflowFinalResult(selectedStep, finalOutput, finalOutputInvocationRecordId);
        return {
          state: 'succeeded',
          ...(root.collectedFailures || await hasCurrentWorkflowFailure(context) ? { completedWithFailures: true } : {}),
          ...(finalOutput === undefined ? {} : { finalOutput }),
          ...(finalResult ? { finalResult } : {}),
        };
      } catch (error) {
        if (error instanceof WorkflowControlBoundary) return { state: error.state,
          ...(error.state === 'waiting_for_review' ? { parkRevision: holds.parkRevision } : {}) };
        if (error instanceof WorkflowLeafFailure) return { state: error.state, reason: error.code };
        if (error instanceof WorkflowInputResolutionError) return { state: 'failed', reason: error.code };
        throw error;
      } finally {
        holds.close();
        if (activeHolds === holds) activeHolds = undefined;
      }
    },
  };
}

type ExecutionContext = Readonly<{
  runId: string;
  definition: WorkflowDefinitionV1;
  authoredDefinition: WorkflowDefinitionV1;
  inputs: Readonly<Record<string, WorkflowJsonValue>>;
  authorization: WorkflowAcceptedAuthorizationV1;
  executionTarget: WorkflowRunExecutionTargetV1;
  materializedLeaves: readonly WorkflowMaterializedLeafV1[];
  frozenChildren: Readonly<Record<string, WorkflowDefinitionV1>>;
  sourceKey: string;
  workDepth: number;
  projectWorkspace?: WorkflowWorkspaceSource;
  rootOwnerKey: string;
  originSessionId?: string;
  automationCause?: AutomationRunCause;
  signal?: AbortSignal;
  admissionGate: KeyedAdmissionGate;
  holds: WorkflowReviewHolds;
  deps: Readonly<{
    store: WorkflowCoordinatorStore;
    sessionContext?: Pick<WorkflowValueResolutionRuntime, 'resolveSessionContext' | 'resolveSessionContextField'>;
    executeStep: WorkflowStepExecutor;
    prepareStep?: WorkflowStepPreparer;
    action?: WorkflowActionExecutor;
    resolveWorkspace: WorkflowWorkspaceResolver;
    isAcceptedAuthorizationCurrent: WorkflowAcceptedAuthorizationCurrentness;
    checkReviewGenerationAuthority?: (params: Readonly<{ signal?: AbortSignal }>) => Promise<string | undefined>;
    allocateInvocationRecordId: () => string;
    onReviewEntered?: (params: Readonly<{ runId: string; invocation: WorkflowCoordinatorInvocation }>) => Promise<void>;
  }>;
}>;

/**
 * Synchronous in-process abort classification shared by every admission
 * boundary. This performs no store I/O: fail-stop, heartbeat-cancel and
 * authorization-revocation aborts stay responsive even where the expensive
 * persisted control read below is coalesced away.
 */
export function assertWorkflowAdmissionSignal(signal: AbortSignal | undefined): void {
  switch (classifyWorkflowAbort(signal)) {
    case 'waiting_for_review':
      throw new WorkflowControlBoundary('waiting_for_review');
    case 'authorization_revoked':
      throw new WorkflowLeafFailure(
        'interrupted',
        WORKFLOW_AUTHORIZATION_NOT_CURRENT_ABORT_REASON,
      );
    case 'interrupted':
      throw new WorkflowRuntimeInterruption();
    case 'cancelled':
    case 'fail_stop':
      throw new WorkflowControlBoundary('cancelled');
    case 'none':
      break;
  }
}

function assertWorkflowAbortSignal(context: ExecutionContext): void {
  assertWorkflowAdmissionSignal(context.signal);
}

async function assertAdmissionOpen(context: ExecutionContext): Promise<void> {
  assertWorkflowAbortSignal(context);
  const control = await context.deps.store.readControl(context.runId);
  if (control === 'pause_requested') throw new WorkflowControlBoundary('paused');
  if (control === 'cancel_requested') throw new WorkflowControlBoundary('cancelled');
}

/** The final outcome selects current failures, not every completed result. */
async function hasCurrentWorkflowFailure(context: ExecutionContext): Promise<boolean> {
  const failed = await context.deps.store.listByLifecycle({ runId: context.runId, lifecycles: ['failed'] });
  for (const failure of failed) {
    let row: WorkflowCoordinatorInvocation | undefined = failure;
    let current = true;
    while (row && row.blockId !== '$root') {
      if (row.memberOrdinal === undefined) { current = false; break; }
      const selected = await context.deps.store.readCurrent({ runId: context.runId, blockId: row.blockId,
        scope: row.path.scope, memberOrdinal: row.memberOrdinal, ...(row.parentKey ? { parentKey: row.parentKey } : {}) });
      if (selected?.recordId !== row.recordId) { current = false; break; }
      row = row.parentKey ? await context.deps.store.read(row.parentKey) : undefined;
    }
    if (current) return true;
  }
  return false;
}

const CAPACITY_OCCUPYING_LIFECYCLES = [
  'admitting', 'running', 'waiting_for_approval', 'needs_attention', 'cancel_requested', 'waiting_for_review', 'outcome_uncertain',
] as const satisfies readonly WorkflowInvocationLifecycleV1[];

async function orderPipelinesForRecovery<T extends Readonly<{ memberOrdinal: string }>>(
  pipelines: readonly T[],
  context: ExecutionContext,
  parentKey: string,
  frame: Frame,
  collectFailures: boolean,
): Promise<readonly T[]> {
  const members = await context.deps.store.listCurrentMembers(parentKey);
  const current = new Map(members.map((member) => [member.memberOrdinal, member]));
  if (collectFailures && members.some((member) => member.lifecycle === 'failed')) frame.collectedFailures = true;
  return pipelines
    .map((pipeline, sourceIndex) => ({
      pipeline,
      sourceIndex,
      lifecycle: current.get(pipeline.memberOrdinal)?.lifecycle,
    }))
    .filter(({ lifecycle }) => lifecycle !== 'completed' && lifecycle !== 'skipped' && !(collectFailures && lifecycle === 'failed'))
    .sort((left, right) => {
      const occupied = (lifecycle: WorkflowInvocationLifecycleV1 | undefined) => lifecycle !== undefined
        && (CAPACITY_OCCUPYING_LIFECYCLES.some((candidate) => candidate === lifecycle) || lifecycle === 'failed');
      return Number(occupied(right.lifecycle)) - Number(occupied(left.lifecycle)) || left.sourceIndex - right.sourceIndex;
    })
    .map(({ pipeline }) => pipeline);
}

/** Both collection strategies advance admission, never a completion watermark. */
function createMemberFrontier(initial: number, commit: (next: number) => Promise<void>) {
  let current = initial;
  let tail = Promise.resolve();
  return (next: number) => {
    const advance = tail.then(async () => { if (next > current) { await commit(next); current = next; } });
    tail = advance.catch(() => undefined);
    return advance;
  };
}

async function persistWaitingForCapacity(params: Readonly<{
  owner: Extract<WorkflowBlock, { kind: 'parallel' | 'loop' }>;
  source: WorkflowInvocationFrameV1['source'];
  scope: WorkflowInvocationPath['scope'];
  context: ExecutionContext;
  parentKey: string;
  memberOrdinal: string;
}>): Promise<void> {
  const current = await params.context.deps.store.readCurrent({
    runId: params.context.runId,
    blockId: params.owner.id,
    scope: params.scope,
    parentKey: params.parentKey,
    memberOrdinal: params.memberOrdinal,
  });
  if (current) return;
  assertWorkflowAbortSignal(params.context);
  // Capacity visibility is not an executable input. Pause/Cancel can forbid
  // this new marker without fencing observation of the pipeline occupying the
  // slot; that pipeline and the normal admission owner settle the control.
  if (await params.context.deps.store.readControl(params.context.runId) !== 'running') return;
  const key = workflowInvocationKey({
    runId: params.context.runId,
    blockId: params.owner.id,
    scope: params.scope,
    attempt: 0,
  });
  try { await params.context.deps.store.ensureIntent({
    key,
    recordId: params.context.deps.allocateInvocationRecordId(),
    acceptedAtMs: Date.now(),
    runId: params.context.runId,
    blockId: params.owner.id,
    blockKind: params.owner.kind,
    parentKey: params.parentKey,
    memberOrdinal: params.memberOrdinal,
    path: { blockId: params.owner.id, scope: params.scope },
    attempt: 0,
    lifecycle: 'waiting_for_capacity',
    frame: { ownerBlockId: params.owner.id, source: params.source },
    container: { kind: 'body', nextBlockOrdinal: '0' },
  }); } catch (error) {
    if (await params.context.deps.store.readControl(params.context.runId) === 'running') throw error;
  }
}

async function closeWaitingAfterFailStop(params: Readonly<{
  owner: Extract<WorkflowBlock, { kind: 'parallel' | 'loop' }>;
  scope: WorkflowInvocationPath['scope'];
  context: ExecutionContext;
  parentKey: string;
  memberOrdinal: string;
  reason: string;
}>): Promise<void> {
  const current = await params.context.deps.store.readCurrent({
    runId: params.context.runId,
    blockId: params.owner.id,
    scope: params.scope,
    parentKey: params.parentKey,
    memberOrdinal: params.memberOrdinal,
  });
  if (current?.lifecycle === 'waiting_for_capacity' || current?.lifecycle === 'pending') {
    await params.context.deps.store.commitFact({
      key: current.key,
      lifecycle: 'cancelled',
      reason: params.reason,
    });
  }
}

async function executeBodyFrame(params: Readonly<{
  owner: Extract<WorkflowBlock, { kind: 'parallel' | 'loop' }>;
  source: WorkflowInvocationFrameV1['source'];
  blocks: readonly WorkflowBlock[];
  scope: WorkflowInvocationPath['scope'];
  frame: Frame;
  context: ExecutionContext;
  parentKey: string;
  memberOrdinal: string;
  onFrameStarted?: (frameKey: string) => Promise<void>;
  afterBlocks?: (frameKey: string) => Promise<void>;
}>): Promise<void> {
  const initialKey = workflowInvocationKey({
    runId: params.context.runId,
    blockId: params.owner.id,
    scope: params.scope,
    attempt: 0,
  });
  const existing = await params.context.deps.store.readCurrent({
    runId: params.context.runId,
    blockId: params.owner.id,
    scope: params.scope,
    parentKey: params.parentKey,
    memberOrdinal: params.memberOrdinal,
  });
  const key = existing?.key ?? initialKey;
  params.frame.structuralKey = key;
  params.frame.blocks = params.owner.kind === 'loop' && params.owner.repetition.kind === 'evaluate'
    ? [...params.blocks, params.owner.repetition.evaluator] : params.blocks;
  params.frame.scope = params.scope;
  if (existing) {
    const failure = persistedFailure(existing);
    if (failure) throw failure;
  }
  if (existing?.lifecycle === 'completed' && existing.containerResult !== undefined) return;
  // Existing body frames may drain owned input during a reclaimed pause.
  // New frames and pending frames still pass the admission check below.
  assertWorkflowAbortSignal(params.context);
  if (!existing) {
    await assertAdmissionOpen(params.context);
    try {
      await params.context.deps.store.ensureIntent({
        key,
        recordId: params.context.deps.allocateInvocationRecordId(),
        runId: params.context.runId,
        blockId: params.owner.id,
        blockKind: params.owner.kind,
        parentKey: params.parentKey,
        memberOrdinal: params.memberOrdinal,
        path: { blockId: params.owner.id, scope: params.scope },
        attempt: 0,
        acceptedAtMs: Date.now(),
        lifecycle: 'running',
        frame: { ownerBlockId: params.owner.id, source: params.source },
        container: { kind: 'body', nextBlockOrdinal: '0' },
      });
    } catch (error) {
      // A parent CAS can lose to an external pause/cancel after the
      // container-level admission check. Re-read only the canonical control
      // owner; do not retry a new row or reinterpret unrelated failures.
      await assertAdmissionOpen(params.context);
      throw error;
    }
  } else if (existing.lifecycle === 'pending' || existing.lifecycle === 'waiting_for_capacity') {
    await assertAdmissionOpen(params.context);
    await params.context.deps.store.commitFact({ key, lifecycle: 'running' });
  }
  if (workflowBodyOwnsConversation(params.owner)) {
    const body = await params.context.deps.store.read(key);
    if (!body) throw new WorkflowRuntimeInterruption();
    params.frame.conversationOwnerKey = body.recordId;
  }
  await params.onFrameStarted?.(key);
  try {
    const nextBlockOrdinal = existing?.container?.kind === 'body' ? Number(existing.container.nextBlockOrdinal) : 0;
    for (let index = nextBlockOrdinal; index < params.blocks.length; index += 1) {
      await executeBlock(params.blocks[index]!, params.scope, params.frame, params.context, key, String(index));
      await params.context.deps.store.commitFact({
        key,
        lifecycle: 'running',
        container: { kind: 'body', nextBlockOrdinal: String(index + 1) },
      });
    }
    await params.afterBlocks?.(key);
  } catch (error) {
    if (error instanceof WorkflowLeafFailure) {
      const failStopClosure = classifyWorkflowAbort(params.context.signal) === 'fail_stop';
      const lifecycle = failStopClosure ? 'cancelled'
        : error.state === 'cancelled' ? 'cancelled'
        : error.state === 'outcome_uncertain' ? 'outcome_uncertain'
          : error.state === 'interrupted' ? 'needs_attention' : 'failed';
      await params.context.deps.store.commitFact({
        key,
        lifecycle,
        reason: failStopClosure ? failStopCausalReason(params.context.signal) : error.code,
      });
    }
    throw error;
  }
  await params.context.deps.store.commitContainerResult({ key });
}

async function ensureAndCommitContainer(
  block: WorkflowBlock,
  scope: WorkflowInvocationPath['scope'],
  context: ExecutionContext,
  parentKey: string | undefined,
  memberOrdinal: string,
  body: (key: string) => Promise<void>,
  initialContainer?: WorkflowContainerProgressV1,
): Promise<void> {
  const initialKey = workflowInvocationKey({ runId: context.runId, blockId: block.id, scope, attempt: 0 });
  const existing = await context.deps.store.readCurrent({ runId: context.runId, blockId: block.id, scope, memberOrdinal, ...(parentKey ? { parentKey } : {}) });
  const key = existing?.key ?? initialKey;
  if (existing?.lifecycle === 'completed' && existing.containerResult !== undefined) return;
  if (existing) {
    const failure = persistedFailure(existing);
    if (failure) throw failure;
    if (existing.lifecycle === 'superseded') {
      throw new WorkflowLeafFailure('interrupted', existing.reason ?? 'retry_not_current');
    }
  }
  // An existing structural frame can contain owned input which an expired
  // pause claim must reconcile. Controls fence only allocation/new admission.
  if (!existing || existing.lifecycle === 'pending' || existing.lifecycle === 'waiting_for_capacity') {
    await assertAdmissionOpen(context);
  }
  if (!existing) {
    await context.deps.store.ensureIntent({
      key, recordId: context.deps.allocateInvocationRecordId(), acceptedAtMs: Date.now(), runId: context.runId, blockId: block.id, memberOrdinal, ...(parentKey ? { parentKey } : {}),
      path: { blockId: block.id, scope }, blockKind: block.kind, attempt: 0, lifecycle: 'running', ...(initialContainer ? { container: initialContainer } : {}),
    });
  } else if (existing.lifecycle === 'waiting_for_capacity' || existing.lifecycle === 'pending') {
    await context.deps.store.commitFact({ key, lifecycle: 'running', ...(initialContainer ? { container: initialContainer } : {}) });
  } else if (initialContainer && !existing.container) {
    await context.deps.store.commitFact({ key, lifecycle: 'running', container: initialContainer });
  }
  try {
    await body(key);
    await context.deps.store.commitContainerResult({ key });
  } catch (error) {
    if (error instanceof WorkflowLeafFailure) {
      const failStopClosure = classifyWorkflowAbort(context.signal) === 'fail_stop';
      const lifecycle = failStopClosure ? 'cancelled' as const
        : error.state === 'cancelled'
        ? 'cancelled' as const
        : error.state === 'outcome_uncertain'
          ? 'outcome_uncertain' as const
          : error.state === 'interrupted'
            ? 'needs_attention' as const
            : 'failed' as const;
      await context.deps.store.commitFact({
        key,
        lifecycle,
        reason: failStopClosure ? failStopCausalReason(context.signal) : error.code,
      });
    }
    throw error;
  }
}

async function executeBlock(
  block: WorkflowBlock,
  scope: WorkflowInvocationPath['scope'],
  frame: Frame,
  context: ExecutionContext,
  parentKey?: string,
  memberOrdinal = '0',
): Promise<void> {
  const current = await context.deps.store.readCurrent({ runId: context.runId, blockId: block.id, scope, memberOrdinal,
    ...(parentKey ? { parentKey } : {}) });
  if (current?.lifecycle === 'skipped' || (current?.lifecycle === 'completed' && current.containerResult)) return;
  const runtime = createResolutionRuntime(context.inputs, frame, context.deps.store, context.deps.sessionContext);
  if (!current && 'onlyWhen' in block && block.onlyWhen && !await evaluateWorkflowCondition(block.onlyWhen, runtime)) {
    const key = workflowInvocationKey({ runId: context.runId, blockId: block.id, scope, attempt: 0 });
    await context.deps.store.ensureIntent({ key, recordId: context.deps.allocateInvocationRecordId(), acceptedAtMs: Date.now(), runId: context.runId, blockId: block.id, blockKind: block.kind, memberOrdinal, ...(parentKey ? { parentKey } : {}), path: { blockId: block.id, scope }, attempt: 0, lifecycle: 'pending' });
    await context.deps.store.commitFact({ key, lifecycle: 'skipped', reason: 'condition_false' });
    return;
  }
  if (block.kind === 'step') {
    await executeStepBlock(block, scope, frame, context, parentKey, memberOrdinal);
    return;
  }
  if (block.kind === 'wait') {
    await executeWaitBlock(block, scope, frame, context, parentKey, memberOrdinal);
    return;
  }
  if (block.kind === 'action') {
    await executeActionBlock(block, scope, frame, context, parentKey, memberOrdinal);
    return;
  }
  if (block.kind === 'workflow') {
    await executeWorkflowBlock(block, scope, frame, context, parentKey, memberOrdinal);
    return;
  }
  if (block.kind === 'if') {
    const key = workflowInvocationKey({ runId: context.runId, blockId: block.id, scope, attempt: 0 });
    const existing = await context.deps.store.readCurrent({
      runId: context.runId, blockId: block.id, scope, memberOrdinal, ...(parentKey ? { parentKey } : {}),
    });
    const selected = existing?.container?.kind === 'if'
      ? existing.container.selected
      : await evaluateWorkflowCondition(block.when, runtime) ? 'then' : 'otherwise';
    if (selected === 'otherwise' && block.otherwise.length === 0) {
      const key = workflowInvocationKey({ runId: context.runId, blockId: block.id, scope, attempt: 0 });
      await context.deps.store.ensureIntent({
        key, recordId: context.deps.allocateInvocationRecordId(), acceptedAtMs: Date.now(), runId: context.runId, blockId: block.id, memberOrdinal, ...(parentKey ? { parentKey } : {}),
        blockKind: block.kind,
        path: { blockId: block.id, scope }, attempt: 0, lifecycle: 'pending',
      });
      await context.deps.store.commitFact({ key, lifecycle: 'skipped', reason: 'condition_false' });
      return;
    }
    await ensureAndCommitContainer(block, scope, context, parentKey, memberOrdinal, async (key) => {
      const selectedBlocks = selected === 'then' ? block.then : block.otherwise;
      const branchFrame = childFrame(frame);
      branchFrame.structuralKey = key;
      branchFrame.blocks = selectedBlocks;
      const row = await context.deps.store.read(key);
      const nextBlockOrdinal = row?.container?.kind === 'if' ? Number(row.container.nextBlockOrdinal) : 0;
      for (let index = nextBlockOrdinal; index < selectedBlocks.length; index += 1) {
        await executeBlock(selectedBlocks[index]!, scope, branchFrame, context, key, String(index));
        await context.deps.store.commitFact({
          key,
          lifecycle: 'running',
          container: { kind: 'if', selected, nextBlockOrdinal: String(index + 1) },
        });
      }
    }, { kind: 'if', selected, nextBlockOrdinal: '0' });
    return;
  }
  if (block.kind === 'parallel') {
    await ensureAndCommitContainer(block, scope, context, parentKey, memberOrdinal, async (containerKey) => {
      const containerRecord = await context.deps.store.read(containerKey);
      if (!containerRecord) throw new WorkflowRuntimeInterruption();
      const failStopReason = `container_fail_stop:${containerRecord.recordId}`;
      const semaphore = new OptionalSemaphore(block.maxConcurrent);
      const failStop = new AbortController();
      const branchContext = block.failurePolicy === 'fail_stop' ? withAbortSignal(context, failStop.signal) : context;
      const branches = block.branches.map((branch, index) => {
        return {
          branch,
          memberOrdinal: String(index),
          scope: [...scope, { kind: 'branch' as const, blockId: block.id, branchId: branch.id }],
        };
      });
      const advance = createMemberFrontier(containerRecord.container?.kind === 'parallel' ? Number(containerRecord.container.nextBranchOrdinal) : 0,
        async (next) => { await context.deps.store.commitFact({ key: containerKey, lifecycle: 'running',
          container: { kind: 'parallel', nextBranchOrdinal: String(next) } }); });
      const scheduledBranches = await orderPipelinesForRecovery(branches, context, containerKey, frame, block.failurePolicy === 'collect_outcomes');
      const branchSettlements = await Promise.allSettled(scheduledBranches.map(({ branch, scope: branchScope }) => semaphore.run(async () => {
        if (failStop.signal.aborted) {
          await closeWaitingAfterFailStop({ owner: block, scope: branchScope, context,
            parentKey: containerKey, memberOrdinal: String(block.branches.indexOf(branch)), reason: failStopReason });
          throw failStop.signal.reason;
        }
        const branchFrame = childFrame(frame);
        try {
          await executeBodyFrame({
            owner: block,
            source: { kind: 'branch', branchId: branch.id },
            blocks: blocksOf(branch),
            scope: branchScope,
            frame: branchFrame,
            context: branchContext,
            parentKey: containerKey,
            memberOrdinal: String(block.branches.indexOf(branch)),
            onFrameStarted: async () => await advance(block.branches.indexOf(branch) + 1),
          });
          if (branchFrame.collectedFailures) frame.collectedFailures = true;
        } catch (error) {
          if (!(error instanceof WorkflowLeafFailure && error.collectable)) context.admissionGate.closeUnclaimedReservations(error);
          if (error instanceof WorkflowControlBoundary || error instanceof WorkflowRuntimeInterruption) throw error;
          if (block.failurePolicy === 'fail_stop' || !(error instanceof WorkflowLeafFailure && error.collectable)) {
            if (!failStop.signal.aborted) failStop.abort(new WorkflowFailStopClosure(failStopReason, error));
            throw error;
          }
          frame.collectedFailures = true;
        }
      }, async () => {
        await persistWaitingForCapacity({ owner: block, source: { kind: 'branch', branchId: branch.id }, scope: branchScope, context,
          parentKey: containerKey, memberOrdinal: String(block.branches.indexOf(branch)) });
      }, () => assertWorkflowAbortSignal(branchContext))));
      const rejectedBranch = branchSettlements.find(
        (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
      );
      if (rejectedBranch) {
        throw failStop.signal.reason instanceof WorkflowFailStopClosure
          ? failStop.signal.reason.original
          : failStop.signal.reason ?? rejectedBranch.reason;
      }
    }, { kind: 'parallel', nextBranchOrdinal: '0' });
    return;
  }
  await executeLoop(block, scope, frame, context, parentKey, memberOrdinal);
}

function blocksOf(branch: { blocks: readonly WorkflowBlock[] }): readonly WorkflowBlock[] {
  return branch.blocks;
}

async function reserveOwnedNativeInputs(context: ExecutionContext): Promise<void> {
  if (!context.materializedLeaves.some((leaf) => leaf.kind === 'step' && leaf.executionTarget.kind === 'detached_run')) return;
  const store = context.deps.store;
  const candidates = await store.listByLifecycle({ runId: context.runId,
    lifecycles: [...CAPACITY_OCCUPYING_LIFECYCLES, 'outcome_uncertain'] });
  for (const admitted of candidates) {
    if (admitted.lifecycle === 'waiting_for_review') continue;
    if (admitted.execution?.kind !== 'detached_run' && admitted.lifecycle !== 'admitting') continue;
    const readInvocation = store.readInvocationBindingRow;
    if (!readInvocation) throw new WorkflowLeafFailure('interrupted', 'continuation_unavailable');
    const row = await readInvocation(admitted.recordId);
    if (!row) throw new WorkflowLeafFailure('interrupted', 'continuation_unavailable');
    if (row.progress.blockKind !== 'step') continue;
    const current = await store.readCurrent({ runId: context.runId, blockId: admitted.blockId,
      scope: admitted.path.scope, memberOrdinal: row.index.memberOrdinal,
      ...(admitted.parentKey ? { parentKey: admitted.parentKey } : {}) });
    if (current?.recordId !== admitted.recordId) continue;
    const structure = await resolveWorkflowInvocationStructure({ definition: context.definition,
      frozenChildren: context.frozenChildren,
      invocation: row, readInvocation,
      keyOfInvocation: ({ index, progress }) => workflowInvocationKey({ runId: index.runId,
        blockId: progress.invocationPath.blockId, scope: progress.invocationPath.scope, attempt: Number(index.attempt) }),
    });
    if (!structure) throw new WorkflowLeafFailure('interrupted', 'continuation_unavailable');
    const leaf = effectiveLeaf({ ...context, definition: structure.definition, authoredDefinition: structure.definition,
      sourceKey: structure.sourceKey }, structure.step);
    if (!leaf) throw new WorkflowLeafFailure('interrupted', 'target_unavailable');
    if (leaf.executionTarget.kind !== 'detached_run') continue;
    const conversationBinding = resolveWorkflowConversationBinding({
      execution: leaf.selection,
      authoredConversation: leaf.authoredStep.execution?.conversation,
      inheritedOwnerKey: structure.inheritedConversationOwnerRecordId,
      rootOwnerKey: structure.rootConversationOwnerRecordId, targetClass: 'detached_run',
    });
    const key = await resolveConversationAdmissionKey({ conversationBinding, admitted,
      context: { ...context, rootOwnerKey: structure.rootConversationOwnerRecordId },
      producerBinding: createWorkflowProducerBinding({ runId: context.runId, store, frame: structure.frame }) });
    if (key) await context.admissionGate.reserve(key, admitted.recordId);
  }
}

async function resolveConversationAdmissionKey(params: Readonly<{
  conversationBinding: WorkflowConversationBinding;
  producerBinding: WorkflowProducerBinding;
  admitted: WorkflowCoordinatorInvocation;
  context: ExecutionContext;
}>): Promise<string | undefined> {
  const { conversationBinding, context } = params;
  if (conversationBinding.kind === 'shared') return workflowConversationAdmissionKey(conversationBinding);
  if (!params.admitted.execution && params.admitted.recovery?.conversation === 'fresh_agent') return undefined;
  const sameRecovery = params.admitted.recovery?.conversation === 'same_conversation';
  if (!params.admitted.execution && conversationBinding.kind !== 'from_step' && !sameRecovery) return undefined;
  const producer = params.admitted.execution ? params.admitted : sameRecovery
    ? await readRetainedConversationAttempt(params.admitted, context.deps.store)
    : conversationBinding.kind === 'from_step' ? await params.producerBinding.resolve(conversationBinding.producer) : undefined;
  const execution = params.admitted.execution ?? producer?.execution;
  if (execution?.kind !== 'detached_run') return undefined;
  // Only exact ancestors may establish a shared owner. Independent native
  // conversations retain their own native key rather than a second shared key.
  const owners = new Set<string>();
  let owner = producer?.parentKey ? await context.deps.store.read(producer.parentKey)
    : await context.deps.store.readByLogicalInvocation(context.rootOwnerKey);
  while (owner && !owners.has(owner.recordId)) {
    owners.add(owner.recordId);
    const pointer = owner?.sharedConversationInvocationRecordId?.detached_run;
    const shared = pointer ? await context.deps.store.readByLogicalInvocation(pointer) : undefined;
    if (shared?.execution && sameWorkflowConversationTarget(shared.execution, execution)) {
      return workflowConversationAdmissionKey({ kind: 'shared', scopeOwnerKey: owner.recordId, targetClass: 'detached_run' });
    }
    if (owner.recordId === context.rootOwnerKey) break;
    owner = owner.parentKey ? await context.deps.store.read(owner.parentKey)
      : await context.deps.store.readByLogicalInvocation(context.rootOwnerKey);
  }
  return `retained:${execution.runId}`;
}

async function readRetainedConversationAttempt(row: WorkflowCoordinatorInvocation, store: WorkflowCoordinatorStore) {
  const invocation = await store.readInvocationBindingRow(row.recordId);
  if (!invocation) return undefined;
  const retained = await resolveWorkflowRetainedConversationAttemptV1({ invocation, readInvocation: store.readInvocationBindingRow });
  return retained ? await store.readByLogicalInvocation(retained.index.id) : undefined;
}

async function awaitReviewedInvocation(row: WorkflowCoordinatorInvocation, context: ExecutionContext) {
  try { return await context.holds.wait(row, context.signal); }
  catch (error) {
    if (error instanceof WorkflowControlBoundary && error.state === 'cancelled') {
      await context.deps.store.commitFact({ key: row.key, lifecycle: 'cancelled',
        ...(classifyWorkflowAbort(context.signal) === 'fail_stop' ? { reason: failStopCausalReason(context.signal) } : {}) });
    }
    throw error;
  }
}

async function enterReview(
  fact: Parameters<WorkflowCoordinatorStore['commitFact']>[0],
  context: ExecutionContext,
  onCommitted?: () => void,
) {
  const row = await context.deps.store.commitFact({ ...fact, lifecycle: 'waiting_for_review' });
  onCommitted?.();
  await context.deps.onReviewEntered?.({ runId: context.runId, invocation: row });
  return row;
}

async function executeWaitBlock(
  leaf: WorkflowWaitLeafV1, scope: WorkflowInvocationPath['scope'], frame: Frame,
  context: ExecutionContext, parentKey: string | undefined, memberOrdinal: string,
): Promise<void> {
  let row = await context.deps.store.readCurrent({ runId: context.runId, blockId: leaf.id, scope, memberOrdinal,
    ...(parentKey ? { parentKey } : {}) });
  if (row?.lifecycle === 'waiting_for_review') {
    row = await awaitReviewedInvocation(row, context);
    if (holdReadiness(row) === 'generate') throw new WorkflowLeafFailure('interrupted', 'continuation_unavailable');
  }
  if (!row) {
    await assertAdmissionOpen(context);
    row = await context.deps.store.ensureIntent({ key: workflowInvocationKey({ runId: context.runId, blockId: leaf.id, scope, attempt: 0 }),
      recordId: context.deps.allocateInvocationRecordId(), runId: context.runId, blockId: leaf.id, blockKind: 'wait',
      path: { blockId: leaf.id, scope }, attempt: 0, memberOrdinal, ...(parentKey ? { parentKey } : {}), acceptedAtMs: Date.now(), lifecycle: 'pending' });
  }
  if (row.lifecycle === 'pending') row = await enterReview({ key: row.key, lifecycle: 'waiting_for_review',
    ...(leaf.result ? { resultContract: leaf.result } : {}) }, context);
  if (row.lifecycle === 'waiting_for_review') row = await awaitReviewedInvocation(row, context);
  if (holdReadiness(row) === 'generate') throw new WorkflowLeafFailure('interrupted', 'continuation_unavailable');
  const failure = persistedFailure(row);
  if (failure) throw failure;
  if (row.lifecycle !== 'completed') throw new WorkflowRuntimeInterruption();
}

async function resolveLeafWorkspace(
  leaf: Pick<WorkflowStep, 'id' | 'execution'>,
  row: WorkflowCoordinatorInvocation,
  scope: WorkflowInvocationPath['scope'],
  frame: Frame,
  context: ExecutionContext,
): Promise<WorkflowWorkspaceDescriptorV1> {
  const frozen = context.materializedLeaves.find((candidate) => candidate.sourceKey === context.sourceKey && candidate.blockId === leaf.id);
  if (!frozen) throw new WorkflowLeafFailure('interrupted', 'target_unavailable');
  const selected = { ...leaf, execution: { ...leaf.execution, workspace: frozen.authoredWorkspace } };
  const resolution = await context.deps.resolveWorkspace({ runId: context.runId, definition: context.definition,
    step: selected, invocation: row, scope,
    producerBinding: createWorkflowProducerBinding({ runId: context.runId, store: context.deps.store, frame }),
    defaultWorkspaceOwner: await context.deps.store.readByLogicalInvocation(context.rootOwnerKey),
    ...(context.projectWorkspace ? { projectWorkspace: context.projectWorkspace } : {}) });
  if (!resolution.ok) throw new WorkflowLeafFailure('failed', resolution.code);
  if (row.blockKind === 'workflow') {
    const current = await context.deps.store.read(row.key);
    if (current?.container?.kind !== 'body') throw new WorkflowRuntimeInterruption();
    await context.deps.store.commitFact({ key: row.key, lifecycle: current.lifecycle,
      container: { ...current.container, frameProjectWorkspace: {
        ...current.container.frameProjectWorkspace, descriptor: resolution.workspace,
      } } });
  } else {
    await context.deps.store.commitFact({ key: row.key, lifecycle: row.lifecycle, workspace: { descriptor: resolution.workspace } });
  }
  return resolution.workspace;
}

async function executeActionBlock(
  leaf: WorkflowActionLeafV1, scope: WorkflowInvocationPath['scope'], frame: Frame,
  context: ExecutionContext, parentKey?: string, memberOrdinal = '0',
): Promise<WorkflowJsonValue> {
  let row = await context.deps.store.readCurrent({ runId: context.runId, blockId: leaf.id, scope, memberOrdinal,
    ...(parentKey ? { parentKey } : {}) });
  if (row?.lifecycle === 'waiting_for_review') {
    row = await awaitReviewedInvocation(row, context);
    if (holdReadiness(row) === 'generate') throw new WorkflowLeafFailure('interrupted', 'continuation_unavailable');
  }
  if (row?.lifecycle === 'completed') {
    const result = row.result ?? null;
    return result;
  }
  if (row?.lifecycle === 'outcome_uncertain') throw new WorkflowLeafFailure('outcome_uncertain', row.reason ?? 'outcome_uncertain');
  if (row) { const failure = persistedFailure(row); if (failure) throw failure; }
  const frozen = context.materializedLeaves.find((candidate) => candidate.sourceKey === context.sourceKey
    && candidate.blockId === leaf.id && candidate.kind === 'action');
  const actionId = ActionIdSchema.safeParse(frozen?.actionId);
  if (!frozen?.actionContract || !actionId.success || actionId.data !== leaf.actionId || !context.deps.action) {
    throw new WorkflowLeafFailure('interrupted', 'target_unavailable');
  }
  if (!row) {
    await assertAdmissionOpen(context);
    row = await context.deps.store.ensureIntent({ key: workflowInvocationKey({ runId: context.runId, blockId: leaf.id, scope, attempt: 0 }),
      recordId: context.deps.allocateInvocationRecordId(), acceptedAtMs: Date.now(), runId: context.runId, blockId: leaf.id,
      blockKind: 'action', path: { blockId: leaf.id, scope }, attempt: 0, lifecycle: 'pending', memberOrdinal,
      ...(parentKey ? { parentKey } : {}) });
  }
  const fail = async (code: string, state: 'failed' | 'outcome_uncertain' = 'failed', collectable = false) => {
    await context.deps.store.commitFact({ key: row!.key, lifecycle: state, reason: code });
    throw new WorkflowLeafFailure(state, code, collectable);
  };
  let completionState = row.execution?.kind === 'action' && row.execution.awaitedRuns && row.execution.output !== undefined
    ? { output: row.execution.output, awaitedRuns: row.execution.awaitedRuns } : undefined;
  if (row.lifecycle !== 'pending' && !completionState) return await fail('outcome_uncertain', 'outcome_uncertain');
  let workspace = row.workspace?.descriptor;
  let completed: Awaited<ReturnType<typeof resumeActionCompletionV1>> | undefined;
  let noRunsLaunched = false;
  if (row.lifecycle === 'pending') {
    const runtime = createResolutionRuntime(context.inputs, frame, context.deps.store, context.deps.sessionContext);
    const input: Record<string, WorkflowJsonValue> = { ...frozen.actionInput };
    const resolve = async (reference: Exclude<WorkflowActionLeafV1['input'][string], { kind: 'list' }>) =>
      reference.kind === 'origin_session_id' ? context.originSessionId ?? null : await resolveWorkflowValueReference(reference, runtime);
    for (const [field, binding] of Object.entries(leaf.input)) {
      input[field] = binding.kind === 'list'
        ? await Promise.all(binding.items.map(resolve)) : await resolve(binding);
    }
    const schema = frozen.actionContract.inputSchema;
    if (!isWorkflowJsonObject(schema)) return await fail('invalid_input', 'failed', true);
    const validation = validateExecutionRunProfileResult(input, { kind: 'json', schema });
    if (!validation.ok) {
      await context.deps.store.commitFact({ key: row.key, lifecycle: 'failed', reason: 'invalid_input',
        ...('issues' in validation && validation.issues ? { validationIssues: [...validation.issues] } : {}) });
      throw new WorkflowLeafFailure('failed', 'invalid_input', true);
    }
    const actionWorkspace = workspace ?? await resolveLeafWorkspace(leaf, row, scope, frame, context);
    workspace = actionWorkspace;
    const localInputId = `workflow:${createHash('sha256').update(row.recordId).digest('hex')}:action`;
    const actionContext: ActionExecutorContext = { ...await context.holds.track(() => context.deps.action!.buildContext({ runId: context.runId, authorization: context.authorization,
      workDepth: context.workDepth, workspace: actionWorkspace, ...(context.originSessionId ? { originSessionId: context.originSessionId } : {}),
      ...(frozen.role ? { role: frozen.role } : {}),
      ...(context.signal ? { signal: context.signal } : {}) })), actionRequestId: localInputId };
    const prepared = await context.holds.track(() => context.deps.action!.executor.prepare(actionId.data, input, actionContext));
    if (prepared.kind === 'settled' && !prepared.result.ok) return await fail(prepared.result.errorCode, 'failed', true);
    await assertAdmissionOpen(context);
    await assertAcceptedAuthorizationCurrent(context);
    const execution = { kind: 'action' as const, actionId: actionId.data, actionRequestId: localInputId, localInputId, input };
    // This CAS is the last asynchronous boundary before the one-shot effect.
    // Failure/lost acknowledgement never authorizes dispatch or replay.
    try { row = await context.deps.store.commitFact({ key: row.key, lifecycle: 'admitting', execution }); }
    catch { return await fail('outcome_uncertain', 'outcome_uncertain'); }
    assertWorkflowAbortSignal(context);
    const invoked = await context.holds.track(async () => {
      try { return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result; }
      catch { return undefined; }
    });
    if (!invoked || (!invoked.ok && invoked.errorCode === 'action_failed')) return await fail('outcome_uncertain', 'outcome_uncertain');
    const declaration = frozen.actionContract.completion ? getActionSpec(actionId.data).completion : undefined;
    if (frozen.actionContract.completion && !declaration) return await fail('outcome_uncertain', 'outcome_uncertain');
    const phase = prepareActionCompletionV1(declaration, invoked);
    if (phase.kind === 'awaiting') {
      completionState = phase.state;
      row = await context.deps.store.commitFact({ key: row.key, lifecycle: 'running', execution: { ...execution, ...completionState } });
    } else {
      completed = phase;
      noRunsLaunched = phase.kind === 'failed' && 'noRunsLaunched' in phase && phase.noRunsLaunched === true;
    }
  }
  // The one-shot call may have returned exact launch ids after this claim was
  // interrupted. Preserve that correspondence before stopping observation.
  assertWorkflowAbortSignal(context);
  if (completionState) {
    if (!workspace) return await fail('outcome_uncertain', 'outcome_uncertain');
    const observationWorkspace = workspace;
    completed = await context.holds.track(() => resumeActionCompletionV1({ actionId: actionId.data,
      completion: frozen.actionContract!.completion, state: completionState,
      resolveDeclaration: () => getActionSpec(actionId.data).completion,
      observeRun: async (run) => await context.deps.action!.observeRun(run, { workspace: observationWorkspace, ...(context.signal ? { signal: context.signal } : {}) }) }));
  }
  if (!completed) return await fail('outcome_uncertain', 'outcome_uncertain');
  assertWorkflowAbortSignal(context);
  if (completed.kind !== 'completed') {
    // Only the native start owner's explicit non-creation evidence proves failure. Otherwise
    // declaring Actions need persisted correspondence and terminal observation.
    const collectable = completed.kind === 'failed'
      && (!frozen.actionContract.completion || noRunsLaunched || (completionState !== undefined
        && getActionSpec(actionId.data).completion?.launched(completionState.output).failed.length === 0));
    return await fail(completed.errorCode, collectable ? 'failed' : 'outcome_uncertain', collectable);
  }
  const outputSchema = frozen.actionContract.outputSchema;
  if (!isWorkflowJsonObject(outputSchema)) return await fail('schema_mismatch');
  const validated = validateExecutionRunProfileResult(completed.value, { kind: 'json', schema: outputSchema });
  const reviewRequired = classifyWorkflowReviewEntryV1({ mayEnterReview: true, pauseForReview: leaf.pauseForReview === true,
    isGeneration: false, inputCompleted: true, observation: { kind: validated.ok ? 'completed' : 'failed' } }) === 'waiting_for_review';
  if (!validated.ok && !reviewRequired) return await fail('schema_mismatch');
  if (reviewRequired) {
    row = await enterReview({ key: row.key, lifecycle: 'waiting_for_review',
      ...(validated.ok ? { result: validated.value, review: { resultSource: { kind: 'execution_input' as const } } }
        : { reason: 'schema_mismatch', ...('issues' in validated && validated.issues ? { validationIssues: [...validated.issues] } : {}) }),
      resultContract: { kind: 'json', schema: outputSchema } }, context);
    row = await awaitReviewedInvocation(row, context);
    if (holdReadiness(row) === 'generate') throw new WorkflowLeafFailure('interrupted', 'continuation_unavailable');
    if (row.lifecycle !== 'completed') throw new WorkflowRuntimeInterruption();
  } else {
    if (!validated.ok) return await fail('schema_mismatch');
    row = await context.deps.store.commitFact({ key: row.key, lifecycle: 'completed', result: validated.value });
  }
  const result = row.result ?? (validated.ok ? validated.value : null);
  return result;
}

async function executeWorkflowBlock(
  leaf: WorkflowNestedLeafV1, scope: WorkflowInvocationPath['scope'], frame: Frame,
  context: ExecutionContext, parentKey?: string, memberOrdinal = '0',
): Promise<void> {
  const selected = context.materializedLeaves.find((candidate) => candidate.sourceKey === context.sourceKey
    && candidate.blockId === leaf.id && candidate.kind === 'workflow');
  const authoredChild = selected?.childRef ? context.frozenChildren[selected.childRef] : undefined;
  if (!authoredChild || !selected?.childRef) throw new WorkflowLeafFailure('interrupted', 'target_unavailable');
  const current = await context.deps.store.readCurrent({ runId: context.runId, blockId: leaf.id, scope, memberOrdinal,
    ...(parentKey ? { parentKey } : {}) });
  let childInputs = current?.container?.kind === 'body' ? current.container.frameInputs : undefined;
  if (childInputs === undefined) {
    const suppliedInputs: Record<string, WorkflowJsonValue> = {};
    const runtime = createResolutionRuntime(context.inputs, frame, context.deps.store, context.deps.sessionContext);
    for (const [name, reference] of Object.entries(leaf.input)) suppliedInputs[name] = await resolveWorkflowValueReference(reference, runtime);
    childInputs = bindAutomationWorkflowInputs({ definition: authoredChild, evidence: suppliedInputs });
  }
  // Each inline admission freezes its inputs before child effects. Reclaim
  // derives the same concrete definition from those persisted inputs.
  const child = freezeWorkflowLoopLimitsV1(authoredChild, childInputs);
  if (!child) throw new WorkflowInputResolutionError('invalid_input');
  const childScope = [...scope, { kind: 'workflow' as const, blockId: leaf.id }];
  await ensureAndCommitContainer(leaf, scope, context, parentKey, memberOrdinal, async (key) => {
    const row = await context.deps.store.read(key);
    if (!row) throw new WorkflowRuntimeInterruption();
    if (row.container?.kind === 'body' && row.container.frameInputs === undefined) {
      await context.deps.store.commitFact({ key, lifecycle: 'running', container: { ...row.container, frameInputs: childInputs } });
    }
    const workspace = await resolveLeafWorkspace(leaf, row, scope, frame, context);
    const resolvedRow = await context.deps.store.read(key);
    const frameProjectWorkspace = resolvedRow?.container?.kind === 'body'
      ? resolvedRow.container.frameProjectWorkspace : undefined;
    if (!frameProjectWorkspace?.descriptor) throw new WorkflowRuntimeInterruption();
    // A Workflow is a new lexical and conversation root, not another Run.
    const childFrame: Frame = { scopeRunId: context.runId, structuralKey: key, conversationOwnerKey: row.recordId, resultContext: frame.resultContext,
      blocks: child.blocks, scope: childScope, collectedFailures: false };
    const childContext: ExecutionContext = { ...context, definition: child, authoredDefinition: child,
      inputs: childInputs, sourceKey: selected.childRef!, rootOwnerKey: row.recordId,
      projectWorkspace: { descriptor: workspace,
        ...(frameProjectWorkspace.creationIntent ? { creationIntent: frameProjectWorkspace.creationIntent } : {}) } };
    const nextBlockOrdinal = row.container?.kind === 'body' ? Number(row.container.nextBlockOrdinal) : 0;
    for (let index = nextBlockOrdinal; index < child.blocks.length; index++) {
      await executeBlock(child.blocks[index]!, childScope, childFrame, childContext, key, String(index));
      await context.deps.store.commitFact({ key, lifecycle: 'running',
        container: { kind: 'body', nextBlockOrdinal: String(index + 1), frameInputs: childInputs, frameProjectWorkspace } });
    }
    if (childFrame.collectedFailures) frame.collectedFailures = true;
    if (child.finalOutput) await resolveWorkflowValueReference(child.finalOutput,
      createResolutionRuntime(childInputs, childFrame, context.deps.store, context.deps.sessionContext));
  }, current?.container?.kind === 'body'
    ? { ...current.container, frameInputs: childInputs }
    : { kind: 'body', nextBlockOrdinal: '0', frameInputs: childInputs });
}

async function executeStepBlock(
  step: WorkflowStep,
  scope: WorkflowInvocationPath['scope'],
  frame: Frame,
  context: ExecutionContext,
  parentKey?: string,
  memberOrdinal = '0',
  supplementalInputValues: readonly WorkflowJsonValue[] = [],
): Promise<WorkflowJsonValue> {
  const current = await context.deps.store.readCurrent({ runId: context.runId, blockId: step.id, scope, memberOrdinal, ...(parentKey ? { parentKey } : {}) });
  const candidateKey = workflowInvocationKey({ runId: context.runId, blockId: step.id, scope, attempt: 0 });
  const existing = current;
  const key = existing?.key ?? candidateKey;
  if (existing?.lifecycle === 'waiting_for_review') {
    const resolved = await awaitReviewedInvocation(existing, context);
    if (holdReadiness(resolved) === 'generate') {
      await assertAdmissionOpen(context);
      if (!resolved.review?.decision) throw new WorkflowLeafFailure('interrupted', 'continuation_unavailable');
      const originalMaterialized = resolved.input ? undefined : await materializeWorkflowStepInput({ document: step.document,
        automationCause: context.automationCause,
        references: [...step.input, ...supplementalInputValues.map((value) => ({ kind: 'literal' as const, value }))],
        runtime: createResolutionRuntime(context.inputs, frame, context.deps.store, context.deps.sessionContext) });
      const original: WorkflowAuthoredInputV1 = { document: step.document,
        input: resolved.input ? [...resolved.input.input] : [...originalMaterialized!.values] };
      const input: WorkflowAuthoredInputV1 = { ...original, document: { ...original.document,
        text: `${original.document.text}\n\nGenerate the required result for this step and return it as the exact terminal output. Do not publish a draft during this input. The workflow will continue automatically when the result is valid.` } };
      await context.deps.store.admitReviewReplacement({ prior: resolved, input,
        recordId: deriveWorkflowReplacementId(['workflow.review.generate', context.runId, resolved.recordId,
          resolved.review.decision.requestedFromContentRevision]) });
    }
    return await executeStepBlock(step, scope, frame, context, parentKey, memberOrdinal, supplementalInputValues);
  }
  const selectedLeaf = effectiveLeaf(context, step);
  if (!selectedLeaf) throw new WorkflowLeafFailure('interrupted', 'target_unavailable');
  const { selection: selectedExecution, executionTarget } = selectedLeaf;
  const conversationBinding = resolveWorkflowConversationBinding({
    execution: selectedExecution,
    authoredConversation: selectedLeaf.authoredStep.execution?.conversation,
    inheritedOwnerKey: frame.conversationOwnerKey,
    rootOwnerKey: context.rootOwnerKey,
    targetClass: executionTarget.kind,
  });
  if (existing?.lifecycle === 'completed') {
    if (existing.execution && conversationBinding.kind === 'shared') {
      // Replaying a terminal predecessor releases no input. Its serialized,
      // sequence-aware pointer repair must not wait behind a recovered child
      // that cannot be reached until this predecessor has been replayed.
      const previous = existing.recovery?.conversation === 'fresh_agent' && existing.previousAttemptRecordId
        ? await context.deps.store.readByLogicalInvocation(existing.previousAttemptRecordId) : undefined;
      await context.deps.store.commitSharedConversation({
        scopeOwnerKey: conversationBinding.scopeOwnerKey, targetClass: conversationBinding.targetClass,
        invocationRecordId: existing.recordId,
        ...(previous?.execution ? { replacesExecution: previous.execution } : {}),
      });
    }
    const result = existing.result ?? null;
    return result;
  }
  if (existing) {
    const failure = conversationBinding.kind === 'origin_session' && existing.lifecycle === 'cancel_requested'
      ? undefined : persistedFailure(existing);
    if (failure) throw failure;
    if (existing.lifecycle === 'superseded') {
      throw new WorkflowLeafFailure('interrupted', existing.reason ?? 'retry_not_current');
    }
  }
  const path = { blockId: step.id, scope };
  const producerBinding = createWorkflowProducerBinding({ runId: context.runId, store: context.deps.store, frame });
  const rejoining = existing !== undefined
    && existing.lifecycle !== 'pending'
    && existing.lifecycle !== 'waiting_for_capacity';
  let admitted: WorkflowCoordinatorInvocation;
  if (rejoining) {
    // `admitting` may represent a lost admission acknowledgement. Without
    // correspondence the executor may only observe the deterministic identity,
    // never release input because a live controller cannot be found.
    if (!existing?.execution && existing?.lifecycle !== 'admitting') {
      throw new WorkflowLeafFailure('interrupted', 'continuation_unavailable');
    }
    admitted = existing;
  } else {
    // Allocation is fenced separately from input release. Preparation stays
    // pending; the adapter's final callback validates the exact parent claim
    // and controls atomically with the admitting fact after all async work.
    await assertAdmissionOpen(context);
    try {
      admitted = await context.deps.store.ensureIntent({
        key, recordId: context.deps.allocateInvocationRecordId(), acceptedAtMs: Date.now(), runId: context.runId, blockId: step.id, memberOrdinal, ...(parentKey ? { parentKey } : {}),
        path, blockKind: 'step', attempt: 0, lifecycle: 'pending',
      });
    } catch (error) {
      // A parent CAS can lose to an external pause/cancel after the
      // container/claim-level admission check. Re-read only the canonical
      // control owner; do not retry a new row or reinterpret unrelated
      // storage failures.
      await assertAdmissionOpen(context);
      throw error;
    }
  }
  const isOriginInput = conversationBinding.kind === 'origin_session';
  const previousAttempt = admitted.previousAttemptRecordId
    ? await context.deps.store.readByLogicalInvocation(admitted.previousAttemptRecordId)
    : undefined;
  const isReviewGeneration = previousAttempt?.review?.decision?.kind === 'generate';
  const recoveryPrevious = admitted.recovery?.conversation === 'same_conversation'
    ? await readRetainedConversationAttempt(admitted, context.deps.store) : previousAttempt;
  const observationDeadline = admitted.observationDeadline;
  const invocation: WorkflowProgressEnvelopeV1 = {
    kind: 'happier.workflow-progress.v1',
    invocationPath: path,
    blockKind: 'step',
    attempt: String(admitted.attempt),
    logicalInvocationRecordId: admitted.logicalInvocationRecordId ?? admitted.recordId,
    resultContract: step.result,
    ...(admitted.execution && !(isOriginInput && !rejoining) ? { execution: admitted.execution } : {}),
    ...(admitted.recovery ? { recovery: admitted.recovery } : {}),
    ...(admitted.previousAttemptRecordId ? { previousAttemptRecordId: admitted.previousAttemptRecordId } : {}),
    ...(observationDeadline ? { observationDeadline } : {}),
  };
  const recoveryInput = admitted.recovery?.input;
  const effectiveStep = recoveryInput?.kind === 'replacement'
    ? { ...step, document: recoveryInput.value.document }
    : step;
  const persistedInput = admitted.input;
  const input = await materializeWorkflowStepInput({
    automationCause: context.automationCause,
    document: persistedInput?.document ?? effectiveStep.document,
    references: persistedInput
      ? persistedInput.input.map((value) => ({ kind: 'literal' as const, value }))
      : recoveryInput?.kind === 'replacement'
        ? recoveryInput.value.input.map((value) => ({ kind: 'literal' as const, value }))
        : [
            ...step.input,
            ...supplementalInputValues.map((value) => ({ kind: 'literal' as const, value })),
          ],
    runtime: createResolutionRuntime(context.inputs, frame, context.deps.store, context.deps.sessionContext),
    ...(step.pauseForReview && !isReviewGeneration ? { reviewContext: { runId: context.runId,
      invocationRecordId: admitted.recordId, contentRevision: admitted.contentRevision ?? '0' } } : {}),
  });
  const authoredInput: WorkflowAuthoredInputV1 = {
    document: persistedInput?.document ?? effectiveStep.document,
    input: [...input.values],
  };
  let durableExecution = admitted.execution;
  const assertInputAuthorization = async () => {
    if (isReviewGeneration && !rejoining && !durableExecution && context.deps.checkReviewGenerationAuthority) {
      const refusal = await context.deps.checkReviewGenerationAuthority({ ...(context.signal ? { signal: context.signal } : {}) });
      if (refusal !== undefined) throw new WorkflowGenerationRefusal(refusal);
    } else await assertAcceptedAuthorizationCurrent(context);
  };
  const onOriginInputOffered: Parameters<WorkflowStepExecutor>[0]['onOriginInputOffered'] = isOriginInput ? async (correspondence, renderedText) => {
      if (correspondence.sessionId !== context.originSessionId
        || (durableExecution && !sameStrictJsonValue(durableExecution, correspondence))) {
        throw new Error('workflow_invocation_fact_conflict');
      }
      await assertAdmissionOpen(context);
      await assertInputAuthorization();
      try {
        admitted = await context.deps.store.commitFact({ key, lifecycle: 'admitting', execution: correspondence,
          input: { ...authoredInput, renderedText }, resultContract: step.result });
        durableExecution = correspondence;
      } catch (error) {
        await assertAdmissionOpen(context);
        throw error;
      }
    } : undefined;
  if (!admitted.input) {
    admitted = await context.deps.store.commitFact({
      key,
      lifecycle: admitted.lifecycle,
      input: authoredInput,
    });
  }
  const admissionKey = await resolveConversationAdmissionKey({ conversationBinding, producerBinding, admitted, context });
  const releaseAdmission = admissionKey === undefined
    ? (_failure?: { error: unknown }) => undefined : await context.admissionGate.acquire(admissionKey, admitted.recordId);
  let nativeTerminalCommitted = false;
  let admissionFailure: { error: unknown } | undefined;
  try {
    if (admitted.execution && conversationBinding.kind === 'shared') {
      await context.deps.store.commitSharedConversation({
        scopeOwnerKey: conversationBinding.scopeOwnerKey,
        targetClass: conversationBinding.targetClass,
        invocationRecordId: admitted.recordId,
        ...(admitted.recovery?.conversation === 'fresh_agent' && recoveryPrevious?.execution
          ? { replacesExecution: recoveryPrevious.execution } : {}),
      });
    }
    let preparedStep: Awaited<ReturnType<WorkflowStepPreparer>> | undefined;
    if (!admitted.execution || (isOriginInput && !rejoining)) {
      try {
        await assertInputAuthorization();
      } catch (error) {
        if (error instanceof WorkflowLeafFailure) {
          await context.deps.store.commitFact({ key, lifecycle: 'needs_attention', reason: error.code });
        }
        throw error;
      }
      preparedStep = await context.deps.prepareStep?.({
        runId: context.runId,
        step: effectiveStep,
        ...(selectedLeaf.role ? { role: selectedLeaf.role } : {}),
        memberOrdinal: admitted.memberOrdinal ?? memberOrdinal,
        invocation,
        invocationRecordId: admitted.recordId,
        producerBinding,
        conversationBinding,
        ...(context.originSessionId ? { originSessionId: context.originSessionId } : {}),
        ...(onOriginInputOffered ? { onOriginInputOffered } : {}),
        ...(recoveryPrevious?.execution ? { recoveryPreviousExecution: recoveryPrevious.execution } : {}),
        ...(recoveryPrevious?.workspace?.descriptor
          ? { recoveryPreviousWorkspace: recoveryPrevious.workspace.descriptor }
          : {}),
        execution: selectedExecution,
        executionTarget,
        authorization: context.authorization,
        ...(frame.item ? { item: frame.item } : {}),
        ...(frame.iteration ? { iteration: frame.iteration } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (!rejoining) await assertAdmissionOpen(context);
      if (preparedStep?.failure) {
        if (classifyWorkflowReviewEntryV1({ mayEnterReview: !rejoining && !durableExecution,
          pauseForReview: step.pauseForReview === true, isGeneration: isReviewGeneration, inputCompleted: false,
          observation: preparedStep.failure, continuationRefusedBeforeAdmission: true }) === 'waiting_for_review') {
          const row = await enterReview({ key, lifecycle: 'waiting_for_review', reason: preparedStep.failure.code }, context, () => {
            nativeTerminalCommitted = true;
            releaseAdmission();
          });
          await awaitReviewedInvocation(row, context);
          return await executeStepBlock(step, scope, frame, context, parentKey, memberOrdinal, supplementalInputValues);
        }
        await context.deps.store.commitFact({
          key,
          lifecycle: preparedStep.failure.kind,
          reason: preparedStep.failure.code,
        });
        nativeTerminalCommitted = preparedStep.failure.kind === 'failed';
        throw new WorkflowLeafFailure(
          'interrupted',
          preparedStep.failure.code,
          preparedStep.failure.kind === 'failed',
        );
      }
    }
    const defaultWorkspaceOwner = await context.deps.store.readByLogicalInvocation(context.rootOwnerKey);
    const workspaceResolution = await context.deps.resolveWorkspace({
      runId: context.runId,
      definition: selectedLeaf.authoredDefinition,
      step: selectedLeaf.authoredStep,
      invocation: admitted,
      scope,
      producerBinding,
      conversationBinding,
      ...(context.projectWorkspace ? { projectWorkspace: context.projectWorkspace } : {}),
      ...(defaultWorkspaceOwner ? { defaultWorkspaceOwner } : {}),
      ...((conversationBinding.kind === 'from_step' || conversationBinding.kind === 'existing_session' || conversationBinding.kind === 'origin_session'
        || conversationBinding.kind === 'shared')
        && executionTarget.kind === 'session' && (!selectedExecution.workspace || selectedExecution.workspace.kind === 'inherit')
        ? { useConversationWorkspace: true } : {}),
      ...(preparedStep?.conversationWorkspace
        ? { conversationWorkspace: preparedStep.conversationWorkspace }
        : {}),
    });
    if (!rejoining) await assertAdmissionOpen(context);
    if (!workspaceResolution.ok) {
      await context.deps.store.commitFact({ key, lifecycle: 'needs_attention', reason: workspaceResolution.code });
      throw new WorkflowLeafFailure('interrupted', workspaceResolution.code);
    }
    let execution: WorkflowStepExecutionResult;
    if (!admitted.execution && !rejoining) {
      await assertAdmissionOpen(context);
      try {
        await assertInputAuthorization();
      } catch (error) {
        if (error instanceof WorkflowLeafFailure) {
          await context.deps.store.commitFact({ key, lifecycle: 'needs_attention', reason: error.code });
        }
        throw error;
      }
    }
    execution = await context.deps.executeStep({
      runId: context.runId,
      step: effectiveStep,
      ...(selectedLeaf.role ? { role: selectedLeaf.role } : {}),
      memberOrdinal: admitted.memberOrdinal ?? memberOrdinal,
      invocation,
      invocationRecordId: admitted.recordId,
      producerBinding,
      conversationBinding,
      ...(context.originSessionId ? { originSessionId: context.originSessionId } : {}),
      ...(onOriginInputOffered ? { onOriginInputOffered,
        readOriginInputControl: async () => await context.deps.store.readControl(context.runId) } : {}),
      ...(recoveryPrevious?.execution ? { recoveryPreviousExecution: recoveryPrevious.execution } : {}),
      ...(recoveryPrevious?.workspace?.descriptor
        ? { recoveryPreviousWorkspace: recoveryPrevious.workspace.descriptor }
        : {}),
      input,
      execution: selectedExecution,
      executionTarget,
      workspace: workspaceResolution.workspace,
      ...(preparedStep?.preparedStep !== undefined
        ? { preparedStep: preparedStep.preparedStep }
        : {}),
      authorization: context.authorization,
      ...(rejoining && !admitted.execution ? { observationOnly: true } : {}),
      ...(frame.item ? { item: frame.item } : {}),
      ...(frame.iteration ? { iteration: frame.iteration } : {}),
      beforeInputAdmission: async () => {
        await assertAdmissionOpen(context);
        await assertInputAuthorization();
        if (!isOriginInput && (admitted.lifecycle === 'pending' || admitted.lifecycle === 'waiting_for_capacity' || admitted.lifecycle === 'admitting')) {
          try {
            admitted = await context.deps.store.commitFact({ key, lifecycle: 'admitting' });
          } catch (error) {
            // A lost transition response is ambiguous. Do not dispatch on the
            // strength of a subsequent read that merely says `admitting`.
            await assertAdmissionOpen(context);
            throw error;
          }
        }
        // The admitting write is asynchronous too; Generate's live gate is
        // the final boundary before releasing input, not a prepared capability.
        if (isReviewGeneration && context.deps.checkReviewGenerationAuthority) await assertInputAuthorization();
        assertWorkflowAbortSignal(context);
      },
      onInputAccepted: async (correspondence, acceptedAtMs) => {
        if (isOriginInput && (correspondence.kind !== 'session' || correspondence.sessionId !== context.originSessionId
          || (durableExecution && !sameStrictJsonValue(durableExecution, correspondence)))) {
          throw new Error('workflow_invocation_fact_conflict');
        }
        const persistedCorrespondence = correspondence.kind === 'detached_run'
          && durableExecution?.kind === 'detached_run'
          && durableExecution.runId === correspondence.runId
          && durableExecution.localInputId === correspondence.localInputId
          && durableExecution.providerResumeIdentity
          ? { ...correspondence, providerResumeIdentity: durableExecution.providerResumeIdentity }
          : correspondence;
        durableExecution = persistedCorrespondence;
        const current = await context.deps.store.read(key);
        const lifecycle = isOriginInput && current?.lifecycle === 'cancel_requested' ? 'cancel_requested' : 'running';
        await context.deps.store.commitFact({ key, lifecycle, execution: persistedCorrespondence,
          ...(current?.observationDeadline ? { observationDeadline: current.observationDeadline } : step.timeoutMs !== undefined && acceptedAtMs !== undefined
            ? { observationDeadline: { kind: 'at', expiresAt: new Date(acceptedAtMs + step.timeoutMs).toISOString() } } : {}),
        });
        if (conversationBinding.kind === 'shared') {
          await context.deps.store.commitSharedConversation({
            scopeOwnerKey: conversationBinding.scopeOwnerKey,
            targetClass: conversationBinding.targetClass,
            invocationRecordId: admitted.recordId,
            ...(admitted.recovery?.conversation === 'fresh_agent' && recoveryPrevious?.execution
              ? { replacesExecution: recoveryPrevious.execution } : {}),
          });
        }
        if (executionTarget.kind === 'session') releaseAdmission();
      },
      onExecutionObservation: async (observation) => {
        const currentExecution = durableExecution;
        if (currentExecution && (
          currentExecution.kind !== 'detached_run'
          || currentExecution.runId !== observation.execution.runId
          || currentExecution.localInputId !== observation.execution.localInputId
        )) {
          throw new Error('workflow_invocation_fact_conflict');
        }
        const existingIdentity = currentExecution?.kind === 'detached_run'
          ? currentExecution.providerResumeIdentity
          : undefined;
        const observedIdentity = observation.execution.providerResumeIdentity;
        if (existingIdentity && observedIdentity
          && !sameStrictJsonValue(existingIdentity, observedIdentity)) {
          throw new Error('workflow_invocation_fact_conflict');
        }
        const mergedExecution = {
          ...(currentExecution?.kind === 'detached_run' ? currentExecution : {}),
          ...observation.execution,
          ...(existingIdentity ? { providerResumeIdentity: existingIdentity } : {}),
        } as Extract<NonNullable<WorkflowProgressEnvelopeV1['execution']>, { kind: 'detached_run' }>;
        durableExecution = mergedExecution;
        await context.deps.store.commitFact({
          key,
          lifecycle: 'running',
          execution: mergedExecution,
          ...(observation.usage ? { usage: observation.usage } : {}),
        });
      },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (execution.kind === 'completed') {
      let result: WorkflowJsonValue;
      try {
        const published = !isReviewGeneration && step.pauseForReview ? await context.deps.store.read(key) : undefined;
        result = published?.review?.resultSource?.kind === 'published' && published.result !== undefined
          ? validateStepResult(step, published.result, 'typed')
          : validateStepResult(step, execution.result, execution.resultEncoding ?? 'raw_text');
      } catch (error) {
        if (error instanceof WorkflowLeafFailure) {
          if (classifyWorkflowReviewEntryV1({ mayEnterReview: true, pauseForReview: step.pauseForReview === true,
            isGeneration: isReviewGeneration, inputCompleted: true,
            observation: { kind: 'failed', code: error.code } }) === 'waiting_for_review') {
            const row = await enterReview({ key, lifecycle: 'waiting_for_review', reason: error.code,
              ...(error.resultFailureReason ? { reasonMessage: error.resultFailureReason } : {}),
              ...(execution.usage ? { usage: execution.usage } : {}) }, context, () => {
              nativeTerminalCommitted = true;
              releaseAdmission();
            });
            await awaitReviewedInvocation(row, context);
            return await executeStepBlock(step, scope, frame, context, parentKey, memberOrdinal, supplementalInputValues);
          }
          await context.deps.store.commitFact({
            key,
            lifecycle: 'failed',
            reason: error.code,
            ...(error.resultFailureReason ? { reasonMessage: error.resultFailureReason } : {}),
            ...(execution.usage ? { usage: execution.usage } : {}),
          });
          nativeTerminalCommitted = true;
        }
        throw error;
      }
      if (classifyWorkflowReviewEntryV1({ mayEnterReview: true, pauseForReview: step.pauseForReview === true,
        isGeneration: isReviewGeneration, inputCompleted: true, observation: { kind: 'completed' } }) === 'waiting_for_review') {
        const row = await enterReview({ key, lifecycle: 'waiting_for_review', result,
          review: { resultSource: { kind: 'execution_input' } },
          ...(execution.usage ? { usage: execution.usage } : {}) }, context, () => {
          nativeTerminalCommitted = true;
          releaseAdmission();
        });
        await awaitReviewedInvocation(row, context);
        return await executeStepBlock(step, scope, frame, context, parentKey, memberOrdinal, supplementalInputValues);
      }
      await context.deps.store.commitFact({
        key,
        lifecycle: 'completed',
        result,
        ...(isReviewGeneration ? { review: { resultSource: { kind: 'execution_input' as const } } } : {}),
        ...(execution.usage ? { usage: execution.usage } : {}),
      });
      nativeTerminalCommitted = true;
      return result;
    }
    const generationContinuationRefused = execution.kind === 'needs_attention' && !rejoining && !durableExecution
      && (execution.code === 'continuation_unavailable' || execution.code === 'workflow_conversation_unavailable');
    if (classifyWorkflowReviewEntryV1({ mayEnterReview: !context.signal?.aborted, pauseForReview: step.pauseForReview === true,
      isGeneration: isReviewGeneration, inputCompleted: false, observation: execution,
      continuationRefusedBeforeAdmission: generationContinuationRefused }) === 'waiting_for_review') {
      const row = await enterReview({ key, lifecycle: 'waiting_for_review', reason: execution.code,
        ...(execution.kind === 'failed' && execution.message !== undefined ? { reasonMessage: execution.message } : {}),
        ...(execution.usage ? { usage: execution.usage } : {}) }, context, () => {
        nativeTerminalCommitted = true;
        releaseAdmission();
      });
      await awaitReviewedInvocation(row, context);
      return await executeStepBlock(step, scope, frame, context, parentKey, memberOrdinal, supplementalInputValues);
    }
    const authorizationRevoked = context.signal?.aborted
      && context.signal.reason === WORKFLOW_AUTHORIZATION_NOT_CURRENT_ABORT_REASON;
    const failStopClosure = classifyWorkflowAbort(context.signal) === 'fail_stop';
    if (isOriginInput && execution.kind === 'cancelled' && execution.code === 'workflow_origin_input_withdrawn') {
      const control = await context.deps.store.readControl(context.runId);
      if (control === 'pause_requested' && !context.signal?.aborted) {
        await context.deps.store.commitFact({ key, lifecycle: 'pending' });
        throw new WorkflowControlBoundary('paused');
      }
    }
    const unresolvedOrigin = isOriginInput && execution.kind === 'needs_attention'
      ? await context.deps.store.read(key) : undefined;
    if (isOriginInput && execution.kind === 'needs_attention'
      && (unresolvedOrigin?.lifecycle === 'admitting' || unresolvedOrigin?.lifecycle === 'cancel_requested'
        || execution.code === 'workflow_origin_input_withdrawal_unavailable' || execution.code === 'workflow_origin_input_stop_pending')) {
      const current = unresolvedOrigin;
      const control = await context.deps.store.readControl(context.runId);
      await context.deps.store.commitFact({ key,
        lifecycle: current?.lifecycle === 'cancel_requested' || control === 'cancel_requested' || context.signal?.aborted
          ? 'cancel_requested' : current?.lifecycle ?? 'admitting', reason: execution.code });
      throw new WorkflowLeafFailure('interrupted', execution.code);
    }
    const state = execution.kind === 'failed' || execution.kind === 'needs_attention'
      || (execution.kind === 'outcome_uncertain' && durableExecution !== undefined)
      ? 'interrupted'
      : execution.kind;
    const reason = failStopClosure
      ? failStopCausalReason(context.signal)
      : authorizationRevoked && execution.kind === 'cancelled'
      ? WORKFLOW_AUTHORIZATION_NOT_CURRENT_ABORT_REASON
      : execution.code;
    await context.deps.store.commitFact({
      key,
      lifecycle: failStopClosure ? 'cancelled' : execution.kind,
      reason,
      ...(execution.kind === 'failed' && execution.message !== undefined
        ? { reasonMessage: execution.message } : {}),
      ...(execution.usage ? { usage: execution.usage } : {}),
    });
    nativeTerminalCommitted = execution.kind === 'failed' || execution.kind === 'cancelled';
    if (authorizationRevoked && execution.kind === 'cancelled') {
      throw new WorkflowLeafFailure(
        'interrupted',
        WORKFLOW_AUTHORIZATION_NOT_CURRENT_ABORT_REASON,
      );
    }
    if (context.signal?.aborted && context.signal.reason instanceof WorkflowLeafFailure) {
      throw context.signal.reason;
    }
    throw new WorkflowLeafFailure(
      state,
      execution.code ?? execution.kind,
      execution.kind === 'failed',
    );
  } catch (error) {
    if (error instanceof WorkflowGenerationRefusal && !rejoining && !durableExecution
      && classifyWorkflowReviewEntryV1({ mayEnterReview: !context.signal?.aborted,
        pauseForReview: step.pauseForReview === true, isGeneration: isReviewGeneration, inputCompleted: false,
        observation: { kind: 'failed', code: error.code }, continuationRefusedBeforeAdmission: true }) === 'waiting_for_review') {
      const row = await enterReview({ key, lifecycle: 'waiting_for_review', reason: error.code,
        reasonMessage: `Couldn't generate: ${error.code}` }, context, () => {
        nativeTerminalCommitted = true;
        releaseAdmission();
      });
      await awaitReviewedInvocation(row, context);
      return await executeStepBlock(step, scope, frame, context, parentKey, memberOrdinal, supplementalInputValues);
    }
    if (executionTarget.kind === 'detached_run' && !nativeTerminalCommitted) {
      admissionFailure = { error };
    }
    throw error;
  } finally {
    // A shared detached conversation has no native prompt queue. Keep its
    // coordinator frontier closed until the exact row-local result or terminal
    // fact is durable, not merely until provider acceptance.
    // Unresolved native effects close this key for the remainder of this
    // coordinator run. Wake waiters with the same interruption, not permission
    // to dispatch onto an execution whose exact terminal fact is unavailable.
    releaseAdmission(admissionFailure);
  }
}

function validateStepResult(
  step: WorkflowStep,
  result: WorkflowJsonValue | undefined,
  encoding: 'raw_text' | 'typed',
): WorkflowJsonValue {
  const observation = encoding === 'typed'
    ? { encoding, value: result ?? null }
    : typeof result === 'string'
      ? { encoding, value: result }
      : null;
  if (!observation) throw new WorkflowLeafFailure('interrupted', 'invalid_result_contract', true);
  const decoded = decodeExecutionRunResultObservation(observation, step.result);
  if (!decoded.ok) {
    throw new WorkflowLeafFailure('interrupted', 'invalid_result_contract', true, decoded.reason);
  }
  return decoded.value;
}

async function executeLoop(
  block: Extract<WorkflowBlock, { kind: 'loop' }>,
  scope: WorkflowInvocationPath['scope'],
  frame: Frame,
  context: ExecutionContext,
  parentKey?: string,
  memberOrdinal = '0',
): Promise<void> {
  const repetition = block.repetition;
  const initialLoopKey = workflowInvocationKey({ runId: context.runId, blockId: block.id, scope, attempt: 0 });
  const existingLoop = await context.deps.store.readCurrent({
    runId: context.runId,
    blockId: block.id,
    scope,
    memberOrdinal,
    ...(parentKey ? { parentKey } : {}),
  });
  const loopKey = existingLoop?.key ?? initialLoopKey;
  const persistedLoop = existingLoop?.container?.kind === 'loop'
    ? existingLoop.container
    : undefined;
  let loopProgress: Extract<WorkflowContainerProgressV1, { kind: 'loop' }>;
  let count: number;
  let items: readonly WorkflowJsonValue[] | undefined;
  if (repetition.kind === 'count') {
    if (persistedLoop && persistedLoop.mode !== 'count') {
      throw new WorkflowInputResolutionError('invalid_reference_scope');
    }
    const source = persistedLoop?.mode === 'count'
      ? persistedLoop.source
      : await resolveLoopSourceSelection(repetition.count, frame, context);
    const resolved = await resolveSelectedLoopSource(source, frame, context);
    if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 0) {
      throw new WorkflowInputResolutionError('invalid_reference_scope');
    }
    count = resolved;
    if (persistedLoop?.mode === 'count' && Number(persistedLoop.count) !== count) {
      throw new WorkflowInputResolutionError('invalid_reference_scope');
    }
    loopProgress = persistedLoop ?? {
      kind: 'loop', mode: 'count', source, count: String(count),
      nextMemberIndex: '0', nextBodyBlockOrdinal: '0',
    };
  } else if (repetition.kind === 'items') {
    if (persistedLoop && persistedLoop.mode !== 'items') {
      throw new WorkflowInputResolutionError('invalid_reference_scope');
    }
    const source = persistedLoop?.mode === 'items'
      ? persistedLoop.source
      : await resolveLoopSourceSelection(repetition.items, frame, context);
    const resolved = await resolveSelectedLoopSource(source, frame, context);
    if (!Array.isArray(resolved)) throw new WorkflowInputResolutionError('invalid_reference_scope');
    items = resolved;
    count = items.length;
    if (persistedLoop?.mode === 'items' && Number(persistedLoop.itemCount) !== count) {
      throw new WorkflowInputResolutionError('invalid_reference_scope');
    }
    loopProgress = persistedLoop ?? {
      kind: 'loop', mode: 'items', source, itemCount: String(count),
      nextMemberIndex: '0', nextBodyBlockOrdinal: '0',
    };
  } else {
    if (persistedLoop && persistedLoop.mode !== repetition.kind) {
      throw new WorkflowInputResolutionError('invalid_reference_scope');
    }
    if (typeof repetition.maxIterations !== 'number') throw new WorkflowInputResolutionError('invalid_input');
    count = repetition.maxIterations;
    loopProgress = persistedLoop ?? {
      kind: 'loop', mode: repetition.kind,
      nextMemberIndex: '0', nextBodyBlockOrdinal: '0',
    };
  }

  const persistedMemberIndex = Number(loopProgress.nextMemberIndex);
  const persistedBodyOrdinal = Number(loopProgress.nextBodyBlockOrdinal);
  const iterationWidth = block.body.length + (repetition.kind === 'evaluate' ? 1 : 0);
  if (!Number.isSafeInteger(persistedMemberIndex) || persistedMemberIndex < 0 || persistedMemberIndex > count
    || !Number.isSafeInteger(persistedBodyOrdinal) || persistedBodyOrdinal < 0
    || persistedBodyOrdinal > iterationWidth) {
    throw new WorkflowInputResolutionError('invalid_reference_scope');
  }

  await ensureAndCommitContainer(block, scope, context, parentKey, memberOrdinal, async (activeLoopKey) => {
    const loopRecord = await context.deps.store.read(activeLoopKey);
    if (!loopRecord) throw new WorkflowRuntimeInterruption();
    const failStopReason = `container_fail_stop:${loopRecord.recordId}`;
    const commitLoopProgress = async (
      nextMemberIndex: number,
      nextBodyBlockOrdinal: number,
      outcome?: WorkflowLoopOutcomeV1,
    ): Promise<void> => {
      loopProgress = {
        ...loopProgress,
        nextMemberIndex: String(nextMemberIndex),
        nextBodyBlockOrdinal: String(nextBodyBlockOrdinal),
        ...(outcome ? { closing: { code: 'loop_completed', outcome } } : {}),
      };
      await context.deps.store.commitFact({ key: loopKey, lifecycle: 'running', container: loopProgress });
    };
    if (repetition.kind === 'items') {
      const selectedItems = items!;
      const failStop = new AbortController();
      const itemContext = repetition.failurePolicy === 'fail_stop'
        ? withAbortSignal(context, failStop.signal)
        : context;
      const parentKey = activeLoopKey;
      const pipelines = selectedItems.map((value, index) => ({
        value,
        index,
        memberOrdinal: String(index),
        scope: [...scope, { kind: 'iteration' as const, blockId: block.id, index }],
      }));
      const scheduledPipelines = await orderPipelinesForRecovery(pipelines, context, activeLoopKey, frame, repetition.failurePolicy === 'collect_outcomes');
      const advanceMemberFrontier = createMemberFrontier(Number(loopProgress.nextMemberIndex), async (next) => await commitLoopProgress(next, 0));
      const runItem = async ({ value, index, scope: itemScope }: typeof pipelines[number]) => {
        if (failStop.signal.aborted) {
          await closeWaitingAfterFailStop({ owner: block, scope: itemScope, context: itemContext, parentKey, memberOrdinal: String(index), reason: failStopReason });
          throw failStop.signal.reason;
        }
        const item = { value, index, position: index + 1, count: selectedItems.length };
        const iteration = {
          index,
          position: index + 1,
          count: selectedItems.length,
          stopReason: null,
        };
        const itemFrame = childFrame(frame, { item, iteration });
        itemFrame.loop = { blockId: block.id, kind: 'items', execution: repetition.execution, ownerKey: activeLoopKey, index };
        try {
          await executeBodyFrame({
            owner: block,
            source: { kind: 'item', index: String(index) },
            blocks: block.body,
            scope: itemScope,
            frame: itemFrame,
            context: itemContext,
            parentKey: loopKey,
            memberOrdinal: String(index),
            onFrameStarted: async () => await advanceMemberFrontier(index + 1),
          });
          if (itemFrame.collectedFailures) frame.collectedFailures = true;
        } catch (error) {
          if (!(error instanceof WorkflowLeafFailure && error.collectable)) context.admissionGate.closeUnclaimedReservations(error);
          if (error instanceof WorkflowControlBoundary || error instanceof WorkflowRuntimeInterruption) throw error;
          if (repetition.failurePolicy === 'fail_stop'
            || !(error instanceof WorkflowLeafFailure && error.collectable)) {
            if (!failStop.signal.aborted) failStop.abort(new WorkflowFailStopClosure(failStopReason, error));
            throw error;
          }
          frame.collectedFailures = true;
        }
      };
      if (repetition.execution === 'parallel') {
        const runWorker = async (nextPipeline: () => Promise<typeof pipelines[number] | undefined>): Promise<void> => {
          for (let pipeline = await nextPipeline(); pipeline; pipeline = await nextPipeline()) {
            assertWorkflowAbortSignal(itemContext);
            await runItem(pipeline);
          }
        };
        let nextPipelineIndex = 0;
        const workerCount = repetition.maxConcurrent === undefined
          ? scheduledPipelines.length
          : Math.min(repetition.maxConcurrent, scheduledPipelines.length);
        let scheduling = Promise.resolve();
        const nextPipeline = async () => {
          const index = nextPipelineIndex++;
          const pipeline = scheduledPipelines[index];
          const waiting = scheduledPipelines[nextPipelineIndex];
          // Item input is lazy: only the immediately reached unstarted member
          // is durable while every authored worker slot is occupied.
          const persist = scheduling.then(async () => {
            if (pipeline && waiting && repetition.maxConcurrent !== undefined && index + 1 >= workerCount) {
              assertWorkflowAbortSignal(itemContext);
              await persistWaitingForCapacity({ owner: block, source: { kind: 'item', index: String(waiting.index) },
                scope: waiting.scope, context: itemContext, parentKey, memberOrdinal: waiting.memberOrdinal });
            }
          });
          scheduling = persist.catch(() => undefined);
          await persist;
          return pipeline;
        };
        const itemSettlements = await Promise.allSettled(
          Array.from({ length: workerCount }, () => runWorker(nextPipeline)),
        );
        const rejectedItem = itemSettlements.find(
          (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
        );
        if (rejectedItem) {
          throw failStop.signal.reason instanceof WorkflowFailStopClosure
            ? failStop.signal.reason.original
            : failStop.signal.reason ?? rejectedItem.reason;
        }
      }
      else for (const pipeline of scheduledPipelines) await runItem(pipeline);
      return;
    }
    if (loopProgress.closing) return;
    const evaluatorOutcomes: WorkflowJsonValue[] = [];

    for (let index = persistedMemberIndex; index < count; index += 1) {
      const iteration = { index, position: index + 1, count, stopReason: null };
      const iterationFrame = childFrame(frame, { iteration });
      iterationFrame.loop = { blockId: block.id, kind: repetition.kind, ownerKey: activeLoopKey, index };
      iterationFrame.blocks = repetition.kind === 'evaluate' ? [...block.body, repetition.evaluator] : block.body;
      if (repetition.kind === 'evaluate' && repetition.history !== 'none' && evaluatorOutcomes.length === 0 && index > 0) {
        const first = repetition.history === 'latest' ? index - 1 : 0;
        for (let prior = first; prior < index; prior++) {
          const historical = await readWorkflowLoopBodyFrame({ runId: context.runId, store: context.deps.store, frame: iterationFrame, index: prior });
          const evaluator = historical ? await resolveWorkflowProducerInFrame({ runId: context.runId, store: context.deps.store,
            frame: historical, blockId: repetition.evaluator.id }) : undefined;
          evaluatorOutcomes.push(await readInvocationResult(evaluator, context.deps.store, iterationFrame, context.deps.sessionContext));
        }
      }
      const iterationScope = [...scope, { kind: 'iteration' as const, blockId: block.id, index }];
      const selectedEvaluatorHistory = repetition.kind !== 'evaluate' || repetition.history === 'none'
        ? []
        : repetition.history === 'latest'
          ? evaluatorOutcomes.slice(-1)
          : [...evaluatorOutcomes];
      await executeBodyFrame({
        owner: block,
        source: { kind: 'iteration', index: String(index) },
            blocks: block.body,
        scope: iterationScope,
        frame: iterationFrame,
        context,
        parentKey: loopKey,
        memberOrdinal: String(index),
        afterBlocks: repetition.kind === 'evaluate'
          ? async (iterationFrameKey) => {
              if (repetition.evaluator.kind === 'action') {
                await executeActionBlock(repetition.evaluator, iterationScope, iterationFrame, context,
                  iterationFrameKey, String(block.body.length));
                return;
              }
              await executeStepBlock(
                repetition.evaluator,
                iterationScope,
                iterationFrame,
                context,
                iterationFrameKey,
                String(block.body.length),
                selectedEvaluatorHistory.length === 0
                  ? []
                  : [{ kind: 'evaluation_history', evaluations: selectedEvaluatorHistory }],
              );
            }
          : undefined,
      });
      if (iterationFrame.collectedFailures) frame.collectedFailures = true;
      let evaluationDecision: WorkflowJsonValue | undefined;
      if (repetition.kind === 'evaluate') {
        evaluationDecision = await readInvocationResult(await resolveWorkflowProducerInFrame({ runId: context.runId,
          store: context.deps.store, frame: iterationFrame, blockId: repetition.evaluator.id }), context.deps.store, iterationFrame, context.deps.sessionContext);
        evaluatorOutcomes.push(evaluationDecision);
      }
      if (repetition.kind === 'until') {
        const stop = await evaluateWorkflowStopCondition(
          repetition.stopWhen,
          createResolutionRuntime(context.inputs, iterationFrame, context.deps.store, context.deps.sessionContext),
        );
        await commitLoopProgress(index + 1, 0, stop.matched
          ? { kind: 'stop_condition', ...(stop.arm === undefined ? {} : { arm: stop.arm }) }
          : index === count - 1 ? { kind: 'exhausted', rounds: count } : undefined);
        if (stop.matched) break;
      }
      if (repetition.kind === 'evaluate') {
        const decision = evaluationDecision;
        if (decision === undefined) throw new WorkflowLeafFailure('failed', 'invalid_result_contract');
        const normalized = isWorkflowJsonObject(decision)
          ? decision.decision
          : decision;
        if (typeof normalized !== 'string') throw new WorkflowLeafFailure('failed', 'invalid_result_contract');
        // Declared membership is enforced by the shared result codec, not here.
        await commitLoopProgress(index + 1, 0, normalized !== 'continue'
          ? { kind: 'decision', value: normalized,
            ...(isWorkflowJsonObject(decision) && typeof decision.reason === 'string' ? { reason: decision.reason } : {}) }
          : index === count - 1 ? { kind: 'exhausted', rounds: count } : undefined);
        if (normalized !== 'continue') break;
      }
      if (repetition.kind === 'count') {
        await commitLoopProgress(index + 1, 0);
      }
    }
  }, loopProgress);
}
