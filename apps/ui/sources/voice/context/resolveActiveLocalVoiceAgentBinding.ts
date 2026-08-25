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
  sendAutomaticUiContextUpdate: (update: string) => void;
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

  const controlSessionId = binding.controlSessionId;
  const boundSessionId = resolveVoiceOperationalSessionId(binding, controlSessionId);

  if (localVoiceRuntimeController.isAgentActive(controlSessionId)) {
    const announcementSessionId = binding?.conversationSessionId?.trim() || boundSessionId;
    return {
      binding,
      operationalSessionId: controlSessionId,
      announcementSessionId,
      sendContextualUpdate: (update) => localVoiceRuntimeController.appendAgentContextUpdate(controlSessionId, update),
      sendAutomaticUiContextUpdate: (update) => localVoiceRuntimeController.appendAgentAutomaticUiContextUpdate(controlSessionId, update),
      sendTextUpdate: (update) => localVoiceRuntimeController.sendAgentTextUpdate(controlSessionId, update),
      announceAssistantText: (text) => localVoiceRuntimeController.announceAgentAssistantText(announcementSessionId, text),
    };
  }

  return null;
}
