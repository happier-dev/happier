import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';

export type LocalNeuralSttCaptureSettings = Readonly<{
  packId: string;
  language: string | null;
}>;

function normalizeNonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function resolveAdapterSettings(settings: any): unknown {
  const voice = settings?.voice ?? null;
  const providerId = normalizeNonEmpty(voice?.providerId);
  return providerId === 'local_direct'
    ? voice?.adapters?.local_direct?.stt
    : voice?.adapters?.local_conversation?.stt ?? voice?.adapters?.local_direct?.stt;
}

export function resolveLocalNeuralSttCaptureSettings(settings: unknown): LocalNeuralSttCaptureSettings {
  let parsed: ReturnType<typeof VoiceLocalSttSchema.parse>;
  try {
    parsed = VoiceLocalSttSchema.parse(resolveAdapterSettings(settings) ?? {});
  } catch {
    parsed = VoiceLocalSttSchema.parse({});
  }

  const defaults = VoiceLocalSttSchema.parse({});
  const packId =
    normalizeNonEmpty(parsed.localNeural?.assetId)
    ?? normalizeNonEmpty(defaults.localNeural?.assetId)
    ?? '';
  const language = normalizeNonEmpty(parsed.localNeural?.language);
  return { packId, language };
}
