import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import {
  WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS,
  type WorkflowBlock,
  type WorkflowDefinitionV1,
  type WorkflowInputDefinition,
  type WorkflowStep,
  type WorkflowStepExecutionSelection,
  type WorkflowValidationIssue,
  type WorkflowValidationResult,
} from '@happier-dev/protocol/workflows/workflowV1';
import type { JsonValue } from '@happier-dev/protocol';
import type { WorkflowReferenceScope } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { workflowBlockReferenceLabel } from './workflowBlockLabel';
export { bindWorkflowSessionConversation, resolveWorkflowSessionBinding } from './workflowAuthoringSessionBinding';
import { parseWorkflowInputTextDraft } from './workflowInputText';

import {
  createWorkflowEditorDraft,
  type WorkflowEditorDraft,
} from './workflowEditorDraft';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

/**
 * The canonical definition ↔ editor projection.
 *
 * The editor never invents a serialization: it hands its authored draft to the
 * one Protocol validator and stores what that validator normalizes. The same
 * validator runs again at the Action host before any save or start effect, so a
 * definition can never mean one thing here and another there.
 */

/** The draft as the canonical validator sees it, before normalization. */
export function buildWorkflowDefinitionCandidate(draft: WorkflowEditorDraft): unknown {
  return {
    version: 1,
    inputs: draft.inputs,
    defaults: draft.defaults,
    blocks: draft.blocks,
    ...(draft.roles === undefined ? {} : { roles: draft.roles }),
    ...(draft.finalOutput === undefined ? {} : { finalOutput: draft.finalOutput }),
  };
}

export type WorkflowDraftValidation = WorkflowValidationResult;

export function validateWorkflowEditorDraft(
  draft: WorkflowEditorDraft,
  options?: Parameters<typeof validateWorkflowDefinition>[1],
): WorkflowDraftValidation {
  return validateWorkflowDefinition(buildWorkflowDefinitionCandidate(draft), options);
}

/** The first blocking issue, which is what the page-level action reason names. */
export function firstBlockingWorkflowIssue(
  validation: WorkflowDraftValidation,
): WorkflowValidationIssue | null {
  return validation.issues.find((issue) => issue.severity === 'error') ?? null;
}

/**
 * The innermost authored block an issue belongs to.
 *
 * Semantic issues name their block; structural parse issues (an empty prompt,
 * an unresolved number) carry only the JSON-pointer path, so this walks that
 * path through the draft's own structure. Reading the path is what lets the
 * editor show and focus such a repair at its block instead of only at the page.
 */
export function resolveWorkflowIssueBlockId(
  draft: WorkflowEditorDraft,
  issue: Pick<WorkflowValidationIssue, 'path' | 'blockId'>,
): string | null {
  if (issue.blockId !== undefined) return issue.blockId;
  const segments = issue.path.split('/').filter((segment) => segment.length > 0);
  if (segments[0] !== 'blocks') return null;
  let list: readonly WorkflowBlock[] = draft.blocks;
  let block: WorkflowBlock | null = null;
  let index = 1;
  while (index < segments.length) {
    const position = Number(segments[index]);
    const candidate = Number.isInteger(position) ? list[position] : undefined;
    if (candidate === undefined) break;
    block = candidate;
    const descent = segments[index + 1];
    if (candidate.kind === 'parallel' && descent === 'branches') {
      const branch = candidate.branches[Number(segments[index + 2])];
      if (branch === undefined || segments[index + 3] !== 'blocks') break;
      list = branch.blocks;
      index += 4;
    } else if (candidate.kind === 'loop' && descent === 'body') {
      list = candidate.body;
      index += 2;
    } else if (candidate.kind === 'loop' && descent === 'repetition' && segments[index + 2] === 'evaluator') {
      return candidate.repetition.kind === 'evaluate' ? candidate.repetition.evaluator.id : candidate.id;
    } else if (candidate.kind === 'if' && (descent === 'then' || descent === 'otherwise')) {
      list = descent === 'then' ? candidate.then : candidate.otherwise;
      index += 2;
    } else {
      break;
    }
  }
  return block?.id ?? null;
}

