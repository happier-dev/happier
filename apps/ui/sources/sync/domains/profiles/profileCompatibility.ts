import { z } from 'zod';

import {
    AIBackendProfileSchema as ProtocolAIBackendProfileSchema,
    type BackendTargetRefV1,
    getProfileEnvironmentVariables as getProfileEnvironmentVariablesProtocol,
    isProfileCompatibleWithBackendTarget as isProfileCompatibleWithBackendTargetProtocol,
    isProfileCompatibleWithAgent as isProfileCompatibleWithAgentProtocol,
} from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';

export const AIBackendProfileSchema = ProtocolAIBackendProfileSchema;

export type AIBackendProfile = z.infer<typeof AIBackendProfileSchema>;
export type ProfileCompatibilitySummary =
    Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>
    & Partial<Pick<AIBackendProfile, 'compatibilityByTargetKey'>>;

function normalizeCompatibilityProfile(
    profile: ProfileCompatibilitySummary,
): Pick<AIBackendProfile, 'compatibility' | 'compatibilityByTargetKey' | 'isBuiltIn'> {
    return {
        compatibility: profile.compatibility,
        compatibilityByTargetKey: profile.compatibilityByTargetKey ?? {},
        isBuiltIn: profile.isBuiltIn,
    };
}

export function isProfileCompatibleWithBackendTarget(
    profile: ProfileCompatibilitySummary,
    target: BackendTargetRefV1,
): boolean {
    return isProfileCompatibleWithBackendTargetProtocol(normalizeCompatibilityProfile(profile), target);
}

export function isProfileCompatibleWithAgent(
    profile: ProfileCompatibilitySummary,
    agentId: AgentId,
): boolean {
    return isProfileCompatibleWithAgentProtocol(normalizeCompatibilityProfile(profile), agentId);
}

export function getProfileEnvironmentVariables(profile: AIBackendProfile): Record<string, string> {
    return getProfileEnvironmentVariablesProtocol(profile);
}
