import { z } from 'zod';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { listActionSpecs } from '../actions/actionSpecs.js';

import {
  WorkflowBlockSchema,
  WorkflowInputDefinitionSchema,
  WorkflowStepSelectionV1Schema,
  type WorkflowBlock,
  type WorkflowDefinitionV1,
  type WorkflowIngressContextV1,
  type WorkflowStep,
  type WorkflowStepSelectionV1,
  type WorkflowLeafV1,
  type WorkflowTargetValidationState,
  type WorkflowValidationIssue,
  type WorkflowValidationIssueCode,
  type WorkflowValidationResult,
} from './workflowV1.js';
import {
  collectWorkflowConditionValueReferences,
  selectWorkflowLexicalScope,
  WorkflowAuthoredResultReferenceSchema,
  type WorkflowCondition,
  type WorkflowLexicalScope,
  type WorkflowReferenceScope,
  type WorkflowValueReference,
} from './workflowReferenceV1.js';
import { readWorkflowWorkspaceProducerRef } from './workflowWorkspaceV1.js';
import { resolveWorkflowStepSelectionV1 } from './workflowStepSelectionV1.js';
import { WorkflowRoleV1Schema } from '../prompts/roles/rolesV1.js';
import { MENTION_KIND_V1, readMentionRefOpaqueForKindV1 } from '../runtime/input/mentionRefV1.js';

/**
 * Normalization and semantic validation for the canonical workflow definition.
 *
 * The same functions back `workflow.validate`, the editor's local feedback and
 * the Action host's pre-effect check before save or start. There is no second
 * validator: a disagreement here would be a split-brain, not a convenience.
 */

const BLOCK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Loose outer envelope for the ingress dialect. Its members are parsed against
 * their own canonical schemas below so each failure keeps its exact path and
 * issue code instead of collapsing into one union error.
 */
const WorkflowIngressEnvelopeSchema = z.object({
  version: z.literal(1).optional(),
  inputs: z.array(WorkflowInputDefinitionSchema).optional(),
  defaults: z.unknown().optional(),
  roles: z.array(WorkflowRoleV1Schema).optional(),
  blocks: z.array(z.unknown()).min(1),
  finalOutput: WorkflowAuthoredResultReferenceSchema.optional(),
}).strict();

function issue(
  code: WorkflowValidationIssueCode,
  path: string,
  message: string,
  blockId?: string,
): WorkflowValidationIssue {
  return blockId === undefined
    ? { code, path, message, severity: 'error' }
    : { code, path, message, blockId, severity: 'error' };
}

/** Escapes a path segment for the JSON-pointer-like issue path. */
function joinPath(prefix: string, ...segments: ReadonlyArray<string | number>): string {
  let path = prefix;
  for (const segment of segments) {
    path += `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`;
  }
  return path;
}

// ---------------------------------------------------------------------------
// Ingress normalization
// ---------------------------------------------------------------------------

/** Escapes a container path so an assigned id stays inside `WorkflowBlockIdSchema`. */
function escapeAssignedIdPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '_');
}

/**
 * Deterministic id for a string ingress block: `wf-<parent-path>-step-<ordinal>`.
 *
 * The parent path is the chain of enclosing container segments — empty at the
 * root, `<parallelId>.<branchId>` inside a branch, `<loopId>.body` inside a loop
 * body and `<ifId>.then` / `<ifId>.otherwise` inside a conditional branch — with
 * non-alphanumeric characters escaped to `_`. The algorithm never hashes prompt
 * text and never uses a database row id, so re-normalizing the same authored
 * document is a no-op and a saved document keeps its assigned ids through
 * rename and reorder.
 */
export function assignWorkflowIngressBlockId(params: Readonly<{
  parentPath: string;
  ordinal: number;
  takenIds: ReadonlySet<string>;
}>): string {
  const base = `wf-${escapeAssignedIdPathSegment(params.parentPath)}-step-${params.ordinal}`;
  if (!params.takenIds.has(base)) return base;
  let suffix = 2;
  while (params.takenIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** Every id an authored object block already claims, so an assigned id never collides. */
function collectAuthoredIngressIds(value: unknown, into: Set<string>): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const entry of current) pending.push(entry);
      continue;
    }
    if (!isRecord(current)) continue;
    if (typeof current['id'] === 'string') into.add(current['id']);
    for (const entry of Object.values(current)) pending.push(entry);
  }
}

/**
 * Expands prompt-only string entries into text-only steps at every block-list
 * position, assigning each a deterministic scoped id. Structured blocks are
 * returned untouched — an authored id is never rewritten.
 */
