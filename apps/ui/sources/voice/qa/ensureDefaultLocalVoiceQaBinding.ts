import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';

export async function ensureDefaultLocalVoiceQaBinding(params: Readonly<{
  controlSessionId: string;
  requestedTargetSessionId?: string | null;
}>): Promise<VoiceSessionBinding | null> {
  return await voiceSessionBindingManager.ensureBound({
    adapterId: 'local_conversation',
    controlSessionId: params.controlSessionId,
    requestedTargetSessionId: params.requestedTargetSessionId ?? null,
  });
}
