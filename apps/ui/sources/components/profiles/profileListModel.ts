import { buildProfileGroups, type ProfileGroups } from '@/sync/domains/profiles/profileGrouping';
import { isProfileCompatibleWithAgent, type AIBackendProfile, type ProfileCompatibilitySummary } from '@/sync/domains/profiles/profileCompatibility';
import { t } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';

export interface ProfileListBackendEntry {
    targetKey: string;
    title: string;
    builtInAgentId?: AgentId | null;
}

export interface ProfileListStrings {
    builtInLabel: string;
    customLabel: string;
    agentLabelById: Readonly<Record<AgentId, string>>;
}

export function getDefaultProfileListStrings(enabledAgentIds: readonly AgentId[]): ProfileListStrings {
    const agentLabelById: Record<AgentId, string> = {} as any;
    for (const agentId of enabledAgentIds) {
        agentLabelById[agentId] = t(getAgentCore(agentId).displayNameKey);
    }
    return {
        builtInLabel: t('profiles.builtIn'),
        customLabel: t('profiles.custom'),
        agentLabelById,
    };
}

export function getProfileBackendSubtitle(params: {
    profile: ProfileCompatibilitySummary;
    enabledAgentIds: readonly AgentId[];
    backendEntries?: readonly ProfileListBackendEntry[];
    strings: ProfileListStrings;
}): string {
    const parts: string[] = [];
    const backendEntries = params.backendEntries ?? [];
    if (backendEntries.length > 0) {
        for (const entry of backendEntries) {
            const compatibleViaTargetKey = params.profile.compatibilityByTargetKey?.[entry.targetKey] === true;
            const compatibleViaBuiltInAgent =
                entry.builtInAgentId != null && isProfileCompatibleWithAgent(params.profile, entry.builtInAgentId);
            if (!compatibleViaTargetKey && !compatibleViaBuiltInAgent) {
                continue;
            }
            if (entry.title) {
                parts.push(entry.title);
            }
        }
        return parts.length > 0 ? parts.join(' • ') : '';
    }

    for (const agentId of params.enabledAgentIds) {
        if (isProfileCompatibleWithAgent(params.profile, agentId)) {
            const label = params.strings.agentLabelById[agentId];
            if (label) parts.push(label);
        }
    }
    return parts.length > 0 ? parts.join(' • ') : '';
}

export function getProfileSubtitle(params: {
    profile: ProfileCompatibilitySummary;
    enabledAgentIds: readonly AgentId[];
    backendEntries?: readonly ProfileListBackendEntry[];
    strings: ProfileListStrings;
}): string {
    const backend = getProfileBackendSubtitle({
        profile: params.profile,
        enabledAgentIds: params.enabledAgentIds,
        backendEntries: params.backendEntries,
        strings: params.strings,
    });

    const label = params.profile.isBuiltIn ? params.strings.builtInLabel : params.strings.customLabel;
    return backend ? `${label} · ${backend}` : label;
}

export function buildProfilesListGroups(params: {
    customProfiles: AIBackendProfile[];
    favoriteProfileIds: string[];
    enabledAgentIds?: readonly AgentId[];
}): ProfileGroups {
    return buildProfileGroups({
        customProfiles: params.customProfiles,
        favoriteProfileIds: params.favoriteProfileIds,
        enabledAgentIds: params.enabledAgentIds,
    });
}
