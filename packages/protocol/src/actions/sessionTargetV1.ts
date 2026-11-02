import { z } from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { SessionListFilterV1Schema } from '../sessions/listFilter/sessionListFilterV1.js';
import { ActionExecuteFailureSchema } from './actionExecutionResult.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ActionSessionAddressV1Schema } from './sessionAddressV1.js';
export { ActionSessionAddressV1Schema, type ActionSessionAddressV1 } from './sessionAddressV1.js';

const ExactSessionReferenceV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

/** Closed routing intent. `of` is an exact reference and never another selector. */
export const SessionTargetSelectorV1Schema = lazyZodSchema(() => z.discriminatedUnion('selector', [
  z.strictObject({ selector: z.literal('self'), of: z.optional(ExactSessionReferenceV1Schema) }),
  z.strictObject({ selector: z.literal('manager'), of: z.optional(ExactSessionReferenceV1Schema) }),
  z.strictObject({ selector: z.literal('workers'), of: z.optional(ExactSessionReferenceV1Schema), recursive: z.optional(z.boolean()) }),
  z.strictObject({ selector: z.literal('siblings'), of: z.optional(ExactSessionReferenceV1Schema) }),
  z.strictObject({ selector: z.literal('followers'), of: z.optional(ExactSessionReferenceV1Schema) }),
  z.strictObject({ selector: z.literal('following'), of: z.optional(ExactSessionReferenceV1Schema) }),
  z.strictObject({ selector: z.literal('discussion'), discussionId: ExactSessionReferenceV1Schema, of: z.optional(ExactSessionReferenceV1Schema) }),
  z.strictObject({ selector: z.literal('matching'), filter: SessionListFilterV1Schema, of: z.optional(ExactSessionReferenceV1Schema) }),
]));
export type SessionTargetSelectorV1 = z.infer<typeof SessionTargetSelectorV1Schema>;

/** Exact predecessor ids and current selector intent share one Action input contract. */
export type SessionTargetV1 = string | SessionTargetSelectorV1;
// A normalized filter has readonly collections. Parsing clones them; author
// input must accept that same intent rather than require mutable UI state.
export const SessionTargetV1Schema: z.ZodMiniType<SessionTargetV1, SessionTargetV1> = lazyZodSchema(
  () => z.union([ExactSessionReferenceV1Schema, SessionTargetSelectorV1Schema]),
);

export const SessionTargetV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(SessionTargetV1Schema));

/** The sole shorthand adapter; clients send its input unchanged to the Actions front door. */
export function normalizeSessionTargetV1(input: unknown): SessionTargetV1 {
  const target = SessionTargetV1Schema.parse(input);
  if (typeof target !== 'string') return target;
  if (target === 'self' || target === 'manager' || target === 'workers' || target === 'siblings'
    || target === 'followers' || target === 'following') return { selector: target };
  if (target.startsWith('discussion:')) {
    return SessionTargetSelectorV1Schema.parse({ selector: 'discussion', discussionId: target.slice('discussion:'.length) });
  }
  if (target.startsWith('matching:')) {
    return SessionTargetSelectorV1Schema.parse({ selector: 'matching', filter: JSON.parse(target.slice('matching:'.length)) });
  }
  return target;
}

/** Declaration-owned operational operand; provenance and CAS references do not acquire selectors. */
export const ActionSessionTargetDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  field: z.string().check(z.trim(), z.minLength(1)),
  cardinality: z.enum(['one', 'many']),
}));
export type ActionSessionTargetDeclarationV1 = z.infer<typeof ActionSessionTargetDeclarationV1Schema>;

export const ActionSessionAddressV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(ActionSessionAddressV1Schema));

/** Read-only inspection; an unavailable corpus never publishes a sendable subset. */
export const SessionTargetPreviewV1Schema = lazyZodSchema(() => z.strictObject({
  coverage: z.enum(['complete', 'unavailable']),
  addresses: z.array(ActionSessionAddressV1Schema),
  error: z.nullable(z.string().check(z.minLength(1))),
  cause: z.optional(z.string().check(z.minLength(1))),
}));
export type SessionTargetPreviewV1 = z.infer<typeof SessionTargetPreviewV1Schema>;

/** Approval retains exact reviewed addresses, not an intent that can expand again. */
export const ActionResolvedSessionTargetsV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.string().check(z.minLength(1)),
  field: z.string().check(z.trim(), z.minLength(1)),
  targets: z.array(ActionSessionAddressV1Schema).check(z.minLength(1)),
  /** Group result projection: self/manager keep a single result, workers/siblings fan out. */
  selector: z.boolean(),
  /** Independently-one collection operands retain their reviewed slot, never a second enumeration. */
  operands: z.optional(z.array(z.strictObject({
    field: z.string().check(z.minLength(1)),
    target: ActionSessionAddressV1Schema,
  })).check(z.minLength(1))),
}));
export type ActionResolvedSessionTargetsV1 = z.infer<typeof ActionResolvedSessionTargetsV1Schema>;

function createSessionFanoutSchema<TSchema extends z.core.$ZodType>(singleSchema: TSchema) {
  return z.strictObject({
    kind: z.literal('fanout'),
    results: z.array(z.strictObject({
      target: ActionSessionAddressV1Schema,
      result: z.union([
        z.strictObject({ ok: z.literal(true), result: singleSchema }),
        ActionExecuteFailureSchema,
      ]),
    })),
  });
}

/** Each leaf retains its own Action result contract, checked by the executor before publication. */
export const ActionSessionFanoutResultV1Schema = lazyZodSchema(() => createSessionFanoutSchema(z.unknown()));
export type ActionSessionFanoutResultV1 = z.infer<typeof ActionSessionFanoutResultV1Schema>;

/** Canonical many-target output, preserving the existing single-target result and every leaf contract. */
export function withSessionTargetFanoutResultV1<TSchema extends z.core.$ZodType>(singleSchema: TSchema) {
  return z.union([
    singleSchema,
    createSessionFanoutSchema(singleSchema),
  ]);
}
