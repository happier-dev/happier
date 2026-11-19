import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { isPortableRelativePath } from '../filesystem/portablePathSegment.js';

export const PluginSourceKindV1Schema = lazyZodSchema(() => z.enum(['bundled', 'path', 'marketplace', 'package', 'archive', 'git']));
export type PluginSourceKindV1 = z.infer<typeof PluginSourceKindV1Schema>;

export function normalizePluginGitRepositoryUrl(locator: string): string | null {
  try {
    const url = new URL(locator);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/') return null;
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (url.hostname === 'github.com') {
      if (url.port || !/^\/[\w.-]+\/[\w.-]+$/.test(url.pathname)) return null;
      url.pathname = url.pathname.toLowerCase().replace(/\.git$/, '');
      if (url.pathname.endsWith('/')) return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export const PluginGitSourceV1Schema = lazyZodSchema(() => z.strictObject({
  locator: z.string().check(z.refine(locator => normalizePluginGitRepositoryUrl(locator) !== null, 'Expected an HTTPS Git repository URL without credentials')),
  subdirectory: z.optional(z.string().check(z.refine(isPortableRelativePath, 'Expected a portable repository-relative plugin directory'))),
}));
export type PluginGitSourceV1 = z.infer<typeof PluginGitSourceV1Schema>;
export const PluginGitCommitV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)));

export const PluginGitCatalogPointerV1Schema = lazyZodSchema(() => z.strictObject({
  sourceId: z.string().check(z.trim(), z.minLength(1)),
  itemId: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginGitCatalogPointerV1 = z.infer<typeof PluginGitCatalogPointerV1Schema>;

export const PluginGitCatalogSourceV1Schema = lazyZodSchema(() => z.extend(PluginGitSourceV1Schema, {
  ref: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type PluginGitCatalogSourceV1 = z.infer<typeof PluginGitCatalogSourceV1Schema>;

export const PluginGitInstallSourceSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.extend(PluginGitSourceV1Schema, { kind: z.literal('git') }),
  z.extend(PluginGitCatalogPointerV1Schema, { kind: z.literal('gitCatalog') }),
]));
export type PluginGitInstallSource = z.infer<typeof PluginGitInstallSourceSchema>;

export const PluginContentNotImportedV1Schema = lazyZodSchema(() => z.strictObject({
  hooks: z.number().check(z.int(), z.nonnegative()), commands: z.number().check(z.int(), z.nonnegative()),
  mcpServers: z.number().check(z.int(), z.nonnegative()), agents: z.number().check(z.int(), z.nonnegative()),
  other: z.optional(z.array(z.string())),
}));
export type PluginContentNotImportedV1 = z.infer<typeof PluginContentNotImportedV1Schema>;

export const PluginSourceTrustPolicyV1Schema = lazyZodSchema(() => z.enum(['local_trusted', 'prompt', 'untrusted']));
export type PluginSourceTrustPolicyV1 = z.infer<typeof PluginSourceTrustPolicyV1Schema>;

export const PluginSourceInstallPolicyV1Schema = lazyZodSchema(() => z.enum(['link', 'copy', 'managed_install']));
export type PluginSourceInstallPolicyV1 = z.infer<typeof PluginSourceInstallPolicyV1Schema>;

/**
 * Provenance of an installed plugin record, derived from what the record IS.
 *
 * `marketplace`, `package`, `archive` and `git` records were materialized from
 * remotely resolved content: their declared id and engine range are third-party
 * claims about bytes this machine did not author, so the reserved namespace
 * rule applies to them. `bundled` ships inside the host and `path` points at
 * a working tree on this machine.
 *
 * Host-engine compatibility at admission, containment, trust, entrypoint
 * and schema validation apply across source kinds.
 */
export function isRegistryCustodiedPluginSourceKind(kind: PluginSourceKindV1): boolean {
  return kind === 'marketplace' || kind === 'package' || kind === 'archive' || kind === 'git';
}

export const PluginSourceSpecV1Schema = lazyZodSchema(() => z.looseObject({
  kind: PluginSourceKindV1Schema,
  locator: z.string().check(z.trim(), z.minLength(1)),
  trustPolicy: PluginSourceTrustPolicyV1Schema,
  installPolicy: PluginSourceInstallPolicyV1Schema,
  resolvedVersion: z.optional(z.string().check(z.trim(), z.minLength(1))),
  subdirectory: z.optional(PluginGitSourceV1Schema.shape.subdirectory),
  resolvedCommit: z.optional(PluginGitCommitV1Schema),
  notImported: z.optional(PluginContentNotImportedV1Schema),
  installedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  devWatch: z.optional(z.boolean()),
}).check(z.superRefine((source, context) => {
  if (source.kind === 'git' && !PluginGitSourceV1Schema.safeParse({ locator: source.locator, subdirectory: source.subdirectory }).success) {
    context.addIssue({ code: 'custom', path: ['locator'], message: 'Invalid Git plugin source' });
  }
  if ('resolvedDigest' in source) {
    context.addIssue({
      code: "custom",
      path: ['resolvedDigest'],
      message: 'Plugin source provenance must not carry a raw resolved digest',
    });
  }
})));
export type PluginSourceSpecV1 = z.infer<typeof PluginSourceSpecV1Schema>;
