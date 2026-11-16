import type { AutomationQualifiedPluginContributionRefV1 } from '../automations/automationEventDeclarationV1.js';
import type { AutomationActionRunEvidenceV1 } from '../automations/automationActionOccurrenceV1.js';
import { AutomationActionPhaseV1Schema } from '../automations/automationActionIdentityV1.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { WorkflowBlockIdProtocolSchema } from './workflowBlockIdProtocol.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';

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
export const WorkflowInputNameSchema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z][A-Za-z0-9_]*$/)));

export const WorkflowReferenceScopeSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('current') }),
  z.strictObject({ kind: z.literal('previous_iteration'), loopBlockId: WorkflowBlockIdSchema }),
  z.strictObject({ kind: z.literal('outer'), levels: z.number().check(z.int(), z.positive(), z.int()) }),
]));
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
export const WorkflowAuthoredProducerRefSchema = lazyZodSchema(() => z.strictObject({
  blockId: WorkflowBlockIdSchema,
  scope: z._default(WorkflowReferenceScopeSchema, { kind: 'current' }),
}));
export type WorkflowAuthoredProducerRef = z.infer<typeof WorkflowAuthoredProducerRefSchema>;

export const WorkflowResultPathSchema = lazyZodSchema(() => z._default(z
  .array(z.union([z.string(), z.number().check(z.int(), z.nonnegative(), z.int())])), []));

export const WorkflowAuthoredResultReferenceSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('result'),
  producer: WorkflowAuthoredProducerRefSchema,
  path: WorkflowResultPathSchema,
  optional: z.optional(z.literal(true)),
}));
export type WorkflowAuthoredResultReference = z.infer<typeof WorkflowAuthoredResultReferenceSchema>;

/**
 * Authored projection of one exact producer invocation's persisted workspace.
 * The definition keeps the scoped producer reference; runtime resolves that
 * reference to the private row-local descriptor before materializing input.
 */
export const WorkflowAuthoredWorkspaceReferenceSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('workspace'),
  producer: WorkflowAuthoredProducerRefSchema,
  field: z.enum(['directory', 'checkoutRootPath']),
}));
export type WorkflowAuthoredWorkspaceReference = z.infer<typeof WorkflowAuthoredWorkspaceReferenceSchema>;

/** Count consecutive matching results in the nearest loop's committed history. */
export const WorkflowLoopTrailingCountReferenceSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('loop_trailing_count'),
  producer: WorkflowAuthoredProducerRefSchema,
  path: WorkflowResultPathSchema,
  equals: StrictJsonValueSchema,
}));
export type WorkflowLoopTrailingCountReference = z.infer<typeof WorkflowLoopTrailingCountReferenceSchema>;

export type WorkflowTriggerEventIdentityV1 = AutomationQualifiedPluginContributionRefV1
  | Readonly<{ kind: 'action'; phase: AutomationActionRunEvidenceV1['phase'] }>;

export const WorkflowActionTriggerEventIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('action'), phase: AutomationActionPhaseV1Schema,
}));
export const WorkflowTriggerEventIdentityV1Schema = lazyZodSchema(() => z.union([
  asProtocolZod(PluginContributionIdentityV1Schema), WorkflowActionTriggerEventIdentityV1Schema,
]));

export type WorkflowTriggerEventReferenceV1 = Readonly<{ kind: 'trigger_event'; event: WorkflowTriggerEventIdentityV1; path: (string | number)[] }>;

export const WorkflowTriggerEventReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('trigger_event'), event: WorkflowTriggerEventIdentityV1Schema,
  path: WorkflowResultPathSchema,
}));

export type WorkflowValueReference =
  | WorkflowTriggerEventReferenceV1
  | Readonly<{ kind: 'literal'; value: JsonValue }>
  | Readonly<{ kind: 'input'; name: string; path?: (string | number)[] }>
  | WorkflowAuthoredResultReference
  | WorkflowAuthoredWorkspaceReference
  | WorkflowLoopTrailingCountReference
  | Readonly<{ kind: 'discussion_context'; scope: 'addressing_message' | 'so_far' }>
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

export const WorkflowInputReferenceV1Schema = z.strictObject({
  kind: z.literal('input'), name: WorkflowInputNameSchema, path: z.optional(WorkflowResultPathSchema),
});

export const WorkflowValueReferenceSchema: z.ZodMiniType<WorkflowValueReference> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('literal'), value: StrictJsonValueSchema }),
  WorkflowInputReferenceV1Schema,
  WorkflowTriggerEventReferenceV1Schema,
  WorkflowAuthoredResultReferenceSchema,
  WorkflowAuthoredWorkspaceReferenceSchema,
  WorkflowLoopTrailingCountReferenceSchema,
  z.strictObject({ kind: z.literal('discussion_context'), scope: z.enum(['addressing_message', 'so_far']) }),
  z.strictObject({ kind: z.literal('session_context'), recentTurns: z.number().check(z.int(), z.nonnegative(), z.int()) }),
  z.strictObject({ kind: z.literal('session_context_field'), field: z.enum(['usage.tokensUsed', 'goal.tokenBudget']) }),
  z.strictObject({ kind: z.literal('item'), field: z.enum(['value', 'index', 'position', 'count']),
    path: z.optional(WorkflowResultPathSchema._zod.def.innerType) }).check(z.superRefine((reference, ctx) => {
      if (reference.path !== undefined && reference.field !== 'value') {
        ctx.addIssue({ code: 'custom', path: ['path'], message: 'Only the item value has a field path' });
      }
    })),
  z.strictObject({ kind: z.literal('iteration'), field: z.enum(['index', 'position', 'count', 'stopReason']) }),
]) as unknown as z.ZodMiniType<WorkflowValueReference>;

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