export function workflowIssuesForBlock(
  validation: WorkflowDraftValidation,
  blockId: string,
  draft?: WorkflowEditorDraft,
): readonly WorkflowValidationIssue[] {
  return validation.issues.filter((issue) => (
    draft === undefined ? issue.blockId === blockId : resolveWorkflowIssueBlockId(draft, issue) === blockId
  ));
}

export function buildWorkflowEditorDraftFromDefinition(params: Readonly<{
  draftId: string;
  name: string;
  definition: WorkflowDefinitionV1;
}>): WorkflowEditorDraft {
  const base = createWorkflowEditorDraft({
    draftId: params.draftId,
    name: params.name,
    defaults: params.definition.defaults,
    blocks: params.definition.blocks,
  });
  const withInputs: WorkflowEditorDraft = { ...base, inputs: params.definition.inputs,
    ...(params.definition.roles === undefined ? {} : { roles: params.definition.roles }),
  };
  return params.definition.finalOutput === undefined
    ? withInputs
    : { ...withInputs, finalOutput: params.definition.finalOutput };
}

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

export type WorkflowFieldInheritance = 'inherited' | 'override';

/**
 * Whether a step reads a field from the workflow default or authored its own.
 *
 * An override that happens to equal the current default is still an override:
 * collapsing it into inheritance would silently change the step the next time
 * the default changes.
 */
export function resolveWorkflowStepFieldInheritance(
  step: WorkflowStep,
  field: keyof WorkflowStepExecutionSelection,
): WorkflowFieldInheritance {
  const execution = step.execution;
  if (execution === undefined) return 'inherited';
  return Object.hasOwn(execution, field) ? 'override' : 'inherited';
}

/** Value-only authoring fields. Roles and execution placement are bound by run admission, not a view. */
export function resolveEffectiveWorkflowStepExecution(
  draft: Readonly<Pick<WorkflowEditorDraft, 'defaults'>>,
  step: WorkflowStep,
): WorkflowStepExecutionSelection {
  return resolveWorkflowStepSelectionV1({ defaults: draft.defaults, step: step.execution, purpose: 'authoring' }).selection;
}

/**
 * Whether every step in a parallel group genuinely runs in its own conversation.
 *
 * Only a `fresh` conversation creates one: under the shared-Run default (or an
 * explicit continuation) the branches reach the same conversation and take
 * turns in it. The runtime reads the same effective selection this resolves —
 * a step's own override, else the workflow default — so the editor states the
 * separation only where it is actually true.
 */
export function doWorkflowParallelBranchesUseSeparateConversations(
  draft: Readonly<Pick<WorkflowEditorDraft, 'defaults'>>,
  parallel: Extract<WorkflowBlock, Readonly<{ kind: 'parallel' }>>,
): boolean {
  const steps = parallel.branches.flatMap(
    (branch) => walkWorkflowBlocks(branch.blocks).filter((block) => block.kind === 'step'),
  );
  if (steps.length === 0) return false;
  return steps.every(
    (step) => resolveEffectiveWorkflowStepExecution(draft, step).conversation?.kind === 'fresh',
  );
}

/** The Session-authoring fields a step overrode, in the editor's chip order. */
export function listWorkflowStepOverriddenFields(
  step: WorkflowStep,
): readonly (keyof WorkflowStepExecutionSelection)[] {
  const execution = step.execution;
  if (execution === undefined) return [];
  return WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS.filter((field) => Object.hasOwn(execution, field));
}

// ---------------------------------------------------------------------------
// Reference vocabulary
// ---------------------------------------------------------------------------

export type WorkflowProducerOption = Readonly<{
  blockId: string;
  label: string;
  scope: WorkflowReferenceScope;
  /** True when the producer is a parallel branch rather than an ordinary block. */
  isBranch: boolean;
}>;

/**
 * The producers a consumer may reference in its own scope, in authored order.
 *
 * The picker offers only valid enclosing/current/prior scopes; it never lists a
 * forward or out-of-scope block and then relies on the validator to reject it.
 */
