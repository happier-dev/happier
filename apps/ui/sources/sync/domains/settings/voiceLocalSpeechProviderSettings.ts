import {
  VoiceProviderIdSchema,
  VoiceProviderSettingsEnvelopeV1Schema,
  VoiceProviderSettingsRecordV1Schema,
  type VoiceProviderSettingsEnvelopeV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

const MAX_SPEECH_PROVIDER_CONFIGS = 64;
const MAX_SPEECH_PROVIDER_CONFIG_BYTES = 256 * 1024;

function jsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  let bytes = 0;
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < json.length) {
      const next = json.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Speech-provider ids are an open, validated domain. Runtime admission is owned
 * by the active voice registry, so an unknown or disabled id remains inert.
 */
export const VoiceLocalSpeechProviderIdSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() : value,
  VoiceProviderIdSchema,
);

/**
 * Generic bounded storage for bundled speech-provider configuration. The host
 * validates only identity, envelope version, JSON safety, and resource bounds;
 * the provider package remains the sole interpreter of `config`.
 */
export const VoiceLocalSpeechProviderSettingsRecordSchema = VoiceProviderSettingsRecordV1Schema
  .superRefine((record, context) => {
    if (Object.keys(record).length > MAX_SPEECH_PROVIDER_CONFIGS) {
      context.addIssue({ code: 'custom', message: 'Too many speech provider configurations' });
      return;
    }
    if (jsonByteLength(record) > MAX_SPEECH_PROVIDER_CONFIG_BYTES) {
      context.addIssue({ code: 'custom', message: 'Speech provider configuration is too large' });
    }
  });

export type VoiceLocalSpeechProviderSettingsRecord = Readonly<
  z.infer<typeof VoiceLocalSpeechProviderSettingsRecordSchema>
>;

export function readLocalSpeechProviderEnvelope(
  settings: Readonly<{ providers?: Readonly<Record<string, VoiceProviderSettingsEnvelopeV1>> | null }>,
  providerId: string,
): VoiceProviderSettingsEnvelopeV1 | null {
  const parsedId = VoiceProviderIdSchema.safeParse(providerId);
  if (!parsedId.success) return null;
  const parsed = VoiceProviderSettingsEnvelopeV1Schema.safeParse(settings.providers?.[parsedId.data]);
  return parsed.success ? parsed.data : null;
}

export function writeLocalSpeechProviderEnvelope(
  settings: Readonly<Record<string, unknown>>,
  providerId: string,
  envelope: VoiceProviderSettingsEnvelopeV1,
): Readonly<Record<string, unknown> & { providers: VoiceLocalSpeechProviderSettingsRecord }> {
  const parsedId = VoiceProviderIdSchema.parse(providerId);
  const currentProviders = settings.providers && typeof settings.providers === 'object' && !Array.isArray(settings.providers)
    ? settings.providers as Readonly<Record<string, VoiceProviderSettingsEnvelopeV1>>
    : {};
  const nextProviders = VoiceLocalSpeechProviderSettingsRecordSchema.parse({
    ...currentProviders,
    [parsedId]: VoiceProviderSettingsEnvelopeV1Schema.parse(envelope),
  });
  return { ...settings, providers: nextProviders };
}
