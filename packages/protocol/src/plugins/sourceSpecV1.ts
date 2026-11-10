import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const PluginSourceKindV1Schema = lazyZodSchema(() => z.enum(['bundled', 'path', 'marketplace', 'package', 'archive']));
export type PluginSourceKindV1 = z.infer<typeof PluginSourceKindV1Schema>;

export const PluginSourceTrustPolicyV1Schema = lazyZodSchema(() => z.enum(['local_trusted', 'prompt', 'untrusted']));
export type PluginSourceTrustPolicyV1 = z.infer<typeof PluginSourceTrustPolicyV1Schema>;

export const PluginSourceInstallPolicyV1Schema = lazyZodSchema(() => z.enum(['link', 'copy', 'managed_install']));
export type PluginSourceInstallPolicyV1 = z.infer<typeof PluginSourceInstallPolicyV1Schema>;

/**
 * Provenance of an installed plugin record, derived from what the record IS.
 *
 * `marketplace`, `package` and `archive` records were materialized from a
 * published artifact: their declared id and engine range are third-party
 * claims about bytes this machine did not author, so impersonation and
 * host-version rules apply to them. `bundled` ships inside the host, and
 * `path` points at a working tree on this machine — a dev loop, where those
 * two rules only block the maintainer from developing their own plugin.
 *
 * This scopes registry-lifecycle rules only. Containment, trust, entrypoint
 * and schema validation are provenance-independent and stay enforced for
 * every kind.
 */
export function isRegistryCustodiedPluginSourceKind(kind: PluginSourceKindV1): boolean {
  return kind === 'marketplace' || kind === 'package' || kind === 'archive';
}

export const PluginSourceSpecV1Schema = lazyZodSchema(() => z.looseObject({
  kind: PluginSourceKindV1Schema,
  locator: z.string().check(z.trim(), z.minLength(1)),
  trustPolicy: PluginSourceTrustPolicyV1Schema,
  installPolicy: PluginSourceInstallPolicyV1Schema,
  resolvedVersion: z.optional(z.string().check(z.trim(), z.minLength(1))),
  installedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  devWatch: z.optional(z.boolean()),
}).check(z.superRefine((source, context) => {
  if ('resolvedDigest' in source) {
    context.addIssue({
      code: "custom",
      path: ['resolvedDigest'],
      message: 'Plugin source provenance must not carry a raw resolved digest',
    });
  }
})));
export type PluginSourceSpecV1 = z.infer<typeof PluginSourceSpecV1Schema>;
