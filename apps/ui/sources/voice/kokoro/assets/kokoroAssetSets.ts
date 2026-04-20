import { z } from 'zod';

const EXPO_PUBLIC_KOKORO_ASSET_SETS_ENV_VAR = 'EXPO_PUBLIC_KOKORO_ASSET_SETS';

export type KokoroAssetSetOption = {
  id: string;
  title: string;
  subtitle?: string;
};

const KokoroAssetSetOptionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
});

function getBuiltInAssetSets(): KokoroAssetSetOption[] {
  return [
    {
      id: 'kokoro-82m-v1.0-onnx-q8-wasm',
      title: 'Kokoro 82M (q8)',
      subtitle: 'Smaller download, faster inference (recommended).',
    },
    {
      id: 'kokoro-82m-v1.0-onnx-fp32-wasm',
      title: 'Kokoro 82M (fp32)',
      subtitle: 'Highest quality, larger download.',
    },
  ];
}

function readAssetSetsFromEnv(env: Record<string, string | undefined>): KokoroAssetSetOption[] | null {
  const raw = env[EXPO_PUBLIC_KOKORO_ASSET_SETS_ENV_VAR];
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = KokoroAssetSetOptionSchema.array().safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function getKokoroAssetSetOptions(env: Record<string, string | undefined> = process.env): KokoroAssetSetOption[] {
  const fromEnv = readAssetSetsFromEnv(env);
  const concrete = fromEnv && fromEnv.length > 0 ? fromEnv : getBuiltInAssetSets();
  return [
    {
      id: '',
      title: 'Default (from env)',
      subtitle: 'Uses environment-configured Kokoro model-pack defaults.',
    },
    ...concrete,
  ];
}
