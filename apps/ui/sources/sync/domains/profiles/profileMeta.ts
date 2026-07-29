import type { AgentId } from '@/agents/registry/registryCore';
import { AGENT_IDS } from '@/agents/registry/registryCore';
import {
    readBackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';
import { isProfileCompatibleWithAgent, type AIBackendProfile, type ProfileCompatibilitySummary } from './profileCompatibility';
import { getBuiltInProfile } from './profileCatalog';

export type ProfilePrimaryCli = AgentId | 'multi' | 'none';

export type BuiltInProfileId =
    | 'azure-openai'
    | 'gemini-api-key'
    | 'gemini-vertex';

export type BuiltInProfileNameKey =
    | 'profiles.builtInNames.azureOpenai'
    | 'profiles.builtInNames.geminiApiKey'
    | 'profiles.builtInNames.geminiVertex';

const ALLOWED_PROFILE_CLIS = new Set<string>(AGENT_IDS as readonly string[]);

export function getProfileSupportedAgentIds(profile: AIBackendProfile | null | undefined): AgentId[] {
    if (!profile) return [];
    const supported = new Set<AgentId>();

    for (const [cli, isSupported] of Object.entries(profile.compatibility ?? {})) {
        if (!isSupported) continue;
        if (ALLOWED_PROFILE_CLIS.has(cli)) {
            supported.add(cli as AgentId);
        }
    }

    for (const [targetKey, isSupported] of Object.entries(profile.compatibilityByTargetKey ?? {})) {
        if (!isSupported) continue;
        try {
            const target = readBackendTargetRefV2(targetKey as BackendTargetRefV2Input);
            if (target.configuredBackendId || target.sourceKind === 'configured') continue;
            if (ALLOWED_PROFILE_CLIS.has(target.backendId)) {
                supported.add(target.backendId as AgentId);
            }
        } catch {
            // Ignore malformed or unsupported target identities.
        }
    }

    return Array.from(supported);
}

export function getProfileCompatibleAgentIds(
    profile: ProfileCompatibilitySummary | null | undefined,
    agentIds: readonly AgentId[],
): AgentId[] {
    if (!profile) return [];
    return agentIds.filter((agentId) => isProfileCompatibleWithAgent(profile, agentId));
}

export function isProfileCompatibleWithAnyAgent(
    profile: ProfileCompatibilitySummary | null | undefined,
    agentIds: readonly AgentId[],
): boolean {
    return getProfileCompatibleAgentIds(profile, agentIds).length > 0;
}

export function getProfilePrimaryCli(profile: AIBackendProfile | null | undefined): ProfilePrimaryCli {
    if (!profile) return 'none';
    const supported = getProfileSupportedAgentIds(profile);

    if (supported.length === 0) return 'none';
    if (supported.length === 1) return supported[0];
    return 'multi';
}

export function getBuiltInProfileNameKey(id: string): BuiltInProfileNameKey | null {
    switch (id as BuiltInProfileId) {
        case 'azure-openai':
            return 'profiles.builtInNames.azureOpenai';
        case 'gemini-api-key':
            return 'profiles.builtInNames.geminiApiKey';
        case 'gemini-vertex':
            return 'profiles.builtInNames.geminiVertex';
        default:
            return null;
    }
}

export function resolveProfileById(id: string, customProfiles: AIBackendProfile[]): AIBackendProfile | null {
    const custom = customProfiles.find((p) => p.id === id);
    return custom ?? getBuiltInProfile(id);
}
