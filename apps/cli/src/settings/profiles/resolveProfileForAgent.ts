import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import {
  buildBackendTargetKey,
  isLaunchProfileV2,
  isProfileCompatibleWithAgent,
  PROVIDER_MIGRATION_SOURCE_PROFILE_IDS,
  resolveBackendProfile,
  type AIBackendProfile,
  type LaunchProfileV2,
} from '@happier-dev/protocol';
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

const PROVIDER_MIGRATION_SOURCE_IDS = new Set<string>(PROVIDER_MIGRATION_SOURCE_PROFILE_IDS);

function migrationSourceProfileIdForQuery(query: string): string | null {
  const sourceProfileId = query.trim();
  return PROVIDER_MIGRATION_SOURCE_IDS.has(sourceProfileId) ? sourceProfileId : null;
}

function formatCandidatesList(candidates: ReadonlyArray<Readonly<{ id: string; name: string }>>): string {
  return candidates.map((c) => `${c.id} (${c.name})`).join(', ');
}

export function resolveProfileForAgent(params: Readonly<{
  agentId: AgentId;
  query: string;
  customProfiles: ReadonlyArray<CliAiLaunchProfile>;
  terminalMigratedProfileIds?: ReadonlySet<string>;
}>): CliAiLaunchProfile {
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
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: params.agentId });
    if (slim.compatibilityByTargetKey[targetKey] !== false
      && (Object.keys(slim.compatibilityByTargetKey).length === 0 || slim.compatibilityByTargetKey[targetKey] === true)) {
      return slim;
    }
    throw new Error(`Profile "${slim.name}" (${slim.id}) is not compatible with ${params.agentId}.`);
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
  if (slim) {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: params.agentId });
    if (slim.compatibilityByTargetKey[targetKey] !== false
      && (Object.keys(slim.compatibilityByTargetKey).length === 0 || slim.compatibilityByTargetKey[targetKey] === true)) {
      return slim;
    }
    throw new Error(`Profile "${slim.name}" (${slim.id}) is not compatible with ${params.agentId}.`);
  }
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
  if (params.terminalMigratedProfileIds?.has(profile.id)) {
    throw new MigratedLegacyProfileError(profile.id);
  }
  if (isProfileCompatibleWithAgent(profile, params.agentId)) {
    return profile;
  }

  const supportedAgentIds = AGENT_IDS.filter((agentId) => isProfileCompatibleWithAgent(profile, agentId));
  const supportedList = supportedAgentIds.length > 0 ? supportedAgentIds.join(', ') : '(none)';
  const firstSuggestion = supportedAgentIds.length > 0 ? supportedAgentIds[0] : null;
  const hint = firstSuggestion
    ? ` Try: happier ${firstSuggestion} --profile ${profile.id}`
    : '';

  throw new Error(`Profile "${profile.name}" (${profile.id}) is not compatible with ${params.agentId}. Supported agents: ${supportedList}.${hint}`);
}
