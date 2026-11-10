import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { buildQualifiedPluginContributionKey, PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';

export const ScmBuiltInBackendIdSchema = lazyZodSchema(() => z.enum(['git', 'sapling']));
export type ScmBuiltInBackendId = z.infer<typeof ScmBuiltInBackendIdSchema>;

export const ScmBackendIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export type ScmBackendId = z.infer<typeof ScmBackendIdSchema>;

export const ScmBackendPreferenceSchema = lazyZodSchema(() => z.object({
  kind: z.literal('prefer'),
  backendId: ScmBackendIdSchema,
}));
export type ScmBackendPreference = z.infer<typeof ScmBackendPreferenceSchema>;

const firstPartyPluginIdByBackendLocalId: Readonly<Record<string, string>> = Object.freeze({
  git: 'happier.scm.backend.git', sapling: 'happier.scm.backend.sapling',
});
const firstPartyBackendLocalIdByQualifiedId: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(firstPartyPluginIdByBackendLocalId).map(([localId, pluginId]) => [`${pluginId}/${localId}`, localId])),
);
export function getFirstPartyScmBackendQualifiedId(localId: string): string | null {
  if (!Object.hasOwn(firstPartyPluginIdByBackendLocalId, localId)) return null;
  const pluginId = firstPartyPluginIdByBackendLocalId[localId];
  return pluginId ? `${pluginId}/${localId}` : null;
}
export function getFirstPartyScmBackendLegacyLocalId(qualifiedId: string): string | null {
  if (!Object.hasOwn(firstPartyBackendLocalIdByQualifiedId, qualifiedId)) return null;
  return firstPartyBackendLocalIdByQualifiedId[qualifiedId] ?? null;
}
export function isFirstPartyGitScmBackendId(backendId: string | null | undefined): boolean {
  return backendId === 'git' || typeof backendId === 'string' && getFirstPartyScmBackendLegacyLocalId(backendId) === 'git';
}
export const SCM_GIT_REPO_BACKEND_OPTIONS = ['git', 'sapling'] as const;
export type ScmGitRepoPreferredBackend = typeof SCM_GIT_REPO_BACKEND_OPTIONS[number];
export const SCM_BACKEND_QUALIFIED_ID_MAX_LENGTH = 256;
export type ScmGitRepoBackendPreferenceSettingsDelta = Readonly<
  | { scmGitRepoPreferredBackend: ScmGitRepoPreferredBackend; scmGitRepoPreferredBackendQualifiedId: null }
  | { scmGitRepoPreferredBackendQualifiedId: string }
>;
export function normalizeScmGitRepoPreferredBackend(value: unknown): ScmGitRepoPreferredBackend {
  return value === 'sapling' ? 'sapling' : 'git';
}
export function normalizeScmBackendQualifiedId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SCM_BACKEND_QUALIFIED_ID_MAX_LENGTH) return null;
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return null;
  const identity = PluginContributionIdentityV1Schema.safeParse({ pluginId: trimmed.slice(0, separatorIndex), localId: trimmed.slice(separatorIndex + 1) });
  return identity.success ? buildQualifiedPluginContributionKey(identity.data) : null;
}
export function resolveScmGitRepoPreferredBackendId(input: Readonly<{ legacyPreference: unknown; qualifiedPreference: unknown }>): string {
  const qualified = normalizeScmBackendQualifiedId(input.qualifiedPreference);
  if (qualified) return qualified;
  const legacy = normalizeScmGitRepoPreferredBackend(input.legacyPreference);
  const resolved = getFirstPartyScmBackendQualifiedId(legacy);
  if (!resolved) throw new Error(`Missing first-party SCM backend identity for "${legacy}"`);
  return resolved;
}
export function buildScmGitRepoBackendPreferenceSettingsDelta(backendId: unknown): ScmGitRepoBackendPreferenceSettingsDelta | null {
  if (typeof backendId !== 'string') return null;
  const trimmed = backendId.trim();
  const firstParty = getFirstPartyScmBackendLegacyLocalId(trimmed) ?? SCM_GIT_REPO_BACKEND_OPTIONS.find(option => option === trimmed) ?? null;
  if (firstParty === 'git' || firstParty === 'sapling') return { scmGitRepoPreferredBackend: firstParty, scmGitRepoPreferredBackendQualifiedId: null };
  const qualified = normalizeScmBackendQualifiedId(trimmed);
  return qualified ? { scmGitRepoPreferredBackendQualifiedId: qualified } : null;
}