type ConsumerScopeLevel = Readonly<{
  blocks: readonly WorkflowBlock[];
  position: number;
  /** The loop whose body this level is, with whether it iterates an item list. */
  loop: Readonly<{ blockId: string; hasItems: boolean }> | null;
}>;

/**
 * The enclosing block lists of a consumer, outermost first, ending with the
 * list that contains it. A loop's own entry-time references (count, items)
 * resolve in the enclosing scope, so the loop's body level is not part of its
 * own chain; an evaluator resolves after the whole body, inside it.
 */
/**
 * Which part of a block is consuming. A loop's continuation (`stopWhen`, the
 * evaluator) runs after each round, so it resolves inside the body with every
 * body member complete; everything else resolves where the block sits.
 */
export type WorkflowReferenceConsumer = Readonly<{ continuation?: boolean }>;

function locateWorkflowConsumerLevels(
  draft: WorkflowEditorDraft,
  consumerBlockId: string,
  consumer: WorkflowReferenceConsumer = {},
): readonly ConsumerScopeLevel[] | null {
  const locate = (
    blocks: readonly WorkflowBlock[],
    loop: ConsumerScopeLevel['loop'],
    ancestors: readonly ConsumerScopeLevel[],
  ): readonly ConsumerScopeLevel[] | null => {
    for (let position = 0; position < blocks.length; position += 1) {
      const block = blocks[position]!;
      const level = { blocks, position, loop } as const;
      if (block.id === consumerBlockId) {
        if (consumer.continuation === true && block.kind === 'loop') {
          return [
            ...ancestors,
            level,
            {
              blocks: block.body,
              position: block.body.length,
              loop: { blockId: block.id, hasItems: block.repetition.kind === 'items' },
            },
          ];
        }
        return [...ancestors, level];
      }
      if (block.kind === 'parallel') {
        for (const branch of block.branches) {
          const found = locate(branch.blocks, null, [...ancestors, level]);
          if (found !== null) return found;
        }
      } else if (block.kind === 'loop') {
        const bodyLoop = { blockId: block.id, hasItems: block.repetition.kind === 'items' } as const;
        if (block.repetition.kind === 'evaluate' && block.repetition.evaluator.id === consumerBlockId) {
          return [
            ...ancestors,
            level,
            { blocks: block.body, position: block.body.length, loop: bodyLoop },
          ];
        }
        const found = locate(block.body, bodyLoop, [...ancestors, level]);
        if (found !== null) return found;
      } else if (block.kind === 'if') {
        const thenFound = locate(block.then, null, [...ancestors, level]);
        if (thenFound !== null) return thenFound;
        const otherwiseFound = locate(block.otherwise, null, [...ancestors, level]);
        if (otherwiseFound !== null) return otherwiseFound;
      }
    }
    return null;
  };
  return locate(draft.blocks, null, []);
}

export type WorkflowReferenceScopeFacts = Readonly<{
  /** Iteration facts (`iteration` references) are available inside any loop. */
  insideLoop: boolean;
  /** The current item (`item` references) is available only inside a for-each loop. */
  insideItemsLoop: boolean;
  /**
   * The consumer runs inside a parallel branch, so siblings may execute at the
   * same time as it — which is what makes a shared workspace a shared write.
   */
  insideParallel: boolean;
}>;

/**
 * Which loop-scoped reference kinds a consumer may author, mirroring the
 * canonical validator's scope rule so the picker never offers a reference the
 * validator would then reject.
 */
export function resolveWorkflowReferenceScopeFacts(
  draft: WorkflowEditorDraft,
  consumerBlockId: string,
  consumer?: WorkflowReferenceConsumer,
): WorkflowReferenceScopeFacts {
  const levels = locateWorkflowConsumerLevels(draft, consumerBlockId, consumer) ?? [];
  return {
    insideLoop: levels.some((level) => level.loop !== null),
    insideItemsLoop: levels.some((level) => level.loop?.hasItems === true),
    // Every level but the consumer's own names an enclosing block.
    insideParallel: levels.slice(0, -1).some((level) => level.blocks[level.position]?.kind === 'parallel'),
  };
}

