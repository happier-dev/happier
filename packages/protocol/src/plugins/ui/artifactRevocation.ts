import { z } from 'zod';

import { PluginUiArtifactDigestV1Schema } from './artifactIntegrity.js';

export const PluginUiArtifactRevocationScopeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plugin'),
    pluginId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('contribution'),
    pluginId: z.string().trim().min(1),
    contributionId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('digest'),
    digest: PluginUiArtifactDigestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('signingKey'),
    signingKeyId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('installSource'),
    sourceId: z.string().trim().min(1),
  }).strict(),
]);
export type PluginUiArtifactRevocationScopeV1 =
  z.infer<typeof PluginUiArtifactRevocationScopeV1Schema>;

export const PluginUiArtifactRevocationV1Schema = z.object({
  id: z.string().trim().min(1),
  scope: PluginUiArtifactRevocationScopeV1Schema,
  reason: z.enum(['compromised', 'incompatible', 'policy_denied', 'user_disabled', 'unknown']),
  revokedAt: z.string().datetime(),
}).strict();
export type PluginUiArtifactRevocationV1 =
  z.infer<typeof PluginUiArtifactRevocationV1Schema>;
