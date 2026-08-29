import {
  isLaunchProfileV2,
  isHistoricalBuiltInAiLaunchProfileIdV1,
  readAiLaunchProfileCollection,
  readProviderSettingsFromAccountSettingsV1,
  type LaunchProfileV2,
  validateLaunchProfileV2ReservedEnvironment,
} from '@happier-dev/protocol';

type SpawnProfileValidationResult =
  | Readonly<{ ok: true; kind: 'none' | 'legacy' | 'slim' }>
  | Readonly<{ ok: false; reason: 'reserved_environment' | 'profile_overlay_mismatch'; message: string }>;

const RETAINED_LEGACY_PROFILE_IDS = new Set(['azure-openai', 'gemini-api-key', 'gemini-vertex']);

export type CanonicalSpawnProfileResolution =
  | Readonly<{ ok: true; kind: 'none' | 'legacy' }>
  | Readonly<{
      ok: true;
      kind: 'slim';
      profile: LaunchProfileV2;
    }>
  | Readonly<{ ok: false; reason: 'profile_overlay_mismatch'; message: string }>;

function rawProfileId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = Reflect.get(value, 'id');
  return typeof id === 'string' ? id : null;
}

/**
 * Resolves one spawn profile from the canonical Account snapshot.
 *
 * Both daemon defaulting and the final provider overlay validation use this
 * owner so legacy migration exceptions and malformed/duplicate handling cannot
 * drift between the two admission stages.
 */
export function resolveCanonicalSpawnProfile(input: Readonly<{
  rawSettings: Readonly<Record<string, unknown>> | null | undefined;
  profileId: string | null | undefined;
}>): CanonicalSpawnProfileResolution {
  const profileId = input.profileId?.trim() ?? '';
  if (!profileId) return { ok: true, kind: 'none' };
  if (!input.rawSettings) {
    return {
      ok: false,
      reason: 'profile_overlay_mismatch',
      message: 'Canonical account settings are unavailable for launch profile validation',
    };
  }

  const rawProfiles = input.rawSettings.profiles;
  const collection = readAiLaunchProfileCollection(rawProfiles);
  const rawMatches = (Array.isArray(rawProfiles) ? rawProfiles : [])
    .filter((entry) => rawProfileId(entry) === profileId);
  const parsedMatches = collection.entries.filter(
    (entry): entry is Extract<(typeof collection.entries)[number], { kind: 'legacy' | 'slim' }> =>
      entry.kind !== 'opaque' && entry.profile.id === profileId,
  );
  if (rawMatches.length === 0) {
    if (RETAINED_LEGACY_PROFILE_IDS.has(profileId)) return { ok: true, kind: 'legacy' };
    const completed = readProviderSettingsFromAccountSettingsV1(input.rawSettings)
      .settings.migration?.completedSources.some((outcome) => outcome.sourceProfileId === profileId) === true;
    if (isHistoricalBuiltInAiLaunchProfileIdV1(profileId) && !completed) return { ok: true, kind: 'legacy' };
    return {
      ok: false,
      reason: 'profile_overlay_mismatch',
      message: completed
        ? `Launch profile '${profileId}' was migrated; omit --profile and select its provider connection or Default Environment`
        : `Launch profile '${profileId}' is not present in canonical account settings`,
    };
  }
  if (rawMatches.length !== 1 || parsedMatches.length !== 1) {
    return {
      ok: false,
      reason: 'profile_overlay_mismatch',
      message: `Launch profile '${profileId}' is ambiguous or malformed`,
    };
  }
  const profile = parsedMatches[0]!.profile;
  return isLaunchProfileV2(profile)
    ? { ok: true, kind: 'slim', profile }
    : { ok: true, kind: 'legacy' };
}

/**
 * Validates profile-derived spawn input against the canonical synced profile.
 * Legacy V1 rows remain on their explicit compatibility path; only V2 rows
 * are subject to the no-routing-env invariant.
 */
export function validateSpawnProfileEnvironment(input: Readonly<{
  rawSettings: Readonly<Record<string, unknown>> | null | undefined;
  profileId: string | null | undefined;
  providedEnvironmentVariables: Readonly<Record<string, string>>;
  reservedEnvironmentVariableNames: ReadonlySet<string>;
}>): SpawnProfileValidationResult {
  const resolved = resolveCanonicalSpawnProfile(input);
  if (!resolved.ok || resolved.kind !== 'slim') return resolved;
  const { profile } = resolved;

  try {
    validateLaunchProfileV2ReservedEnvironment(profile, input.reservedEnvironmentVariableNames);
  } catch (error) {
    return {
      ok: false,
      reason: 'reserved_environment',
      message: error instanceof Error ? error.message : 'Launch profile contains an agent-owned environment key',
    };
  }
  for (const entry of profile.extraEnvironmentVariables) {
    if (!Object.prototype.hasOwnProperty.call(input.providedEnvironmentVariables, entry.name)
      || input.providedEnvironmentVariables[entry.name] !== entry.value) {
      return {
        ok: false,
        reason: 'profile_overlay_mismatch',
        message: `Launch profile environment variable '${entry.name}' does not match canonical account settings`,
      };
    }
  }
  return { ok: true, kind: 'slim' };
}
