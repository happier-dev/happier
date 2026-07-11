import { AGENT_IDS } from '@happier-dev/agents';
import {
  getRequiredConfigEnvVarNames,
  getRequiredSecretEnvVarNames,
  isLaunchProfileV2,
  isProfileCompatibleWithAgent,
  type AIBackendProfile,
  type LaunchProfileV2,
} from '@happier-dev/protocol';

export type ProfilesListItem = Readonly<{
  id: string;
  name: string;
  isBuiltIn: boolean;
  description?: string;
  supportedAgentIds: string[];
  requiredSecretEnvVarNames: string[];
  requiredConfigEnvVarNames: string[];
  authMode?: AIBackendProfile['authMode'];
  requiresMachineLoginTargetKey?: string;
  requiresMachineLogin?: string;
}>;

export function mapProfileToListItem(profile: AIBackendProfile | LaunchProfileV2): ProfilesListItem {
  const slim = isLaunchProfileV2(profile);
  return {
    id: profile.id,
    name: profile.name,
    isBuiltIn: slim ? false : profile.isBuiltIn === true,
    ...(profile.description ? { description: profile.description } : {}),
    supportedAgentIds: AGENT_IDS.filter((agentId) => slim
      ? profile.compatibilityByTargetKey[`agent:${agentId}`] !== false
        && (Object.keys(profile.compatibilityByTargetKey).length === 0 || profile.compatibilityByTargetKey[`agent:${agentId}`] === true)
      : isProfileCompatibleWithAgent(profile, agentId)),
    requiredSecretEnvVarNames: slim ? [] : getRequiredSecretEnvVarNames(profile),
    requiredConfigEnvVarNames: slim ? [] : getRequiredConfigEnvVarNames(profile),
    ...(!slim && profile.authMode ? { authMode: profile.authMode } : {}),
    ...(!slim && profile.requiresMachineLoginTargetKey ? { requiresMachineLoginTargetKey: profile.requiresMachineLoginTargetKey } : {}),
    ...(!slim && profile.requiresMachineLogin ? { requiresMachineLogin: profile.requiresMachineLogin } : {}),
  };
}
