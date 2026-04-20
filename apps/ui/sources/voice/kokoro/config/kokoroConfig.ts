export const EXPO_PUBLIC_KOKORO_OPERATION_TIMEOUT_MS_ENV_VAR = 'EXPO_PUBLIC_KOKORO_OPERATION_TIMEOUT_MS';

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
