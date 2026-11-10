import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
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
  z.strictObject({ status: z.literal('available'), facts: RunnerEndpointFactsV1Schema }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['creator_unavailable', 'recipient_mismatch', 'invalid_content']) }),
]));

export const RunnerActivationProjectionV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(RunnerActivationBindingV1Schema, {
  draftId: RunnerResourceIdSchema,
  state: RunnerActivationStateV1Schema,
  closeReason: z.nullable(RunnerActivationCloseReasonV1Schema),
  progressPhase: z._default(z.nullable(RunnerActivationProgressPhaseV1Schema), null),
  claim: z.nullable(RunnerClaimV1Schema),
  endpointFacts: z.nullable(RunnerEndpointFactsProjectionV1Schema),
  review: z._default(z.nullable(RunnerActivationReviewV1Schema), null),
  consent: z._default(z.nullable(RunnerConsentV1Schema), null),
  readiness: z._default(z.nullable(RunnerReadinessV1Schema), null),
  materialization: z._default(z.nullable(z.strictObject({
    sessionId: RunnerResourceIdSchema,
    machineId: RunnerResourceIdSchema,
  })), null),
})).check(z.refine((activation) => (activation.state === 'closed') === (activation.closeReason !== null), 'Only closed activations have a close reason'), z.refine((activation) => !['claimed', 'consented', 'materialized'].includes(activation.state) || activation.claim !== null, 'Claimed activations retain the signed endpoint claim'), z.refine((activation) => !['consented', 'materialized'].includes(activation.state) || (activation.review !== null && activation.consent !== null), 'Consented activations retain their immutable review and consent'), z.refine((activation) => activation.state !== 'materialized' || (activation.readiness !== null && activation.materialization !== null), 'Materialized activations retain readiness and final identity projection')));
export type RunnerActivationProjectionV1 = z.infer<typeof RunnerActivationProjectionV1Schema>;

/** Extract only the immutable binding; callers still verify it against local creating-device custody. */
export function runnerActivationProjectionBindingV1(value: RunnerActivationProjectionV1): RunnerActivationBindingV1 {
  const { draftId: _draftId, state: _state, closeReason: _closeReason, progressPhase: _progressPhase, claim: _claim,
    endpointFacts: _endpointFacts, review: _review, consent: _consent, readiness: _readiness,
    materialization: _materialization, ...binding } = RunnerActivationProjectionV1Schema.parse(value);
  return binding;
}