export function listWorkflowProducerOptions(
  draft: WorkflowEditorDraft,
  consumerBlockId: string,
  consumer?: WorkflowReferenceConsumer,
): readonly WorkflowProducerOption[] {
  type Level = ConsumerScopeLevel;

  const levels = locateWorkflowConsumerLevels(draft, consumerBlockId, consumer);
  if (levels === null) return [];

  const options: WorkflowProducerOption[] = [];
  const appendCandidates = (level: Level, scope: WorkflowReferenceScope, limit: number): void => {
    for (const block of level.blocks.slice(0, limit)) {
      options.push({ blockId: block.id, label: workflowBlockReferenceLabel(block), scope, isBranch: false });
      if (block.kind === 'parallel') {
        for (const branch of block.branches) {
          options.push({ blockId: branch.id, label: branch.id, scope, isBranch: true });
        }
      }
    }
  };

  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const distance = levels.length - 1 - index;
    appendCandidates(
      levels[index]!,
      distance === 0 ? { kind: 'current' } : { kind: 'outer', levels: distance },
      levels[index]!.position,
    );
  }
  for (const level of levels) {
    if (level.loop !== null) {
      appendCandidates(
        level,
        { kind: 'previous_iteration', loopBlockId: level.loop.blockId },
        level.blocks.length,
      );
    }
  }
  return options;
}

/**
 * An existing Session a step may continue, as the host's canonical Session
 * candidacy and machine-target owners project it. The editor is controlled and
 * reads no store, so the host supplies these; the exact Machine is part of the
 * option because the conversation selection records it and the coordinator
 * refuses a Session on another Machine.
 */
export type WorkflowExistingSessionOption = Readonly<{
  sessionId: string;
  machineId: string;
  label: string;
}>;

