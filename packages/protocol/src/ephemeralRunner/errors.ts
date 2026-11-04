import { z } from 'zod/mini';

/**
 * The one Runner server error vocabulary.
 *
 * Every code here is emitted by a registered creator/endpoint route in
 * `apps/server/sources/app/ephemeralRunner/routes.ts`, which types its error
 * replies with {@link RunnerServerErrorV1Schema}; the compiler therefore keeps
 * the routes and this enum in step. Codes with no producer are not carried: a
 * published vocabulary that contradicts the live surface is a broken contract,
 * not spare capacity.
 */
export const RunnerServerErrorCodeV1Schema = z.enum([
  // Feature gate and identity.
  'not_found',
  'forbidden',
  // Request validation.
  'invalid_input',
  'invalid_request',
  'invalid_proof',
  'recipient_mismatch',
  // Home/runner availability.
  'runner_unavailable',
  'runner_activation_unavailable',
  'runner_creator_currentness_unavailable',
  'runner_artifact_publication_unavailable',
  'runner_artifact_publication_invalid',
  'runner_artifact_not_published',
  'runner_artifact_target_not_published',
  'runner_artifact_identity_mismatch',
  'credential_authentication_evidence_unavailable',
  // Concurrency and state conflicts.
  'activation_conflict',
  'activation_progress_conflict',
  'runner_activation_conflict',
  'runner_endpoint_facts_conflict',
  'runner_endpoint_facts_mode_mismatch',
  'review_conflict',
  'materialization_conflict',
]);
export type RunnerServerErrorCodeV1 = z.infer<typeof RunnerServerErrorCodeV1Schema>;

/** Safe publication facts supplied by the shared release reader, never upstream prose. */
export const RunnerArtifactPublicationFailureV1Schema = z.readonly(z.strictObject({
  reason: z.enum(['rate_limited', 'not_found', 'network', 'upstream', 'invalid_publication']),
  resetAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(8.64e15)))),
  status: z.optional(z.number().check(z.int(), z.minimum(100), z.maximum(599))),
}));
export type RunnerArtifactPublicationFailureV1 = z.infer<typeof RunnerArtifactPublicationFailureV1Schema>;

export const RunnerServerErrorV1Schema = z.strictObject({
  error: RunnerServerErrorCodeV1Schema,
  publicationFailure: z.optional(RunnerArtifactPublicationFailureV1Schema),
});
export type RunnerServerErrorV1 = z.infer<typeof RunnerServerErrorV1Schema>;
