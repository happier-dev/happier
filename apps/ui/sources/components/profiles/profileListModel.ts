import { buildProfileGroups, type ProfileGroups } from '@/sync/domains/profiles/profileGrouping';
import type { ProfileEnabledById } from '@/sync/domains/profiles/profileEnablement';
import { isProfileCompatibleWithAgent, type AIBackendProfile, type ProfileCompatibilitySummary } from '@/sync/domains/profiles/profileCompatibility';
import { t } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';

export interface ProfileListBackendEntry {
    backendTargetKey: string;
    title: string;
    builtInAgentId?: AgentId | null;
}

export interface ProfileListStrings {
    builtInLabel: string;
    customLabel: string;
    /** A profile every enabled Agent can run. */
    anyAgentLabel: string;
    variableCount: (count: number) => string;
    /** Labels for the Agents currently enabled; an open Agent id may be absent. */
    agentLabelById: Readonly<Partial<Record<AgentId, string>>>;
}

export function getDefaultProfileListStrings(enabledAgentIds: readonly AgentId[]): ProfileListStrings {
    const agentLabelById: Partial<Record<AgentId, string>> = {};
    for (const agentId of enabledAgentIds) {
        agentLabelById[agentId] = formatAgentLikeIdForDisplay(agentId);
    }
    return {
        builtInLabel: t('profiles.builtIn'),
        customLabel: t('profiles.custom'),
        anyAgentLabel: t('profilesPage.anyAgent'),
        variableCount: (count) => t('profilesPage.variableCount', { count }),
        agentLabelById,
    };
}

/** The titles of the enabled Agents this profile runs on, and how many enabled Agents there are. */
function collectCompatibleAgentTitles(params: {
    profile: ProfileCompatibilitySummary;
    enabledAgentIds: readonly AgentId[];
    backendEntries?: readonly ProfileListBackendEntry[];
    strings: ProfileListStrings;
}): Readonly<{ titles: string[]; candidates: number }> {
    const titles: string[] = [];
    const backendEntries = params.backendEntries ?? [];
    if (backendEntries.length > 0) {
        for (const entry of backendEntries) {
            const compatibleViaTargetKey = params.profile.compatibilityByTargetKey?.[entry.backendTargetKey] === true;
            const compatibleViaBuiltInAgent =
                entry.builtInAgentId != null && isProfileCompatibleWithAgent(params.profile, entry.builtInAgentId);
            if (!compatibleViaTargetKey && !compatibleViaBuiltInAgent) {
                continue;
            }
            if (entry.title) {
                titles.push(entry.title);
            }
        }
        return { titles, candidates: backendEntries.length };
    }
    for (const agentId of params.enabledAgentIds) {
        if (isProfileCompatibleWithAgent(params.profile, agentId)) {
            const label = params.strings.agentLabelById[agentId];
            if (label) titles.push(label);
        }
    }
    return { titles, candidates: params.enabledAgentIds.length };
}

export function getProfileBackendSubtitle(params: {
    profile: ProfileCompatibilitySummary;
    enabledAgentIds: readonly AgentId[];
    backendEntries?: readonly ProfileListBackendEntry[];
    strings: ProfileListStrings;
}): string {
    const parts = collectCompatibleAgentTitles(params).titles;
    // The identity line names two compatible Agents, then counts the rest. Keep both catalog
    // paths under this owner so the rail and Share subtitle cannot drift into long inventories.
    return [...parts.slice(0, 2), ...(parts.length > 2
        ? [t('shareSheet.profileAgentsMore', { count: parts.length - 2 })] : [])].join(' · ');
}

/**
 * A profile's one-line meta: what tells it apart from its neighbours. The person's own description
 * leads; otherwise which Agents it is limited to ("Any agent" when it runs on all of them) and how
 * many variables it sets. Built-in and custom are said by the list's groups, not repeated per row.
 */
type ProfileDescriptionParams = {
    profile: ProfileCompatibilitySummary & Partial<Pick<AIBackendProfile, 'description' | 'environmentVariables'>>;
    enabledAgentIds: readonly AgentId[];
    backendEntries?: readonly ProfileListBackendEntry[];
    strings: ProfileListStrings;
    /** The agent the profile starts with, when it names one: it leads the facts. */
    preferredAgentTitle?: string | null;
};

/** What a profile sets ("Claude · 1 variable"), for a page that already shows its description. */
export function getProfileFacts(params: ProfileDescriptionParams): string {
    const { titles, candidates } = collectCompatibleAgentTitles(params);
    const facts: string[] = [];
    if (params.preferredAgentTitle) {
        facts.push(params.preferredAgentTitle);
    } else if (titles.length > 0) {
        facts.push(titles.length >= candidates ? params.strings.anyAgentLabel : getProfileBackendSubtitle(params));
    }
    const variables = params.profile.environmentVariables?.length ?? 0;
    if (variables > 0) facts.push(params.strings.variableCount(variables));
    if (facts.length > 0) return facts.join(' · ');
    return params.profile.isBuiltIn ? params.strings.builtInLabel : params.strings.customLabel;
}

/** A profile's one line in a list: the person's own description, else what it sets. */
export function getProfileSubtitle(params: ProfileDescriptionParams): string {
    const description = params.profile.description?.trim();
    return description || getProfileFacts(params);
}

export function buildProfilesListGroups(params: {
    customProfiles: AIBackendProfile[];
    builtInProfiles?: AIBackendProfile[];
    favoriteProfileIds: string[];
    enabledAgentIds?: readonly AgentId[];
    profileEnabledById?: ProfileEnabledById | null;
    includeDisabledProfiles?: boolean;
}): ProfileGroups {
    return buildProfileGroups({
        customProfiles: params.customProfiles,
        builtInProfiles: params.builtInProfiles,
        favoriteProfileIds: params.favoriteProfileIds,
        enabledAgentIds: params.enabledAgentIds,
        profileEnabledById: params.profileEnabledById,
        includeDisabledProfiles: params.includeDisabledProfiles,
    });
}
