/** Curated controls over the OpenAI plugin's canonical configuration. */
import { OPENAI_REALTIME_DEFAULT_INPUT_TRANSCRIPTION_MODEL, OPENAI_REALTIME_DEFAULT_SETTINGS } from './protocol/voice/settings.js';

export const OPENAI_REALTIME_SETTINGS_SECTION = Object.freeze({
  kind: 'voice.provider-settings.v1' as const,
  modes: ['byo'],
  language: { kind: 'automatic_recognition' as const },
  titleKey: 'settingsVoice.realtimeProviders.setup.title',
  footerKey: 'settingsVoice.realtimeProviders.authentication.footer',
  credential: {
    kind: 'api_key' as const, credentialPurpose: 'voice.client-auth', catalog: 'voices' as const,
    titleKey: 'settingsVoice.realtimeProviders.credential.title',
    promptTitleKey: 'settingsVoice.realtimeProviders.credential.promptTitle',
    promptBodyKey: 'settingsVoice.realtimeProviders.credential.promptBody',
  },
  links: { account: 'https://platform.openai.com', apiKeys: 'https://platform.openai.com/api-keys', privacy: 'https://openai.com/policies/privacy-policy/' },
  fields: [
    {
      kind: 'model', path: 'model', movingAliasRequiresOptIn: true, customIdAllowed: true,
      titleKey: 'settingsVoice.realtimeProviders.fields.model.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.model.subtitle',
      options: [OPENAI_REALTIME_DEFAULT_SETTINGS.model, { kind: 'moving_alias', id: 'gpt-realtime' }],
    },
    {
      kind: 'voice_catalog', path: 'voice', valueShape: 'string', customIdAllowed: true,
      titleKey: 'settingsVoice.realtimeProviders.fields.voice.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.voice.subtitle',
    },
    {
      kind: 'instructions', path: 'instructions', maxLength: 10_000,
      titleKey: 'settingsVoice.realtimeProviders.fields.instructions.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.instructions.subtitle',
      promptTitleKey: 'settingsVoice.realtimeProviders.fields.instructions.promptTitle',
      promptBodyKey: 'settingsVoice.realtimeProviders.fields.instructions.promptBody',
    },
    {
      kind: 'select', path: 'turnDetection', options: ['server_vad', 'semantic_vad', 'manual'],
      titleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.subtitle',
    },
    {
      kind: 'select', path: 'inputTranscriptionModel',
      titleKey: 'settingsVoice.realtimeProviders.fields.transcriptionModel.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.transcriptionModel.subtitle',
      options: [
        { id: '', titleKey: 'settingsVoice.realtimeProviders.options.automatic' },
        { id: OPENAI_REALTIME_DEFAULT_INPUT_TRANSCRIPTION_MODEL, title: OPENAI_REALTIME_DEFAULT_INPUT_TRANSCRIPTION_MODEL },
        { id: 'custom', titleKey: 'settingsVoice.realtimeProviders.options.custom' },
      ],
    },
  ],
});
