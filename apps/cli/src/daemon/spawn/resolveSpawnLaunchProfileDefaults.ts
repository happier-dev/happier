import { isLaunchProfileV2 } from '@happier-dev/protocol/profiles/read';
import { isProfileCompatibleWithBackendTarget } from '@happier-dev/protocol/profiles/profileCompatibility';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV2, ArtifactSharingResourceV1 } from '@happier-dev/protocol';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { SessionSpawnLaunchErrorV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnLaunchErrorV1';

import { readSessionSpawnModelChoice } from '@/session/creation/readSessionSpawnModelChoice';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveCanonicalSpawnProfile } from '@/settings/profiles/validateSpawnProfile';
import type { AccountSettingsProfilesSnapshot } from '@/settings/profiles/readProfilesFromAccountSettings';
import { logger } from '@/ui/logger';
import { mergeProjectLaunchLayers } from '@/workspaces/projectSetup/projectLaunchEnvironment';

export type ResolveSpawnLaunchProfileDefaultsResult =
  | Readonly<{ ok: true; options: SpawnSessionOptions }>
  | Readonly<{ ok: false; result: SpawnSessionResult }>;

/** One diagnostic projection for selected-Profile refusals at daemon admission. */
export function refuseSpawnLaunchProfile(
  profileRefusal: NonNullable<SessionSpawnLaunchErrorV1['profileRefusal']>,
  message: string,
): SpawnSessionResult {
  logger.infoFile('[DAEMON RUN] Profile launch refused', { ...profileRefusal, message });
  return {
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    errorMessage: message,
    errorDetail: { kind: 'launch_error', code: 'profile_launch_unavailable', message, profileRefusal },
  };
}

/**
 * Applies the canonical Account Launch Profile at the daemon admission seam.
 *
 * Public launch callers carry only a stable `profileId`; they do not receive
 * profile environment or provider/model material merely so they can echo it
 * back. Explicit invocation values and explicit model, permission and
 * transcript selections take precedence over the Profile's defaults.
 */
export function resolveSpawnLaunchProfileDefaults(input: Readonly<{
  options: SpawnSessionOptions;
  effectiveBackendTarget: BackendTargetRefV2;
  rawSettings: Readonly<Record<string, unknown>> | null | undefined;
  artifactsById?: ReadonlyMap<string, ArtifactSharingResourceV1>;
  profileCatalog?: ProfileCatalogSnapshotV1;
  profilesSnapshot?: AccountSettingsProfilesSnapshot;
}>): ResolveSpawnLaunchProfileDefaultsResult {
  const profileId = input.options.profileId ?? '';
  if (!profileId) return { ok: true, options: input.options };
  const resolved = resolveCanonicalSpawnProfile({
    rawSettings: input.rawSettings,
    profileId,
    artifactsById: input.artifactsById,
    profileCatalog: input.profileCatalog,
    profilesSnapshot: input.profilesSnapshot,
  });
  if (!resolved.ok) return { ok: false,
    result: refuseSpawnLaunchProfile({ profileId, reason: resolved.reason }, resolved.message) };
  // Fresh legacy launches retain their caller-projected compatibility path.
  // Resume callers have only the stored identity, so restore its admitted row.
  if (resolved.kind !== 'slim' && !input.options.existingSessionId) return { ok: true, options: input.options };
  const profile = resolved.kind === 'slim' ? resolved.profile
    : input.profilesSnapshot?.visibleProfiles.find(candidate => candidate.id === profileId);
  if (!profile) return { ok: false, result: refuseSpawnLaunchProfile({ profileId, reason: 'profile_resume_unavailable' },
    `Launch profile '${profileId}' is unavailable for resume`) };

  const targetKey = buildBackendTargetKeyV2(input.effectiveBackendTarget);
  const readTargetDefault = <T>(values: Readonly<Record<string, T>>): T | undefined => (
    values[targetKey]
  );
  if (!isProfileCompatibleWithBackendTarget(profile, input.effectiveBackendTarget)) {
    return { ok: false, result: refuseSpawnLaunchProfile({ profileId, reason: 'profile_target_incompatible' },
      `Launch profile '${profileId}' is not compatible with '${targetKey}'`) };
  }

  if (!isLaunchProfileV2(profile)) {
    return { ok: true, options: {
      ...input.options,
      environmentVariables: mergeProjectLaunchLayers(undefined,
        Object.fromEntries(profile.environmentVariables.map(entry => [entry.name, entry.value])),
        input.options.environmentVariables),
    } };
  }

  const permissionMode = readTargetDefault(profile.defaultPermissionModeByTargetKey);
  const transcriptStorage = readTargetDefault(profile.defaultPersistenceModeByTargetKey);
  const preferredModelSelection = profile.preferredModelSelection?.ref.agentTargetKey === targetKey
    ? profile.preferredModelSelection
    : undefined;
  const profileEnvironment = Object.fromEntries(
    profile.extraEnvironmentVariables.map((entry) => [entry.name, entry.value]),
  );

  const options: SpawnSessionOptions = {
    ...input.options,
    ...(Object.keys(profileEnvironment).length > 0 || input.options.environmentVariables
      ? { environmentVariables: mergeProjectLaunchLayers(undefined, profileEnvironment, input.options.environmentVariables) }
      : {}),
    ...(input.options.permissionMode === undefined && permissionMode !== undefined
      ? { permissionMode, permissionModeUpdatedAt: profile.updatedAt }
      : {}),
    ...(input.options.transcriptStorage === undefined && transcriptStorage !== undefined
      ? { transcriptStorage }
      : {}),
    ...(preferredModelSelection !== undefined && readSessionSpawnModelChoice(input.options, input.effectiveBackendTarget) === undefined
      ? { modelSelection: preferredModelSelection }
      : {}),
  };
  return { ok: true, options };
}
