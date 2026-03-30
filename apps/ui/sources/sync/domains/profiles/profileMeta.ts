import type { AgentId } from '@/agents/registry/registryCore';
import { AGENT_IDS } from '@/agents/registry/registryCore';
import { isProfileCompatibleWithAgent, type AIBackendProfile, type ProfileCompatibilitySummary } from './profileCompatibility';
import { getBuiltInProfile } from './profileCatalog';

export type ProfilePrimaryCli = AgentId | 'multi' | 'none';

export type BuiltInProfileId =
    | 'anthropic'
    | 'deepseek'
    | 'zai'
    | 'codex'
    | 'openai'
    | 'azure-openai'
    | 'gemini'
    | 'gemini-api-key'
    | 'gemini-vertex';

export type BuiltInProfileNameKey =
    | 'profiles.builtInNames.anthropic'
    | 'profiles.builtInNames.deepseek'
    | 'profiles.builtInNames.zai'
    | 'profiles.builtInNames.codex'
    | 'profiles.builtInNames.openai'
    | 'profiles.builtInNames.azureOpenai'
    | 'profiles.builtInNames.gemini'
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
        if (!targetKey.startsWith('agent:')) continue;
        const cli = targetKey.slice('agent:'.length);
        if (ALLOWED_PROFILE_CLIS.has(cli)) {
            supported.add(cli as AgentId);
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
        case 'anthropic':
            return 'profiles.builtInNames.anthropic';
        case 'deepseek':
            return 'profiles.builtInNames.deepseek';
        case 'zai':
            return 'profiles.builtInNames.zai';
        case 'codex':
            return 'profiles.builtInNames.codex';
        case 'openai':
            return 'profiles.builtInNames.openai';
        case 'azure-openai':
            return 'profiles.builtInNames.azureOpenai';
        case 'gemini':
            return 'profiles.builtInNames.gemini';
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
