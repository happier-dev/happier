import {
  VoiceProviderSettingsEnvelopeV1Schema,
  type VoiceProviderSettingsJsonValueV1,
} from '@happier-dev/protocol';

const GOOGLE_GEMINI_STT_ID = 'happier.voice.google/gemini-stt';
const GOOGLE_CLOUD_TTS_ID = 'happier.voice.google/google-cloud-tts';
const OPENAI_COMPAT_STT_ID = 'happier.voice.openai-compat/stt';
const OPENAI_COMPAT_TTS_ID = 'happier.voice.openai-compat/tts';

export function normalizeLegacySpeechProviderSelection(
  role: 'stt' | 'tts',
  providerId: string,
): string {
  if (role === 'stt' && providerId === 'google_gemini') return GOOGLE_GEMINI_STT_ID;
  if (role === 'tts' && providerId === 'google_cloud') return GOOGLE_CLOUD_TTS_ID;
  if (role === 'stt' && providerId === 'openai_compat') return OPENAI_COMPAT_STT_ID;
  if (role === 'tts' && providerId === 'openai_compat') return OPENAI_COMPAT_TTS_ID;
  return providerId;
}

/**
 * Projects only speech selections understood by the released Voice reader.
 * Unknown/current-only contributions remain unprojectable instead of being
 * aliased into a different predecessor provider.
 */
