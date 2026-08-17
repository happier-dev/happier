import type { VoiceAdapterTranscriptMode } from '@/voice/session/types';
import { readLocalConversationVoiceSettings, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

/**
 * Provider-owned decision for the `local_conversation` adapter: how its voice
 * conversation transcript is persisted, derived from settings.
 *
 * - Returns `null` when the adapter does not expose a hidden voice conversation
 *   session (i.e. not in `agent` conversation mode) — no binding.
 * - Agent mode always mirrors the daemon-owned execution run session
 *   (`native_session`). Provider-backed Chat changes the selected runtime
 *   composition, not transcript ownership.
 *
 * This lives with the provider adapter so generic binding/sync code never has
 * to branch on the `local_conversation` id to learn the transcript mode.
 */
export function resolveLocalConversationTranscriptMode(
    settings: unknown,
): VoiceAdapterTranscriptMode | null {
    const config = readLocalConversationConfig(settings);
    if ((config?.conversationMode ?? 'direct_session') !== 'agent') return null;
    return 'native_session';
}

type LocalConversationConfig = Readonly<{
    conversationMode?: string;
}>;

function readLocalConversationConfig(settings: unknown): LocalConversationConfig | null {
    if (typeof settings !== 'object' || settings === null) return null;
    const voice = (settings as { voice?: unknown }).voice;
    if (typeof voice !== 'object' || voice === null) return null;
    return readLocalConversationVoiceSettings(voiceSettingsParse(voice)) as LocalConversationConfig;
}