function expandIngressStringBlocks(rootBlocks: readonly unknown[]): readonly unknown[] {
  const takenIds = new Set<string>();
  collectAuthoredIngressIds(rootBlocks, takenIds);
  const expandedRoot: unknown[] = new Array(rootBlocks.length);
  const pending: Array<Readonly<{
    source: readonly unknown[];
    target: unknown[];
    parentPath: string;
  }>> = [{ source: rootBlocks, target: expandedRoot, parentPath: '' }];

  while (pending.length > 0) {
    const { source, target, parentPath } = pending.pop()!;
    for (let index = 0; index < source.length; index += 1) {
      const entry = source[index];
      if (typeof entry === 'string') {
        const id = assignWorkflowIngressBlockId({ parentPath, ordinal: index, takenIds });
        takenIds.add(id);
        target[index] = {
          kind: 'step',
          id,
          document: { text: entry, references: [], attachments: [] },
          input: [],
          result: { kind: 'text' },
        } satisfies WorkflowStep;
        continue;
      }
      if (!isRecord(entry)) {
        target[index] = entry;
        continue;
      }

      const ownId = typeof entry['id'] === 'string' ? entry['id'] : '';
      if (entry['kind'] === 'parallel' && Array.isArray(entry['branches'])) {
        const branches = entry['branches'].map((branch) => {
          if (!isRecord(branch) || !Array.isArray(branch['blocks'])) return branch;
          const blocks: unknown[] = new Array(branch['blocks'].length);
          const branchId = typeof branch['id'] === 'string' ? branch['id'] : '';
          pending.push({ source: branch['blocks'], target: blocks, parentPath: `${ownId}.${branchId}` });
          return { ...branch, blocks };
        });
        target[index] = { ...entry, branches };
        continue;
      }
      if (entry['kind'] === 'loop' && Array.isArray(entry['body'])) {
        const body: unknown[] = new Array(entry['body'].length);
        target[index] = { ...entry, body };
        pending.push({ source: entry['body'], target: body, parentPath: `${ownId}.body` });
        continue;
      }
      if (entry['kind'] === 'if') {
        const next: Record<string, unknown> = { ...entry };
        if (Array.isArray(entry['then'])) {
          const thenBlocks: unknown[] = new Array(entry['then'].length);
          next['then'] = thenBlocks;
          pending.push({ source: entry['then'], target: thenBlocks, parentPath: `${ownId}.then` });
        }
        if (Array.isArray(entry['otherwise'])) {
          const otherwiseBlocks: unknown[] = new Array(entry['otherwise'].length);
          next['otherwise'] = otherwiseBlocks;
          pending.push({
            source: entry['otherwise'],
            target: otherwiseBlocks,
            parentPath: `${ownId}.otherwise`,
          });
        }
        target[index] = next;
        continue;
      }
      target[index] = entry;
    }
  }

  return expandedRoot;
}

type IngressNormalizationOutcome =
  | Readonly<{ kind: 'parsed'; definition: WorkflowDefinitionV1 }>
  | Readonly<{ kind: 'issues'; issues: readonly WorkflowValidationIssue[] }>;

function mapZodIssueCode(zodIssue: z.core.$ZodIssue): WorkflowValidationIssueCode {
  const path = zodIssue.path.map((segment) => String(segment));
  if (zodIssue.code === 'unrecognized_keys') return 'unknown_field';
  if (path[0] === 'version') return 'invalid_version';
  const last = path[path.length - 1];
  if (last === 'id') return 'invalid_id';
  if (path.includes('attachments')) return 'unsupported_persisted_attachment';
  if (path.includes('maxConcurrent')) return 'invalid_max_concurrent';
  if (path.includes('repetition')) return 'invalid_repetition';
  if (path.includes('onlyWhen') || path.includes('when') || path.includes('stopWhen')) return 'invalid_condition';
  if (path.includes('result')) return 'invalid_result_contract';
  // The remaining structural failures are malformed authored values. The closed
  // Protocol union has no generic parse code, and `invalid_input` is its
  // "this authored value cannot be accepted" member.
  return 'invalid_input';
}

function issuesFromZodError(error: z.ZodError<unknown>, pathPrefix = ''): readonly WorkflowValidationIssue[] {
  return error.issues.map((zodIssue) => issue(
    mapZodIssueCode(zodIssue),
    joinPath(pathPrefix, ...zodIssue.path.map((segment) => String(segment))),
    zodIssue.message,
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rejects transfer-owned staged media before parsing so the author sees the
 * exact repairable reason instead of an unrecognized-key message. A staged
 * claim is device-local; a portable definition needs a durable Account-backed
 * reference first.
 */
function collectStagedAttachmentIssues(input: unknown): readonly WorkflowValidationIssue[] {
  const found: WorkflowValidationIssue[] = [];
  const pending: Array<Readonly<{ value: unknown; path: string }>> = [{ value: input, path: '' }];
  while (pending.length > 0) {
    const { value, path } = pending.pop()!;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: value[index], path: joinPath(path, index) });
      }
      continue;
    }
    if (!isRecord(value)) continue;
    const attachments = value['attachments'];
    if (Array.isArray(attachments)) {
      attachments.forEach((attachment, index) => {
        if (isRecord(attachment) && attachment['content'] !== undefined) {
          found.push(issue(
            'unsupported_persisted_attachment',
            joinPath(path, 'attachments', index, 'content'),
            'Staged media must have a durable Account-backed reference before it can be saved in a workflow.',
            typeof value['id'] === 'string' ? value['id'] : undefined,
          ));
        }
      });
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'attachments') continue;
      pending.push({ value: entry, path: joinPath(path, key) });
    }
  }
  return found;
}

