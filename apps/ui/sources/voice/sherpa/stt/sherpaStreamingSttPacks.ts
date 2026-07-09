import { getDefaultModelPackId } from '@happier-dev/protocol';
import { z } from 'zod';

export type SherpaStreamingSttPackOption = {
  id: string;
  title: string;
  subtitle?: string;
};

const EXPO_PUBLIC_SHERPA_STREAMING_STT_PACKS = 'EXPO_PUBLIC_SHERPA_STREAMING_STT_PACKS';

const SherpaStreamingSttPackOptionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
});

const DEFAULT_STREAMING_STT_PACK_ID =
  getDefaultModelPackId('stt_sherpa') ?? 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';

function getBuiltInOptions(): SherpaStreamingSttPackOption[] {
  return [
    {
      id: DEFAULT_STREAMING_STT_PACK_ID,
      title: 'Zipformer EN 20M (int8)',
      subtitle: 'Streaming, low latency (recommended).',
    },
  ];
}

function readOptionsFromEnv(env: Record<string, string | undefined>): SherpaStreamingSttPackOption[] | null {
  const raw = env[EXPO_PUBLIC_SHERPA_STREAMING_STT_PACKS];
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = SherpaStreamingSttPackOptionSchema.array().safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function getSherpaStreamingSttPackOptions(env: Record<string, string | undefined> = process.env): SherpaStreamingSttPackOption[] {
  const fromEnv = readOptionsFromEnv(env);
  return fromEnv && fromEnv.length > 0 ? fromEnv : getBuiltInOptions();
}
