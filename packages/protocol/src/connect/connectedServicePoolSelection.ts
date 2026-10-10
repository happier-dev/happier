import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { QualifiedConnectedAccountIdSchema } from './qualifiedConnectedAccountPersistence.js';
import { QualifiedConnectedAccountGroupRefSchema } from './qualifiedConnectedAccountProjectionsV4.js';
import { ConnectedServiceAuthGroupPolicyV1Schema } from './connectedServiceSchemas.js';
import { RPC_METHODS } from '../rpc/methods.js';

export const CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD = RPC_METHODS.DAEMON_CONNECTED_SERVICE_POOL_SELECTION_GET;

const ProfileIdSchema = asProtocolZod(QualifiedConnectedAccountIdSchema);
const FiniteNumberSchema = lazyZodSchema(() => z.number().finite());
const SelectionReasonSchema = lazyZodSchema(() => z.enum(['selected', 'manual_strategy', 'no_eligible_members']));
const ExclusionReasonSchema = lazyZodSchema(() => z.enum([
  'current_active', 'disabled', 'cooldown', 'quota_exhausted', 'capacity_limited',
  'auth_invalid', 'credential_unavailable', 'plan_unavailable', 'validation_blocked', 'policy_wait_until_reset',
]));
const CandidateSchema = lazyZodSchema(() => z.object({
  profileId: ProfileIdSchema,
  priority: FiniteNumberSchema,
  createdAtMs: FiniteNumberSchema,
  enabled: z.boolean(),
  leastLimitedScore: FiniteNumberSchema.nullable(),
  preferenceDeadlineMs: FiniteNumberSchema.nullable().optional(),
}).strict());
const CandidateEvidenceSchema = lazyZodSchema(() => z.object({
  profileId: ProfileIdSchema,
  decision: z.enum(['selected', 'eligible', 'excluded']),
  exclusionReason: ExclusionReasonSchema.optional(),
  retryAtMs: FiniteNumberSchema.nullable().optional(),
  quotaEvidence: z.object({
    status: z.enum(['fresh', 'stale_or_missing']),
    remainingPercent: FiniteNumberSchema.nullable().optional(),
    capturedAtMs: FiniteNumberSchema.optional(),
    exhausted: z.boolean().optional(),
  }).strict(),
}).strict());

/** Read evidence only: ordered preference remains independent of a sticky selected member. */
export const ConnectedServicePoolSelectionV1Schema = lazyZodSchema(() => z.object({
  selected: CandidateSchema.nullable(),
  reason: SelectionReasonSchema,
  excluded: z.array(z.object({
    profileId: ProfileIdSchema, reason: ExclusionReasonSchema,
    retryAtMs: FiniteNumberSchema.nullable().optional(),
  }).strict()),
  decisionTrace: z.object({
    activeProfileId: ProfileIdSchema.nullable(),
    reason: SelectionReasonSchema,
    strategy: ConnectedServiceAuthGroupPolicyV1Schema.shape.strategy,
    selectionBasis: z.enum(['manual_strategy', 'no_eligible_members', 'preference', 'primary_restore', 'active_stickiness', 'soft_switch']),
    sticky: z.boolean(),
    orderedEligibleCandidates: z.array(CandidateSchema),
    candidates: z.array(CandidateEvidenceSchema),
  }).strict(),
}).strict());

export const ConnectedServicePoolSelectionGetRequestV1Schema = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1),
  group: QualifiedConnectedAccountGroupRefSchema,
  providerLimitId: z.string().trim().min(1).optional(),
}).strict());

export const ConnectedServicePoolSelectionGetResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({
    group: QualifiedConnectedAccountGroupRefSchema,
    observedAtMs: FiniteNumberSchema,
    selection: ConnectedServicePoolSelectionV1Schema,
  }).strict(),
  z.object({ status: z.literal('unavailable'), code: z.enum([
    'connected_account_daemon_owner_unavailable', 'connected_account_daemon_runtime_unavailable',
    'connected_account_daemon_response_invalid', 'unsupported',
  ]) }).strict(),
]));

export type ConnectedServicePoolSelectionV1 = z.infer<typeof ConnectedServicePoolSelectionV1Schema>;
export type ConnectedServicePoolSelectionGetRequestV1 = z.infer<typeof ConnectedServicePoolSelectionGetRequestV1Schema>;
export type ConnectedServicePoolSelectionGetResponseV1 = z.infer<typeof ConnectedServicePoolSelectionGetResponseV1Schema>;
