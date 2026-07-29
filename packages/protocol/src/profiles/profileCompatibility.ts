import type { AIBackendProfile } from './backendProfileSchema.js';
import {
  buildBackendTargetKey,
  type BackendTargetRefV1,
} from '../backends/targets/backendTargetRef.js';
import {
  buildBackendTargetKeyV2,
  readBackendTargetRefV2,
} from '../backends/targets/backendTargetRefV2.js';

export function isProfileCompatibleWithBackendTarget(
  profile: Pick<AIBackendProfile, 'compatibilityByTargetKey' | 'compatibility' | 'isBuiltIn'>,
  target: BackendTargetRefV1,
): boolean {
  const targetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(target));
  const explicitByTargetKey = profile.compatibilityByTargetKey?.[targetKey];
  if (typeof explicitByTargetKey === 'boolean') return explicitByTargetKey;
  const legacyExplicitByTargetKey = profile.compatibilityByTargetKey?.[buildBackendTargetKey(target)];
  if (typeof legacyExplicitByTargetKey === 'boolean') return legacyExplicitByTargetKey;

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
