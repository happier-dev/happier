import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { BackendTargetKeyV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { ProviderAgentTargetKeySchema } from '../providers/ids.js';
import { ProviderBrokerApplicationBindingV1Schema } from '../providers/brokerRouteGrantV1.js';
import { RunnerResourceIdSchema, RunnerSha256CommitmentSchema, RunnerSignatureSchema } from './activation.js';
import { RunnerMachineContentKeyBindingV1Schema } from './machineContentKeyBindingSchema.js';

export const RunnerCredentialSelectionBindingV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  resourceId: RunnerResourceIdSchema,
  brokerMachineId: RunnerResourceIdSchema,
  revision: z.number().int().nonnegative().safe(),
  /** Exact content-free Provider application proven before review. */
  application: ProviderBrokerApplicationBindingV1Schema,
  /** Current source/catalog incarnation proven with that application. */
  sourceRevision: z.string().trim().min(1).max(512),
}).strict());
export type RunnerCredentialSelectionBindingV1 = z.infer<typeof RunnerCredentialSelectionBindingV1Schema>;

const RunnerVerifiedDisplayLabelV1Schema = lazyZodSchema(() => z.string().trim().min(1).superRefine((value, context) => {
  if (/\p{Cc}|[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Verified display labels must not contain control characters' });
  }
  if (Array.from(value).length > 512 || new TextEncoder().encode(value).byteLength > 4_096) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Verified display label exceeds its presentation bound' });
  }
}));

/**
 * Home-authenticated labels frozen for the endpoint consent decision. Exact
 * identities remain in the activation/model bindings and are never derived
 * from these presentation-only values.
 */
export const RunnerConsentDisplayFactsV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  homeId: RunnerResourceIdSchema,
  homeName: RunnerVerifiedDisplayLabelV1Schema,
  requesterId: RunnerResourceIdSchema,
  requesterName: RunnerVerifiedDisplayLabelV1Schema,
  teamId: RunnerResourceIdSchema,
  teamName: RunnerVerifiedDisplayLabelV1Schema,
}).strict());
export type RunnerConsentDisplayFactsV1 = z.infer<typeof RunnerConsentDisplayFactsV1Schema>;

/**
 * Identifies the exact already dual-signed endpoint-facts singleton used to
 * prepare the sealed review. This reuses the incumbent facts proof instead of
 * introducing another content commitment or facts copy.
 */
export const RunnerEndpointFactsProofV1Schema = lazyZodSchema(() => z.object({
  activationSignature: RunnerSignatureSchema,
  installationSignature: RunnerSignatureSchema,
}).strict());
export type RunnerEndpointFactsProofV1 = z.infer<typeof RunnerEndpointFactsProofV1Schema>;

const RunnerReviewedAgentTargetKeyV1Schema = lazyZodSchema(() => ProviderAgentTargetKeySchema
  .and(BackendTargetKeyV2Schema)
  .refine((value) => value.startsWith('agent:'), 'Runner review must identify an exact qualified Agent target'));

export const RunnerActivationReviewV1Schema = lazyZodSchema(() => z.object({
  sealedLaunchManifest: z.string().min(1).max(1024 * 1024),
  /** Exact first commitment already bound into the activation and claim. */
  authoringCommitment: RunnerSha256CommitmentSchema,
  launchManifestCommitment: RunnerSha256CommitmentSchema,
  endpointFactsProof: RunnerEndpointFactsProofV1Schema,
  agentTargetKey: RunnerReviewedAgentTargetKeyV1Schema,
  machineContentKeyBinding: RunnerMachineContentKeyBindingV1Schema.nullable(),
  credentialSelectionBinding: RunnerCredentialSelectionBindingV1Schema,
  displayFacts: RunnerConsentDisplayFactsV1Schema,
}).strict());
export type RunnerActivationReviewV1 = z.infer<typeof RunnerActivationReviewV1Schema>;
