import {
  VoiceCredentialSlotIdSchema,
  type VoiceProviderContribution,
} from '@happier-dev/plugin-sdk/voice';

type SpeechVoiceProviderDeclaration = Omit<Extract<VoiceProviderContribution, { kind: 'speech' }>, 'id'>;
const GOOGLE_API_KEY_VOICE_CREDENTIAL_SLOT_ID = VoiceCredentialSlotIdSchema.parse('api_key');

export const GOOGLE_GEMINI_STT_VOICE_PROVIDER_DECLARATION: SpeechVoiceProviderDeclaration & {
  limits: { transcribe: { maxInputBytes: number } };
} = {
  title: 'Google Gemini Speech-to-Text',
  kind: 'speech',
  roles: ['dictation_stt', 'conversation_stt'],
  platforms: ['web', 'ios', 'android'],
  credentials: {
    slot: {
      id: GOOGLE_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
      purpose: 'voice.speech.transcribe',
      title: 'Google Gemini API key',
    },
    requirement: { kind: 'always' },
    sources: [{
      kind: 'savedSecret',
      secretKinds: ['apiKey'],
      rawGrants: [{
        realm: 'daemon',
        phase: 'speech',
        request: {
          kind: 'httpHeaders',
          origin: 'https://generativelanguage.googleapis.com',
          headerNames: ['x-goog-api-key'],
        },
      }],
    }],
  },
  settings: {
    schemaVersion: 2,
    privacyDisclosure: {
      key: 'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure',
      fallback: 'Audio sent for transcription is processed by Google Gemini. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
    },
    privacyFacts: {
      audioDestination: 'Google',
      processor: 'Google Gemini',
      retention: { key: 'settingsVoice.pages.privacy.servicePolicy', fallback: 'Follows your service account settings and terms.' },
    },
    fields: [
      {
        id: 'model',
        title: 'Model',
        schema: { type: 'string', minLength: 1, maxLength: 256 },
        default: 'gemini-2.5-flash',
        presentation: { control: 'select' },
      },
      {
        id: 'language',
        title: 'Language',
        schema: { type: 'string', maxLength: 64 },
        default: '',
        presentation: { control: 'text' },
      },
    ],
  },
  catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }],
  limits: { transcribe: { maxInputBytes: 8_388_608 } },
};

export const GOOGLE_CLOUD_TTS_VOICE_PROVIDER_DECLARATION: SpeechVoiceProviderDeclaration & {
  limits: { synthesize: { maxInputUtf8Bytes: number; maxOutputBytes: number } };
} = {
  title: 'Google Cloud Text-to-Speech',
  kind: 'speech',
  roles: ['conversation_tts'],
  platforms: ['web', 'ios', 'android'],
  credentials: {
    slot: {
      id: GOOGLE_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
      purpose: 'voice.speech.synthesize',
      title: 'Google Cloud API key',
    },
    requirement: { kind: 'always' },
    sources: [{
      kind: 'savedSecret',
      secretKinds: ['apiKey'],
      rawGrants: [{
        realm: 'daemon',
        phase: 'speech',
        request: {
          kind: 'httpHeaders',
          origin: 'https://texttospeech.googleapis.com',
          headerNames: ['x-goog-api-key'],
        },
      }],
    }],
  },
  settings: {
    schemaVersion: 2,
    privacyDisclosure: {
      key: 'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure',
      fallback: 'Text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
    },
    privacyFacts: {
      audioDestination: { key: 'settingsVoice.pages.privacy.noMicrophoneAudio', fallback: 'No microphone audio; reply text only.' },
      processor: 'Google Cloud Text-to-Speech',
      retention: { key: 'settingsVoice.pages.privacy.servicePolicy', fallback: 'Follows your service account settings and terms.' },
    },
    fields: [
      {
        id: 'voiceName',
        title: 'Voice',
        schema: { type: 'string', maxLength: 256 },
        default: '',
        presentation: { control: 'select' },
      },
      {
        id: 'languageCode',
        title: 'Language',
        schema: { type: 'string', maxLength: 64 },
        default: '',
        presentation: { control: 'text' },
      },
      {
        id: 'format',
        title: 'Audio format',
        schema: { type: 'string', enum: ['mp3', 'wav'] },
        default: 'mp3',
        presentation: {
          control: 'select',
          options: [
            { value: 'mp3', title: 'MP3' },
            { value: 'wav', title: 'WAV' },
          ],
        },
      },
      {
        id: 'speakingRate',
        title: 'Speaking rate',
        schema: { type: 'number', minimum: 0.25, maximum: 4 },
        default: 1,
        presentation: { control: 'number', step: 0.05 },
      },
      {
        id: 'pitch',
        title: 'Pitch',
        schema: { type: 'number', minimum: -20, maximum: 20 },
        default: 0,
        presentation: { control: 'number', step: 0.5 },
      },
    ],
    readiness: [{ kind: 'setting_nonempty', settingId: 'voiceName' }],
  },
  catalogs: [{ kind: 'voices', settingFieldId: 'voiceName', allowCustom: true }],
  limits: {
    synthesize: {
      maxInputUtf8Bytes: 5_000,
      maxOutputBytes: 3_000_000,
    },
  },
};

export const GOOGLE_VOICE_UI = {
  translations: [
    { locale: "en", resourceId: "i18n-en" },
    { locale: "ru", resourceId: "i18n-ru" },
    { locale: "pl", resourceId: "i18n-pl" },
    { locale: "es", resourceId: "i18n-es" },
    { locale: "fr", resourceId: "i18n-fr" },
    { locale: "it", resourceId: "i18n-it" },
    { locale: "pt", resourceId: "i18n-pt" },
    { locale: "de", resourceId: "i18n-de" },
    { locale: "ca", resourceId: "i18n-ca" },
    { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
    { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
    { locale: "ja", resourceId: "i18n-ja" },
  ],
};