/** Root-level producers, which are the only eligible final-output selections. */
export function listWorkflowFinalOutputOptions(
  draft: WorkflowEditorDraft,
): readonly WorkflowProducerOption[] {
  const options: WorkflowProducerOption[] = [];
  for (const block of draft.blocks) {
    options.push({ blockId: block.id, label: workflowBlockReferenceLabel(block), scope: { kind: 'current' }, isBranch: false });
    if (block.kind === 'parallel') {
      for (const branch of block.branches) {
        options.push({ blockId: branch.id, label: branch.id, scope: { kind: 'current' }, isBranch: true });
      }
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Declared inputs
// ---------------------------------------------------------------------------

export type WorkflowRunInputValue = Readonly<{ name: string; value: JsonValue | undefined }>;

export type WorkflowRunInputFieldState = Readonly<{
  definition: WorkflowInputDefinition;
  value: JsonValue | undefined;
  /** Blocking means Run stays unavailable until it is repaired. */
  blocking: boolean;
  errorCode: 'missing_required_input' | 'invalid_input' | null;
}>;

/**
 * Projects the Run-now sheet in authored declaration order. Required status
 * marks a field and blocks the command; it never reorders the form.
 */
export function projectWorkflowRunInputFields(params: Readonly<{
  inputs: readonly WorkflowInputDefinition[];
  values: Readonly<Record<string, JsonValue | undefined>>;
  /** Uncommitted text buffers; seeded values above are already semantic JSON. */
  rawTextValues?: Readonly<Record<string, string>>;
}>): readonly WorkflowRunInputFieldState[] {
  return params.inputs.map((definition) => {
    const rawText = params.rawTextValues?.[definition.name];
    const draft = rawText === undefined ? null : parseWorkflowInputTextDraft(definition, rawText);
    if (draft?.invalid) return { definition, value: undefined, blocking: true, errorCode: 'invalid_input' };
    const supplied = draft === null ? params.values[definition.name] : draft.value;
    const value = supplied === undefined ? definition.default : supplied;
    if (value === undefined) {
      return {
        definition,
        value,
        blocking: definition.required,
        errorCode: definition.required ? 'missing_required_input' : null,
      };
    }
    const matches = definition.valueType === 'json'
      || (definition.valueType === 'string' && typeof value === 'string')
      || (definition.valueType === 'number' && typeof value === 'number')
      || (definition.valueType === 'boolean' && typeof value === 'boolean');
    return {
      definition,
      value,
      blocking: !matches,
      errorCode: matches ? null : 'invalid_input',
    };
  });
}

/** The `workflow.run.start` input map, omitting values the author left unset. */
export function buildWorkflowRunStartInputs(
  fields: readonly WorkflowRunInputFieldState[],
): Readonly<Record<string, JsonValue>> | undefined {
  const entries = fields
    .filter((field): field is WorkflowRunInputFieldState & { value: JsonValue } => field.value !== undefined)
    .map((field) => [field.definition.name, field.value] as const);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * Binds immutable trigger evidence to declared inputs **by name**.
 *
 * Evidence is never interpolated into prompt text: an Automation occurrence
 * resolves the same named input map the Run-now sheet fills, and the resolved
 * values are recorded in the frozen Run envelope.
 */
export function bindWorkflowTriggerEvidenceInputs(params: Readonly<{
  inputs: readonly WorkflowInputDefinition[];
  evidence: Readonly<Record<string, JsonValue>>;
}>): Readonly<{
  values: Readonly<Record<string, JsonValue>>;
  unbound: readonly string[];
}> {
  const values: Record<string, JsonValue> = {};
  const unbound: string[] = [];
  for (const definition of params.inputs) {
    const supplied = params.evidence[definition.name];
    if (supplied !== undefined) {
      values[definition.name] = supplied;
      continue;
    }
    if (definition.default !== undefined) {
      values[definition.name] = definition.default;
      continue;
    }
    if (definition.required) unbound.push(definition.name);
  }
  return { values, unbound };
}

// ---------------------------------------------------------------------------
// Save eligibility
// ---------------------------------------------------------------------------

export type WorkflowSaveBlockedReason =
  | 'name_required'
  | 'unsupported_persisted_attachment'
  | 'definition_invalid';

/**
 * Save is unavailable only for reasons the author can act on, and the reason is
 * specific: a staged-media attachment without a durable Account reference blocks
 * Save rather than being silently dropped.
 */
export function resolveWorkflowSaveBlockedReason(params: Readonly<{
  draft: WorkflowEditorDraft;
  validation: WorkflowDraftValidation;
}>): WorkflowSaveBlockedReason | null {
  if (params.draft.name.trim().length === 0) return 'name_required';
  if (params.validation.issues.some((issue) => issue.code === 'unsupported_persisted_attachment')) {
    return 'unsupported_persisted_attachment';
  }
  return params.validation.valid ? null : 'definition_invalid';
}

/**
 * Why a page-level command cannot make progress right now.
 *
 * Run now, Schedule and Export share this one owner so a disabled control can
 * always name its cause. A control that cannot say why it is inert is the
 * silent no-op UX §3.3 forbids, and three local predicates would drift.
 */
export type WorkflowCommandBlockedReason =
  | WorkflowSaveBlockedReason
  /** No exact Machine and project folder has been resolved for this draft. */
  | 'target_required'
  /** The same command is already in flight; duplicate submission is refused. */
  | 'pending';

export function resolveWorkflowRunBlockedReason(params: Readonly<{
  validation: WorkflowDraftValidation;
  /** True only when an exact Machine and a non-empty project directory exist. */
  targetResolved: boolean;
  pending?: boolean;
}>): WorkflowCommandBlockedReason | null {
  if (params.pending === true) return 'pending';
  if (!params.targetResolved) return 'target_required';
  return params.validation.valid ? null : 'definition_invalid';
}

/**
 * Export serializes through the canonical definition codec, which rejects an
 * invalid draft. Refusing before the press is truthful; alerting after it is
 * the failure this replaces. A name is not required to export.
 */
export function resolveWorkflowExportBlockedReason(params: Readonly<{
  validation: WorkflowDraftValidation;
}>): WorkflowCommandBlockedReason | null {
  return params.validation.valid ? null : 'definition_invalid';
}

/** Steps in authored order, which the announcement and Flow owners both read. */
export function listWorkflowSteps(draft: WorkflowEditorDraft): readonly WorkflowStep[] {
  return walkWorkflowBlocks(draft.blocks).filter((block): block is WorkflowStep => block.kind === 'step');
}
