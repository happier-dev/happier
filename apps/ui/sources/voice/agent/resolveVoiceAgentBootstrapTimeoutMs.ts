import { readLocalConversationVoiceSettings, voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 60_000;

function normalizePositiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

export function resolveVoiceAgentBootstrapTimeoutMs(localConversationSettings: any): number {
  const configuredBootstrapTimeoutMs = normalizePositiveInteger(localConversationSettings?.agent?.bootstrapTimeoutMs);
  if (configuredBootstrapTimeoutMs) return configuredBootstrapTimeoutMs;

  const configuredNetworkTimeoutMs = normalizePositiveInteger(localConversationSettings?.networkTimeoutMs);
  const defaultNetworkTimeoutMs = normalizePositiveInteger(readLocalConversationVoiceSettings(voiceSettingsDefaults).networkTimeoutMs);

  return Math.max(
    DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    configuredNetworkTimeoutMs ?? defaultNetworkTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  );
}
