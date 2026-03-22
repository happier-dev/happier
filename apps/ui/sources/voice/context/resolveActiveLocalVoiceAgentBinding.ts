import {
  announceLocalVoiceAgentAssistantText,
  appendLocalVoiceAgentContextUpdate,
  isLocalVoiceAgentActive,
  sendLocalVoiceAgentTextUpdate,
} from '@/voice/local/localVoiceEngine';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { resolveVoiceOperationalSessionId } from '@/voice/sessionBinding/resolveVoiceOperationalSessionId';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import type { VoiceSessionBinding } from '@/voice/sessionBinding/voiceSessionBindingTypes';

export type ActiveLocalVoiceAgentBinding = Readonly<{
  binding: VoiceSessionBinding | null;
  operationalSessionId: string;
  announcementSessionId: string;
  sendContextualUpdate: (update: string) => void;
  sendTextUpdate: (update: string) => Promise<void>;
  announceAssistantText: (text: string) => void;
}>;

export function resolveActiveLocalVoiceAgentBinding(): ActiveLocalVoiceAgentBinding | null {
  const binding = resolveVoiceSessionBindingByControlSessionId({
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    adapterId: 'local_conversation',
  });
  const boundSessionId = resolveVoiceOperationalSessionId(binding, VOICE_AGENT_GLOBAL_SESSION_ID);

  if (boundSessionId && isLocalVoiceAgentActive(boundSessionId)) {
    const announcementSessionId = binding?.conversationSessionId?.trim() || boundSessionId;
    return {
      binding,
      operationalSessionId: boundSessionId,
      announcementSessionId,
      sendContextualUpdate: (update) => appendLocalVoiceAgentContextUpdate(boundSessionId, update),
      sendTextUpdate: (update) => sendLocalVoiceAgentTextUpdate(boundSessionId, update),
      announceAssistantText: (text) => announceLocalVoiceAgentAssistantText(announcementSessionId, text),
    };
  }

  if (!isLocalVoiceAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)) {
    return null;
  }

  return {
    binding: null,
    operationalSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    announcementSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    sendContextualUpdate: (update) => appendLocalVoiceAgentContextUpdate(VOICE_AGENT_GLOBAL_SESSION_ID, update),
    sendTextUpdate: (update) => sendLocalVoiceAgentTextUpdate(VOICE_AGENT_GLOBAL_SESSION_ID, update),
    announceAssistantText: (text) => announceLocalVoiceAgentAssistantText(VOICE_AGENT_GLOBAL_SESSION_ID, text),
  };
}
