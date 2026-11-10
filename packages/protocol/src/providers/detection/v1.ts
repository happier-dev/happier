import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { ProviderEndpointUrlSyntaxSchema } from '../endpointUrlSchema.js';
import { canonicalizeProviderContributionKeyV1 } from '../contributionIdentityV1.js';
import { createProviderFingerprintV1 } from '../fingerprints.js';
import {
  ProviderConnectionIdSchema,
  ProviderContributionKeySchema,
  ProviderLocalIdSchema,
  ProviderMachineIdSchema,
} from '../ids.js';

export {
  ProviderCatalogCommandFallbackV1Schema,
  ProviderCommandCatalogParserV1Schema,
  ProviderDetectionDescriptorV1Schema,
  type ProviderCatalogCommandFallbackV1,
  type ProviderCommandCatalogParserV1,
  type ProviderDetectionDescriptorV1,
} from './descriptorV1.js';

export const ProviderDiscoveryCandidateEvidenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('attributed_listener') }),
  z.strictObject({ kind: z.literal('default_port_hint') }),
]));
export type ProviderDiscoveryCandidateEvidenceV1 = z.infer<typeof ProviderDiscoveryCandidateEvidenceV1Schema>;

export const ManagedProviderProcessOwnershipSchema = lazyZodSchema(() => z.enum(['owned', 'adopted']));
export type ManagedProviderProcessOwnership = z.infer<typeof ManagedProviderProcessOwnershipSchema>;

const ProviderDiscoveryCandidateConnectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('matched'), connectionId: ProviderConnectionIdSchema }),
  z.strictObject({ status: z.literal('enable_default') }),
  z.strictObject({ status: z.literal('requires_named_connection') }),
]));

export const ProviderDiscoveryCandidateIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256), z.startsWith('discovery-candidate:v1:')));
export type ProviderDiscoveryCandidateIdV1 = z.infer<typeof ProviderDiscoveryCandidateIdV1Schema>;

export function createProviderDiscoveryCandidateIdV1(input: Readonly<{
  machineId: string;
  contributionKey: string;
  endpointTemplateId: string;
  normalizedEndpointUrl: string;
}>): ProviderDiscoveryCandidateIdV1 {
  return ProviderDiscoveryCandidateIdV1Schema.parse(createProviderFingerprintV1('discovery-candidate', {
    machineId: ProviderMachineIdSchema.parse(input.machineId),
    contributionKey: canonicalizeProviderContributionKeyV1(
      ProviderContributionKeySchema.parse(input.contributionKey),
    ),
    endpointTemplateId: ProviderLocalIdSchema.parse(input.endpointTemplateId),
    normalizedEndpointUrl: ProviderEndpointUrlSyntaxSchema.parse(input.normalizedEndpointUrl),
  }));
}

/**
 * Redacted pre-connection evidence derived from the daemon's local-listener inventory.
 * A candidate is not endpoint availability and deliberately carries no process facts,
 * model count, credential state, or implicit connection identity.
 */
export const ProviderDiscoveryCandidateV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  machineId: ProviderMachineIdSchema,
  contributionKey: ProviderContributionKeySchema,
  providerName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  endpointTemplateId: ProviderLocalIdSchema,
  normalizedEndpointUrl: ProviderEndpointUrlSyntaxSchema,
  // Optional only for mixed-version reads. Current daemons always issue it;
  // callers must fail closed rather than deriving authority when it is absent.
  candidateId: z.optional(ProviderDiscoveryCandidateIdV1Schema),
  evidence: ProviderDiscoveryCandidateEvidenceV1Schema,
  ownership: ManagedProviderProcessOwnershipSchema,
  connection: ProviderDiscoveryCandidateConnectionV1Schema,
}));
export type ProviderDiscoveryCandidateV1 = z.infer<typeof ProviderDiscoveryCandidateV1Schema>;

/** Local binary/application presence when no listening candidate exists. */
export const ProviderLocalInstallationSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  machineId: ProviderMachineIdSchema,
  contributionKey: ProviderContributionKeySchema,
  providerName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  status: z.enum(['installed_not_running', 'app_running_server_off']),
  managedStartAvailable: z.boolean(),
}));
export type ProviderLocalInstallationSummaryV1 = z.infer<typeof ProviderLocalInstallationSummaryV1Schema>;
