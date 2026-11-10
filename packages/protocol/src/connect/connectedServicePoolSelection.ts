import * as zMini from '../zodRuntimePolicy.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { QualifiedConnectedAccountIdSchema, QualifiedConnectedAccountRefSchema } from './qualifiedConnectedAccountPersistence.js';
import { QualifiedConnectedAccountGroupRefSchema } from './qualifiedConnectedAccountProjectionsV4.js';
import { ConnectedServiceAuthGroupPolicyV2Schema, ConnectedServiceAuthGroupStateV1Schema } from './connectedServiceSchemas.js';
import { RPC_METHODS } from '../rpc/methods.js';

export const CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD = RPC_METHODS.DAEMON_CONNECTED_SERVICE_POOL_SELECTION_GET;

const ProfileIdSchema = asProtocolZod(QualifiedConnectedAccountIdSchema);
const FiniteNumberSchema = lazyZodSchema(() => z.number());
const SelectionReasonSchema = lazyZodSchema(() => z.enum(['selected', 'manual_strategy', 'no_eligible_members']));
const ExclusionReasonSchema = lazyZodSchema(() => z.enum([
  'current_active', 'disabled', 'cooldown', 'quota_exhausted', 'capacity_limited',
  'auth_invalid', 'credential_unavailable', 'plan_unavailable', 'validation_blocked', 'policy_wait_until_reset',
  'quota_probe_deferred', 'quota_evidence_unavailable', 'not_meaningfully_better',
]));
const CandidateSchema = lazyZodSchema(() => z.strictObject({
  profileId: ProfileIdSchema,
  priority: FiniteNumberSchema,
  createdAtMs: FiniteNumberSchema,
  enabled: z.boolean(),
  leastLimitedScore: z.nullable(FiniteNumberSchema),
  preferenceDeadlineMs: z.optional(z.nullable(FiniteNumberSchema)),
}));
const CandidateEvidenceSchema = lazyZodSchema(() => z.strictObject({
  profileId: ProfileIdSchema,
  decision: z.enum(['selected', 'eligible', 'excluded']),
  exclusionReason: z.optional(ExclusionReasonSchema),
  retryAtMs: z.optional(z.nullable(FiniteNumberSchema)),
  quotaEvidence: z.strictObject({
    status: z.enum(['fresh', 'stale_or_missing']),
    remainingPercent: z.optional(z.nullable(FiniteNumberSchema)),
    capturedAtMs: z.optional(FiniteNumberSchema),
    exhausted: z.optional(z.boolean()),
  }),
}));

/** Read evidence only: ordered preference remains independent of a sticky selected member. */
export const ConnectedServicePoolSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  selected: z.nullable(CandidateSchema),
  reason: SelectionReasonSchema,
  excluded: z.array(z.strictObject({
    profileId: ProfileIdSchema, reason: ExclusionReasonSchema,
    retryAtMs: z.optional(z.nullable(FiniteNumberSchema)),
  })),
  decisionTrace: z.strictObject({
    activeProfileId: zMini.nullable(ProfileIdSchema),
    reason: SelectionReasonSchema,
    strategy: ConnectedServiceAuthGroupPolicyV2Schema.shape.strategy,
    selectionBasis: z.enum(['manual_strategy', 'no_eligible_members', 'preference', 'primary_restore', 'active_stickiness', 'soft_switch']),
    sticky: z.boolean(),
    orderedEligibleCandidates: z.array(CandidateSchema),
    candidates: z.array(CandidateEvidenceSchema),
  }),
}));

export const ConnectedServicePoolSelectionGetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  group: QualifiedConnectedAccountGroupRefSchema,
  providerLimitId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Evaluates retained facts only; it neither switches accounts nor predicts a refreshed quota. */
  hypothetical: z.optional(z.strictObject({
    strategy: zMini.optional(ConnectedServiceAuthGroupPolicyV2Schema.shape.strategy),
    atMs: z.optional(z.number().check(z.nonnegative())),
  })),
}));

export const ConnectedServicePoolSelectionGetResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    group: QualifiedConnectedAccountGroupRefSchema,
    observedAtMs: FiniteNumberSchema,
    selection: ConnectedServicePoolSelectionV1Schema,
    hypothetical: z.optional(z.strictObject({
      strategy: ConnectedServiceAuthGroupPolicyV2Schema.shape.strategy,
      atMs: z.number().check(z.nonnegative()),
    })),
    activeAccountRef: z.optional(z.nullable(asProtocolZod(QualifiedConnectedAccountRefSchema))),
    activeSince: ConnectedServiceAuthGroupStateV1Schema._zod.def.innerType.shape.activeSince,
  }),
  z.strictObject({ status: z.literal('unavailable'), code: z.enum([
    'connected_account_daemon_owner_unavailable', 'connected_account_daemon_runtime_unavailable',
    'connected_account_daemon_response_invalid', 'unsupported',
  ]) }),
]));

export type ConnectedServicePoolSelectionV1 = z.infer<typeof ConnectedServicePoolSelectionV1Schema>;
export type ConnectedServicePoolSelectionGetRequestV1 = z.infer<typeof ConnectedServicePoolSelectionGetRequestV1Schema>;
export type ConnectedServicePoolSelectionGetResponseV1 = z.infer<typeof ConnectedServicePoolSelectionGetResponseV1Schema>;
