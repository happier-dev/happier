import { z } from 'zod';

import { StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { WorkflowBlockIdProtocolSchema } from './workflowBlockIdProtocol.js';

export {
  WorkflowBlockIdProtocolSchema,
  type WorkflowBlockId,
} from './workflowBlockIdProtocol.js';

/** Canonical Zod projection for incumbent workflow schemas. */
export const WorkflowBlockIdSchema = asProtocolZod(WorkflowBlockIdProtocolSchema);

/**
 * Typed workflow references, scopes and conditions.
 *
 * These are the authored halves of FLOW §3.1: they name a producer **block**
 * plus the scope in which to resolve it. They never contain a runtime
 * invocation/record id — admission binds an authored reference to the exact
 * parent-owned invocation row, and that binding is private progress content.
 *
 * The daemon interpreter and the editor both import these declarations; there
 * is no second reference dialect.
 */

/** Declared workflow input names use identifier syntax so they can be named in evidence bindings. */
export const WorkflowInputNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);

export const WorkflowReferenceScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current') }).strict(),
  z.object({ kind: z.literal('previous_iteration'), loopBlockId: WorkflowBlockIdSchema }).strict(),
  z.object({ kind: z.literal('outer'), levels: z.number().int().positive().safe() }).strict(),
]);
export type WorkflowReferenceScope = z.infer<typeof WorkflowReferenceScopeSchema>;

/** Lexical block lists, rooted at the enclosing Workflow frame. */
export type WorkflowLexicalScope = Readonly<{
  loop?: Readonly<{
    blockId: string;
    kind: 'count' | 'items' | 'until' | 'evaluate';
    execution?: 'sequential' | 'parallel';
  }>;
}>;

export type WorkflowLexicalScopeSelection =
  | Readonly<{ kind: 'current'; levelIndex: number }>
  | Readonly<{ kind: 'previous_iteration'; levelIndex: number; loopBlockId: string }>
  | Readonly<{ kind: 'invalid'; code: 'invalid_reference_scope' }>;

/** Choose a lexical list, without loading or deciding availability of its rows. */
export function selectWorkflowLexicalScope(
  levels: readonly WorkflowLexicalScope[],
  scope: WorkflowReferenceScope,
): WorkflowLexicalScopeSelection {
  if (levels.length > 0) {
    if (scope.kind === 'current') return { kind: 'current', levelIndex: levels.length - 1 };
    if (scope.kind === 'outer') {
      const levelIndex = levels.length - 1 - scope.levels;
      if (Number.isSafeInteger(scope.levels) && scope.levels > 0 && levelIndex >= 0) {
        return { kind: 'current', levelIndex };
      }
    } else {
      for (let levelIndex = levels.length - 1; levelIndex >= 0; levelIndex -= 1) {
        const loop = levels[levelIndex]!.loop;
        if (loop?.blockId !== scope.loopBlockId) continue;
        if (loop.kind === 'items' && loop.execution === 'parallel') break;
        return { kind: 'previous_iteration', levelIndex, loopBlockId: loop.blockId };
      }
    }
  }
  return { kind: 'invalid', code: 'invalid_reference_scope' };
}

/**
 * Authored producer reference. This exists before any invocation row does, so
 * it names the authored block plus the scope that selects which occurrence of
 * that block the consumer means.
 */
export const WorkflowAuthoredProducerRefSchema = z.object({
  blockId: WorkflowBlockIdSchema,
  scope: WorkflowReferenceScopeSchema.default({ kind: 'current' }),
}).strict();
export type WorkflowAuthoredProducerRef = z.infer<typeof WorkflowAuthoredProducerRefSchema>;

export const WorkflowResultPathSchema = z
  .array(z.union([z.string(), z.number().int().nonnegative().safe()]))
  .default([]);

export const WorkflowAuthoredResultReferenceSchema = z.object({
  kind: z.literal('result'),
  producer: WorkflowAuthoredProducerRefSchema,
  path: WorkflowResultPathSchema,
  optional: z.literal(true).optional(),
}).strict();
export type WorkflowAuthoredResultReference = z.infer<typeof WorkflowAuthoredResultReferenceSchema>;

/**
 * Authored projection of one exact producer invocation's persisted workspace.
 * The definition keeps the scoped producer reference; runtime resolves that
 * reference to the private row-local descriptor before materializing input.
 */
export const WorkflowAuthoredWorkspaceReferenceSchema = z.object({
  kind: z.literal('workspace'),
  producer: WorkflowAuthoredProducerRefSchema,
  field: z.enum(['directory', 'checkoutRootPath']),
}).strict();
export type WorkflowAuthoredWorkspaceReference = z.infer<typeof WorkflowAuthoredWorkspaceReferenceSchema>;

/** Count consecutive matching results in the nearest loop's committed history. */
export const WorkflowLoopTrailingCountReferenceSchema = z.object({
  kind: z.literal('loop_trailing_count'),
  producer: WorkflowAuthoredProducerRefSchema,
  path: WorkflowResultPathSchema,
  equals: StrictJsonValueSchema,
}).strict();
export type WorkflowLoopTrailingCountReference = z.infer<typeof WorkflowLoopTrailingCountReferenceSchema>;

