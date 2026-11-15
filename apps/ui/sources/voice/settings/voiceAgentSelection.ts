import { applyVoiceAgentSelectionV1 } from '@happier-dev/protocol/voice/settings/voiceAgentSelection';
import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';
import { buildSessionModelPickerSections } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import {
    readLocalConversationVoiceSettings,
    writeLocalConversationVoiceSettings,
    type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import {
    completeLegacyVoiceOpenAiChatAgentSelection,
} from '@happier-dev/protocol/voice/settings/legacyOpenAiChatProviderMigration';

export type VoiceAgentSelectionChoice =
    | Readonly<{ kind: 'catalog'; entry: Pick<ResolvedAgentCatalogEntry,
        'agentId' | 'backendTargetKey' | 'identity' | 'projectionGeneration' | 'isBuiltIn'> }>
    | Readonly<{ kind: 'custom'; agentId: string }>
    | Readonly<{ kind: 'legacy_provider_chat'; entry: Pick<ResolvedAgentCatalogEntry,
        'agentId' | 'backendTargetKey' | 'identity' | 'projectionGeneration' | 'isBuiltIn'>;
        modelProjection?: Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }> }>;

/** A selection replaces all routing facts together; catalog identities are never inferred from an id. */
export function applyVoiceAgentSelection(voice: VoiceSettings, choice: VoiceAgentSelectionChoice): VoiceSettings {
    const cfg = readLocalConversationVoiceSettings(voice);
    if (choice.kind !== 'legacy_provider_chat') return applyVoiceAgentSelectionV1(voice, choice, { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings });
    if (cfg.agent.providerChat?.status !== 'needs_selection') return voice;
    const providerChat = completeLegacyVoiceOpenAiChatAgentSelection(cfg.agent.providerChat,
        choice.entry.backendTargetKey ?? { kind: 'backend', backendId: choice.entry.agentId });
    const projection = choice.modelProjection;
    if (!projection || !backendTargetKeysMatch(projection.agentTargetKey, providerChat.chat.agentTargetKey)) return voice;
    // Reuse the session picker's existing authorization/compatibility/visibility
    // decision. Selecting an Agent cannot authorize an imported endpoint or
    // confirm experimental models; execution still reauthorizes at launch.
    const options = buildSessionModelPickerSections({
        // Legacy Account migration has no selected Machine declaration authority.
        declarationContext: { kind: 'account' },
        agentTargetKey: projection.agentTargetKey, nativeModels: [], providerGroups: projection.groups,
        hiddenNativeModelKeys: new Set(), providerProjectionAuthoritative: true, allowAutomatic: false,
        canConfirmExperimental: false,
    }).flatMap(section => section.options);
    if (![providerChat.chat, providerChat.commit].every(ref => options.some(option => !option.disabled
        && sessionModelSelectionKey(option.value) === sessionModelSelectionKey(ref)))) return voice;
    const selected = applyVoiceAgentSelectionV1(voice, { kind: 'catalog', entry: choice.entry },
        { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings });
    const selectedConfig = readLocalConversationVoiceSettings(selected);
    return writeLocalConversationVoiceSettings(selected, {
        ...selectedConfig,
        agent: {
            ...selectedConfig.agent,
            agentSource: 'agent',
            providerChat,
        },
    });
}
