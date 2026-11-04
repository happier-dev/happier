import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
} from '@/sync/domains/settings/voiceSettings';
import type { VoiceLocalConversationSettings } from '@/voice/adapters/localConversation/settings';
import { MAX_VOICE_TIMER_DELAY_MS } from '@/voice/runtime/input/TurnEndpointDetector';

export type VoiceTurnStreamReadConfig = Readonly<{
  pollIntervalMs: number;
  maxEvents: number;
}>;

export function resolveVoiceTurnStreamReadConfig(
  voiceCfg: VoiceLocalConversationSettings | null | undefined,
): VoiceTurnStreamReadConfig {
  const defaultConversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
  const defaults = defaultConversation.streaming;

  const streamingCfg = voiceCfg?.streaming ?? null;
  const pollIntervalMsRaw = streamingCfg?.turnReadPollIntervalMs;
  const pollIntervalMs =
    typeof pollIntervalMsRaw === 'number' && Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw > 0
      ? Math.min(MAX_VOICE_TIMER_DELAY_MS, Math.floor(pollIntervalMsRaw))
      : defaults.turnReadPollIntervalMs;

  const maxEventsRaw = streamingCfg?.turnReadMaxEvents;
  const maxEvents =
    typeof maxEventsRaw === 'number' && Number.isFinite(maxEventsRaw) && maxEventsRaw > 0
      ? Math.floor(maxEventsRaw)
      : defaults.turnReadMaxEvents;

  return { pollIntervalMs, maxEvents };
}
