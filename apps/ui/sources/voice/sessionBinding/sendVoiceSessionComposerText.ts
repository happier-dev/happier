import type { VoiceAdapterController } from '@/voice/session/types';

import { voiceSessionBindingStore } from './voiceSessionBindingStore';
import { resolveVoiceSessionComposerRouting } from './voiceSessionComposerRouting';

export async function sendVoiceSessionComposerText(params: Readonly<{
  conversationSessionId: string;
  text: string;
  store?: typeof voiceSessionBindingStore;
  sessionMetadata?: unknown;
  getAdapter: (adapterId: string) => VoiceAdapterController | null;
}>): Promise<
  | { ok: true }
  | { ok: false; reason: 'not_voice_session' | 'adapter_unavailable' | 'send_failed'; message?: string }
> {
  const routing = resolveVoiceSessionComposerRouting({
    conversationSessionId: params.conversationSessionId,
    store: params.store,
    sessionMetadata: params.sessionMetadata,
  });
  if (!routing) return { ok: false, reason: 'not_voice_session' };

  const adapter = params.getAdapter(routing.binding.adapterId);
  if (!adapter?.sendTextTurn) return { ok: false, reason: 'adapter_unavailable' };

  try {
    await adapter.sendTextTurn({
      controlSessionId: routing.binding.controlSessionId,
      conversationSessionId: routing.binding.conversationSessionId,
      text: params.text,
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'send_failed',
      ...(error instanceof Error && error.message.trim().length > 0 ? { message: error.message } : {}),
    };
  }
  return { ok: true };
}
