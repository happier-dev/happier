import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import {
    readLocalConversationVoiceSettings,
    writeLocalConversationVoiceSettings,
    type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import {
    completeLegacyVoiceOpenAiChatAgentSelection,
    LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID,
} from '@/voice/adapters/localConversation/migrateLegacyOpenAiChatProvider';

export type VoiceAgentSelectionChoice =
    | Readonly<{ kind: 'catalog'; entry: Pick<ResolvedAgentCatalogEntry,
        'agentId' | 'backendTargetKey' | 'identity' | 'projectionGeneration' | 'isBuiltIn'> }>
    | Readonly<{ kind: 'custom'; agentId: string }>
    | Readonly<{ kind: 'legacy_provider_chat'; agentId: string }>;

/** A selection replaces all routing facts together; catalog identities are never inferred from an id. */
export function applyVoiceAgentSelection(voice: VoiceSettings, choice: VoiceAgentSelectionChoice): VoiceSettings {
    const cfg = readLocalConversationVoiceSettings(voice);
    if (choice.kind === 'catalog') {
        const { entry } = choice;
        return writeLocalConversationVoiceSettings(voice, {
            ...cfg,
            agent: {
                ...cfg.agent,
                agentId: entry.agentId,
                agentTargetKey: entry.backendTargetKey,
                agentIdentity: entry.isBuiltIn ? null : entry.identity,
                agentProjectionGeneration: entry.isBuiltIn ? null : entry.projectionGeneration,
            },
        });
    }
    if (choice.kind === 'custom') {
        const agentId = choice.agentId.trim();
        if (!agentId || agentId === cfg.agent.agentId.trim()) return voice;
        return writeLocalConversationVoiceSettings(voice, {
            ...cfg,
            agent: {
                ...cfg.agent,
                agentId,
                agentTargetKey: null,
                agentIdentity: null,
                agentProjectionGeneration: null,
            },
        });
    }
    if (cfg.agent.providerChat?.status !== 'needs_selection') return voice;
    const providerChat = completeLegacyVoiceOpenAiChatAgentSelection(cfg.agent.providerChat, choice.agentId);
    if (!providerChat) return voice;
    return writeLocalConversationVoiceSettings(voice, {
        ...cfg,
        agent: {
            ...cfg.agent,
            agentSource: 'agent',
            agentId: LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID,
            agentTargetKey: providerChat.chat.agentTargetKey,
            agentIdentity: null,
            agentProjectionGeneration: null,
            providerChat,
        },
    });
}
