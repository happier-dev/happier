import { isLaunchProfileV2 } from '@happier-dev/protocol/profiles/read';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { ProfileCatalogUnavailableError, readProfileCollectionFromAccountSnapshot,
  type AccountSettingsProfilesSnapshot } from './readProfilesFromAccountSettings';
import type { LaunchProfileV2, AiLaunchProfileSourceV1, ArtifactSharingResourceV1 } from '@happier-dev/protocol';
import { validateLaunchProfileV2ReservedEnvironment } from '@happier-dev/protocol/profiles/v2/schema';

type SpawnProfileValidationResult =
  | Readonly<{ ok: true; kind: 'none' | 'legacy' | 'slim' }>
  | Readonly<{ ok: false; reason: 'reserved_environment' | 'profile_overlay_mismatch'; message: string }>;

const RETAINED_LEGACY_PROFILE_IDS = new Set(['azure-openai', 'gemini-api-key', 'gemini-vertex']);

export type CanonicalSpawnProfileResolution =
  | Readonly<{ ok: true; kind: 'none' | 'legacy' }>
  | Readonly<{
      ok: true;
      kind: 'slim';
      profile: LaunchProfileV2 & AiLaunchProfileSourceV1;
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
  artifactsById?: ReadonlyMap<string, ArtifactSharingResourceV1>;
  profileCatalog?: ProfileCatalogSnapshotV1;
  /** The same scoped, lifetime-admitted async read used to select the Profile. */
  profilesSnapshot?: AccountSettingsProfilesSnapshot;
  /** Present-but-undefined pins a predecessor or grant-only Profile, with no private membership row. */
  expectedProfileRecordRevision?: number;
}>): CanonicalSpawnProfileResolution {
  const profileId = input.profileId ?? '';
  if (!profileId) return { ok: true, kind: 'none' };
  if (!input.rawSettings && !input.profileCatalog) {
    return {
      ok: false,
      reason: 'profile_overlay_mismatch',
      message: 'Canonical account settings are unavailable for launch profile validation',
    };
  }

  let collection;
  try {
    collection = readProfileCollectionFromAccountSnapshot(input.rawSettings, input.artifactsById, input.profileCatalog);
  } catch (error) {
    if (!(error instanceof ProfileCatalogUnavailableError)) throw error;
    return { ok: false, reason: 'profile_overlay_mismatch', message: error.message };
  }
  const rawProfiles = collection.raw;
  const rawMatches = (Array.isArray(rawProfiles) ? rawProfiles : [])
    .filter((entry) => rawProfileId(entry) === profileId);
  const parsedMatches = collection.entries.filter(
    (entry): entry is Extract<(typeof collection.entries)[number], { kind: 'legacy' | 'slim' }> =>
      entry.kind !== 'opaque' && entry.profile.id === profileId,
  );
  const matchingCount = rawMatches.length + parsedMatches.filter((entry) => rawProfileId(entry.raw) !== profileId).length;
  if (matchingCount === 0) {
    const destinationAuthority = input.profileCatalog?.status === 'ready' && input.profileCatalog.source === 'destination';
    if (destinationAuthority && input.expectedProfileRecordRevision === undefined && input.profilesSnapshot) {
      const visible = input.profilesSnapshot.visibleProfiles.filter(profile => profile.id === profileId);
      const profile = visible.length === 1 ? visible[0] : undefined;
      if (profile && !isLaunchProfileV2(profile) && profile.profileRecordRevision === undefined
        && profile.enabled !== false && input.profilesSnapshot.enabledByProfileId[profileId] !== false) {
        return { ok: true, kind: 'legacy' };
      }
    }
    if (!destinationAuthority && input.expectedProfileRecordRevision === undefined && RETAINED_LEGACY_PROFILE_IDS.has(profileId)) return { ok: true, kind: 'legacy' };
    const completed = input.profilesSnapshot?.terminalMigratedProfileIds?.has(profileId) === true;
    return {
      ok: false,
      reason: 'profile_overlay_mismatch',
      message: completed
        ? `Launch profile '${profileId}' was migrated; omit --profile and select its provider connection or Default Environment`
        : `Launch profile '${profileId}' is not present in canonical account settings`,
    };
  }
  if (matchingCount !== 1 || parsedMatches.length !== 1) {
    return {
      ok: false,
      reason: 'profile_overlay_mismatch',
      message: `Launch profile '${profileId}' is ambiguous or malformed`,
    };
  }
  const profile = parsedMatches[0]!.profile;
  if (Object.hasOwn(input, 'expectedProfileRecordRevision')
    && profile.profileRecordRevision !== input.expectedProfileRecordRevision) {
    return { ok: false, reason: 'profile_overlay_mismatch', message: `Launch profile '${profileId}' changed after selection` };
  }
  if (profile.enabled === false) return { ok: false, reason: 'profile_overlay_mismatch', message: `Launch profile '${profileId}' is disabled` };
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
  artifactsById?: ReadonlyMap<string, ArtifactSharingResourceV1>;
  profileCatalog?: ProfileCatalogSnapshotV1;
  profilesSnapshot?: AccountSettingsProfilesSnapshot;
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
