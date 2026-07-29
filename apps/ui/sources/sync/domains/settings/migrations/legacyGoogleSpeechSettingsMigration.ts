import {
  VoiceProviderSettingsEnvelopeV1Schema,
  type VoiceProviderSettingsJsonValueV1,
} from '@happier-dev/protocol';

type LegacyGoogleSpeechMapping = Readonly<{
  field: 'googleGemini' | 'googleCloud';
  providerId: 'google_gemini' | 'google_cloud';
}>;

const LEGACY_GOOGLE_STT = Object.freeze({
  field: 'googleGemini',
  providerId: 'google_gemini',
} satisfies LegacyGoogleSpeechMapping);

const LEGACY_GOOGLE_TTS = Object.freeze({
  field: 'googleCloud',
  providerId: 'google_cloud',
} satisfies LegacyGoogleSpeechMapping);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The only reader for the retired host-owned Google speech fields. It performs
 * a lossless structural move into the generic envelope and never interprets or
 * supplies provider defaults. Existing canonical envelopes always win.
 */
function migrateLegacyGoogleSpeechSettings(
  input: Record<string, unknown>,
  mapping: LegacyGoogleSpeechMapping,
): Record<string, unknown> {
  const { [mapping.field]: legacyConfig, ...withoutLegacyField } = input;
  const providers = isRecord(input.providers) ? { ...input.providers } : {};
  const hasCanonicalEnvelope = VoiceProviderSettingsEnvelopeV1Schema.safeParse(
    providers[mapping.providerId],
  ).success;
  const selectedLegacyProvider = input.provider === mapping.providerId;

  if (!hasCanonicalEnvelope && (legacyConfig !== undefined || selectedLegacyProvider)) {
    const config = isRecord(legacyConfig) ? legacyConfig : {};
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
  return migrateLegacyGoogleSpeechSettings(input, LEGACY_GOOGLE_STT);
}

export function migrateLegacyGoogleTtsSettings(input: Record<string, unknown>): Record<string, unknown> {
  return migrateLegacyGoogleSpeechSettings(input, LEGACY_GOOGLE_TTS);
}
