export type GoogleVoiceSettingsField =
  | Readonly<{
      kind: 'remote_select';
      key: 'model' | 'voiceName';
      catalog: 'models' | 'voices';
      titleKey: string;
      subtitleKey: string;
      searchPlaceholderKey: string;
      allowCustom: boolean;
      nullable: boolean;
    }>
  | Readonly<{
      kind: 'language';
      key: 'language' | 'languageCode';
      titleKey: string;
      subtitleKey: string;
      autoTitleKey: string;
      autoSubtitleKey: string;
    }>
  | Readonly<{
      kind: 'enum';
      key: 'format';
      titleKey: string;
      subtitleKey: string;
      options: readonly Readonly<{ id: string; title: string }>[];
    }>
  | Readonly<{
      kind: 'number';
      key: 'speakingRate' | 'pitch';
      titleKey: string;
      subtitleKey: string;
      promptTitleKey: string;
      promptBodyKey: string;
      min: number;
      max: number;
      nullable: true;
    }>;

export type GoogleVoiceSettingsSpec = Readonly<{
  kind: 'voice.internal.speech-settings.v1';
  providerId: 'google_gemini' | 'google_cloud';
  role: 'stt' | 'tts';
  schemaVersion: 2;
  titleKey: string;
  subtitleKey: string;
  detailKey: string;
  privacyDisclosureKey: string;
  iconName: 'logo-google';
  credential: Readonly<{
    kind: 'api_key';
    titleKey: string;
    promptTitleKey: string;
    promptBodyKey: string;
    androidRestricted: boolean;
    androidRestrictedBodyKey: string | null;
  }>;
  fields: readonly GoogleVoiceSettingsField[];
  runtime: Readonly<Record<string, string>>;
  test: null | Readonly<{
    kind: 'synthesize';
    missingValueKey: 'voiceName';
    missingValueMessageKey: string;
  }>;
  defaultConfig: GoogleGeminiSttSettings | GoogleCloudTtsSettings;
  parseConfig: (value: unknown) => GoogleGeminiSttSettings | GoogleCloudTtsSettings | null;
  parseLegacyConfig: (value: unknown) => GoogleGeminiSttSettingsLegacy | GoogleCloudTtsSettingsLegacy | null;
  readLegacySecret: (value: unknown) => unknown | null;
  migrateLegacy: (value: unknown) => GoogleGeminiSttSettings | GoogleCloudTtsSettings | null;
  classifyLegacyCredential: (value: unknown) => 'importable' | 'needs_machine_credential';
}>;