export function projectPredecessorSpeechProviderSelection(
  role: 'stt' | 'tts',
  providerId: string,
): string | null {
  if (providerId === 'device' || providerId === 'local_neural') return providerId;
  if (role === 'stt' && (providerId === 'google_gemini' || providerId === GOOGLE_GEMINI_STT_ID)) {
    return 'google_gemini';
  }
  if (role === 'tts' && (providerId === 'google_cloud' || providerId === GOOGLE_CLOUD_TTS_ID)) {
    return 'google_cloud';
  }
  if (role === 'stt' && providerId === OPENAI_COMPAT_STT_ID) return 'openai_compat';
  if (role === 'tts' && providerId === OPENAI_COMPAT_TTS_ID) return 'openai_compat';
  return null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

type LegacyGoogleSpeechMapping = Readonly<{
  field: 'googleGemini' | 'googleCloud';
  providerId: 'google_gemini' | 'google_cloud';
}>;

function migrateLegacyGoogleSpeechSettings(
  input: Record<string, unknown>,
  mapping: LegacyGoogleSpeechMapping,
): Record<string, unknown> {
  const { [mapping.field]: legacyConfig, ...withoutLegacyField } = input;
  const existingProviders = asRecord(input.providers);
  const providers: Record<string, unknown> = existingProviders ? { ...existingProviders } : {};
  const hasCanonicalEnvelope = VoiceProviderSettingsEnvelopeV1Schema.safeParse(
    providers[mapping.providerId],
  ).success;
  const selectedLegacyProvider = input.provider === mapping.providerId;

  if (!hasCanonicalEnvelope && (legacyConfig !== undefined || selectedLegacyProvider)) {
    const config = asRecord(legacyConfig) ?? {};
    providers[mapping.providerId] = {
      schemaVersion: 1,
      config: config as VoiceProviderSettingsJsonValueV1,
    };
  }

  return Object.keys(providers).length > 0
    ? { ...withoutLegacyField, providers }
    : withoutLegacyField;
}

export function migrateLegacyGoogleSttSettings(input: Record<string, unknown>): Record<string, unknown> {
  return migrateLegacyGoogleSpeechSettings(input, {
    field: 'googleGemini',
    providerId: 'google_gemini',
  });
}

export function migrateLegacyGoogleTtsSettings(input: Record<string, unknown>): Record<string, unknown> {
  return migrateLegacyGoogleSpeechSettings(input, {
    field: 'googleCloud',
    providerId: 'google_cloud',
  });
}

function copyString(
  source: Readonly<Record<string, unknown>>,
  sourceKey: string,
  target: Record<string, unknown>,
  targetKey = sourceKey,
): void {
  const value = source[sourceKey];
  if (typeof value === 'string') target[targetKey] = value;
}

function copyFiniteNumber(
  source: Readonly<Record<string, unknown>>,
  key: string,
  target: Record<string, unknown>,
): void {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value;
}

/**
 * The sole ingress mapper from predecessor speech-role configuration into
 * contribution-owned settings. Google configuration is provenance-backed.
 * Released OpenAI-compatible role configuration is qualified only by this
 * predecessor role context. Credentials are handled by the Account Settings
 * SavedSecret owner, never copied into provider configuration.
 */
export function migrateLegacySpeechProviderConfig(
  providerId: string,
  rawConfig: unknown,
): Readonly<Record<string, unknown>> | null {
  const source = asRecord(rawConfig);
  if (!source) return null;
  const migrated: Record<string, unknown> = {};

  switch (providerId) {
    case GOOGLE_GEMINI_STT_ID:
      copyString(source, 'model', migrated);
      copyString(source, 'language', migrated);
      return migrated;
    case GOOGLE_CLOUD_TTS_ID:
      copyString(source, 'voiceName', migrated);
      copyString(source, 'languageCode', migrated);
      copyString(source, 'format', migrated);
      copyFiniteNumber(source, 'speakingRate', migrated);
      copyFiniteNumber(source, 'pitch', migrated);
      return migrated;
    case OPENAI_COMPAT_STT_ID:
      copyString(source, 'baseUrl', migrated);
      copyString(source, 'model', migrated);
      return migrated;
    case OPENAI_COMPAT_TTS_ID:
      copyString(source, 'baseUrl', migrated);
      copyString(source, 'model', migrated);
      copyString(source, 'voice', migrated, 'voiceName');
      copyString(source, 'format', migrated);
      return migrated;
    default:
      return null;
  }
}

/**
 * Projects current contribution-owned Google settings into the released
 * reader's inline speech shape. Credentials are intentionally excluded and
 * provider defaults are represented by the predecessor's nullable values.
 */
export function projectPredecessorSpeechProviderConfig(
  providerId: string,
  rawConfig: unknown,
): Readonly<Record<string, unknown>> | null {
  const source = asRecord(rawConfig);
  if (!source) return null;

  switch (providerId) {
    case GOOGLE_GEMINI_STT_ID:
      return {
        model: typeof source.model === 'string' ? source.model : 'gemini-2.5-flash',
        language: typeof source.language === 'string' && source.language.length > 0
          ? source.language
          : null,
      };
    case GOOGLE_CLOUD_TTS_ID:
      return {
        androidCertSha1: null,
        voiceName: typeof source.voiceName === 'string' && source.voiceName.length > 0
          ? source.voiceName
          : null,
        languageCode: typeof source.languageCode === 'string' && source.languageCode.length > 0
          ? source.languageCode
          : null,
        format: source.format === 'wav' ? 'wav' : 'mp3',
        speakingRate: typeof source.speakingRate === 'number' && source.speakingRate !== 1
          ? source.speakingRate
          : null,
        pitch: typeof source.pitch === 'number' && source.pitch !== 0
          ? source.pitch
          : null,
      };
    case OPENAI_COMPAT_STT_ID:
      return {
        baseUrl: typeof source.baseUrl === 'string' && source.baseUrl.length > 0
          ? source.baseUrl
          : null,
        model: typeof source.model === 'string' ? source.model : 'whisper-1',
      };
    case OPENAI_COMPAT_TTS_ID:
      return {
        baseUrl: typeof source.baseUrl === 'string' && source.baseUrl.length > 0
          ? source.baseUrl
          : null,
        model: typeof source.model === 'string' ? source.model : 'tts-1',
        voice: typeof source.voiceName === 'string' ? source.voiceName : 'alloy',
        format: source.format === 'wav' ? 'wav' : 'mp3',
      };
    default:
      return null;
  }
}
