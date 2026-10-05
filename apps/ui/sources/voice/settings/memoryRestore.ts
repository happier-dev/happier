import { z } from 'zod';

import { SETTING_VALUE_UNAVAILABLE, type SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import {
  readLocalConversationVoiceSettings,
  readVoiceProviderSettingsConfig,
  writeLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

/**
 * How the Voice agent restores a remembered conversation, as the person chooses it: replay recent
 * messages, replay a summary plus recent messages, or resume the agent's own conversation. Stored as
 * `agent.resumabilityMode` plus `agent.replay.strategy`; resuming keeps the replay strategy, which its
 * fallback uses.
 */
export const VoiceMemoryRestoreChoiceSchema = z.enum(['recent_messages', 'summary_plus_recent', 'provider_resume']);
export type VoiceMemoryRestoreChoice = z.infer<typeof VoiceMemoryRestoreChoiceSchema>;

export function resolveVoiceMemoryRestoreChoice(voice: VoiceSettings): VoiceMemoryRestoreChoice {
  const agent = readLocalConversationVoiceSettings(voice).agent;
  return agent.resumabilityMode === 'provider_resume' ? 'provider_resume' : agent.replay.strategy;
}

export function applyVoiceMemoryRestoreChoice(voice: VoiceSettings, choice: VoiceMemoryRestoreChoice): VoiceSettings {
  const cfg = readLocalConversationVoiceSettings(voice);
  const agent = choice === 'provider_resume'
    ? { ...cfg.agent, resumabilityMode: 'provider_resume' as const }
    : { ...cfg.agent, resumabilityMode: 'replay' as const, replay: { ...cfg.agent.replay, strategy: choice } };
  return writeLocalConversationVoiceSettings(voice, { ...cfg, agent });
}

/** The "Restore memory by" declaration's owner binding: one choice, one atomic write. */
export const voiceMemoryRestoreBinding: SettingStorageBinding = {
  scope: 'account',
  kind: 'owner',
  access: 'read_write',
  allowedValues: VoiceMemoryRestoreChoiceSchema.options,
  read: (settings) => settings.voice.providers.local_conversation && !readVoiceProviderSettingsConfig(settings.voice, 'local_conversation')
    ? SETTING_VALUE_UNAVAILABLE : resolveVoiceMemoryRestoreChoice(settings.voice),
  parse: (value) => {
    const parsed = VoiceMemoryRestoreChoiceSchema.safeParse(value);
    return parsed.success ? { success: true, value: parsed.data } : { success: false };
  },
  mutate: (settings, value) => settings.voice.providers.local_conversation && !readVoiceProviderSettingsConfig(settings.voice, 'local_conversation') ? null : ({
    voice: applyVoiceMemoryRestoreChoice(settings.voice, VoiceMemoryRestoreChoiceSchema.parse(value)),
  }),
};
