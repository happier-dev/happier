import type { PluginContributionIdentityV1 } from '../../plugins/contributionIdentity.js';
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

/** Resolve the catalog choice used by declaration Actions before capturing its routing tuple. */
export function voiceAgentCatalogSelectionValueV1(entry: VoiceAgentCatalogEntryV1): string {
    return entry.backendTargetKey ?? entry.agentId;
}

export function resolveVoiceAgentCatalogSelectionV1<T extends VoiceAgentCatalogEntryV1>(entries: readonly T[], value: string): T | null {
    const exact = entries.find(entry => entry.backendTargetKey === value);
    if (exact) return exact;
    const legacy = entries.filter(entry => entry.agentId === value);
    return legacy.length === 1 ? legacy[0]! : null;
}

export function applyVoiceAgentSelectionV1(voice: VoiceSettings, choice: VoiceAgentSelectionChoiceV1, owner: VoiceAgentSettingsOwnerV1): VoiceSettings {
    const config = owner.readLocalConversationVoiceSettings(voice);
    if (choice.kind === 'catalog') {
        const { entry } = choice;
        return owner.writeLocalConversationVoiceSettings(voice, { ...config, agent: { ...config.agent,
            agentId: entry.agentId, agentTargetKey: entry.backendTargetKey,
            agentIdentity: entry.isBuiltIn ? null : entry.identity,
            agentProjectionGeneration: entry.isBuiltIn ? null : entry.projectionGeneration,
        } });
    }
    const agentId = choice.agentId.trim();
    if (!agentId || agentId === config.agent.agentId.trim()) return voice;
    return owner.writeLocalConversationVoiceSettings(voice, { ...config, agent: { ...config.agent,
        agentId, agentTargetKey: null, agentIdentity: null, agentProjectionGeneration: null,
    } });
}
