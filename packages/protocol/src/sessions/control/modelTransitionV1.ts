import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';
import { SessionModelSelectionV2Schema } from '../../providers/selection/v2.js';

const intentOrder = lazyZodSchema(() => z.number().check(z.nonnegative()));
export const SessionModelMutationScopeV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.minLength(1)), accountId: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)),
}));
export type SessionModelMutationScopeV1 = z.infer<typeof SessionModelMutationScopeV1Schema>;
/** Conditions name the existing runtime/intent authority, never a client version. */
export const SessionModelMutationExpectedV1Schema = lazyZodSchema(() => z.discriminatedUnion('owner', [
  z.strictObject({ owner: z.literal('active'), scope: SessionModelMutationScopeV1Schema, runId: z.string().check(z.minLength(1)), selection: ProviderBoundModelRefSchema, updatedAt: intentOrder }),
  z.strictObject({ owner: z.literal('inactive'), scope: SessionModelMutationScopeV1Schema, selection: ProviderBoundModelRefSchema, updatedAt: intentOrder }),
]));
export type SessionModelMutationExpectedV1 = z.infer<typeof SessionModelMutationExpectedV1Schema>;
export const SessionModelMutationReversalV1Schema = lazyZodSchema(() => z.discriminatedUnion('owner', [
  z.strictObject({ owner: z.literal('active'), scope: SessionModelMutationScopeV1Schema, runId: z.string().check(z.minLength(1)), before: ProviderBoundModelRefSchema,
    applied: ProviderBoundModelRefSchema, updatedAt: intentOrder }),
  z.strictObject({ owner: z.literal('inactive'), scope: SessionModelMutationScopeV1Schema, before: ProviderBoundModelRefSchema,
    applied: ProviderBoundModelRefSchema, updatedAt: intentOrder }),
]));
export type SessionModelMutationReversalV1 = z.infer<typeof SessionModelMutationReversalV1Schema>;

export const SessionModelTransitionRequestV1Schema = lazyZodSchema(() => z.union([z.strictObject({
  v: z.literal(1),
  selection: ProviderBoundModelRefSchema,
  applyTiming: z.optional(z.enum(['immediate', 'next_prompt'])),
  captureBefore: z.optional(z.boolean()),
  expected: z.optional(SessionModelMutationExpectedV1Schema),
}), z.strictObject({ v: z.literal(1), unarm: z.literal(true) })]));
export type SessionModelTransitionRequestV1 = z.infer<
  typeof SessionModelTransitionRequestV1Schema
>;

const SessionModelTransitionSuccessV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  status: z.enum(['applied', 'already_active']),
  activeSelection: ProviderBoundModelRefSchema,
  reversal: z.optional(SessionModelMutationReversalV1Schema),
}));
const SessionModelTransitionArmedV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), status: z.literal('armed'), activeSelection: ProviderBoundModelRefSchema,
  requestedSelection: ProviderBoundModelRefSchema,
}));

const SessionModelTransitionKnownActiveFailureV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  status: z.enum([
    'restart_required',
    'unsupported',
    'superseded',
    'apply_failed',
    'publication_failed_rolled_back',
  ]),
  activeSelection: ProviderBoundModelRefSchema,
  requestedSelection: ProviderBoundModelRefSchema,
  reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

const SessionModelTransitionReconciliationRequiredV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  status: z.literal('reconciliation_required'),
  activeSelection: z.nullable(ProviderBoundModelRefSchema),
  requestedSelection: ProviderBoundModelRefSchema,
  reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

const SessionModelTransitionOwnerUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  status: z.literal('owner_unavailable'),
  activeSelection: z.nullable(ProviderBoundModelRefSchema),
  requestedSelection: ProviderBoundModelRefSchema,
  reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const SessionModelTransitionResultV1Schema = lazyZodSchema(() => z.union([
  SessionModelTransitionSuccessV1Schema,
  SessionModelTransitionArmedV1Schema,
  SessionModelTransitionKnownActiveFailureV1Schema,
  SessionModelTransitionReconciliationRequiredV1Schema,
  SessionModelTransitionOwnerUnavailableV1Schema,
]));
export type SessionModelTransitionResultV1 = z.infer<
  typeof SessionModelTransitionResultV1Schema
>;

/** Public Action successes include the addressed Session and inactive intent writes.
 * Failures use the canonical Action failure envelope rather than this result payload.
 */
export const SessionModelSetResultV1Schema = lazyZodSchema(() => {
  const addressedModel = {
    sessionId: z.string().check(z.minLength(1)),
    modelId: z.string().check(z.minLength(1)),
  };
  const intent = {
    ok: z.literal(true), status: z.literal('intent_updated'),
    sessionId: addressedModel.sessionId, updatedAt: intentOrder,
  };
  return z.union([
    z.strictObject({ ...SessionModelTransitionSuccessV1Schema.shape, ...addressedModel }),
    z.strictObject({ ...SessionModelTransitionArmedV1Schema.shape, ...addressedModel }),
    z.strictObject({ ...intent, modelId: addressedModel.modelId, selection: ProviderBoundModelRefSchema,
      reversal: z.optional(SessionModelMutationReversalV1Schema) }),
    z.strictObject({ ...intent, modelId: z.optional(addressedModel.modelId), selection: SessionModelSelectionV2Schema }),
  ]);
});
export type SessionModelSetResultV1 = z.infer<typeof SessionModelSetResultV1Schema>;
