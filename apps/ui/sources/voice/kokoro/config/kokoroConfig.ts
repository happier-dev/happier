export const EXPO_PUBLIC_KOKORO_MODEL_ID_ENV_VAR = 'EXPO_PUBLIC_KOKORO_MODEL_ID';
export const EXPO_PUBLIC_KOKORO_DTYPE_ENV_VAR = 'EXPO_PUBLIC_KOKORO_DTYPE';
export const EXPO_PUBLIC_KOKORO_DEVICE_ENV_VAR = 'EXPO_PUBLIC_KOKORO_DEVICE';
export const EXPO_PUBLIC_KOKORO_WASM_PATHS_ENV_VAR = 'EXPO_PUBLIC_KOKORO_WASM_PATHS';

export type KokoroDtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
export type KokoroDevice = 'wasm' | 'webgpu';

export function readKokoroModelIdFromEnv(env: Record<string, string | undefined> = process.env): string {
  const raw = env[EXPO_PUBLIC_KOKORO_MODEL_ID_ENV_VAR];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || 'onnx-community/Kokoro-82M-v1.0-ONNX';
}

export function readKokoroDtypeFromEnv(env: Record<string, string | undefined> = process.env): KokoroDtype {
  const raw = env[EXPO_PUBLIC_KOKORO_DTYPE_ENV_VAR];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === 'fp16' || trimmed === 'q8' || trimmed === 'q4' || trimmed === 'q4f16') return trimmed;
  return 'q8';
}

export function readKokoroDeviceFromEnv(env: Record<string, string | undefined> = process.env): KokoroDevice {
  const raw = env[EXPO_PUBLIC_KOKORO_DEVICE_ENV_VAR];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === 'webgpu') return 'webgpu';
  return 'wasm';
}

export function readKokoroWasmPathsFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[EXPO_PUBLIC_KOKORO_WASM_PATHS_ENV_VAR];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || null;
}
