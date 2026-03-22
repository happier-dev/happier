import { resolveVoiceSessionBindingByConversationSessionId } from './resolveVoiceSessionBinding';
import { voiceSessionBindingStore } from './voiceSessionBindingStore';
import type { VoiceSessionBinding } from './voiceSessionBindingTypes';

export function resolveVoiceSessionComposerRouting(params: Readonly<{
  conversationSessionId: string;
  store?: typeof voiceSessionBindingStore;
  sessionMetadata?: unknown;
}>): { kind: 'adapter_text'; binding: VoiceSessionBinding } | null {
  const binding = resolveVoiceSessionBindingByConversationSessionId({
    conversationSessionId: params.conversationSessionId,
    sessionMetadata: params.sessionMetadata,
    store: params.store ?? voiceSessionBindingStore,
  });
  if (!binding) return null;
  return { kind: 'adapter_text', binding };
}