export type WorkflowValueReference =
  | Readonly<{ kind: 'literal'; value: JsonValue }>
  | Readonly<{ kind: 'input'; name: string }>
  | WorkflowAuthoredResultReference
  | WorkflowAuthoredWorkspaceReference
  | WorkflowLoopTrailingCountReference
  | Readonly<{ kind: 'session_context'; recentTurns: number }>
  | Readonly<{ kind: 'session_context_field'; field: 'usage.tokensUsed' | 'goal.tokenBudget' }>
  | Readonly<{ kind: 'item'; field: 'value' | 'index' | 'position' | 'count'; path?: (string | number)[] }>
  | Readonly<{ kind: 'iteration'; field: 'index' | 'position' | 'count' | 'stopReason' }>;

/** Shared path selection for frozen admission facts and invocation-time inputs. */
export function readWorkflowValuePathV1(value: JsonValue, path: readonly (string | number)[]): JsonValue | undefined {
  let selected: JsonValue | undefined = value;
  for (const segment of path) {
    selected = Array.isArray(selected)
      ? typeof segment === 'number' ? selected[segment] : segment === 'last' ? selected.at(-1) : undefined
      : selected !== null && typeof selected === 'object' && typeof segment === 'string'
        ? (selected as Readonly<Record<string, JsonValue>>)[segment] : undefined;
    if (selected === undefined) return undefined;
  }
  return selected;
}

export const WorkflowValueReferenceSchema: z.ZodType<WorkflowValueReference> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: StrictJsonValueSchema }).strict(),
  z.object({ kind: z.literal('input'), name: WorkflowInputNameSchema }).strict(),
  WorkflowAuthoredResultReferenceSchema,
  WorkflowAuthoredWorkspaceReferenceSchema,
  WorkflowLoopTrailingCountReferenceSchema,
  z.object({ kind: z.literal('session_context'), recentTurns: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.literal('session_context_field'), field: z.enum(['usage.tokensUsed', 'goal.tokenBudget']) }).strict(),
  z.object({ kind: z.literal('item'), field: z.enum(['value', 'index', 'position', 'count']),
    path: WorkflowResultPathSchema.unwrap().optional() }).strict().superRefine((reference, ctx) => {
      if (reference.path !== undefined && reference.field !== 'value') {
        ctx.addIssue({ code: 'custom', path: ['path'], message: 'Only the item value has a field path' });
      }
    }),
  z.object({ kind: z.literal('iteration'), field: z.enum(['index', 'position', 'count', 'stopReason']) }).strict(),
]) as unknown as z.ZodType<WorkflowValueReference>;

export const WORKFLOW_COMPARE_OPERATORS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'] as const;
export type WorkflowCompareOperator = (typeof WORKFLOW_COMPARE_OPERATORS)[number];

export type WorkflowCondition =
  | Readonly<{ kind: 'exists'; value: WorkflowValueReference }>
  | Readonly<{
    kind: 'compare';
    operator: WorkflowCompareOperator;
    left: WorkflowValueReference;
    right: WorkflowValueReference;
  }>
  | Readonly<{ kind: 'all'; conditions: readonly WorkflowCondition[] }>
  | Readonly<{ kind: 'any'; conditions: readonly WorkflowCondition[] }>
  | Readonly<{ kind: 'not'; condition: WorkflowCondition }>;

export const WorkflowConditionSchema: z.ZodType<WorkflowCondition> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exists'), value: WorkflowValueReferenceSchema }).strict(),
  z.object({
    kind: z.literal('compare'),
    operator: z.enum(WORKFLOW_COMPARE_OPERATORS),
    left: WorkflowValueReferenceSchema,
    right: WorkflowValueReferenceSchema,
  }).strict(),
  z.object({ kind: z.literal('all'), conditions: z.array(WorkflowConditionSchema).min(1) }).strict(),
  z.object({ kind: z.literal('any'), conditions: z.array(WorkflowConditionSchema).min(1) }).strict(),
  z.object({ kind: z.literal('not'), condition: WorkflowConditionSchema }).strict(),
])) as unknown as z.ZodType<WorkflowCondition>;

/**
 * Conversation continuity is authored separately from workspace continuity and
 * from dataflow: reusing a conversation never implies reusing a workspace, and
 * sharing a workspace never implies sharing history.
 */
export const WorkflowConversationSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shared_run') }).strict(),
  z.object({ kind: z.literal('fresh') }).strict(),
  z.object({ kind: z.literal('origin_session') }).strict(),
  z.object({ kind: z.literal('from_step'), producer: WorkflowAuthoredProducerRefSchema }).strict(),
  z.object({
    kind: z.literal('existing_session'),
    sessionId: z.string().min(1),
    machineId: z.string().min(1),
  }).strict(),
]);
export type WorkflowConversationSelection = z.infer<typeof WorkflowConversationSelectionSchema>;

/** Every reference kind that names another block, so scope validation has one walker. */
export function collectWorkflowConditionValueReferences(
  condition: WorkflowCondition,
): readonly WorkflowValueReference[] {
  const collected: WorkflowValueReference[] = [];
  const pending: WorkflowCondition[] = [condition];
  while (pending.length > 0) {
    const current = pending.pop()!;
    switch (current.kind) {
      case 'exists':
        collected.push(current.value);
        break;
      case 'compare':
        collected.push(current.left, current.right);
        break;
      case 'all':
      case 'any':
        for (const nested of current.conditions) pending.push(nested);
        break;
      case 'not':
        pending.push(current.condition);
        break;
    }
  }
  return collected;
}
