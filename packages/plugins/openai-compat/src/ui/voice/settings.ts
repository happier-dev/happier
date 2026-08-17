const OPENAI_COMPAT_STT_SETTINGS = Object.freeze({
  titleKey: 'settingsVoice.local.openaiCompatStt.provider.title',
  subtitleKey: 'settingsVoice.local.openaiCompatStt.provider.subtitle',
  detailKey: 'settingsVoice.local.openaiCompatStt.provider.detail',
  iconName: 'cloud',
  credential: Object.freeze({
    titleKey: 'settingsVoice.local.sttApiKey',
    promptTitleKey: 'settingsVoice.local.sttApiKeyTitle',
    promptBodyKey: 'settingsVoice.local.sttApiKeyDescription',
  }),
  fields: Object.freeze([
    Object.freeze({
      fieldId: 'baseUrl',
      titleKey: 'settingsVoice.local.sttBaseUrl',
      subtitleKey: 'settingsVoice.local.sttBaseUrlDescription',
      promptTitleKey: 'settingsVoice.local.sttBaseUrlTitle',
      promptBodyKey: 'settingsVoice.local.sttBaseUrlDescription',
    }),
    Object.freeze({
      fieldId: 'model',
      titleKey: 'settingsVoice.local.sttModel',
      subtitleKey: 'settingsVoice.local.sttModelSubtitle',
      promptTitleKey: 'settingsVoice.local.sttModelTitle',
      promptBodyKey: 'settingsVoice.local.sttModelDescription',
    }),
    Object.freeze({
      fieldId: 'language',
      titleKey: 'settingsVoice.local.localNeuralStt.language.title',
      subtitleKey: 'settingsVoice.local.localNeuralStt.language.subtitle',
      promptTitleKey: 'settingsVoice.local.localNeuralStt.language.promptTitle',
      promptBodyKey: 'settingsVoice.local.localNeuralStt.language.promptBody',
    }),
  ]),
  test: null,
});

const OPENAI_COMPAT_TTS_SETTINGS = Object.freeze({
  titleKey: 'settingsVoice.local.openaiCompatTts.provider.title',
  subtitleKey: 'settingsVoice.local.openaiCompatTts.provider.subtitle',
  detailKey: 'settingsVoice.local.openaiCompatTts.provider.detail',
  iconName: 'cloud',
  credential: Object.freeze({
    titleKey: 'settingsVoice.local.ttsApiKey',
    promptTitleKey: 'settingsVoice.local.ttsApiKeyTitle',
    promptBodyKey: 'settingsVoice.local.ttsApiKeyDescription',
  }),
  fields: Object.freeze([
    Object.freeze({
      fieldId: 'baseUrl',
      titleKey: 'settingsVoice.local.ttsBaseUrl',
      subtitleKey: 'settingsVoice.local.ttsBaseUrlDescription',
      promptTitleKey: 'settingsVoice.local.ttsBaseUrlTitle',
      promptBodyKey: 'settingsVoice.local.ttsBaseUrlDescription',
    }),
    Object.freeze({
      fieldId: 'model',
      titleKey: 'settingsVoice.local.ttsModel',
      subtitleKey: 'settingsVoice.local.ttsModelSubtitle',
      promptTitleKey: 'settingsVoice.local.ttsModelTitle',
      promptBodyKey: 'settingsVoice.local.ttsModelDescription',
    }),
    Object.freeze({
      fieldId: 'voiceName',
      titleKey: 'settingsVoice.local.ttsVoice',
      subtitleKey: 'settingsVoice.local.ttsVoiceSubtitle',
      promptTitleKey: 'settingsVoice.local.ttsVoiceTitle',
      promptBodyKey: 'settingsVoice.local.ttsVoiceDescription',
    }),
    Object.freeze({
      fieldId: 'format',
      titleKey: 'settingsVoice.local.ttsFormat',
      subtitleKey: 'settingsVoice.local.ttsFormatSubtitle',
    }),
  ]),
  test: Object.freeze({
    missingValueMessageKey: 'settingsVoice.local.testTtsMissingBaseUrl',
  }),
});

export function createOpenAiCompatSttVoiceSettingsSpec() {
  return OPENAI_COMPAT_STT_SETTINGS;
}

export function createOpenAiCompatTtsVoiceSettingsSpec() {
  return OPENAI_COMPAT_TTS_SETTINGS;
}
