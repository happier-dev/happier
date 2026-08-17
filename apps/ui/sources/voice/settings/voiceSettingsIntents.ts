import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { TranslationKeyNoParams } from '@/text';

export type VoiceSettingsIntent = 'dictation' | 'conversations' | 'privacy' | 'advanced';

export type VoiceSettingsIntentDefinition = Readonly<{
  id: VoiceSettingsIntent;
  route: string;
  titleKey: TranslationKeyNoParams;
  subtitleKey: TranslationKeyNoParams;
}>;

export const VOICE_SETTINGS_INTENTS: readonly VoiceSettingsIntentDefinition[] = Object.freeze([
  {
    id: 'dictation',
    route: SETTINGS_ROUTES.voiceDictation,
    titleKey: 'settingsVoice.intents.dictation.title',
    subtitleKey: 'settingsVoice.intents.dictation.subtitle',
  },
  {
    id: 'conversations',
    route: SETTINGS_ROUTES.voiceConversations,
    titleKey: 'settingsVoice.intents.conversations.title',
    subtitleKey: 'settingsVoice.intents.conversations.subtitle',
  },
  {
    id: 'privacy',
    route: SETTINGS_ROUTES.voicePrivacy,
    titleKey: 'settingsVoice.intents.privacy.title',
    subtitleKey: 'settingsVoice.intents.privacy.subtitle',
  },
  {
    id: 'advanced',
    route: SETTINGS_ROUTES.voiceAdvanced,
    titleKey: 'settingsVoice.intents.advanced.title',
    subtitleKey: 'settingsVoice.intents.advanced.subtitle',
  },
]);

export function resolveLegacyVoiceSettingsIntent(value: unknown): VoiceSettingsIntent | null {
  if (value === 'provider') return 'conversations';
  if (value === 'privacy') return 'privacy';
  return null;
}
