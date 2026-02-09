import { type AIBackendProfile } from '../settings/settings';
import type { AgentId } from '@/agents/catalog/catalog';
import * as agentCatalog from '@/agents/catalog/catalog';
import { isProfileCompatibleWithAgent } from '../settings/settings';
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

// Some tests partially mock `@/agents/catalog` and omit AGENT_IDS.
// Keep profile helpers resilient by treating it as an optional runtime export.
const allowedProfileClis =
    (agentCatalog as Partial<{ AGENT_IDS: readonly string[] }>).AGENT_IDS ?? [];

const ALLOWED_PROFILE_CLIS = new Set<string>(allowedProfileClis);

export function getProfileSupportedAgentIds(profile: AIBackendProfile | null | undefined): AgentId[] {
    if (!profile) return [];
    return Object.entries(profile.compatibility ?? {})
        .filter(([, isSupported]) => isSupported)
        .map(([cli]) => cli)
        .filter((cli): cli is AgentId => ALLOWED_PROFILE_CLIS.has(cli));
}

export function getProfileCompatibleAgentIds(
    profile: Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'> | null | undefined,
    agentIds: readonly AgentId[],
): AgentId[] {
    if (!profile) return [];
    return agentIds.filter((agentId) => isProfileCompatibleWithAgent(profile, agentId));
}

export function isProfileCompatibleWithAnyAgent(
    profile: Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'> | null | undefined,
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
