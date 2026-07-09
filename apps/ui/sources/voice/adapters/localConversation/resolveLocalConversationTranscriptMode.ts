import type { VoiceAdapterTranscriptMode } from '@/voice/session/types';

/**
 * Provider-owned decision for the `local_conversation` adapter: how its voice
 * conversation transcript is persisted, derived from settings.
 *
 * - Returns `null` when the adapter does not expose a hidden voice conversation
 *   session (i.e. not in `agent` conversation mode) — no binding.
 * - `daemon` agent backend mirrors a real backend session (`native_session`).
 * - Any other agent backend (e.g. `openai_compat`) projects a `synthetic`
 *   transcript.
 *
 * This lives with the provider adapter so generic binding/sync code never has
 * to branch on the `local_conversation` id to learn the transcript mode.
 */
export function resolveLocalConversationTranscriptMode(
    settings: unknown,
): VoiceAdapterTranscriptMode | null {
    const config = readLocalConversationConfig(settings);
    if ((config?.conversationMode ?? 'direct_session') !== 'agent') return null;
    return config?.agent?.backend === 'daemon' ? 'native_session' : 'synthetic';
}

type LocalConversationConfig = Readonly<{
    conversationMode?: string;
    agent?: Readonly<{ backend?: string }> | null;
}>;

function readLocalConversationConfig(settings: unknown): LocalConversationConfig | null {
    if (typeof settings !== 'object' || settings === null) return null;
    const voice = (settings as { voice?: unknown }).voice;
    if (typeof voice !== 'object' || voice === null) return null;
    const adapters = (voice as { adapters?: unknown }).adapters;
    if (typeof adapters !== 'object' || adapters === null) return null;
    const config = (adapters as { local_conversation?: unknown }).local_conversation;
    if (typeof config !== 'object' || config === null) return null;
    return config as LocalConversationConfig;
}