/**
 * Accepts the ingress dialect (prompt-only string blocks, omitted version and
 * defaults) and produces exactly one canonical definition. Structured blocks
 * require the current explicit execution and failure-policy fields.
 */
function normalizeIngressShape(
  input: unknown,
  context: WorkflowIngressContextV1 | undefined,
): IngressNormalizationOutcome {
  const stagedIssues = collectStagedAttachmentIssues(input);
  if (stagedIssues.length > 0) return { kind: 'issues', issues: stagedIssues };

  const parsedEnvelope = WorkflowIngressEnvelopeSchema.safeParse(input);
  if (!parsedEnvelope.success) {
    return { kind: 'issues', issues: issuesFromZodError(parsedEnvelope.error) };
  }
  const envelope = parsedEnvelope.data;

  // Blocks and defaults are parsed against their own schemas rather than
  // through the ingress union, so an unrecognized key or a structured block
  // missing its id produces its exact path-addressed code instead of one
  // opaque union failure.
  const memberIssues: WorkflowValidationIssue[] = [];
  const parsedDefaults = WorkflowStepSelectionV1Schema.safeParse(envelope.defaults ?? {});
  if (!parsedDefaults.success) {
    for (const parsedIssue of issuesFromZodError(parsedDefaults.error, '/defaults')) {
      memberIssues.push(parsedIssue);
    }
  }

  // Strings are expanded everywhere a block may appear, before any strict parse,
  // so the canonical schema only ever sees structured blocks with real ids.
  const expandedBlocks = expandIngressStringBlocks(envelope.blocks);

  // Canonical parsing and normalization share one stack-safe structural owner.
  const parsedStructural = z.array(WorkflowBlockSchema).safeParse(expandedBlocks);
  if (!parsedStructural.success) memberIssues.push(...issuesFromZodError(parsedStructural.error, '/blocks'));

  if (memberIssues.length > 0) return { kind: 'issues', issues: memberIssues };

  if (!parsedStructural.success) return { kind: 'issues', issues: memberIssues };
  const blocks: readonly WorkflowBlock[] = parsedStructural.data;

  const defaults = parsedDefaults.success ? parsedDefaults.data : {};
  const effectiveDefaults = defaults.agentTarget === undefined && defaults.engine === undefined && context?.agentTarget !== undefined
    ? { ...defaults, agentTarget: context.agentTarget }
    : defaults;

  // Every member (envelope, inputs, defaults, blocks, finalOutput) already
  // parsed through its canonical schema above, so the candidate is exactly
  // the canonical definition shape without a recursive reparse.
  const candidate: WorkflowDefinitionV1 = {
    version: 1 as const,
    inputs: envelope.inputs ?? [],
    defaults: effectiveDefaults,
    ...(envelope.roles === undefined ? {} : { roles: envelope.roles }),
    blocks,
    ...(envelope.finalOutput === undefined ? {} : { finalOutput: envelope.finalOutput }),
  };

  return { kind: 'parsed', definition: candidate };
}

/**
 * Public normalization entry point. Returns the canonical definition or the
 * path-addressed issues that prevented it. Block members parse stack-safely
 * above, so a deeply nested valid definition normalizes instead of
 * overflowing the call stack; no nesting limit is enforced.
 */
export function normalizeWorkflowIngress(
  input: unknown,
  context?: WorkflowIngressContextV1,
): IngressNormalizationOutcome {
  return normalizeIngressShape(input, context);
}

// ---------------------------------------------------------------------------
// Semantic walk
// ---------------------------------------------------------------------------

type ScopeLevel = Readonly<{
  /** Ordered members of this block list. */
  blocks: readonly WorkflowBlock[];
  /** Branch ids each parallel member exposes as an addressable producer. */
  branchIdsByIndex: ReadonlyMap<number, readonly string[]>;
  /** Authored loop mode used by the canonical lexical selector. */
  loop?: WorkflowLexicalScope['loop'];
}>;

type WalkState = {
  readonly issues: WorkflowValidationIssue[];
  readonly seenIds: Map<string, string>;
  readonly inputNames: ReadonlySet<string>;
  readonly numberInputNames: ReadonlySet<string>;
  readonly workflowDefaults: WorkflowStepSelectionV1;
  readonly levels: ScopeLevel[];
  /** Index currently being visited at each level; parallel to `levels`. */
  readonly positions: number[];
};

function recordId(state: WalkState, id: string, path: string): void {
  if (!BLOCK_ID_PATTERN.test(id)) {
    state.issues.push(issue('invalid_id', path, `"${id}" is not a valid block id.`, id));
    return;
  }
  const existing = state.seenIds.get(id);
  if (existing !== undefined) {
    state.issues.push(issue('duplicate_id', path, `Block id "${id}" is already used at ${existing}.`, id));
    return;
  }
  state.seenIds.set(id, path);
}

