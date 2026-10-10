import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import {
  RunnerActivationBindingV1Schema,
  RunnerActivationCloseReasonV1Schema,
  RunnerActivationStateV1Schema,
  RunnerResourceIdSchema,
  RunnerSha256CommitmentSchema,
  type RunnerActivationBindingV1,
} from './activation.js';
import { RunnerClaimV1Schema, RunnerEndpointFactsV1Schema } from './endpoint.js';
import { RunnerConsentV1Schema } from './consent.js';
import { RunnerReadinessV1Schema } from './readiness.js';
import { RunnerActivationReviewV1Schema } from './review.js';
import { RunnerActivationProgressPhaseV1Schema } from './progress.js';

export const RunnerEndpointFactsProjectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), facts: RunnerEndpointFactsV1Schema }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['creator_unavailable', 'recipient_mismatch', 'invalid_content']) }).strict(),
]));

export const RunnerActivationProjectionV1Schema = lazyZodSchema(() => RunnerActivationBindingV1Schema.safeExtend({
  draftId: RunnerResourceIdSchema,
  state: RunnerActivationStateV1Schema,
  closeReason: RunnerActivationCloseReasonV1Schema.nullable(),
  progressPhase: RunnerActivationProgressPhaseV1Schema.nullable().default(null),
  claim: RunnerClaimV1Schema.nullable(),
  endpointFacts: RunnerEndpointFactsProjectionV1Schema.nullable(),
  review: RunnerActivationReviewV1Schema.nullable().default(null),
  consent: RunnerConsentV1Schema.nullable().default(null),
  readiness: RunnerReadinessV1Schema.nullable().default(null),
  materialization: z.object({
    sessionId: RunnerResourceIdSchema,
    machineId: RunnerResourceIdSchema,
  }).strict().nullable().default(null),
}).strict().refine(
  (activation) => (activation.state === 'closed') === (activation.closeReason !== null),
  'Only closed activations have a close reason',
).refine(
  (activation) => !['claimed', 'consented', 'materialized'].includes(activation.state) || activation.claim !== null,
  'Claimed activations retain the signed endpoint claim',
).refine(
  (activation) => !['consented', 'materialized'].includes(activation.state) || (activation.review !== null && activation.consent !== null),
  'Consented activations retain their immutable review and consent',
).refine(
  (activation) => activation.state !== 'materialized' || (activation.readiness !== null && activation.materialization !== null),
  'Materialized activations retain readiness and final identity projection',
));
export type RunnerActivationProjectionV1 = z.infer<typeof RunnerActivationProjectionV1Schema>;

/** Extract only the immutable binding; callers still verify it against local creating-device custody. */
export function runnerActivationProjectionBindingV1(value: RunnerActivationProjectionV1): RunnerActivationBindingV1 {
  const { draftId: _draftId, state: _state, closeReason: _closeReason, progressPhase: _progressPhase, claim: _claim,
    endpointFacts: _endpointFacts, review: _review, consent: _consent, readiness: _readiness,
    materialization: _materialization, ...binding } = RunnerActivationProjectionV1Schema.parse(value);
  return binding;
}
