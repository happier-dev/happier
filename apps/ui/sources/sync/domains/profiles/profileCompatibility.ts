import { type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { getProfileEnvironmentVariables as getProfileEnvironmentVariablesProtocol } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { isProfileCompatibleWithBackendTarget as isProfileCompatibleWithBackendTargetProtocol } from '@happier-dev/protocol/profiles/profileCompatibility';
import type { AgentId } from '@/agents/registry/registryCore';

export {
    AIBackendProfileSchema,
    type AIBackendProfile,
} from './aiBackendProfileSchema';
import type { AIBackendProfile } from './aiBackendProfileSchema';
export type ProfileCompatibilitySummary =
    Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>
    & Partial<Pick<AIBackendProfile, 'compatibilityByTargetKey'>>;

export function isProfileCompatibleWithBackendTarget(
    profile: ProfileCompatibilitySummary,
    target: BackendTargetRefV2Input,
): boolean {
    return isProfileCompatibleWithBackendTargetProtocol(profile, target);
}

export function isProfileCompatibleWithAgent(
    profile: ProfileCompatibilitySummary,
    agentId: AgentId,
): boolean {
    return isProfileCompatibleWithBackendTarget(profile, { kind: 'builtInAgent', agentId });
}

export function getProfileEnvironmentVariables(profile: AIBackendProfile): Record<string, string> {
    return getProfileEnvironmentVariablesProtocol(profile);
}
