import { z } from 'zod';

import type { KokoroDevice, KokoroDtype } from '@/voice/kokoro/config/kokoroConfig';
import {
  readKokoroDeviceFromEnv,
  readKokoroDtypeFromEnv,
  readKokoroModelIdFromEnv,
  readKokoroWasmPathsFromEnv,
} from '@/voice/kokoro/config/kokoroConfig';

const EXPO_PUBLIC_KOKORO_ASSET_SETS_ENV_VAR = 'EXPO_PUBLIC_KOKORO_ASSET_SETS';

export type KokoroRuntimeConfig = {
  modelId: string;
  dtype: KokoroDtype;
  device: KokoroDevice;
  wasmPaths: string | null;
};

export type KokoroAssetSetOption = {
  id: string;
  title: string;
  subtitle?: string;
  config?: KokoroRuntimeConfig;
};

const KokoroRuntimeConfigSchema = z.object({
  modelId: z.string().min(1),
  dtype: z.enum(['fp32', 'fp16', 'q8', 'q4', 'q4f16']),
  device: z.enum(['wasm', 'webgpu']),
  // Treat missing wasmPaths as "no override" to keep runtime types concrete and consistent.
  wasmPaths: z.string().nullable().default(null),
});

const KokoroAssetSetOptionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  config: KokoroRuntimeConfigSchema.optional(),
});

function getBuiltInAssetSets(): KokoroAssetSetOption[] {
  return [
    {
      id: 'kokoro-82m-v1.0-onnx-q8-wasm',
      title: 'Kokoro 82M (q8)',
      subtitle: 'Smaller download, faster inference (recommended).',
      config: {
        modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
        dtype: 'q8',
        device: 'wasm',
        wasmPaths: null,
      },
    },
    {
      id: 'kokoro-82m-v1.0-onnx-fp32-wasm',
      title: 'Kokoro 82M (fp32)',
      subtitle: 'Highest quality, larger download.',
      config: {
        modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
        dtype: 'fp32',
        device: 'wasm',
        wasmPaths: null,
      },
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
      subtitle: 'Uses environment configuration for Kokoro runtime.',
    },
    ...concrete,
  ];
}

export function resolveKokoroRuntimeConfig(opts: {
  assetSetId: string | null;
  env?: Record<string, string | undefined>;
}): KokoroRuntimeConfig {
  const env = opts.env ?? process.env;
  const selectedId = opts.assetSetId ?? '';
  if (selectedId) {
    const match = getKokoroAssetSetOptions(env).find((s) => s.id === selectedId);
    if (match?.config) {
      return {
        modelId: match.config.modelId,
        dtype: match.config.dtype,
        device: match.config.device,
        wasmPaths: typeof match.config.wasmPaths === 'string' ? match.config.wasmPaths : null,
      };
    }
  }

  return {
    modelId: readKokoroModelIdFromEnv(env),
    dtype: readKokoroDtypeFromEnv(env),
    device: readKokoroDeviceFromEnv(env),
    wasmPaths: readKokoroWasmPathsFromEnv(env),
  };
}
