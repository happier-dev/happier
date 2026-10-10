import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';

const intentOrder = lazyZodSchema(() => z.number().finite().nonnegative());
export const SessionModelMutationScopeV1Schema = lazyZodSchema(() => z.object({
  serverId: z.string().min(1), accountId: z.string().min(1), sessionId: z.string().min(1),
}).strict());
export type SessionModelMutationScopeV1 = z.infer<typeof SessionModelMutationScopeV1Schema>;
/** Conditions name the existing runtime/intent authority, never a client version. */
export const SessionModelMutationExpectedV1Schema = lazyZodSchema(() => z.discriminatedUnion('owner', [
  z.object({ owner: z.literal('active'), scope: SessionModelMutationScopeV1Schema, runId: z.string().min(1), selection: ProviderBoundModelRefSchema, updatedAt: intentOrder }).strict(),
  z.object({ owner: z.literal('inactive'), scope: SessionModelMutationScopeV1Schema, selection: ProviderBoundModelRefSchema, updatedAt: intentOrder }).strict(),
]));
export type SessionModelMutationExpectedV1 = z.infer<typeof SessionModelMutationExpectedV1Schema>;
export const SessionModelMutationReversalV1Schema = lazyZodSchema(() => z.discriminatedUnion('owner', [
  z.object({ owner: z.literal('active'), scope: SessionModelMutationScopeV1Schema, runId: z.string().min(1), before: ProviderBoundModelRefSchema,
    applied: ProviderBoundModelRefSchema, updatedAt: intentOrder }).strict(),
  z.object({ owner: z.literal('inactive'), scope: SessionModelMutationScopeV1Schema, before: ProviderBoundModelRefSchema,
    applied: ProviderBoundModelRefSchema, updatedAt: intentOrder }).strict(),
]));
export type SessionModelMutationReversalV1 = z.infer<typeof SessionModelMutationReversalV1Schema>;

export const SessionModelTransitionRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  selection: ProviderBoundModelRefSchema,
  captureBefore: z.boolean().optional(),
  expected: SessionModelMutationExpectedV1Schema.optional(),
}).strict());
export type SessionModelTransitionRequestV1 = z.infer<
  typeof SessionModelTransitionRequestV1Schema
>;

const SessionModelTransitionSuccessV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  status: z.enum(['applied', 'already_active']),
  activeSelection: ProviderBoundModelRefSchema,
  reversal: SessionModelMutationReversalV1Schema.optional(),
}).strict());

const SessionModelTransitionKnownActiveFailureV1Schema = lazyZodSchema(() => z.object({
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
  reason: z.string().trim().min(1).optional(),
}).strict());

const SessionModelTransitionReconciliationRequiredV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(false),
  status: z.literal('reconciliation_required'),
  activeSelection: ProviderBoundModelRefSchema.nullable(),
  requestedSelection: ProviderBoundModelRefSchema,
  reason: z.string().trim().min(1).optional(),
}).strict());

const SessionModelTransitionOwnerUnavailableV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(false),
  status: z.literal('owner_unavailable'),
  activeSelection: ProviderBoundModelRefSchema.nullable(),
  requestedSelection: ProviderBoundModelRefSchema,
  reason: z.string().trim().min(1).optional(),
}).strict());

export const SessionModelTransitionResultV1Schema = lazyZodSchema(() => z.union([
  SessionModelTransitionSuccessV1Schema,
  SessionModelTransitionKnownActiveFailureV1Schema,
  SessionModelTransitionReconciliationRequiredV1Schema,
  SessionModelTransitionOwnerUnavailableV1Schema,
]));
export type SessionModelTransitionResultV1 = z.infer<
  typeof SessionModelTransitionResultV1Schema
>;