function createWorkflowConditionSchema(stored = false): z.ZodMiniType<WorkflowCondition> {
  const exists = z.strictObject({ kind: z.literal('exists'), value: WorkflowValueReferenceSchema });
  const compare = z.strictObject({
    kind: z.literal('compare'),
    operator: z.enum(WORKFLOW_COMPARE_OPERATORS),
    left: WorkflowValueReferenceSchema,
    right: WorkflowValueReferenceSchema,
  });
  const all = z.strictObject({ kind: z.literal('all'), conditions: z.array(z.unknown()).check(z.minLength(1)) });
  const any = z.strictObject({ kind: z.literal('any'), conditions: z.array(z.unknown()).check(z.minLength(1)) });
  const not = z.strictObject({ kind: z.literal('not'), condition: z.unknown() });
  const canonicalShallow = z.discriminatedUnion('kind', [exists, compare, all, any, not]);
  const shallow = stored ? createStoredReadSchema(canonicalShallow) : canonicalShallow;
  // Conditions have no authored depth cap. Parse their recursive edges with an
  // explicit stack, retaining paths lazily so a valid deep chain stays linear.
  type Path = { parent?: Path; segment: string | number };
  const issuePath = (path?: Path): (string | number)[] => {
    const segments: (string | number)[] = [];
    for (let cursor = path; cursor; cursor = cursor.parent) segments.push(cursor.segment);
    return segments.reverse();
  };
  const schema = z.pipe(z.unknown(), z.transform((value, context): WorkflowCondition => {
    let output: unknown;
    let failed = false;
    const ancestors = new WeakSet<object>();
    type Task = { value: unknown; path?: Path; assign: (value: unknown) => void } | { finish: object };
    const pending: Task[] = [{ value, assign: (parsed) => { output = parsed; } }];
    while (pending.length) {
      const task = pending.pop()!;
      if ('finish' in task) { ancestors.delete(task.finish); continue; }
      if (task.value !== null && typeof task.value === 'object') {
        if (ancestors.has(task.value)) {
          context.issues.push({ code: 'custom', path: issuePath(task.path), message: 'Workflow conditions cannot contain cycles', input: context.value });
          failed = true;
          continue;
        }
        ancestors.add(task.value);
        pending.push({ finish: task.value });
      }
      const parsed = shallow.safeParse(task.value);
      if (!parsed.success) {
        failed = true;
        for (const issue of parsed.error.issues) context.issues.push({ ...issue, path: [...issuePath(task.path), ...issue.path], input: ('input' in issue ? issue.input ?? context.value : context.value) } as z.core.$ZodRawIssue);
        continue;
      }
      const node = parsed.data;
      task.assign(node);
      if (node.kind === 'not') {
        pending.push({ value: node.condition, path: { parent: task.path, segment: 'condition' },
          assign: (child) => { node.condition = child; } });
      } else if (node.kind === 'all' || node.kind === 'any') {
        const parent = { parent: task.path, segment: 'conditions' };
        for (let index = node.conditions.length - 1; index >= 0; index -= 1) {
          pending.push({ value: node.conditions[index], path: { parent, segment: index },
            assign: (child) => { node.conditions[index] = child; } });
        }
      }
    }
    // All nodes and value references have passed their canonical field schemas.
    return failed ? z.NEVER : output as WorkflowCondition;
  }));
  // Export the same recursive declaration graph to Action/SDK JSON Schema
  // consumers, without making it a competing recursive runtime parser.
  const projection: z.ZodMiniType<WorkflowCondition> = z.lazy(() => z.discriminatedUnion('kind', [exists, compare,
    z.extend(all, { conditions: z.array(schema).check(z.minLength(1)) }),
    z.extend(any, { conditions: z.array(schema).check(z.minLength(1)) }),
    z.extend(not, { condition: schema }),
  ])) as z.ZodMiniType<WorkflowCondition>;
  schema._zod.processJSONSchema = (context, _json, params) => {
    context.reused = 'ref';
    z.core.process(projection, context, params);
    context.seen.get(schema)!.ref = projection;
  };
  return schema;
}

export const WorkflowConditionSchema = defineStoredReadProjection(createWorkflowConditionSchema(),
  () => createWorkflowConditionSchema(true));

/**
 * Conversation continuity is authored separately from workspace continuity and
 * from dataflow: reusing a conversation never implies reusing a workspace, and
 * sharing a workspace never implies sharing history.
 */
export const WorkflowConversationSelectionSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('shared_run') }),
  z.strictObject({ kind: z.literal('fresh') }),
  z.strictObject({ kind: z.literal('origin_session') }),
  z.strictObject({ kind: z.literal('input'), name: WorkflowInputNameSchema }),
  z.strictObject({ kind: z.literal('from_step'), producer: WorkflowAuthoredProducerRefSchema }),
  z.strictObject({
    kind: z.literal('existing_session'),
    sessionId: z.string().check(z.minLength(1)),
    machineId: z.string().check(z.minLength(1)),
  }),
]));
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
