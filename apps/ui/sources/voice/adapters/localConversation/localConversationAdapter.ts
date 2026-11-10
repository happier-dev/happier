import { createLocalVoiceAdapter } from '@/voice/adapters/local/createLocalVoiceAdapter';
import { resolveLocalConversationTranscriptMode } from './resolveLocalConversationTranscriptMode';
import type { VoiceAdapterController } from '@/voice/session/types';
import { readLocalConversationVoiceSettings, readVoiceProviderSettingsConfig, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { resolveActiveLocalVoiceAgentBinding } from '@/voice/context/resolveActiveLocalVoiceAgentBinding';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';
import { projectLocalVoiceSurfaceCapabilities } from '@/voice/registry/voiceProviderSurfaceCapabilities';

function readConfig(voiceSettings: unknown) {
  const parsedVoice = voiceSettingsParse(voiceSettings);
  const envelope = parsedVoice.providers.local_conversation;
  if (envelope?.schemaVersion !== 1
    || readVoiceProviderSettingsConfig(parsedVoice, 'local_conversation') === null) return null;
  return readLocalConversationVoiceSettings(parsedVoice);
}

export function createLocalConversationVoiceAdapter(input: Readonly<{
  currentUiContext?: VoiceCurrentUiToolPort;
}> = {}): VoiceAdapterController {
  return createLocalVoiceAdapter('local_conversation', {
    // Stored Session changes are reconciled by the daemon at Voice turn
    // admission. The UI adapter must not retain a second Follow queue.
    contextUpdates: false,
    textTurns: true,
    resolveBindingTranscriptMode: resolveLocalConversationTranscriptMode,
    resolveSurfaceCapabilities: (voiceSettings) => projectLocalVoiceSurfaceCapabilities('local_conversation', voiceSettings),
    resolveContextChannel: (voiceSettings) => {
      const active = resolveActiveLocalVoiceAgentBinding();
      if (!active) return null;
      // The registry already selected this adapter from the canonical active
      // owner. Do not let a concurrent settings selection steal its live sink.
      const config = readConfig(voiceSettings);
      if (!config || config.conversationMode !== 'agent') return null;
      return {
        // Local Voice is Happier's own assistant: it has no external prompt
        // authority, so host-authored session context is its normal input.
        hostAuthoredContext: 'session_context',
        sendContextualUpdate: (update, contextClass) => {
          if (contextClass === 'current_ui') {
            active.sendAutomaticUiContextUpdate(update);
          }
          // Stored Session updates are reconciled by the daemon on the next
          // accepted Voice turn. The foreground UI owns only current-UI
          // projection and immediate announcement, never Follow custody.
        },
        sendTextMessage: (text, context) => fireAndForget(active.sendTextUpdate(text, context), {
          tag: 'local_voice_agent_text_update',
        }),
        announceAssistantText: active.announceAssistantText,
      };
    },
    ...(input.currentUiContext ? { currentUiContext: input.currentUiContext } : {}),
  });
}
