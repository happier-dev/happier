import { sleep } from '../../timing';

const RETRIABLE_ERROR_PATTERNS = [
  'operation has timed out',
  'timed out connecting user socket',
  'rpc_method_not_available',
  'rpc method not available',
  'econnreset',
  'socket hang up',
  'connection closed',
];

export function isRetriableCapabilityErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return RETRIABLE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export async function withCapabilityProbeRetry<T>(
  run: () => Promise<T>,
  options?: { attempts?: number; delayMs?: number },
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options?.attempts ?? 2));
  const delayMs = Math.max(1, Math.trunc(options?.delayMs ?? 300));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retriable = isRetriableCapabilityErrorMessage(message);
      if (!retriable || attempt >= attempts) throw error;
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'capability probe failed'));
}
