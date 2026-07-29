import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';
import { resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';

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
  return resolveLocalVoiceAdapterSettings(settings).config?.stt;
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
