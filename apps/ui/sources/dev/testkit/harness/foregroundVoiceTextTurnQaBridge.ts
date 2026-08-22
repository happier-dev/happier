import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { submitDurableVoiceTextTurn } from '@/voice/binding/sendVoiceSessionComposerText';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import { resolveActiveLocalVoiceAgentBinding } from '@/voice/context/resolveActiveLocalVoiceAgentBinding';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';

const LOCAL_CONVERSATION_ADAPTER_ID = 'local_conversation';

/**
 * Test-only entrypoint for a text turn at the already-registered foreground
 * local-conversation adapter. The adapter carries the AppShell-owned current
 * UI port, while the incumbent durable turn owner keeps custody of the row.
 */
export async function dispatchForegroundVoiceTextTurnQa(text: string): Promise<VoiceSessionBinding | null> {
    const normalizedText = text.trim();
    if (!normalizedText) return null;

    const binding = resolveActiveLocalVoiceAgentBinding()?.binding ?? null;
    if (!binding) {
        throw new Error('foreground_voice_text_turn_qa_binding_unavailable');
    }

    const adapter = getVoiceAdapterRegistry().get(LOCAL_CONVERSATION_ADAPTER_ID);
    if (!adapter?.sendTextTurn) {
        throw new Error('foreground_voice_text_turn_qa_adapter_unavailable');
    }

    const result = await submitDurableVoiceTextTurn({
        conversationSessionId: binding.conversationSessionId,
        text: normalizedText,
        ...(adapter.transcriptSource ? { source: adapter.transcriptSource } : {}),
        dispatch: async ({ localId, deliveryCommand, onAccepted }) => {
            await adapter.sendTextTurn!({
                controlSessionId: binding.controlSessionId,
                conversationSessionId: binding.conversationSessionId,
                text: normalizedText,
                localId,
                deliveryCommand,
                onAccepted,
            });
        },
    });

    if (!result.ok) {
        throw new Error(result.message ?? result.reason);
    }
    if (result.disposition !== 'settled') {
        throw new Error(result.disposition === 'ambiguous'
            ? 'foreground_voice_text_turn_qa_dispatch_ambiguous'
            : 'foreground_voice_text_turn_qa_dispatch_pending');
    }
    return binding;
}
