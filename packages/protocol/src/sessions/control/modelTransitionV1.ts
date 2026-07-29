import { z } from 'zod';

import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';

export const SessionModelTransitionRequestV1Schema = z.object({
  v: z.literal(1),
  selection: ProviderBoundModelRefSchema,
}).strict();
export type SessionModelTransitionRequestV1 = z.infer<
  typeof SessionModelTransitionRequestV1Schema
>;

const SessionModelTransitionSuccessV1Schema = z.object({
  ok: z.literal(true),
  status: z.enum(['applied', 'already_active']),
  activeSelection: ProviderBoundModelRefSchema,
}).strict();

const SessionModelTransitionKnownActiveFailureV1Schema = z.object({
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
  reason: z.string().trim().min(1).max(512).optional(),
}).strict();

const SessionModelTransitionReconciliationRequiredV1Schema = z.object({
  ok: z.literal(false),
  status: z.literal('reconciliation_required'),
  activeSelection: ProviderBoundModelRefSchema.nullable(),
  requestedSelection: ProviderBoundModelRefSchema,
  reason: z.string().trim().min(1).max(512).optional(),
}).strict();

const SessionModelTransitionOwnerUnavailableV1Schema = z.object({
  ok: z.literal(false),
  status: z.literal('owner_unavailable'),
  activeSelection: ProviderBoundModelRefSchema.nullable(),
  requestedSelection: ProviderBoundModelRefSchema,
  reason: z.string().trim().min(1).max(512).optional(),
}).strict();

export const SessionModelTransitionResultV1Schema = z.union([
  SessionModelTransitionSuccessV1Schema,
  SessionModelTransitionKnownActiveFailureV1Schema,
  SessionModelTransitionReconciliationRequiredV1Schema,
  SessionModelTransitionOwnerUnavailableV1Schema,
]);
export type SessionModelTransitionResultV1 = z.infer<
  typeof SessionModelTransitionResultV1Schema
>;
