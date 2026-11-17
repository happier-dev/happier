import { MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES } from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { sameStrictJsonValue, StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { readWorkflowValuePathV1 } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import type { WorkflowTriggerEventValueV1 } from '@happier-dev/protocol/workflows/workflowTriggerEventReferenceV1';
import { WorkflowSessionContextV1Schema } from '@happier-dev/protocol/workflows/workflowSessionContextV1';
import type { WorkflowSessionContextV1, WorkflowAuthoredInputV1, WorkflowAuthoredProducerRef, WorkflowCondition, WorkflowDefinitionV1, WorkflowStepComposerDocument, WorkflowValueReference } from '@happier-dev/protocol/workflows';
import type { AutomationRunCause } from '@happier-dev/protocol/automations/run-cause';
import { AutomationConversationOccurrenceEvidenceV1Schema } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { readWorkflowStepInputIndexV1 } from '@happier-dev/protocol/workflows/workflowComposerDocumentV1';
import type { DiscussionPromptAuthorV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { WorkflowActionFieldBindingV1, WorkflowActionValueReferenceV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import { listWorkflowActionTextInputIndexesV1, renderWorkflowActionTextV1, type WorkflowActionTextEncodingV1 } from '@happier-dev/protocol/workflows/workflowActionTextV1';
import { compactWorkflowPromptContext, projectWorkflowPromptContext, renderWorkflowPromptContext } from './workflowPromptContext';
import { isWorkflowJsonObject, type WorkflowJsonValue } from './workflowValues';

export { isWorkflowJsonObject } from './workflowValues';
export type { WorkflowJsonValue } from './workflowValues';

export type WorkflowInputResolutionErrorCode =
  | 'missing_reference'
  | 'invalid_reference_scope'
  | 'invalid_condition'
  | 'invalid_input'
  | 'missing_required_input'
  | 'workflow_session_context_unavailable'
  | 'workflow_discussion_context_unavailable'
  | 'workflow_input_too_large';

export class WorkflowInputResolutionError extends Error {
  readonly code: WorkflowInputResolutionErrorCode;

  constructor(code: WorkflowInputResolutionErrorCode) {
    super(code);
    this.name = 'WorkflowInputResolutionError';
    this.code = code;
  }
}

/**
 * Projects one immutable Automation occurrence into the named-input seed.
 *
 * Schedule/session/Run-lifecycle/Action evidence already belongs to the bounded Run
 * cause. Plugin and Conversation payloads remain opaque to the server and are
 * opened only by the assigned daemon. This adapter deliberately does not
 * merge the two sources or infer fields from current trigger state.
 */
export function resolveAutomationWorkflowOccurrenceSeed(params: Readonly<{
  cause: AutomationRunCause;
  openedEvidence: unknown | null;
  diffFingerprint?: string;
}>): Readonly<Record<string, WorkflowJsonValue>> {
  const fingerprintEvidence: Readonly<Record<string, WorkflowJsonValue>> = params.diffFingerprint === undefined ? {} : { diffFingerprint: params.diffFingerprint };
  if (params.cause.kind === 'manual') {
    if (params.openedEvidence !== null) throw new WorkflowInputResolutionError('invalid_input');
    return fingerprintEvidence;
  }
  if (params.cause.kind === 'trigger' && params.cause.triggerKind === 'schedule') {
    if (params.openedEvidence !== null) throw new WorkflowInputResolutionError('invalid_input');
    return { scheduledFor: params.cause.evidence.scheduledFor, triggerId: params.cause.triggerId,
      ...fingerprintEvidence, occurrenceKey: params.cause.occurrenceKey };
  }
  if (params.cause.kind === 'trigger'
    && (params.cause.triggerKind === 'sessionLifecycle' || params.cause.triggerKind === 'runLifecycle'
      || params.cause.triggerKind === 'action')) {
    if (params.openedEvidence !== null) throw new WorkflowInputResolutionError('invalid_input');
    return { ...params.cause.evidence, triggerId: params.cause.triggerId, ...fingerprintEvidence, occurrenceKey: params.cause.occurrenceKey };
  }
  if (!isWorkflowJsonObject(params.openedEvidence)) {
    throw new WorkflowInputResolutionError('invalid_input');
  }
  let evidence = params.openedEvidence;
  if (params.cause.kind === 'conversation' && evidence.kind === 'conversation') {
    const occurrence = AutomationConversationOccurrenceEvidenceV1Schema.safeParse(evidence);
    if (!occurrence.success || !isWorkflowJsonObject(occurrence.data.input)) throw new WorkflowInputResolutionError('invalid_input');
    evidence = occurrence.data.input;
  }
  if (!isWorkflowJsonObject(evidence)) throw new WorkflowInputResolutionError('invalid_input');
  return params.cause.kind === 'trigger' || params.cause.triggerId !== undefined
    ? { ...evidence, triggerId: params.cause.triggerId!, ...fingerprintEvidence, occurrenceKey: params.cause.occurrenceKey }
    : { ...evidence, ...fingerprintEvidence, occurrenceKey: params.cause.occurrenceKey };
}

function matchesDeclaredInputType(value: WorkflowJsonValue, valueType: WorkflowDefinitionV1['inputs'][number]['valueType']): boolean {
  return valueType === 'json' || typeof value === valueType;
}

/**
 * Binds immutable Automation occurrence evidence to declared workflow inputs
 * by exact name. Undeclared evidence (for example schedule {scheduledFor}
 * for a zero-input workflow) is ignored: the immutable cause retains the full
 * evidence, but only declared exact-name inputs are selected and type-checked.
 * It never rewrites Composer text or guesses fields from an
 * event kind. The Automation adapter is responsible for supplying the
 * occurrence evidence object it admitted.
 */
export function bindAutomationWorkflowInputs(params: Readonly<{
  definition: Pick<WorkflowDefinitionV1, 'inputs'>;
  evidence: Readonly<Record<string, WorkflowJsonValue>>;
  constants?: Readonly<Record<string, WorkflowJsonValue>>;
}>): Readonly<Record<string, WorkflowJsonValue>> {
  const bound: Record<string, WorkflowJsonValue> = {};
  for (const input of params.definition.inputs) {
    const hasSuppliedValue = Object.prototype.hasOwnProperty.call(params.evidence, input.name);
    const hasConstant = params.constants !== undefined && Object.prototype.hasOwnProperty.call(params.constants, input.name);
    const value = hasSuppliedValue ? params.evidence[input.name]
      : hasConstant ? params.constants![input.name] : input.default;
    if (value === undefined) {
      if (input.required && input.defaultFrom !== 'origin_session') throw new WorkflowInputResolutionError('missing_required_input');
      continue;
    }
    if (!matchesDeclaredInputType(value, input.valueType)
      || (input.enum !== undefined && (typeof value !== 'string' || !input.enum.includes(value)))) {
      throw new WorkflowInputResolutionError('invalid_input');
    }
    bound[input.name] = value;
  }
  return bound;
}

export type WorkflowValueResolutionRuntime = Readonly<{
  inputs: Readonly<Record<string, WorkflowJsonValue>>;
  triggerEventValues?: readonly WorkflowTriggerEventValueV1[];
  item?: Readonly<{ value: WorkflowJsonValue; index: number; position: number; count: number }>;
  iteration?: Readonly<{
    index: number;
    position: number;
    count: number;
    stopReason: WorkflowJsonValue | null;
  }>;
  resolveResult: (
    producer: WorkflowAuthoredProducerRef,
  ) => Promise<WorkflowJsonValue>;
  resolveResultPath?: (
    producer: WorkflowAuthoredProducerRef,
    path: readonly (string | number)[],
  ) => Promise<WorkflowJsonValue>;
  resolveResultSource?: (producer: WorkflowAuthoredProducerRef) => Promise<Readonly<{
    author: DiscussionPromptAuthorV1; source: WorkflowJsonValue;
    entries?: readonly Readonly<{ author: DiscussionPromptAuthorV1; source: WorkflowJsonValue; value: WorkflowJsonValue }>[];
  }>>;
  resolveWorkspace: (
    producer: WorkflowAuthoredProducerRef,
  ) => Promise<Readonly<{ directory: string; checkoutRootPath: string }>>;
  resolveLoopTrailingCount?: (
    reference: Extract<WorkflowValueReference, { kind: 'loop_trailing_count' }>,
  ) => Promise<number>;
  resolveSessionContext?: (recentTurns: number) => Promise<WorkflowSessionContextV1>;
  resolveSessionContextField?: (field: 'usage.tokensUsed' | 'goal.tokenBudget') => Promise<number>;
  /** Captures only demanded sources for one condition; the next evaluation starts fresh. */
  createSessionContextFieldResolver?: () => NonNullable<WorkflowValueResolutionRuntime['resolveSessionContextField']>;
  /** C3 supplies authorized content and its frontier; Workflow never reads history itself. */
  resolveDiscussionContext?: (scope: Extract<WorkflowValueReference, { kind: 'discussion_context' }>['scope']) => Promise<WorkflowJsonValue>;
}>;

/** One input preparation fixes each requested Discussion frontier, even with repeated references. */
export function captureWorkflowDiscussionContext(runtime: WorkflowValueResolutionRuntime): WorkflowValueResolutionRuntime {
  if (!runtime.resolveDiscussionContext) return runtime;
  const read = runtime.resolveDiscussionContext;
  const captured = new Map<Parameters<typeof read>[0], ReturnType<typeof read>>();
  return { ...runtime, resolveDiscussionContext: scope => {
    let value = captured.get(scope);
    if (!value) { value = read(scope); captured.set(scope, value); }
    return value;
  } };
}

export function selectWorkflowResultPath(
  value: WorkflowJsonValue,
  path: readonly (string | number)[],
  missingCode: 'invalid_reference_scope' | 'missing_reference' = 'invalid_reference_scope',
): WorkflowJsonValue {
  const selected = readWorkflowValuePathV1(value, path);
  if (selected === undefined) throw new WorkflowInputResolutionError(missingCode);
  return selected;
}

/**
 * Resolve each authored field through the value owner, preserving its object or list shape.
 * Text with values inside resolves only the values it uses, encoded as the frozen field type
 * declares (`readWorkflowActionFieldTextEncodingV1`); without that decision it fails closed.
 */
export async function resolveWorkflowActionFieldBinding(
  binding: WorkflowActionFieldBindingV1,
  runtime: WorkflowValueResolutionRuntime,
  originSessionId?: string,
  textEncoding?: WorkflowActionTextEncodingV1,
): Promise<WorkflowJsonValue> {
  const resolve = async (reference: WorkflowActionValueReferenceV1): Promise<WorkflowJsonValue> =>
    reference.kind === 'origin_session_id' ? originSessionId ?? null : await resolveWorkflowValueReference(reference, runtime);
  if (binding.kind === 'text') {
    if (textEncoding === undefined) throw new WorkflowInputResolutionError('invalid_input');
    const values = new Map<number, WorkflowJsonValue | undefined>();
    for (const index of listWorkflowActionTextInputIndexesV1(binding.document)) {
      const reference = binding.input[index];
      if (reference === undefined) throw new WorkflowInputResolutionError('missing_reference');
      try {
        values.set(index, await resolve(reference));
      } catch (error) {
        if (reference.kind !== 'trigger_event' || !(error instanceof WorkflowInputResolutionError) || error.code !== 'missing_reference') throw error;
      }
    }
    const rendered = renderWorkflowActionTextV1(binding.document, textEncoding, index => values.get(index));
    if (!rendered.ok) throw new WorkflowInputResolutionError('invalid_input');
    return rendered.value;
  }
  if (binding.kind === 'list') return await Promise.all(binding.items.map(resolve));
  if (binding.kind === 'object') return Object.fromEntries(await Promise.all(Object.entries(binding.fields)
    .map(async ([field, reference]) => [field, await resolve(reference)] as const)));
  return await resolve(binding);
}

export async function resolveWorkflowValueReference(
  reference: WorkflowValueReference,
  runtime: WorkflowValueResolutionRuntime,
): Promise<WorkflowJsonValue> {
  switch (reference.kind) {
    case 'literal':
      return reference.value;
    case 'discussion_context': {
      if (!runtime.resolveDiscussionContext) throw new WorkflowInputResolutionError('invalid_reference_scope');
      return await runtime.resolveDiscussionContext(reference.scope);
    }
    case 'session_context': {
      if (!runtime.resolveSessionContext) throw new WorkflowInputResolutionError('invalid_reference_scope');
      return WorkflowSessionContextV1Schema.parse(await runtime.resolveSessionContext(reference.recentTurns));
    }
    case 'session_context_field': {
      if (!runtime.resolveSessionContextField) throw new WorkflowInputResolutionError('invalid_reference_scope');
      return await runtime.resolveSessionContextField(reference.field);
    }
    case 'input': {
      if (!Object.prototype.hasOwnProperty.call(runtime.inputs, reference.name)) {
        throw new WorkflowInputResolutionError('missing_reference');
      }
      return selectWorkflowResultPath(runtime.inputs[reference.name]!, reference.path ?? [], 'missing_reference');
    }
    case 'trigger_event': {
      const sealed = runtime.triggerEventValues?.find(value => sameStrictJsonValue(value.event, reference.event)
        && sameStrictJsonValue(value.path, reference.path));
      if (!sealed) throw new WorkflowInputResolutionError('missing_reference');
      return sealed.value;
    }
    case 'result': {
      if (runtime.resolveResultPath) return await runtime.resolveResultPath(reference.producer, reference.path);
      const result = await runtime.resolveResult(reference.producer);
      return selectWorkflowResultPath(result, reference.path);
    }
    case 'workspace': {
      const workspace = await runtime.resolveWorkspace(reference.producer);
      return workspace[reference.field];
    }
    case 'loop_trailing_count': {
      if (!runtime.resolveLoopTrailingCount) throw new WorkflowInputResolutionError('invalid_reference_scope');
      return await runtime.resolveLoopTrailingCount(reference);
    }
    case 'item': {
      if (!runtime.item) throw new WorkflowInputResolutionError('invalid_reference_scope');
      return selectWorkflowResultPath(runtime.item[reference.field], reference.path ?? [], 'missing_reference');
    }
    case 'iteration': {
      if (!runtime.iteration) throw new WorkflowInputResolutionError('invalid_reference_scope');
      return runtime.iteration[reference.field];
    }
  }
}

async function referenceExists(
  reference: WorkflowValueReference,
  runtime: WorkflowValueResolutionRuntime,
): Promise<boolean> {
  try {
    // Result scope is required; its optional leaf may legitimately be absent.
    if (reference.kind === 'result') {
      const result = await runtime.resolveResult(reference.producer);
      return readWorkflowValuePathV1(result, reference.path) !== undefined;
    }
    await resolveWorkflowValueReference(reference, runtime);
    return true;
  } catch (error) {
    if (error instanceof WorkflowInputResolutionError && error.code === 'missing_reference') return false;
    if (error instanceof WorkflowInputResolutionError && (error.code === 'workflow_session_context_unavailable'
      || error.code === 'workflow_discussion_context_unavailable')) throw error;
    if (error instanceof WorkflowInputResolutionError) {
      throw new WorkflowInputResolutionError('invalid_condition');
    }
    throw error;
  }
}

async function resolveConditionValue(
  reference: WorkflowValueReference,
  runtime: WorkflowValueResolutionRuntime,
): Promise<WorkflowJsonValue | undefined> {
  try {
    return await resolveWorkflowValueReference(reference, runtime);
  } catch (error) {
    if ((reference.kind === 'session_context_field' || reference.kind === 'trigger_event')
      && error instanceof WorkflowInputResolutionError && error.code === 'missing_reference') return undefined;
    if (error instanceof WorkflowInputResolutionError && (error.code === 'workflow_session_context_unavailable'
      || error.code === 'workflow_discussion_context_unavailable')) throw error;
    if (error instanceof WorkflowInputResolutionError) {
      throw new WorkflowInputResolutionError('invalid_condition');
    }
    throw error;
  }
}

export async function evaluateWorkflowCondition(
  condition: WorkflowCondition,
  runtime: WorkflowValueResolutionRuntime,
): Promise<boolean> {
  return evaluateCapturedWorkflowCondition(condition, captureWorkflowConditionRuntime(runtime));
}

function captureWorkflowConditionRuntime(runtime: WorkflowValueResolutionRuntime): WorkflowValueResolutionRuntime {
  return runtime.createSessionContextFieldResolver
    ? { ...runtime, resolveSessionContextField: runtime.createSessionContextFieldResolver() }
    : runtime;
}

async function evaluateCapturedWorkflowCondition(
  condition: WorkflowCondition,
  runtime: WorkflowValueResolutionRuntime,
): Promise<boolean> {
  // Definitions have no nesting limit. Keep traversal off the JavaScript call
  // stack while retaining authored order and all/any short-circuiting.
  const pending: (
    | Readonly<{ kind: 'not' }>
    | Readonly<{ kind: 'all' | 'any'; conditions: readonly WorkflowCondition[]; next: number }>
  )[] = [];
  let current = condition;
  let result: boolean;
  for (;;) {
    switch (current.kind) {
      case 'not':
        pending.push({ kind: 'not' });
        current = current.condition;
        continue;
      case 'all':
      case 'any':
        if (current.conditions.length > 0) {
          pending.push({ kind: current.kind, conditions: current.conditions, next: 1 });
          current = current.conditions[0]!;
          continue;
        }
        result = current.kind === 'all';
        break;
      default:
        result = await evaluateWorkflowConditionLeaf(current, runtime);
    }
    for (;;) {
      const parent = pending.pop();
      if (!parent) return result;
      if (parent.kind === 'not') {
        result = !result;
      } else if (result === (parent.kind === 'all') && parent.next < parent.conditions.length) {
        pending.push({ ...parent, next: parent.next + 1 });
        current = parent.conditions[parent.next]!;
        break;
      }
    }
  }
}

async function evaluateWorkflowConditionLeaf(
  condition: Exclude<WorkflowCondition, { kind: 'all' | 'any' | 'not' }>,
  runtime: WorkflowValueResolutionRuntime,
): Promise<boolean> {
  switch (condition.kind) {
    case 'exists':
      return await referenceExists(condition.value, runtime);
    case 'compare': {
      const left = await resolveConditionValue(condition.left, runtime);
      const right = await resolveConditionValue(condition.right, runtime);
      if (left === undefined || right === undefined) return false;
      if (condition.operator === 'eq') return sameStrictJsonValue(left, right);
      if (condition.operator === 'neq') return !sameStrictJsonValue(left, right);
      // Ordering compares homogeneous operands only: two numbers numerically,
      // two strings by ordinary JavaScript lexical (UTF-16 code unit) order —
      // no locale transform, no coercion. This matches the Protocol
      // validator's admission contract for lt/lte/gt/gte.
      if ((typeof left === 'number' && typeof right === 'number')
        || (typeof left === 'string' && typeof right === 'string')) {
        switch (condition.operator) {
          case 'lt': return left < right;
          case 'lte': return left <= right;
          case 'gt': return left > right;
          case 'gte': return left >= right;
        }
      }
      throw new WorkflowInputResolutionError('invalid_condition');
    }
  }
}

/** Uses ordinary short-circuit semantics and retains only the top-level winning arm. */
export async function evaluateWorkflowStopCondition(
  condition: WorkflowCondition,
  runtime: WorkflowValueResolutionRuntime,
): Promise<Readonly<{ matched: boolean; arm?: number }>> {
  const captured = captureWorkflowConditionRuntime(runtime);
  if (condition.kind !== 'any') return { matched: await evaluateCapturedWorkflowCondition(condition, captured) };
  for (const [arm, child] of condition.conditions.entries()) {
    if (await evaluateCapturedWorkflowCondition(child, captured)) return { matched: true, arm };
  }
  return { matched: false };
}

export type MaterializedWorkflowStepInput = Readonly<{
  text: string;
  /** Full leaf-rendered prompt frozen at its original admission. */
  renderedText?: string;
  displayText?: string;
  references: WorkflowStepComposerDocument['references'];
  attachments: WorkflowStepComposerDocument['attachments'];
  values: readonly WorkflowJsonValue[];
  discussionReplyTo?: import('@happier-dev/protocol/workflows/workflowDestinationsV1').WorkflowDiscussionOriginV1;
}>;

export async function materializeWorkflowStepInput(params: Readonly<{
  document: WorkflowStepComposerDocument;
  references: readonly WorkflowValueReference[];
  retainedInput?: WorkflowAuthoredInputV1;
  runtime: WorkflowValueResolutionRuntime;
  reviewContext?: Readonly<{ runId: string; invocationRecordId: string; contentRevision: string }>;
  /** Immutable Automation origin, carried only for prompt presentation. */
  automationCause?: AutomationRunCause;
}>): Promise<MaterializedWorkflowStepInput> {
  const retained = params.retainedInput;
  if (retained?.renderedText !== undefined) {
    return {
      text: retained.renderedText, renderedText: retained.renderedText,
      displayText: retained.document.displayText ?? retained.document.text,
      references: retained.document.references.filter(mention => mention.kind !== MENTION_KIND_V1.workflowInput),
      attachments: retained.document.attachments,
      values: retained.input,
    };
  }
  const values: WorkflowJsonValue[] = [];
  const tokens = new Map<number, string>();
  for (const mention of params.document.references) {
    if (mention.kind !== MENTION_KIND_V1.workflowInput) continue;
    const index = readWorkflowStepInputIndexV1(mention.ref);
    if (index === null) continue;
    if (!tokens.has(index)) tokens.set(index, mention.token);
  }
  const resolvedInputs: { token?: string; reference: WorkflowValueReference; value: WorkflowJsonValue }[] = [];
  const runtime = captureWorkflowDiscussionContext(params.runtime);
  const references = runtime.resolveDiscussionContext && !params.references.some(reference => reference.kind === 'discussion_context')
    ? [...params.references, { kind: 'discussion_context' as const, scope: 'addressing_message' as const }]
    : params.references;
  for (const [index, reference] of references.entries()) {
    try {
      const value = await resolveWorkflowValueReference(reference, runtime);
      values.push(value);
      const token = tokens.get(index);
      resolvedInputs.push({ ...(token === undefined ? {} : { token }), reference, value });
    } catch (error) {
      if ((reference.kind === 'trigger_event' || (reference.kind === 'result' && reference.optional === true))
        && error instanceof WorkflowInputResolutionError && error.code === 'missing_reference') continue;
      throw error;
    }
  }
  const promptContext = (await Promise.all(resolvedInputs.map(async entry => projectWorkflowPromptContext({ ...entry,
    ...(entry.reference.kind === 'result' && runtime.resolveResultSource
      ? { resultSource: await runtime.resolveResultSource(entry.reference.producer) } : {}) })))).flat();
  const render = () => {
    const authored = values.length === 0 ? params.document.text
      : `${params.document.text}\n\n${renderWorkflowPromptContext(promptContext)}`;
    return params.reviewContext === undefined ? authored
      : `${authored}\n\nThis step requires human review. You may publish a provisional result with workflow.run.invocations.publish_draft using ${JSON.stringify({ runId: params.reviewContext.runId, invocation: { recordId: params.reviewContext.invocationRecordId }, expectedContentRevision: params.reviewContext.contentRevision })} and value. Read the exact invocation first if its content revision changed. Publishing does not approve the result or continue the workflow.`;
  };
  let text = render();
  while (Buffer.byteLength(text, 'utf8') > MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES) {
    const index = resolvedInputs.findIndex((entry) => entry.reference.kind === 'session_context'
      && isWorkflowJsonObject(entry.value) && Array.isArray(entry.value.turns) && entry.value.turns.length > 0);
    if (index < 0) {
      const compacted = compactWorkflowPromptContext(promptContext, render, text);
      if (compacted === null) throw new WorkflowInputResolutionError('workflow_input_too_large');
      text = compacted;
      continue;
    }
    const entry = resolvedInputs[index]!;
    const context = WorkflowSessionContextV1Schema.parse(entry.value);
    const projected = promptContext.find(projected => projected.reference === entry.reference);
    const dropOldestTurns = (count: number) => {
      entry.value = { ...context, turns: context.turns.slice(count), truncated: true };
      values[index] = entry.value;
      if (projected) projected.value = entry.value;
      return render();
    };
    // Removing Session turns reduces the encoded array. Find the same first
    // fitting suffix without reparsing and rendering every discarded prefix.
    text = dropOldestTurns(context.turns.length);
    if (Buffer.byteLength(text, 'utf8') > MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES) continue;
    let first = 1;
    let last = context.turns.length;
    while (first < last) {
      const middle = first + Math.floor((last - first) / 2);
      const candidate = dropOldestTurns(middle);
      if (Buffer.byteLength(candidate, 'utf8') <= MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES) last = middle;
      else first = middle + 1;
    }
    text = dropOldestTurns(first);
  }
  for (const [index, entry] of resolvedInputs.entries()) {
    const projection = promptContext.filter(projected => projected.reference === entry.reference);
    if (projection.some(projected => projected.incomplete)) {
      values[index] = StrictJsonValueSchema.parse({ incomplete: true, reference: entry.reference, projection });
    }
  }
  return {
    text,
    displayText: params.document.displayText ?? params.document.text,
    references: params.document.references.filter((mention) => mention.kind !== MENTION_KIND_V1.workflowInput),
    attachments: params.document.attachments,
    values,
  };
}
