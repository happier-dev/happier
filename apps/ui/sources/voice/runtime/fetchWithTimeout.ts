function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as any).name === 'AbortError');
}

export function resolveVoiceNetworkTimeoutMs(raw: unknown, fallbackMs: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallbackMs;
  return Math.max(1_000, Math.min(60_000, n));
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  timeoutErrorCode: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...(init ?? {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(timeoutErrorCode);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