function producerCandidatesAt(level: ScopeLevel, exclusivePosition: number): ReadonlySet<string> {
  const candidates = new Set<string>();
  const limit = Math.min(exclusivePosition, level.blocks.length);
  for (let index = 0; index < limit; index += 1) {
    candidates.add(level.blocks[index]!.id);
    for (const branchId of level.branchIdsByIndex.get(index) ?? []) candidates.add(branchId);
  }
  return candidates;
}

type ResolvedScope =
  | Readonly<{ kind: 'resolved'; level: ScopeLevel; exclusivePosition: number }>
  | Readonly<{ kind: 'unresolvable'; message: string }>;

function resolveReferenceScope(state: WalkState, scope: WorkflowReferenceScope): ResolvedScope {
  const selected = selectWorkflowLexicalScope(state.levels, scope);
  if (selected.kind !== 'invalid') {
    const level = state.levels[selected.levelIndex]!;
    return {
      kind: 'resolved', level,
      exclusivePosition: selected.kind === 'previous_iteration'
        ? level.blocks.length
        : state.positions[selected.levelIndex]!,
    };
  }
  return {
    kind: 'unresolvable',
    message: 'The selected lexical scope is unavailable or has no sequential previous iteration.',
  };
}

function validateValueReference(
  state: WalkState,
  reference: WorkflowValueReference,
  path: string,
  blockId: string,
  options?: Readonly<{ allowOptionalResult?: boolean; allowSessionContext?: boolean; conditionOperand?: boolean }>,
): void {
  if (reference.kind === 'result' && reference.optional === true && !options?.allowOptionalResult) {
    state.issues.push(issue('invalid_reference_scope', path, 'Optional results are only allowed in step input lists.', blockId));
    return;
  }
  switch (reference.kind) {
    case 'session_context':
      if (!options?.allowSessionContext) state.issues.push(issue('invalid_reference_scope', path,
        'Session context is only available in Agent or Action input bindings.', blockId));
      return;
    case 'session_context_field':
      if (!options?.conditionOperand) state.issues.push(issue('invalid_reference_scope', path,
        'Session context fields are only available in conditions.', blockId));
      return;
    case 'literal':
      return;
    case 'input': {
      if (!state.inputNames.has(reference.name)) {
        state.issues.push(issue(
          'missing_reference',
          joinPath(path, 'name'),
          `No workflow input named "${reference.name}" is declared.`,
          blockId,
        ));
      }
      return;
    }
    case 'item': {
      const insideItemsLoop = state.levels.some((level) => level.loop?.kind === 'items');
      if (!insideItemsLoop) {
        state.issues.push(issue(
          'invalid_reference_scope',
          path,
          'The current item is only available inside a for-each loop.',
          blockId,
        ));
      }
      return;
    }
    case 'iteration': {
      const insideLoop = state.levels.some((level) => level.loop !== undefined);
      if (!insideLoop) {
        state.issues.push(issue(
          'invalid_reference_scope',
          path,
          'Iteration facts are only available inside a loop.',
          blockId,
        ));
      }
      return;
    }
    case 'loop_trailing_count': {
      let levelIndex = state.levels.length - 1;
      while (levelIndex >= 0 && state.levels[levelIndex]!.loop === undefined) levelIndex -= 1;
      const level = state.levels[levelIndex];
      if (!level || reference.producer.scope.kind !== 'current'
        || !producerCandidatesAt(level, state.positions[levelIndex]!).has(reference.producer.blockId)) {
        state.issues.push(issue('invalid_reference_scope', path,
          'Trailing counts require a preceding producer in the nearest loop body.', blockId));
      }
      return;
    }
    case 'result':
    case 'workspace': {
      const resolved = resolveReferenceScope(state, reference.producer.scope);
      if (resolved.kind === 'unresolvable') {
        state.issues.push(issue(
          'invalid_reference_scope',
          joinPath(path, 'producer', 'scope'),
          resolved.message,
          blockId,
        ));
        return;
      }
      const candidates = producerCandidatesAt(resolved.level, resolved.exclusivePosition);
      if (!candidates.has(reference.producer.blockId)) {
        const known = state.seenIds.has(reference.producer.blockId);
        state.issues.push(known
          ? issue(
            'invalid_reference_scope',
            joinPath(path, 'producer', 'blockId'),
            `"${reference.producer.blockId}" does not complete before this block in the selected scope.`,
            blockId,
          )
          : issue(
            'missing_reference',
            joinPath(path, 'producer', 'blockId'),
            `No block named "${reference.producer.blockId}" is available here.`,
            blockId,
          ));
      }
      return;
    }
  }
}

