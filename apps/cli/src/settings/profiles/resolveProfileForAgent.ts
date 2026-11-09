import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import { readBackendTargetKeyV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isLaunchProfileV2 } from '@happier-dev/protocol/profiles/read';
import { isProfileCompatibleWithAgent, isProfileCompatibleWithBackendTarget } from '@happier-dev/protocol/profiles/profileCompatibility';
import { PROVIDER_MIGRATION_SOURCE_PROFILE_IDS } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { resolveBackendProfile } from '@happier-dev/protocol/profiles/resolveBackendProfile';
import type { AIBackendProfile, LaunchProfileV2 } from '@happier-dev/protocol';
import type { CliAiLaunchProfile } from './readProfilesFromAccountSettings';

const REMOVED_LEGACY_PROFILE_ALIASES = new Map<string, string>([
  ['anthropic', 'anthropic'],
  ['anthropic (default)', 'anthropic'],
  ['codex', 'codex'],
  ['codex (default)', 'codex'],
  ['gemini', 'gemini'],
  ['gemini (default)', 'gemini'],
]);

function resolveRemovedLegacyProfileId(query: string): string | null {
  return REMOVED_LEGACY_PROFILE_ALIASES.get(query.trim().toLocaleLowerCase()) ?? null;
}

export function isRemovedLegacyProfileId(profileId: string): boolean {
  return resolveRemovedLegacyProfileId(profileId) !== null;
}

export class RemovedLegacyProfileError extends Error {
  readonly code = 'legacy_profile_removed' as const;
  readonly profileId: string;

  constructor(profileId: string) {
    super(`Profile "${profileId}" now uses Default Environment. Re-run the command and omit --profile.`);
    this.name = 'RemovedLegacyProfileError';
    this.profileId = profileId;
  }
}

export class MigratedLegacyProfileError extends Error {
  readonly code = 'legacy_profile_migrated' as const;
  readonly profileId: string;

  constructor(profileId: string) {
    super(`Profile "${profileId}" was migrated. Select its provider connection, or omit --profile for Default Environment.`);
    this.name = 'MigratedLegacyProfileError';
    this.profileId = profileId;
  }
}

export class ProviderProfileSetupRequiredError extends Error {
  readonly code = 'legacy_profile_requires_provider_setup' as const;
  readonly profileId: string;

  constructor(profileId: string) {
    super(`Profile "${profileId}" is now configured as a Provider. Enable its provider connection and select a model instead of using --profile.`);
    this.name = 'ProviderProfileSetupRequiredError';
    this.profileId = profileId;
  }
}

export class ProviderProfileMigrationFactsUnavailableError extends Error {
  readonly code = 'provider_settings_invalid' as const;

  constructor(readonly profileId: string) {
    super(`Provider migration facts are unavailable for retained profile "${profileId}".`);
    this.name = 'ProviderProfileMigrationFactsUnavailableError';
  }
}

const PROVIDER_MIGRATION_SOURCE_IDS = new Set<string>(PROVIDER_MIGRATION_SOURCE_PROFILE_IDS);

function migrationSourceProfileIdForQuery(query: string): string | null {
  const sourceProfileId = query.trim();
  return PROVIDER_MIGRATION_SOURCE_IDS.has(sourceProfileId) ? sourceProfileId : null;
}

function formatCandidatesList(candidates: ReadonlyArray<Readonly<{ id: string; name: string }>>): string {
  return candidates.map((c) => `${c.id} (${c.name})`).join(', ');
}

export function assertProfileCompatibleWithBackendTarget(profile: CliAiLaunchProfile, backendTarget: BackendTargetRefV2Input): void {
  if (!isProfileCompatibleWithBackendTarget(profile, backendTarget)) {
    throw new Error(`Profile "${profile.name}" (${profile.id}) is not compatible with ${readBackendTargetKeyV2(backendTarget)}.`);
  }
}

