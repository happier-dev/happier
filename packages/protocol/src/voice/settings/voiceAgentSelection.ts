import type { PluginContributionIdentityV1 } from '../../plugins/contributionIdentity.js';
import { readBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import type { VoiceSettings, VoiceLocalConversationSettings } from './voiceSettings.js';

/** Catalog routing facts are selected together, never inferred from the display/routing id. */
export type VoiceAgentCatalogEntryV1 = Readonly<{
    agentId: string; backendTargetKey: string | null; identity: PluginContributionIdentityV1 | null;
    projectionGeneration: number | null; isBuiltIn: boolean; enabled?: boolean | null;
}>;
export type VoiceAgentSelectionChoiceV1 =
    | Readonly<{ kind: 'catalog'; entry: VoiceAgentCatalogEntryV1 }>
    | Readonly<{ kind: 'custom'; agentId: string }>;
export type VoiceAgentSettingsOwnerV1 = Readonly<{
    readLocalConversationVoiceSettings(voice: VoiceSettings): VoiceLocalConversationSettings;
    writeLocalConversationVoiceSettings(voice: VoiceSettings, config: VoiceLocalConversationSettings): VoiceSettings;
}>;

// The Voice profile has one fixed-Agent slot. Account defaults and saved
// Connected Accounts live separately from this slot's explicit choices.
function resetVoiceAgentScopedChoices(agent: VoiceLocalConversationSettings['agent']): VoiceLocalConversationSettings['agent'] {
    const { connectedServices: _connectedServices, ...previousAgent } = agent;
    return {
        ...previousAgent,
        chatModelId: 'default',
        chatModelSelection: null,
        commitModelId: 'default',
        commitModelSelection: null,
        providerChat: null,
    };
}

/** Resolve the catalog choice used by declaration Actions before capturing its routing tuple. */
export function voiceAgentCatalogSelectionValueV1(entry: VoiceAgentCatalogEntryV1): string {
    return entry.backendTargetKey ?? entry.agentId;
}

export function resolveVoiceAgentCatalogSelectionV1<T extends VoiceAgentCatalogEntryV1>(entries: readonly T[], value: string): T | null {
    const targetKey = readBackendTargetKeyV2(value);
    const entryTargetKey = (entry: T) => readBackendTargetKeyV2(entry.backendTargetKey
        ?? { kind: 'backend', backendId: entry.agentId });
    const exact = targetKey ? entries.find(entry => entryTargetKey(entry) === targetKey) : null;
    if (exact) return exact;
    const legacy = entries.filter(entry => entry.agentId === value && entryTargetKey(entry) !== null);
    return legacy.length === 1 ? legacy[0]! : null;
}

export function applyVoiceAgentSelectionV1(voice: VoiceSettings, choice: VoiceAgentSelectionChoiceV1, owner: VoiceAgentSettingsOwnerV1): VoiceSettings {
    const config = owner.readLocalConversationVoiceSettings(voice);
    if (choice.kind === 'catalog') {
        const { entry } = choice;
        const changed = readBackendTargetKeyV2(config.agent.agentTargetKey ?? { kind: 'backend', backendId: config.agent.agentId })
            !== readBackendTargetKeyV2(entry.backendTargetKey ?? { kind: 'backend', backendId: entry.agentId });
        const agent = changed ? resetVoiceAgentScopedChoices(config.agent) : config.agent;
        return owner.writeLocalConversationVoiceSettings(voice, { ...config, agent: { ...agent,
            agentId: entry.agentId, agentTargetKey: entry.backendTargetKey,
            agentIdentity: entry.isBuiltIn ? null : entry.identity,
        } });
    }
    const agentId = choice.agentId.trim();
    if (!agentId || agentId === config.agent.agentId.trim()) return voice;
    return owner.writeLocalConversationVoiceSettings(voice, { ...config, agent: { ...resetVoiceAgentScopedChoices(config.agent),
        agentId, agentTargetKey: null, agentIdentity: null,
    } });
}
