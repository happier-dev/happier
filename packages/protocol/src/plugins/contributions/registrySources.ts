import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { REGISTRY_FORMAT_KINDS_V1, RegistryKindV1Schema, RegistryPackageContentPathV1Schema } from '../../registries/registrySourcesV1.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';

/** Closed data-only declaration; registry adapters and credentials remain host-owned. */
const PluginRemoteRegistrySourceContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: z.string().check(z.minLength(1)),
  format: z.enum(['git', 'claude-marketplace', 'mcp-registry', 'acp-registry', 'happier-catalog', 'coolify-templates', 'dokploy-templates']),
  kinds: z.array(RegistryKindV1Schema).check(z.minLength(1)),
  url: z.string().check(z.url(), z.refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch { return false; }
  }, 'Registry declarations require credential-free HTTPS')),
  path: z.optional(z.string()),
  ref: z.optional(z.string().check(z.minLength(1))),
}).check(z.superRefine((source, context) => {
  if (source.kinds.some(kind => !REGISTRY_FORMAT_KINDS_V1[source.format].includes(kind))) {
    context.addIssue({ code: 'custom', path: ['kinds'], message: 'Kind not supported by source format' });
  }
})));

export const PluginRegistrySourceContributionV1Schema = lazyZodSchema(() => z.union([
  PluginRemoteRegistrySourceContributionV1Schema,
  z.strictObject({ id: asProtocolZod(PluginContributionLocalIdSchema), title: z.string().check(z.minLength(1)),
    format: z.literal('happier-catalog'), kinds: z.array(z.literal('app')).check(z.minLength(1), z.maxLength(1)),
    packageContent: z.strictObject({ path: RegistryPackageContentPathV1Schema }) }),
]));

export type PluginRegistrySourceContributionV1 = z.infer<typeof PluginRegistrySourceContributionV1Schema>;
