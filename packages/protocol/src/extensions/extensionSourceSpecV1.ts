import { z } from 'zod';

export const ExtensionSourceKindV1Schema = z.enum(['path', 'marketplace', 'package', 'archive']);
export type ExtensionSourceKindV1 = z.infer<typeof ExtensionSourceKindV1Schema>;

export const ExtensionSourceTrustPolicyV1Schema = z.enum(['local_trusted', 'prompt', 'untrusted']);
export type ExtensionSourceTrustPolicyV1 = z.infer<typeof ExtensionSourceTrustPolicyV1Schema>;

export const ExtensionSourceInstallPolicyV1Schema = z.enum(['link', 'copy', 'managed_install']);
export type ExtensionSourceInstallPolicyV1 = z.infer<typeof ExtensionSourceInstallPolicyV1Schema>;

export const ExtensionSourceSpecV1Schema = z.object({
  kind: ExtensionSourceKindV1Schema,
  locator: z.string().trim().min(1),
  trustPolicy: ExtensionSourceTrustPolicyV1Schema,
  installPolicy: ExtensionSourceInstallPolicyV1Schema,
  resolvedVersion: z.string().trim().min(1).optional(),
  resolvedDigest: z.string().trim().min(1).optional(),
  installedAt: z.number().int().nonnegative().optional(),
}).passthrough();
export type ExtensionSourceSpecV1 = z.infer<typeof ExtensionSourceSpecV1Schema>;
