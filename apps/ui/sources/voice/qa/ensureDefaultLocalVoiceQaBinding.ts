import { voiceSessionBindingManager } from '@/voice/sessionBinding/voiceSessionBindingRuntime';
import type { VoiceSessionBinding } from '@/voice/sessionBinding/voiceSessionBindingTypes';

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