const GOOGLE_GEMINI_SETTINGS = Object.freeze({
  kind: 'voice.internal.speech-settings.v1' as const,
  providerId: 'google_gemini' as const,
  role: 'stt' as const,
  schemaVersion: 2 as const,
  titleKey: 'settingsVoice.local.googleGeminiStt.provider.title',
  subtitleKey: 'settingsVoice.local.googleGeminiStt.provider.subtitle',
  detailKey: 'settingsVoice.local.googleGeminiStt.provider.detail',
  privacyDisclosureKey: 'settingsVoice.realtimeProviders.google.privacyDisclosure',
  iconName: 'logo-google' as const,
  credential: Object.freeze({
    kind: 'api_key' as const,
    titleKey: 'settingsVoice.local.googleGeminiStt.apiKey.title',
    promptTitleKey: 'settingsVoice.local.googleGeminiStt.apiKey.promptTitle',
    promptBodyKey: 'settingsVoice.local.googleGeminiStt.apiKey.promptBody',
    androidRestricted: false,
    androidRestrictedBodyKey: null,
  }),
  fields: Object.freeze([
    Object.freeze({
      kind: 'remote_select' as const,
      key: 'model' as const,
      catalog: 'models' as const,
      titleKey: 'settingsVoice.local.googleGeminiStt.model.title',
      subtitleKey: 'settingsVoice.local.googleGeminiStt.model.subtitle',
      searchPlaceholderKey: 'settingsVoice.local.googleGeminiStt.model.searchPlaceholder',
      allowCustom: true,
      nullable: false,
    }),
    Object.freeze({
      kind: 'language' as const,
      key: 'language' as const,
      titleKey: 'settingsVoice.local.googleGeminiStt.language.title',
      subtitleKey: 'settingsVoice.local.googleGeminiStt.language.subtitle',
      autoTitleKey: 'settingsVoice.local.googleGeminiStt.language.autoTitle',
      autoSubtitleKey: 'settingsVoice.local.googleGeminiStt.language.autoSubtitle',
    }),
  ]),
  runtime: Object.freeze({
    modelKey: 'model',
    languageKey: 'language',
    defaultModel: 'gemini-2.5-flash',
  }),
  defaultConfig: GOOGLE_GEMINI_STT_SETTINGS_DEFAULTS,
  parseConfig(value: unknown) {
    const parsed = GoogleGeminiSttSettingsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  parseLegacyConfig(value: unknown) {
    const parsed = GoogleGeminiSttSettingsLegacySchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  readLegacySecret(value: unknown) {
    const parsed = GoogleGeminiSttSettingsLegacySchema.safeParse(value);
    return parsed.success ? parsed.data.apiKey : null;
  },
  migrateLegacy(value: unknown) {
    const parsed = GoogleGeminiSttSettingsLegacySchema.safeParse(value);
    if (!parsed.success) return null;
    const { apiKey: _apiKey, ...canonical } = parsed.data;
    return GoogleGeminiSttSettingsSchema.parse(canonical);
  },
  classifyLegacyCredential: () => 'importable' as const,
  test: null,
}) satisfies GoogleVoiceSettingsSpec;

const GOOGLE_CLOUD_SETTINGS = Object.freeze({
  kind: 'voice.internal.speech-settings.v1' as const,
  providerId: 'google_cloud' as const,
  role: 'tts' as const,
  schemaVersion: 2 as const,
  titleKey: 'settingsVoice.local.googleCloudTts.provider.title',
  subtitleKey: 'settingsVoice.local.googleCloudTts.provider.subtitle',
  detailKey: 'settingsVoice.local.googleCloudTts.provider.detail',
  privacyDisclosureKey: 'settingsVoice.realtimeProviders.google.privacyDisclosure',
  iconName: 'logo-google' as const,
  credential: Object.freeze({
    kind: 'api_key' as const,
    titleKey: 'settingsVoice.local.googleCloudTts.apiKey.title',
    promptTitleKey: 'settingsVoice.local.googleCloudTts.apiKey.promptTitle',
    promptBodyKey: 'settingsVoice.local.googleCloudTts.apiKey.promptBody',
    androidRestricted: true,
    androidRestrictedBodyKey: 'settingsVoice.local.googleCloudTts.apiKey.machineCredentialRestrictionBody',
  }),
  fields: Object.freeze([
    Object.freeze({ kind: 'language' as const, key: 'languageCode' as const, titleKey: 'settingsVoice.local.googleCloudTts.language.title', subtitleKey: 'settingsVoice.local.googleCloudTts.language.subtitle', autoTitleKey: 'settingsVoice.local.googleCloudTts.language.allTitle', autoSubtitleKey: 'settingsVoice.local.googleCloudTts.language.allSubtitle' }),
    Object.freeze({ kind: 'remote_select' as const, key: 'voiceName' as const, catalog: 'voices' as const, titleKey: 'settingsVoice.local.googleCloudTts.voice.title', subtitleKey: 'settingsVoice.local.googleCloudTts.voice.subtitle', searchPlaceholderKey: 'settingsVoice.local.googleCloudTts.voice.searchPlaceholder', allowCustom: true, nullable: true }),
    Object.freeze({ kind: 'enum' as const, key: 'format' as const, titleKey: 'settingsVoice.local.googleCloudTts.format.title', subtitleKey: 'settingsVoice.local.googleCloudTts.format.subtitle', options: Object.freeze([{ id: 'mp3', title: 'MP3' }, { id: 'wav', title: 'WAV' }]) }),
    Object.freeze({ kind: 'number' as const, key: 'speakingRate' as const, titleKey: 'settingsVoice.local.googleCloudTts.speakingRate.title', subtitleKey: 'settingsVoice.local.googleCloudTts.speakingRate.subtitle', promptTitleKey: 'settingsVoice.local.googleCloudTts.speakingRate.promptTitle', promptBodyKey: 'settingsVoice.local.googleCloudTts.speakingRate.promptBody', min: 0.25, max: 4, nullable: true as const }),
    Object.freeze({ kind: 'number' as const, key: 'pitch' as const, titleKey: 'settingsVoice.local.googleCloudTts.pitch.title', subtitleKey: 'settingsVoice.local.googleCloudTts.pitch.subtitle', promptTitleKey: 'settingsVoice.local.googleCloudTts.pitch.promptTitle', promptBodyKey: 'settingsVoice.local.googleCloudTts.pitch.promptBody', min: -20, max: 20, nullable: true as const }),
  ]),
  runtime: Object.freeze({
    voiceKey: 'voiceName',
    languageKey: 'languageCode',
    formatKey: 'format',
    rateKey: 'speakingRate',
    pitchKey: 'pitch',
  }),
  defaultConfig: GOOGLE_CLOUD_TTS_SETTINGS_DEFAULTS,
  parseConfig(value: unknown) {
    const parsed = GoogleCloudTtsSettingsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  parseLegacyConfig(value: unknown) {
    const parsed = GoogleCloudTtsSettingsLegacySchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  readLegacySecret(value: unknown) {
    const parsed = GoogleCloudTtsSettingsLegacySchema.safeParse(value);
    return parsed.success ? parsed.data.apiKey : null;
  },
  migrateLegacy(value: unknown) {
    const parsed = GoogleCloudTtsSettingsLegacySchema.safeParse(value);
    if (!parsed.success) return null;
    const { apiKey: _apiKey, androidCertSha1: _androidCertSha1, ...canonical } = parsed.data;
    return GoogleCloudTtsSettingsSchema.parse(canonical);
  },
  classifyLegacyCredential(value: unknown) {
    const parsed = GoogleCloudTtsSettingsLegacySchema.safeParse(value);
    return parsed.success && typeof parsed.data.androidCertSha1 === 'string' && parsed.data.androidCertSha1.trim()
      ? 'needs_machine_credential' as const
      : 'importable' as const;
  },
  test: Object.freeze({
    kind: 'synthesize' as const,
    missingValueKey: 'voiceName' as const,
    missingValueMessageKey: 'settingsVoice.local.googleCloudTts.alerts.missingVoice',
  }),
}) satisfies GoogleVoiceSettingsSpec;

export function createGoogleVoiceSettingsSpec(providerId: string): GoogleVoiceSettingsSpec | null {
  if (providerId === GOOGLE_GEMINI_SETTINGS.providerId) return GOOGLE_GEMINI_SETTINGS;
  if (providerId === GOOGLE_CLOUD_SETTINGS.providerId) return GOOGLE_CLOUD_SETTINGS;
  return null;
}
import {
  GOOGLE_CLOUD_TTS_SETTINGS_DEFAULTS,
  GOOGLE_GEMINI_STT_SETTINGS_DEFAULTS,
  GoogleCloudTtsSettingsLegacySchema,
  GoogleCloudTtsSettingsSchema,
  GoogleGeminiSttSettingsLegacySchema,
  GoogleGeminiSttSettingsSchema,
  type GoogleCloudTtsSettingsLegacy,
  type GoogleCloudTtsSettings,
  type GoogleGeminiSttSettingsLegacy,
  type GoogleGeminiSttSettings,
} from '../../protocol/voice/settings.js';
