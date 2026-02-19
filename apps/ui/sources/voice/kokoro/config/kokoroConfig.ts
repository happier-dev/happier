export const EXPO_PUBLIC_KOKORO_MODEL_ID_ENV_VAR = 'EXPO_PUBLIC_KOKORO_MODEL_ID';
export const EXPO_PUBLIC_KOKORO_DTYPE_ENV_VAR = 'EXPO_PUBLIC_KOKORO_DTYPE';
export const EXPO_PUBLIC_KOKORO_DEVICE_ENV_VAR = 'EXPO_PUBLIC_KOKORO_DEVICE';
export const EXPO_PUBLIC_KOKORO_WASM_PATHS_ENV_VAR = 'EXPO_PUBLIC_KOKORO_WASM_PATHS';
export const EXPO_PUBLIC_KOKORO_OPERATION_TIMEOUT_MS_ENV_VAR = 'EXPO_PUBLIC_KOKORO_OPERATION_TIMEOUT_MS';

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

export function readKokoroOperationTimeoutMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env[EXPO_PUBLIC_KOKORO_OPERATION_TIMEOUT_MS_ENV_VAR];
  const parsed = typeof raw === 'string' && raw.trim().length > 0 ? Number(raw.trim()) : NaN;
  // Default to a higher timeout than generic network timeouts: model initialization and WASM inference can take
  // noticeably longer on first run (download, compilation, cache hydration), especially on low-end devices.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
}

export function resolveKokoroOperationTimeoutMs(
  networkTimeoutMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const fallback = readKokoroOperationTimeoutMsFromEnv(env);
  return Math.max(fallback, Number.isFinite(networkTimeoutMs) && networkTimeoutMs > 0 ? networkTimeoutMs : 0);
}
