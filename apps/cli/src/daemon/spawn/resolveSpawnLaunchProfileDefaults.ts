import {
  buildBackendTargetKeyV2,
  type BackendTargetRefV2,
} from '@happier-dev/protocol';

import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveCanonicalSpawnProfile } from '@/settings/profiles/validateSpawnProfile';

export type ResolveSpawnLaunchProfileDefaultsResult =
  | Readonly<{ ok: true; options: SpawnSessionOptions }>
  | Readonly<{ ok: false; result: SpawnSessionResult }>;

function refuseProfile(message: string): ResolveSpawnLaunchProfileDefaultsResult {
  return {
    ok: false,
    result: {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: message,
    },
  };
}

/**
 * Applies the canonical Account Launch Profile at the daemon admission seam.
 *
 * Public launch callers carry only a stable `profileId`; they do not receive
 * profile environment or provider/model material merely so they can echo it
 * back. Explicit model, permission and transcript fields are sparse user intent
 * and win. Profile-owned environment names remain canonical; explicit names
 * outside that overlay survive beside them.
 */
export function resolveSpawnLaunchProfileDefaults(input: Readonly<{
  options: SpawnSessionOptions;
  effectiveBackendTarget: BackendTargetRefV2;
  rawSettings: Readonly<Record<string, unknown>> | null | undefined;
}>): ResolveSpawnLaunchProfileDefaultsResult {
  const profileId = input.options.profileId?.trim() ?? '';
  if (!profileId) return { ok: true, options: input.options };
  const resolved = resolveCanonicalSpawnProfile({
    rawSettings: input.rawSettings,
    profileId,
  });
  if (!resolved.ok) return refuseProfile(resolved.message);
  // Legacy profiles retain their existing caller-projected compatibility path.
  // V2 is the canonical stable-id contract used by Action callers.
  if (resolved.kind !== 'slim') return { ok: true, options: input.options };
  const { profile } = resolved;

  const targetKey = buildBackendTargetKeyV2(input.effectiveBackendTarget);
  const readTargetDefault = <T>(values: Readonly<Record<string, T>>): T | undefined => (
    values[targetKey]
  );
  const compatibility = readTargetDefault(profile.compatibilityByTargetKey);
  if (
    compatibility === false
    || (Object.keys(profile.compatibilityByTargetKey).length > 0 && compatibility !== true)
  ) {
    return refuseProfile(`Launch profile '${profileId}' is not compatible with '${targetKey}'`);
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
      ? { environmentVariables: { ...input.options.environmentVariables, ...profileEnvironment } }
      : {}),
    ...(input.options.permissionMode === undefined && permissionMode !== undefined
      ? { permissionMode, permissionModeUpdatedAt: profile.updatedAt }
      : {}),
    ...(input.options.transcriptStorage === undefined && transcriptStorage !== undefined
      ? { transcriptStorage }
      : {}),
    ...(input.options.modelSelection === undefined && preferredModelSelection !== undefined
      ? { modelSelection: preferredModelSelection }
      : {}),
  };
  return { ok: true, options };
}
