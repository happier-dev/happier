import { isLegacyCustomAcpId } from '../backends/targets/compat/customAcp.js';
import { buildBackendTargetKey } from '../backends/targets/backendTargetRef.js';
import {
  parseBackendTargetKeyV2,
  readBackendTargetKeyV2,
  type PersistedBackendTargetRefV2,
} from '../backends/targets/backendTargetRefV2.js';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '../agents/executionTargetV1.js';

export type ProfileCompatibilitySummary = Readonly<{
  compatibilityByTargetKey?: Readonly<Record<string, boolean>>;
  compatibility?: Readonly<Record<string, boolean>>;
  isBuiltIn?: boolean;
}>;

export function isProfileCompatibleWithBackendTarget(
  profile: ProfileCompatibilitySummary,
  targetInput: unknown,
): boolean {
  const targetKey = readBackendTargetKeyV2(targetInput);
  if (targetKey === null) return false;
  const explicit = profile.compatibilityByTargetKey?.[targetKey];
  if (typeof explicit === 'boolean') return explicit;
  // Retained keys are normalized by the target owner, including qualified
  // external identities which have no legacy catalog routing id.
  for (const [key, compatible] of Object.entries(profile.compatibilityByTargetKey ?? {})) {
    if (readBackendTargetKeyV2(key) === targetKey) return compatible;
  }
  const target = parseBackendTargetKeyV2(targetKey);
  if ((target.kind === 'agent' && target.definitionId !== undefined)
    || (target.kind === 'backend' && target.configuredBackendId !== undefined)) {
    // Released profiles also addressed the configured transport container.
    // An exact definition override above always wins over this old shape.
    const carrierId = CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId;
    const carrier = profile.compatibilityByTargetKey?.[buildBackendTargetKey({ kind: 'builtInAgent', agentId: carrierId })];
    if (typeof carrier === 'boolean') return carrier;
    // The released 0.2 container alias is compatibility metadata, never an executable target.
    for (const [key, compatible] of Object.entries(profile.compatibilityByTargetKey ?? {})) {
      if (key.startsWith('agent:') && isLegacyCustomAcpId(key.slice('agent:'.length))) return compatible;
    }
    const flatCarrier = profile.compatibility?.[carrierId];
    if (typeof flatCarrier === 'boolean') return flatCarrier;
    for (const [agentId, compatible] of Object.entries(profile.compatibility ?? {})) {
      if (isLegacyCustomAcpId(agentId)) return compatible;
    }
  } else {
    for (const [agentId, compatible] of Object.entries(profile.compatibility ?? {})) {
      if (readBackendTargetKeyV2({ kind: 'builtInAgent', agentId }) === targetKey) return compatible;
    }
  }
  return profile.isBuiltIn ? false : true;
}

export function isProfileCompatibleWithAgent(profile: ProfileCompatibilitySummary, agentId: string): boolean {
  return isProfileCompatibleWithBackendTarget(profile, { kind: 'builtInAgent', agentId });
}

/** Profile preference only; callers retain explicit choice and admission authority. */
export function getProfileDefaultBackendTarget(profile: Readonly<{
  preferredAgentTargetKey?: string;
  preferredModelSelection?: Readonly<{ ref: Readonly<{ agentTargetKey: string }> }>;
  defaultBackendTargetKey?: string;
}>): PersistedBackendTargetRefV2 | null {
  const key = profile.preferredModelSelection?.ref.agentTargetKey
    ?? profile.preferredAgentTargetKey ?? profile.defaultBackendTargetKey;
  if (!key) return null;
  const targetKey = readBackendTargetKeyV2(key);
  return targetKey === null ? null : parseBackendTargetKeyV2(targetKey);
}