function validateCondition(
  state: WalkState,
  condition: WorkflowCondition,
  path: string,
  blockId: string,
  allowSessionContextFields = false,
): void {
  for (const reference of collectWorkflowConditionValueReferences(condition)) {
    validateValueReference(state, reference, path, blockId, { conditionOperand: allowSessionContextFields });
  }
  const pending: WorkflowCondition[] = [condition];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind === 'compare' && current.operator !== 'eq' && current.operator !== 'neq') {
      const left = current.left;
      const right = current.right;
      const operandType = (reference: WorkflowValueReference) => reference.kind === 'loop_trailing_count' || reference.kind === 'session_context_field'
        ? 'number'
        : reference.kind === 'literal' ? typeof reference.value : undefined;
      const leftType = operandType(left);
      const rightType = operandType(right);
      if (leftType !== undefined && rightType !== undefined) {
        const comparable = leftType === rightType && (leftType === 'number' || leftType === 'string');
        if (!comparable) {
          state.issues.push(issue(
            'invalid_condition',
            path,
            `"${current.operator}" needs two numbers or two strings to compare.`,
            blockId,
          ));
        }
      }
    } else if (current.kind === 'all' || current.kind === 'any') {
      for (const nested of current.conditions) pending.push(nested);
    } else if (current.kind === 'not') {
      pending.push(current.condition);
    }
  }
}

function validateStepExecution(state: WalkState, step: WorkflowLeafV1, path: string): void {
  const execution = step.execution;
  // Roles are resolved at admission. Static validation recognizes the role arm
  // without consulting mutable Account settings or choosing a target class.
  const engine = execution?.engine ?? state.workflowDefaults.engine;
  const withoutEngine = (selection: WorkflowStepSelectionV1) => {
    const { engine: _engine, executionTarget: _target, ...fields } = selection;
    return fields;
  };
  const effective = resolveWorkflowStepSelectionV1({ defaults: withoutEngine(state.workflowDefaults),
    step: execution === undefined ? undefined : withoutEngine(execution) }).selection;
  const boundConversation = effective.conversation?.kind === 'origin_session' || effective.conversation?.kind === 'existing_session';
  if (step.kind === 'step' && effective.agentTarget == null && !engine && !boundConversation) {
    state.issues.push(issue(
      'target_unavailable',
      joinPath(path, 'execution', 'agentTarget'),
      'This step has no Agent. Choose a workflow default Agent or set one on the step.',
      step.id,
    ));
  }
  if (execution?.executionTarget?.kind === 'detached_run' && boundConversation) {
    state.issues.push(issue('invalid_input', joinPath(path, 'execution', 'executionTarget'),
      'A conversation bound to a Session requires a Session target.', step.id));
  }

  const effectiveConversation = effective.conversation;
  if ((effectiveConversation?.kind === 'existing_session' || effectiveConversation?.kind === 'origin_session')
    && execution?.workspace?.kind === 'new_worktree') {
    state.issues.push(issue(
      'conversation_workspace_mismatch',
      joinPath(path, 'execution', 'workspace'),
      'An existing Session keeps its current workspace and cannot use a new workflow worktree.',
      step.id,
    ));
  }

  if (execution?.conversation?.kind === 'from_step') {
    validateValueReference(
      state,
      { kind: 'result', producer: execution.conversation.producer, path: [] },
      joinPath(path, 'execution', 'conversation'),
      step.id,
    );
  }
  if (execution?.workspace !== undefined) {
    const producer = readWorkflowWorkspaceProducerRef(execution.workspace);
    if (producer !== null) {
      validateValueReference(
        state,
        { kind: 'result', producer, path: [] },
        joinPath(path, 'execution', 'workspace'),
        step.id,
      );
    }
  }
}

function validateStep(
  state: WalkState,
  step: WorkflowStep,
  path: string,
  options?: Readonly<{ requireDecisionResult?: boolean }>,
): void {
  validateStepExecution(state, step, path);
  const invalidBindings = new Map<number, WorkflowValidationIssue>();
  step.input.forEach((reference, index) => {
    const issueCount = state.issues.length;
    validateValueReference(state, reference, joinPath(path, 'input', index), step.id, { allowOptionalResult: true, allowSessionContext: true });
    const bindingIssue = state.issues[issueCount];
    if (bindingIssue) invalidBindings.set(index, bindingIssue);
  });
  step.document.references.forEach((mention, index) => {
    if (mention.kind !== MENTION_KIND_V1.workflowInput) return;
    const opaque = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.workflowInput, mention.ref);
    const bindingIndex = opaque !== null && /^\d+$/.test(opaque) ? Number(opaque) : NaN;
    const tokenPath = joinPath(path, 'document', 'references', index, 'ref');
    if (!Number.isSafeInteger(bindingIndex) || bindingIndex >= step.input.length) {
      state.issues.push(issue('invalid_input', tokenPath, 'This token has no Workflow input binding.', step.id));
      return;
    }
    const bindingIssue = invalidBindings.get(bindingIndex);
    if (bindingIssue) state.issues.push({ ...bindingIssue, path: tokenPath });
  });
  if (step.onlyWhen !== undefined) {
    validateCondition(state, step.onlyWhen, joinPath(path, 'onlyWhen'), step.id, options?.requireDecisionResult === true);
  }
  if (options?.requireDecisionResult === true && (step.result.kind !== 'decision'
    || !step.result.decisions.includes('continue') || step.result.decisions.length < 2)) {
    state.issues.push(issue(
      'invalid_result_contract',
      joinPath(path, 'result'),
      'An evaluator must declare continue and at least one terminal decision.',
      step.id,
    ));
  }
  if (step.result.kind === 'json' && !isRecord(step.result.schema)) {
    state.issues.push(issue(
      'invalid_result_contract',
      joinPath(path, 'result', 'schema'),
      'A structured result contract needs a JSON Schema object.',
      step.id,
    ));
  }
}

