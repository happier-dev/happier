import { localVoiceRuntimeController } from '@/voice/local/localVoiceRuntimeController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { resolveVoiceOperationalSessionId } from '@/voice/binding/resolveVoiceOperationalSessionId';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';

export type ActiveLocalVoiceAgentBinding = Readonly<{
  binding: VoiceSessionBinding | null;
  operationalSessionId: string;
  announcementSessionId: string;
  sendContextualUpdate: (update: string) => void;
  sendTextUpdate: (update: string) => Promise<void>;
  announceAssistantText: (text: string) => void;
}>;

export function resolveActiveLocalVoiceAgentBinding(): ActiveLocalVoiceAgentBinding | null {
  const binding = voiceConversationBindingResolver.resolveByControlSessionId({
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    adapterId: 'local_conversation',
  });
  if (!binding) {
    return null;
  }

  const boundSessionId = resolveVoiceOperationalSessionId(binding, VOICE_AGENT_GLOBAL_SESSION_ID);

  if (boundSessionId && localVoiceRuntimeController.isAgentActive(boundSessionId)) {
    const announcementSessionId = binding?.conversationSessionId?.trim() || boundSessionId;
    return {
      binding,
      operationalSessionId: boundSessionId,
      announcementSessionId,
      sendContextualUpdate: (update) => localVoiceRuntimeController.appendAgentContextUpdate(boundSessionId, update),
      sendTextUpdate: (update) => localVoiceRuntimeController.sendAgentTextUpdate(boundSessionId, update),
      announceAssistantText: (text) => localVoiceRuntimeController.announceAgentAssistantText(announcementSessionId, text),
    };
  }

  return null;
}