export function resolveProfileForAgent(params: Readonly<{
  agentId?: AgentId;
  backendTarget?: BackendTargetRefV2Input;
  query: string;
  customProfiles: ReadonlyArray<CliAiLaunchProfile>;
  terminalMigratedProfileIds?: ReadonlySet<string>;
}>): CliAiLaunchProfile {
  const backendTarget = params.backendTarget ?? (params.agentId
    ? { kind: 'builtInAgent' as const, agentId: params.agentId } : null);
  const assertCompatible = (profile: CliAiLaunchProfile): CliAiLaunchProfile => {
    if (backendTarget) assertProfileCompatibleWithBackendTarget(profile, backendTarget);
    return profile;
  };
  const queriedProfile = params.customProfiles.find((profile) => profile.id === params.query)
    ?? params.customProfiles.find((profile) => profile.name.toLocaleLowerCase() === params.query.toLocaleLowerCase());
  if (queriedProfile?.enabled === false) {
    throw Object.assign(new Error(`Profile "${queriedProfile.name}" (${queriedProfile.id}) is disabled.`), { code: 'profile_disabled' });
  }
  const removedLegacyProfileId = resolveRemovedLegacyProfileId(params.query);
  if (removedLegacyProfileId) {
    throw new RemovedLegacyProfileError(removedLegacyProfileId);
  }
  const slimProfiles = params.customProfiles.filter((profile): profile is LaunchProfileV2 => isLaunchProfileV2(profile));
  const exactSlim = slimProfiles.find((profile) => profile.id === params.query);
  const slimNameMatches = exactSlim ? [] : slimProfiles.filter((profile) => profile.name.toLocaleLowerCase() === params.query.toLocaleLowerCase());
  if (slimNameMatches.length > 1) {
    throw new Error(`Ambiguous profile name "${params.query}". Matches: ${formatCandidatesList(slimNameMatches)}. Use --profile <id>.`);
  }
  const slim = exactSlim ?? slimNameMatches[0];
  const migrationSourceProfileId = migrationSourceProfileIdForQuery(params.query);
  const terminalSourceProfileId = slim?.id ?? migrationSourceProfileId ?? params.query.trim();
  if (params.terminalMigratedProfileIds?.has(terminalSourceProfileId)) {
    if (!slim) throw new MigratedLegacyProfileError(params.query.trim());
    return assertCompatible(slim);
  }
  const legacyProfiles = params.customProfiles.filter((profile): profile is AIBackendProfile => !isLaunchProfileV2(profile));
  const explicitLegacy = migrationSourceProfileId === null
    ? null
    : legacyProfiles.find((profile) => profile.id === migrationSourceProfileId);
  if (migrationSourceProfileId && !explicitLegacy) {
    throw new ProviderProfileSetupRequiredError(migrationSourceProfileId);
  }
  const resolved = resolveBackendProfile({ query: params.query, customProfiles: legacyProfiles });
  if (slim && resolved.ok && !exactSlim) {
    throw new Error(`Ambiguous profile name "${params.query}". Matches: ${formatCandidatesList([slim, resolved.profile])}. Use --profile <id>.`);
  }
  if (slim) return assertCompatible(slim);

  if (!resolved.ok) {
    if (resolved.reason === 'ambiguous_name') {
      throw new Error(
        `Ambiguous profile name "${params.query}". Matches: ${formatCandidatesList(resolved.candidates)}. Use --profile <id>.`,
      );
    }
    throw new Error(`Unknown profile "${params.query}". Run "happier profiles list" to see available profiles.`);
  }

  const profile = resolved.profile;
  if (isRemovedLegacyProfileId(profile.id)) {
    throw new RemovedLegacyProfileError(profile.id);
  }
  if (PROVIDER_MIGRATION_SOURCE_IDS.has(profile.id) && params.terminalMigratedProfileIds === undefined) {
    throw new ProviderProfileMigrationFactsUnavailableError(profile.id);
  }
  if (params.terminalMigratedProfileIds?.has(profile.id)) {
    throw new MigratedLegacyProfileError(profile.id);
  }
  if (!backendTarget || isProfileCompatibleWithBackendTarget(profile, backendTarget)) {
    return profile;
  }

  const supportedAgentIds = AGENT_IDS.filter((agentId) => isProfileCompatibleWithAgent(profile, agentId));
  const supportedList = supportedAgentIds.length > 0 ? supportedAgentIds.join(', ') : '(none)';
  throw new Error(`Profile "${profile.name}" (${profile.id}) is not compatible with ${readBackendTargetKeyV2(backendTarget)}. Supported agents: ${supportedList}.`);
}

/** Resolves one Account Profile through the canonical catalog and migration-facts owners. */
export async function resolveAccountProfileForSessionStart(params: Readonly<{
  query: string;
  credentials: import('@/persistence').StoredCredentials;
  accountSettingsContext: import('@/settings/accountSettings/bootstrapAccountSettingsContext').AccountSettingsContext;
  backendTarget?: BackendTargetRefV2Input;
}>): Promise<Readonly<{ profile: CliAiLaunchProfile; accountSettingsContext: import('@/settings/accountSettings/bootstrapAccountSettingsContext').AccountSettingsContext }>> {
  const { readAccountLaunchProfiles, ProfileCatalogUnavailableError } = await import('./readProfilesFromAccountSettings');
  const { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
  const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const scopeKey = resolveAccountSettingsScopeKey(params.credentials);
  const capture = (profile: CliAiLaunchProfile) => {
    const active = getActiveAccountSettingsSnapshot();
    if (active?.scopeKey !== scopeKey || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw new ProfileCatalogUnavailableError('unavailable');
    }
    return { profile, accountSettingsContext: { ...params.accountSettingsContext, ...active, whenRefreshed: null } };
  };
  const resolve = (snapshot: Awaited<ReturnType<typeof readAccountLaunchProfiles>>) => resolveProfileForAgent({
    query: params.query, backendTarget: params.backendTarget,
    customProfiles: snapshot.visibleProfiles, terminalMigratedProfileIds: snapshot.terminalMigratedProfileIds,
  });
  try {
    return capture(resolve(await readAccountLaunchProfiles(params.accountSettingsContext.settings, params.credentials)));
  } catch (error) {
    if (!(error instanceof ProviderProfileMigrationFactsUnavailableError)) throw error;
    const { prepareProviderConnectionsCatalogForCli } = await import('@/providers/settings/hydrate');
    const catalog = await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: resolveAccountSettingsScopeKey(params.credentials) });
    if (catalog.status !== 'ready') throw error;
    return capture(resolve(await readAccountLaunchProfiles(getActiveAccountSettingsSnapshot()?.settings, params.credentials)));
  }
}
