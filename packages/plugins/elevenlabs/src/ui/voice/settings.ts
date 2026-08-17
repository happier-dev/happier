export const ELEVENLABS_SETTINGS_SECTION = Object.freeze({
  kind: 'voice.internal.conversation-settings.v1' as const,
  providerId: 'happier.voice.elevenlabs/realtime-elevenlabs' as const,
  modes: Object.freeze(['happier', 'byo'] as const),
  titleKey: 'settingsVoice.byo.title',
  footerKey: 'settingsVoice.byo.provisioningGroupFooter',
  credential: Object.freeze({
    kind: 'api_key' as const,
    credentialPurpose: 'voice.client-auth.elevenlabs' as const,
    catalog: 'voices' as const,
    titleKey: 'settingsVoice.byo.apiKeyTitle',
    promptTitleKey: 'settingsVoice.byo.apiKeyTitle',
    promptBodyKey: 'settingsVoice.byo.apiKeyDescription',
  }),
  links: Object.freeze({
    account: 'https://elevenlabs.io',
    apiKeys: 'https://elevenlabs.io/app/settings/api-keys',
  }),
  fields: Object.freeze([
    Object.freeze({
      kind: 'welcome' as const,
      path: 'welcome',
      titleKey: 'settingsVoice.byo.realtime.call.welcome.title',
      subtitleKey: 'settingsVoice.byo.realtime.call.welcome.subtitle',
    }),
    Object.freeze({
      kind: 'text' as const,
      path: 'agentId',
      titleKey: 'settingsVoice.byo.agentIdTitle',
      subtitleKey: 'settingsVoice.byo.agentIdDescription',
      promptTitleKey: 'settingsVoice.byo.agentIdTitle',
      promptBodyKey: 'settingsVoice.byo.agentIdDescription',
    }),
    Object.freeze({
      kind: 'remote_voice' as const,
      path: 'tts.voiceId',
      catalog: 'voices' as const,
      titleKey: 'settingsVoice.byo.realtime.voicePicker.title',
      subtitleKey: 'settingsVoice.byo.realtime.voicePicker.subtitle',
      searchPlaceholderKey: 'settingsVoice.byo.voiceSearchPlaceholder',
    }),
    Object.freeze({ kind: 'select' as const, path: 'tts.modelId',
      titleKey: 'settingsVoice.byo.realtime.modelPicker.title',
      subtitleKey: 'settingsVoice.byo.realtime.modelPicker.subtitle',
      promptTitleKey: 'settingsVoice.byo.realtime.modelPicker.prompt.title',
      promptBodyKey: 'settingsVoice.byo.realtime.modelPicker.prompt.body',
      options: Object.freeze([
      Object.freeze({ id: '', titleKey: 'settingsVoice.byo.realtime.modelPicker.options.autoTitle', subtitleKey: 'settingsVoice.byo.realtime.modelPicker.options.autoSubtitle' }),
      Object.freeze({ id: 'eleven_multilingual_v2', title: 'eleven_multilingual_v2', subtitleKey: 'settingsVoice.byo.realtime.modelPicker.options.multilingualV2Subtitle' }),
      Object.freeze({ id: 'eleven_turbo_v2', title: 'eleven_turbo_v2', subtitleKey: 'settingsVoice.byo.realtime.modelPicker.options.turboV2Subtitle' }),
      Object.freeze({ id: 'eleven_turbo_v2_5', title: 'eleven_turbo_v2_5', subtitleKey: 'settingsVoice.byo.realtime.modelPicker.options.turboV25Subtitle' }),
      Object.freeze({ id: 'custom', titleKey: 'settingsVoice.byo.realtime.modelPicker.options.customTitle', subtitleKey: 'settingsVoice.byo.realtime.modelPicker.options.customSubtitle' }),
    ]) }),
    Object.freeze({ kind: 'number' as const, path: 'tts.voiceSettings.stability', min: 0, max: 1,
      titleKey: 'settingsVoice.byo.realtime.voiceSettings.stability.title', subtitleKey: 'settingsVoice.byo.realtime.voiceSettings.stability.subtitle',
      promptTitleKey: 'settingsVoice.byo.realtime.voiceSettings.stability.promptTitle', promptBodyKey: 'settingsVoice.byo.realtime.voiceSettings.stability.promptBody' }),
    Object.freeze({ kind: 'number' as const, path: 'tts.voiceSettings.similarityBoost', min: 0, max: 1,
      titleKey: 'settingsVoice.byo.realtime.voiceSettings.similarityBoost.title', subtitleKey: 'settingsVoice.byo.realtime.voiceSettings.similarityBoost.subtitle',
      promptTitleKey: 'settingsVoice.byo.realtime.voiceSettings.similarityBoost.promptTitle', promptBodyKey: 'settingsVoice.byo.realtime.voiceSettings.similarityBoost.promptBody' }),
    Object.freeze({ kind: 'number' as const, path: 'tts.voiceSettings.speed', min: 0.7, max: 1.2,
      titleKey: 'settingsVoice.byo.realtime.voiceSettings.speed.title', subtitleKey: 'settingsVoice.byo.realtime.voiceSettings.speed.subtitle',
      promptTitleKey: 'settingsVoice.byo.realtime.voiceSettings.speed.promptTitle', promptBodyKey: 'settingsVoice.byo.realtime.voiceSettings.speed.promptBody' }),
  ]),
});

export function createElevenLabsSettingsSection() {
  return ELEVENLABS_SETTINGS_SECTION;
}
