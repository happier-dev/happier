export const GOOGLE_GEMINI_SETTINGS = Object.freeze({
  titleKey: 'settingsVoice.local.googleGeminiStt.provider.title',
  subtitleKey: 'settingsVoice.local.googleGeminiStt.provider.subtitle',
  detailKey: 'settingsVoice.local.googleGeminiStt.provider.detail',
  iconName: 'logo-google' as const,
  credential: Object.freeze({
    titleKey: 'settingsVoice.local.googleGeminiStt.apiKey.title',
    promptTitleKey: 'settingsVoice.local.googleGeminiStt.apiKey.promptTitle',
    promptBodyKey: 'settingsVoice.local.googleGeminiStt.apiKey.promptBody',
  }),
  fields: Object.freeze([
    Object.freeze({
      fieldId: 'model',
      titleKey: 'settingsVoice.local.googleGeminiStt.model.title',
      subtitleKey: 'settingsVoice.local.googleGeminiStt.model.subtitle',
      searchPlaceholderKey: 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder',
    }),
    Object.freeze({
      fieldId: 'language',
      titleKey: 'settingsVoice.local.googleGeminiStt.language.title',
      subtitleKey: 'settingsVoice.local.googleGeminiStt.language.subtitle',
      autoTitleKey: 'settingsVoice.local.googleGeminiStt.language.autoTitle',
      autoSubtitleKey: 'settingsVoice.local.googleGeminiStt.language.autoSubtitle',
    }),
  ]),
  test: null,
});

export const GOOGLE_CLOUD_SETTINGS = Object.freeze({
  titleKey: 'settingsVoice.local.googleCloudTts.provider.title',
  subtitleKey: 'settingsVoice.local.googleCloudTts.provider.subtitle',
  detailKey: 'settingsVoice.local.googleCloudTts.provider.detail',
  iconName: 'logo-google' as const,
  credential: Object.freeze({
    titleKey: 'settingsVoice.local.googleCloudTts.apiKey.title',
    promptTitleKey: 'settingsVoice.local.googleCloudTts.apiKey.promptTitle',
    promptBodyKey: 'settingsVoice.local.googleCloudTts.apiKey.promptBody',
  }),
  fields: Object.freeze([
    Object.freeze({
      fieldId: 'languageCode',
      titleKey: 'settingsVoice.local.googleCloudTts.language.title',
      subtitleKey: 'settingsVoice.local.googleCloudTts.language.subtitle',
      autoTitleKey: 'settingsVoice.local.googleCloudTts.language.allTitle',
      autoSubtitleKey: 'settingsVoice.local.googleCloudTts.language.allSubtitle',
    }),
    Object.freeze({
      fieldId: 'voiceName',
      titleKey: 'settingsVoice.local.googleCloudTts.voice.title',
      subtitleKey: 'settingsVoice.local.googleCloudTts.voice.subtitle',
      searchPlaceholderKey: 'settingsVoice.local.googleCloudTts.voice.searchPlaceholder',
    }),
    Object.freeze({
      fieldId: 'format',
      titleKey: 'settingsVoice.local.googleCloudTts.format.title',
      subtitleKey: 'settingsVoice.local.googleCloudTts.format.subtitle',
    }),
    Object.freeze({
      fieldId: 'speakingRate',
      titleKey: 'settingsVoice.local.googleCloudTts.speakingRate.title',
      subtitleKey: 'settingsVoice.local.googleCloudTts.speakingRate.subtitle',
      promptTitleKey: 'settingsVoice.local.googleCloudTts.speakingRate.promptTitle',
      promptBodyKey: 'settingsVoice.local.googleCloudTts.speakingRate.promptBody',
    }),
    Object.freeze({
      fieldId: 'pitch',
      titleKey: 'settingsVoice.local.googleCloudTts.pitch.title',
      subtitleKey: 'settingsVoice.local.googleCloudTts.pitch.subtitle',
      promptTitleKey: 'settingsVoice.local.googleCloudTts.pitch.promptTitle',
      promptBodyKey: 'settingsVoice.local.googleCloudTts.pitch.promptBody',
    }),
  ]),
  test: Object.freeze({
    missingValueMessageKey: 'settingsVoice.local.googleCloudTts.alerts.missingVoice',
  }),
});