function validateNonAgentLeaf(
  state: WalkState,
  leaf: Exclude<WorkflowLeafV1, WorkflowStep>,
  path: string,
  allowAggregateCondition = false,
): void {
  validateStepExecution(state, leaf, path);
  if (leaf.onlyWhen !== undefined) {
    validateCondition(state, leaf.onlyWhen, joinPath(path, 'onlyWhen'), leaf.id, allowAggregateCondition);
  }
  if (leaf.kind === 'wait') return;
  for (const [field, binding] of Object.entries(leaf.input)) {
    const references = binding.kind === 'list' ? binding.items : [binding];
    references.forEach((reference, index) => {
      if (reference.kind !== 'origin_session_id') {
        validateValueReference(state, reference,
          joinPath(path, 'input', field, ...(binding.kind === 'list' ? ['items', index] : [])), leaf.id,
          { allowSessionContext: leaf.kind === 'action' });
      }
    });
  }
}

function buildScopeLevel(
  blocks: readonly WorkflowBlock[],
  loop: NonNullable<WorkflowLexicalScope['loop']> | null,
): ScopeLevel {
  const branchIdsByIndex = new Map<number, readonly string[]>();
  blocks.forEach((block, index) => {
    if (block.kind === 'parallel') {
      branchIdsByIndex.set(index, block.branches.map((branch) => branch.id));
    }
  });
  return {
    blocks,
    branchIdsByIndex,
    ...(loop ? { loop } : {}),
  };
}

function collectDeclaredIds(state: WalkState, blocks: readonly WorkflowBlock[], path: string): void {
  type IdWalkTask =
    | Readonly<{ kind: 'block'; block: WorkflowBlock; path: string }>
    | Readonly<{
      kind: 'branch';
      branch: Extract<WorkflowBlock, { kind: 'parallel' }>['branches'][number];
      path: string;
    }>;
  const pending: IdWalkTask[] = [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    pending.push({ kind: 'block', block: blocks[index]!, path: joinPath(path, index) });
  }
  while (pending.length > 0) {
    const task = pending.pop()!;
    if (task.kind === 'branch') {
      recordId(state, task.branch.id, joinPath(task.path, 'id'));
      for (let index = task.branch.blocks.length - 1; index >= 0; index -= 1) {
        pending.push({
          kind: 'block',
          block: task.branch.blocks[index]!,
          path: joinPath(task.path, 'blocks', index),
        });
      }
      continue;
    }
    const { block, path: blockPath } = task;
    recordId(state, block.id, joinPath(blockPath, 'id'));
    switch (block.kind) {
      case 'step':
      case 'action':
      case 'workflow':
      case 'wait':
        break;
      case 'parallel':
        for (let branchIndex = block.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
          const branch = block.branches[branchIndex]!;
          pending.push({ kind: 'branch', branch, path: joinPath(blockPath, 'branches', branchIndex) });
        }
        break;
      case 'loop':
        if (block.repetition.kind === 'evaluate') {
          recordId(
            state,
            block.repetition.evaluator.id,
            joinPath(blockPath, 'repetition', 'evaluator', 'id'),
          );
        }
        for (let index = block.body.length - 1; index >= 0; index -= 1) {
          pending.push({ kind: 'block', block: block.body[index]!, path: joinPath(blockPath, 'body', index) });
        }
        break;
      case 'if':
        for (let index = block.otherwise.length - 1; index >= 0; index -= 1) {
          pending.push({ kind: 'block', block: block.otherwise[index]!, path: joinPath(blockPath, 'otherwise', index) });
        }
        for (let index = block.then.length - 1; index >= 0; index -= 1) {
          pending.push({ kind: 'block', block: block.then[index]!, path: joinPath(blockPath, 'then', index) });
        }
        break;
    }
  }
}

type ValidationWalkTask =
  | Readonly<{ kind: 'enter'; level: ScopeLevel; path: string }>
  | Readonly<{ kind: 'leave' }>
  | Readonly<{ kind: 'block'; block: WorkflowBlock; path: string; position: number }>
  | Readonly<{
    kind: 'loop_continuation';
    level: ScopeLevel;
    block: Extract<WorkflowBlock, Readonly<{ kind: 'loop' }>>;
    repetitionPath: string;
  }>;

