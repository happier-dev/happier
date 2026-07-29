import { createLocalVoiceAdapter } from '@/voice/adapters/local/createLocalVoiceAdapter';
import { resolveLocalConversationTranscriptMode } from './resolveLocalConversationTranscriptMode';
import type { VoiceAdapterController } from '@/voice/session/types';
import { readLocalConversationVoiceSettings, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { VoiceLocalConversationSchema } from './settings';
import { resolveActiveLocalVoiceAgentBinding } from '@/voice/context/resolveActiveLocalVoiceAgentBinding';
import { fireAndForget } from '@/utils/system/fireAndForget';

function readConfig(voiceSettings: unknown) {
  const parsedVoice = voiceSettingsParse(voiceSettings);
  const envelope = parsedVoice.providers.local_conversation;
  const configResult = envelope?.schemaVersion === 1
    ? VoiceLocalConversationSchema.safeParse(envelope.config)
    : null;
  if (!configResult?.success) return null;
  return readLocalConversationVoiceSettings(parsedVoice);
}

function readSelectedConfig(voiceSettings: unknown) {
  const parsedVoice = voiceSettingsParse(voiceSettings);
  return parsedVoice.providerId === 'local_conversation' ? readConfig(parsedVoice) : null;
}

export function createLocalConversationVoiceAdapter(): VoiceAdapterController {
  return createLocalVoiceAdapter('local_conversation', {
    contextUpdates: true,
    textTurns: true,
    resolveBindingTranscriptMode: resolveLocalConversationTranscriptMode,
    resolveSurfaceCapabilities: (voiceSettings) => {
      const config = readSelectedConfig(voiceSettings);
      if (!config) return null;
      const agentMode = config.conversationMode === 'agent';
      return {
        allowsGlobalStart: agentMode,
        controlSessionScope: agentMode ? 'global' : 'surface',
        requiresVoiceAgentFeature: agentMode && config.agent.backend === 'daemon',
        bargeInEnabled: config.tts.bargeInEnabled !== false,
        cancelResponse: 'immediate',
      };
    },
    resolveContextChannel: (voiceSettings) => {
      // The registry already selected this adapter from the canonical active
      // owner. Do not let a concurrent settings selection steal its live sink.
      const config = readConfig(voiceSettings);
      if (!config || config.conversationMode !== 'agent') return null;
      const active = resolveActiveLocalVoiceAgentBinding();
      if (!active) return null;
      return {
        sendContextualUpdate: active.sendContextualUpdate,
        sendTextMessage: (text) => fireAndForget(active.sendTextUpdate(text), {
          tag: 'local_voice_agent_text_update',
        }),
        announceAssistantText: active.announceAssistantText,
      };
    },
  });
}
