import type { VoiceSessionBinding } from './voiceConversationBindingTypes';
import { createVoiceConversationBindingResolver } from './VoiceConversationBindingResolver';
import { voiceSessionBindingStore } from './voiceConversationBindingStore';

export function resolveVoiceSessionComposerRouting(params: Readonly<{
    conversationSessionId: string;
    store?: typeof voiceSessionBindingStore;
    sessionMetadata?: unknown;
}>): { kind: 'adapter_text'; binding: VoiceSessionBinding } | null {
    return createVoiceConversationBindingResolver({
        store: params.store ?? voiceSessionBindingStore,
    }).resolveComposerRouting(params);
}