function validateBlockList(state: WalkState, initialLevel: ScopeLevel, initialPath: string): void {
  const pending: ValidationWalkTask[] = [{ kind: 'enter', level: initialLevel, path: initialPath }];
  while (pending.length > 0) {
    const task = pending.pop()!;
    if (task.kind === 'leave') {
      state.levels.pop();
      state.positions.pop();
      continue;
    }
    if (task.kind === 'enter') {
      state.levels.push(task.level);
      state.positions.push(0);
      pending.push({ kind: 'leave' });
      for (let index = task.level.blocks.length - 1; index >= 0; index -= 1) {
        pending.push({
          kind: 'block',
          block: task.level.blocks[index]!,
          path: joinPath(task.path, index),
          position: index,
        });
      }
      continue;
    }
    if (task.kind === 'loop_continuation') {
      state.levels.push(task.level);
      state.positions.push(task.level.blocks.length);
      try {
        const repetition = task.block.repetition;
        if (repetition.kind === 'until') {
          validateCondition(
            state,
            repetition.stopWhen,
            joinPath(task.repetitionPath, 'stopWhen'),
            task.block.id,
            true,
          );
        } else if (repetition.kind === 'evaluate') {
          if (repetition.evaluator.kind === 'step') {
            validateStep(state, repetition.evaluator, joinPath(task.repetitionPath, 'evaluator'),
              { requireDecisionResult: true });
          } else {
            validateNonAgentLeaf(state, repetition.evaluator, joinPath(task.repetitionPath, 'evaluator'), true);
          }
        }
      } finally {
        state.levels.pop();
        state.positions.pop();
      }
      continue;
    }

    state.positions[state.positions.length - 1] = task.position;
    const { block, path: blockPath } = task;
    switch (block.kind) {
      case 'step':
        validateStep(state, block, blockPath);
        break;
      case 'action':
      case 'workflow':
      case 'wait': {
        validateNonAgentLeaf(state, block, blockPath);
        break;
      }
      case 'parallel': {
        if (block.onlyWhen !== undefined) {
          validateCondition(state, block.onlyWhen, joinPath(blockPath, 'onlyWhen'), block.id);
        }
        for (let branchIndex = block.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
          const branch = block.branches[branchIndex]!;
          pending.push({
            kind: 'enter',
            level: buildScopeLevel(branch.blocks, null),
            path: joinPath(blockPath, 'branches', branchIndex, 'blocks'),
          });
        }
        break;
      }
      case 'loop': {
        if (block.onlyWhen !== undefined) {
          validateCondition(state, block.onlyWhen, joinPath(blockPath, 'onlyWhen'), block.id);
        }
        const repetition = block.repetition;
        const repetitionPath = joinPath(blockPath, 'repetition');
        if ((repetition.kind === 'until' || repetition.kind === 'evaluate')
          && typeof repetition.maxIterations !== 'number'
          && !state.numberInputNames.has(repetition.maxIterations.name)) {
          state.issues.push(issue('invalid_input', joinPath(repetitionPath, 'maxIterations'),
            'A round limit must reference a declared number input.', block.id));
        }
        if (repetition.kind === 'count') {
          validateValueReference(state, repetition.count, joinPath(repetitionPath, 'count'), block.id);
          if (repetition.count.kind === 'literal') {
            const count = repetition.count.value;
            if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
              state.issues.push(issue(
                'invalid_repetition',
                joinPath(repetitionPath, 'count'),
                'A repeat count must be a nonnegative whole number.',
                block.id,
              ));
            }
          }
        }
        if (repetition.kind === 'items') {
          validateValueReference(state, repetition.items, joinPath(repetitionPath, 'items'), block.id);
          if (repetition.items.kind === 'literal' && !Array.isArray(repetition.items.value)) {
            state.issues.push(issue(
              'invalid_repetition',
              joinPath(repetitionPath, 'items'),
              'A for-each list must be a list.',
              block.id,
            ));
          }
          if (repetition.execution === 'sequential' && repetition.maxConcurrent !== undefined) {
            state.issues.push(issue(
              'invalid_max_concurrent',
              joinPath(repetitionPath, 'maxConcurrent'),
              'Maximum concurrent items applies only to parallel items.',
              block.id,
            ));
          }
        }
        const bodyLevel = buildScopeLevel(block.body, {
          blockId: block.id,
          kind: repetition.kind,
          ...(repetition.kind === 'items' ? { execution: repetition.execution } : {}),
        });
        if (repetition.kind === 'until' || repetition.kind === 'evaluate') {
          pending.push({ kind: 'loop_continuation', level: bodyLevel, block, repetitionPath });
        }
        pending.push({ kind: 'enter', level: bodyLevel, path: joinPath(blockPath, 'body') });
        break;
      }
      case 'if': {
        validateCondition(state, block.when, joinPath(blockPath, 'when'), block.id, true);
        pending.push({
          kind: 'enter',
          level: buildScopeLevel(block.otherwise, null),
          path: joinPath(blockPath, 'otherwise'),
        });
        pending.push({
          kind: 'enter',
          level: buildScopeLevel(block.then, null),
          path: joinPath(blockPath, 'then'),
        });
        break;
      }
    }
  }
}

