import { isBundledAgentId } from '@happier-dev/agents';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { createLocalVoiceAdapter } from '@/voice/adapters/local/createLocalVoiceAdapter';
import { resolveLocalConversationTranscriptMode } from './resolveLocalConversationTranscriptMode';
import type { VoiceAdapterController } from '@/voice/session/types';
import { readLocalConversationVoiceSettings, readVoiceProviderSettingsConfig, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { resolveActiveLocalVoiceAgentBinding } from '@/voice/context/resolveActiveLocalVoiceAgentBinding';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';

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
    resolveSurfaceCapabilities: (voiceSettings) => {
      // The registry names the adapter whose capabilities are requested. A
      // next-provider selection cannot revoke this adapter's running controls.
      const config = readConfig(voiceSettings);
      if (!config) return null;
      const agentMode = config.conversationMode === 'agent';
      // A fixed Agent is the exact runtime a refusal is repaired on; an Agent that follows the
      // session has no identity of its own.
      const { agentSource, agentId, agentIdentity } = config.agent;
      const agentRuntime = agentMode && agentSource === 'agent'
        ? agentIdentity ?? (isBundledAgentId(agentId) ? BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId] : null)
        : null;
      return {
        allowsGlobalStart: agentMode,
        controlSessionScope: agentMode ? 'global' : 'surface',
        requiresVoiceAgentFeature: agentMode,
        bargeInEnabled: config.tts.bargeInEnabled !== false,
        cancelResponse: 'immediate',
        ...(agentRuntime ? { agentRuntime } : {}),
      };
    },
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
        sendTextMessage: (text) => fireAndForget(active.sendTextUpdate(text), {
          tag: 'local_voice_agent_text_update',
        }),
        announceAssistantText: active.announceAssistantText,
      };
    },
    ...(input.currentUiContext ? { currentUiContext: input.currentUiContext } : {}),
  });
}
