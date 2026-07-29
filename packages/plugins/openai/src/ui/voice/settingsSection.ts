export const OPENAI_REALTIME_SETTINGS_SECTION = Object.freeze({
  kind: 'voice.internal.realtime-settings.v1' as const,
  providerId: 'realtime_openai' as const,
  mode: 'byo' as const,
  titleKey: 'settingsVoice.realtimeProviders.authentication.sectionTitle',
  footerKey: 'settingsVoice.realtimeProviders.authentication.footer',
  credential: Object.freeze({
    kind: 'api_key' as const,
    catalog: null,
    titleKey: 'settingsVoice.realtimeProviders.credential.title',
    promptTitleKey: 'settingsVoice.realtimeProviders.credential.promptTitle',
    promptBodyKey: 'settingsVoice.realtimeProviders.credential.promptBody',
  }),
  links: Object.freeze({
    account: 'https://platform.openai.com',
    apiKeys: 'https://platform.openai.com/api-keys',
    privacy: 'https://openai.com/policies/privacy-policy/',
  }),
  fields: Object.freeze([
    Object.freeze({
      kind: 'authentication_source' as const,
      path: 'authentication',
      titleKey: 'settingsVoice.realtimeProviders.authentication.title',
      subtitleKey: 'settingsVoice.realtimeProviders.authentication.subtitle',
      options: Object.freeze([
        Object.freeze({
          id: 'voice_saved_secret' as const,
          titleKey: 'settingsVoice.realtimeProviders.authentication.savedSecret.title',
          subtitleKey: 'settingsVoice.realtimeProviders.authentication.savedSecret.subtitle',
        }),
        Object.freeze({
          id: 'connected_service_api_key' as const,
          purpose: 'realtime-openai-account' as const,
          titleKey: 'settingsVoice.realtimeProviders.authentication.openAiApiKey.title',
          subtitleKey: 'settingsVoice.realtimeProviders.authentication.openAiApiKey.subtitle',
        }),
        Object.freeze({
          id: 'connected_service_oauth' as const,
          purpose: 'realtime-openai-codex-account' as const,
          titleKey: 'settingsVoice.realtimeProviders.authentication.openAiCodex.title',
          subtitleKey: 'settingsVoice.realtimeProviders.authentication.openAiCodex.subtitle',
        }),
      ]),
    }),
    Object.freeze({
      kind: 'model' as const,
      path: 'model',
      titleKey: 'settingsVoice.realtimeProviders.fields.model.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.model.subtitle',
      movingAliasRequiresOptIn: true,
      options: Object.freeze([
        Object.freeze({ kind: 'pinned' as const, id: 'gpt-realtime-2.1' }),
        Object.freeze({ kind: 'moving_alias' as const, id: 'gpt-realtime' }),
      ]),
    }),
    Object.freeze({
      kind: 'voice' as const,
      path: 'voice',
      titleKey: 'settingsVoice.realtimeProviders.fields.voice.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.voice.subtitle',
      customIdAllowed: true,
      options: Object.freeze([
        Object.freeze({ id: 'marin', recommended: true }),
        Object.freeze({ id: 'cedar', recommended: true }),
      ]),
    }),
    Object.freeze({
      kind: 'instructions' as const,
      path: 'instructions',
      maxLength: 16_384,
      titleKey: 'settingsVoice.realtimeProviders.fields.instructions.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.instructions.subtitle',
      promptTitleKey: 'settingsVoice.realtimeProviders.fields.instructions.promptTitle',
      promptBodyKey: 'settingsVoice.realtimeProviders.fields.instructions.promptBody',
    }),
    Object.freeze({
      kind: 'turn_detection' as const,
      path: 'turnDetection',
      options: Object.freeze(['server_vad', 'semantic_vad', 'manual']),
      titleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.subtitle',
    }),
    Object.freeze({
      kind: 'optional_model' as const,
      path: 'inputTranscriptionModel',
      titleKey: 'settingsVoice.realtimeProviders.fields.transcriptionModel.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.transcriptionModel.subtitle',
      promptTitleKey: 'settingsVoice.realtimeProviders.fields.transcriptionModel.promptTitle',
      promptBodyKey: 'settingsVoice.realtimeProviders.fields.transcriptionModel.promptBody',
    }),
  ]),
});

export function createOpenAiRealtimeSettingsSection() {
  return OPENAI_REALTIME_SETTINGS_SECTION;
}