function validateInputs(state: WalkState, definition: WorkflowDefinitionV1): void {
  const seen = new Set<string>();
  definition.inputs.forEach((input, index) => {
    const path = joinPath('/inputs', index);
    if (seen.has(input.name)) {
      state.issues.push(issue('invalid_input', joinPath(path, 'name'), `Input "${input.name}" is declared twice.`));
    }
    seen.add(input.name);
    if (input.optionsSourceId !== undefined && !listActionSpecs().some((spec) =>
      spec.inputHints?.fields.some((field) => field.optionsSourceId === input.optionsSourceId))) {
      state.issues.push(issue('invalid_input', joinPath(path, 'optionsSourceId'), 'This Action options source is not registered.'));
    }
    if (input.default !== undefined) {
      const matches = input.valueType === 'json'
        || (input.valueType === 'string' && typeof input.default === 'string')
        || (input.valueType === 'number' && typeof input.default === 'number')
        || (input.valueType === 'boolean' && typeof input.default === 'boolean');
      if (!matches) {
        state.issues.push(issue(
          'invalid_input',
          joinPath(path, 'default'),
          `The default value for "${input.name}" is not a ${input.valueType}.`,
        ));
      }
    }
  });
}

function validateFinalOutput(state: WalkState, definition: WorkflowDefinitionV1): void {
  const finalOutput = definition.finalOutput;
  if (finalOutput === undefined) return;
  const path = '/finalOutput';
  if (finalOutput.optional === true) {
    state.issues.push(issue('invalid_reference_scope', path, 'The final output cannot be an optional result.'));
    return;
  }
  if (finalOutput.producer.scope.kind !== 'current') {
    state.issues.push(issue(
      'invalid_reference_scope',
      joinPath(path, 'producer', 'scope'),
      'The final output must name a top-level block of this workflow.',
    ));
    return;
  }
  const rootLevel = buildScopeLevel(definition.blocks, null);
  const candidates = producerCandidatesAt(rootLevel, rootLevel.blocks.length);
  if (!candidates.has(finalOutput.producer.blockId)) {
    state.issues.push(state.seenIds.has(finalOutput.producer.blockId)
      ? issue(
        'invalid_reference_scope',
        joinPath(path, 'producer', 'blockId'),
        `"${finalOutput.producer.blockId}" is nested inside another block and cannot be the final output.`,
      )
      : issue(
        'missing_reference',
        joinPath(path, 'producer', 'blockId'),
        `No block named "${finalOutput.producer.blockId}" exists in this workflow.`,
      ));
  }
}

export type ValidateWorkflowDefinitionOptions = Readonly<{
  /** Trusted host context; used only when the definition supplies no effective value. */
  context?: WorkflowIngressContextV1;
  /**
   * Contextual target diagnostics resolved by the caller (machine reachability,
   * Agent availability). Absence is reported as `not_requested`, and an
   * unavailable check never withholds the normalized definition.
   */
  targetValidation?: WorkflowTargetValidationState;
  /**
   * Host-resolved diagnostics about state the portable definition cannot carry:
   * target reachability and Agent availability, and live composer custody such
   * as staged attachment bytes an authoring surface is still holding. They join
   * the definition's own issues so one owner decides validity.
   */
  targetIssues?: readonly WorkflowValidationIssue[];
}>;

/** The authored-source comparison used by admission rejoin and Plan review recovery. */
export function matchesWorkflowAcceptedDefinitionV1(
  acceptedAuthoredDefinition: WorkflowDefinitionV1,
  proposal: unknown,
  options: ValidateWorkflowDefinitionOptions = {},
): boolean {
  const checked = validateWorkflowDefinition(proposal, options);
  return checked.valid && checked.normalizedDefinition !== undefined
    && sameStrictJsonValue(acceptedAuthoredDefinition, checked.normalizedDefinition);
}

/**
 * Normalizes and semantically validates a workflow definition or its ingress
 * dialect. `normalizedDefinition` is present whenever parsing and normalization
 * succeed, even when target diagnostics are unavailable.
 */
export function validateWorkflowDefinition(
  input: unknown,
  options: ValidateWorkflowDefinitionOptions = {},
): WorkflowValidationResult {
  const targetValidation = options.targetValidation ?? 'not_requested';
  const normalized = normalizeWorkflowIngress(input, options.context);
  if (normalized.kind === 'issues') {
    return { valid: false, issues: normalized.issues, targetValidation };
  }

  const definition = normalized.definition;
  const state: WalkState = {
    issues: [],
    seenIds: new Map<string, string>(),
    inputNames: new Set(definition.inputs.map((declared) => declared.name)),
    numberInputNames: new Set(definition.inputs.filter((declared) => declared.valueType === 'number').map((declared) => declared.name)),
    workflowDefaults: definition.defaults,
    levels: [],
    positions: [],
  };

  validateInputs(state, definition);
  collectDeclaredIds(state, definition.blocks, '/blocks');
  validateBlockList(state, buildScopeLevel(definition.blocks, null), '/blocks');
  validateFinalOutput(state, definition);

  const targetIssues = options.targetIssues ?? [];
  const issues = [...state.issues, ...targetIssues];
  const valid = issues.every((entry) => entry.severity !== 'error');
  return { valid, normalizedDefinition: definition, issues, targetValidation };
}
