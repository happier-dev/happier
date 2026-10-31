import type { AIBackendProfile } from './backendProfileSchema.js';
import {
  BackendTargetKeySchema,
  buildBackendTargetKey,
  parseBackendTargetKey,
  type BackendTargetRefV1,
} from '../backendTargets/backendTargetRef.js';

export function isProfileCompatibleWithBackendTarget(
  profile: Pick<AIBackendProfile, 'compatibilityByTargetKey' | 'compatibility' | 'isBuiltIn'>,
  target: BackendTargetRefV1,
): boolean {
  const targetKey = buildBackendTargetKey(target);
  const explicitByTargetKey = profile.compatibilityByTargetKey?.[targetKey];
  if (typeof explicitByTargetKey === 'boolean') return explicitByTargetKey;

  if (target.kind === 'builtInAgent') {
    const explicitLegacy = profile.compatibility?.[target.agentId];
    if (typeof explicitLegacy === 'boolean') return explicitLegacy;
  }

  return profile.isBuiltIn ? false : true;
}

export function isProfileCompatibleWithAgent(
  profile: Pick<AIBackendProfile, 'compatibilityByTargetKey' | 'compatibility' | 'isBuiltIn'>,
  agentId: string,
): boolean {
  return isProfileCompatibleWithBackendTarget(profile, { kind: 'builtInAgent', agentId });
}

/**
 * The profile's default backend target for sessions started under it without an explicit
 * backend choice, or null when unset or malformed. Callers must additionally verify the
 * target is compatible with the profile and available on the target machine.
 */
export function getProfileDefaultBackendTarget(
  profile: Pick<AIBackendProfile, 'defaultBackendTargetKey'>,
): BackendTargetRefV1 | null {
  const key = profile.defaultBackendTargetKey;
  if (!key) return null;
  if (!BackendTargetKeySchema.safeParse(key).success) return null;
  return parseBackendTargetKey(key);
}
