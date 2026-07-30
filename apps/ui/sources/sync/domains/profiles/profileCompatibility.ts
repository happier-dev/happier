import { z } from 'zod';

import {
    AIBackendProfileSchema as ProtocolAIBackendProfileSchema,
    type BackendTargetRefV1,
    getProfileEnvironmentVariables as getProfileEnvironmentVariablesProtocol,
    isProfileCompatibleWithBackendTarget as isProfileCompatibleWithBackendTargetProtocol,
    isProfileCompatibleWithAgent as isProfileCompatibleWithAgentProtocol,
    type CodingPromptBehaviorModeV1,
    type CodingPromptBehaviorOverrideV1,
    type CodingPromptSessionTitleUpdatesModeV1,
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

export function getProfileCodingPromptBehaviorOverride(profile: AIBackendProfile): CodingPromptBehaviorOverrideV1 | null {
    if (profile.codingPromptBehaviorV1 === undefined) {
        return null;
    }
    return profile.codingPromptBehaviorV1;
}

/**
 * Builds a per-profile codingPromptBehaviorV1 override from explicit per-knob choices.
 * A knob set to null/undefined is omitted so it inherits the account (system) default.
 * Returns undefined when neither knob is set, so callers can omit the field entirely
 * (omit-means-inherit semantics preserved on save).
 */
export function buildCodingPromptBehaviorOverrideV1(params: {
    sessionTitleUpdates?: CodingPromptSessionTitleUpdatesModeV1 | null;
    responseOptions?: CodingPromptBehaviorModeV1 | null;
}): CodingPromptBehaviorOverrideV1 | undefined {
    const sessionTitleUpdates = params.sessionTitleUpdates ?? null;
    const responseOptions = params.responseOptions ?? null;
    if (!sessionTitleUpdates && !responseOptions) return undefined;
    const override: CodingPromptBehaviorOverrideV1 = { v: 1 };
    if (sessionTitleUpdates) {
        override.sessionTitleUpdates = sessionTitleUpdates;
    }
    if (responseOptions) {
        override.responseOptions = responseOptions;
    }
    return override;
}
