import { z } from 'zod';

import { PluginIdSchema } from './pluginId.js';

export const PluginContributionProvenanceV1Schema = z.enum(['built_in', 'first_party', 'external']);
export type PluginContributionProvenanceV1 = z.infer<typeof PluginContributionProvenanceV1Schema>;

export const PluginContributionIdentityV1Schema = z.object({
  pluginId: PluginIdSchema,
  family: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  provenance: PluginContributionProvenanceV1Schema,
}).strict();
export type PluginContributionIdentityV1 = z.infer<typeof PluginContributionIdentityV1Schema>;

export function createPluginContributionIdentity(
  input: PluginContributionIdentityV1,
): PluginContributionIdentityV1 {
  return PluginContributionIdentityV1Schema.parse(input);
}

export function buildQualifiedPluginContributionKey(identity: PluginContributionIdentityV1): string {
  return `${identity.pluginId}:${identity.family}:${identity.contributionId}`;
}
