import { voiceSettingsDefaults, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';

export type VoiceTurnStreamReadConfig = Readonly<{
  pollIntervalMs: number;
  maxEvents: number;
  streamTimeoutMs: number | null;
}>;

export function resolveVoiceTurnStreamReadConfig(
  voiceCfg: VoiceSettings['adapters']['local_conversation'] | null | undefined,
): VoiceTurnStreamReadConfig {
  const defaults = voiceSettingsDefaults.adapters.local_conversation.streaming;
  const networkDefault = voiceSettingsDefaults.adapters.local_conversation.networkTimeoutMs;

  const networkTimeoutMsRaw = voiceCfg?.networkTimeoutMs;
  const networkTimeoutMs =
    typeof networkTimeoutMsRaw === 'number' && Number.isFinite(networkTimeoutMsRaw) && networkTimeoutMsRaw > 0
      ? Math.max(1000, Math.min(60000, Math.floor(networkTimeoutMsRaw)))
      : networkDefault;

  const streamingCfg = voiceCfg?.streaming ?? null;
  const pollIntervalMsRaw = streamingCfg?.turnReadPollIntervalMs;
  const pollIntervalMs =
    typeof pollIntervalMsRaw === 'number' && Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw > 0
      ? Math.max(10, Math.min(500, Math.floor(pollIntervalMsRaw)))
      : defaults.turnReadPollIntervalMs;

  const maxEventsRaw = streamingCfg?.turnReadMaxEvents;
  const maxEvents =
    typeof maxEventsRaw === 'number' && Number.isFinite(maxEventsRaw) && maxEventsRaw > 0
      ? Math.max(1, Math.min(256, Math.floor(maxEventsRaw)))
      : defaults.turnReadMaxEvents;

  const streamTimeoutMsRaw = streamingCfg?.turnStreamTimeoutMs;
  const streamTimeoutMs =
    streamTimeoutMsRaw === null
      ? null
      : typeof streamTimeoutMsRaw === 'number' && Number.isFinite(streamTimeoutMsRaw) && streamTimeoutMsRaw > 0
        ? Math.max(1000, Math.min(3600000, Math.floor(streamTimeoutMsRaw)))
        : networkTimeoutMs;

  return { pollIntervalMs, maxEvents, streamTimeoutMs };
}
