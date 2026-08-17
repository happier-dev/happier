import { z } from 'zod';

export const PluginSourceKindV1Schema = z.enum(['bundled', 'path', 'marketplace', 'package', 'archive']);
export type PluginSourceKindV1 = z.infer<typeof PluginSourceKindV1Schema>;

export const PluginSourceTrustPolicyV1Schema = z.enum(['local_trusted', 'prompt', 'untrusted']);
export type PluginSourceTrustPolicyV1 = z.infer<typeof PluginSourceTrustPolicyV1Schema>;

export const PluginSourceInstallPolicyV1Schema = z.enum(['link', 'copy', 'managed_install']);
export type PluginSourceInstallPolicyV1 = z.infer<typeof PluginSourceInstallPolicyV1Schema>;

export const PluginSourceSpecV1Schema = z.object({
  kind: PluginSourceKindV1Schema,
  locator: z.string().trim().min(1),
  trustPolicy: PluginSourceTrustPolicyV1Schema,
  installPolicy: PluginSourceInstallPolicyV1Schema,
  resolvedVersion: z.string().trim().min(1).optional(),
  installedAt: z.number().int().nonnegative().optional(),
  devWatch: z.boolean().optional(),
}).passthrough().superRefine((source, context) => {
  if ('resolvedDigest' in source) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolvedDigest'],
      message: 'Plugin source provenance must not carry a raw resolved digest',
    });
  }
});
export type PluginSourceSpecV1 = z.infer<typeof PluginSourceSpecV1Schema>;
