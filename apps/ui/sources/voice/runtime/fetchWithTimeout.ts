import { runtimeFetch } from '@/utils/system/runtimeFetch';

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
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Forward an optional caller-owned signal so an in-flight request is truly
  // cancelled on abort (not just timed out). The timeout retains its own abort
  // so callers without a signal are unaffected.
  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }
  try {
    return await runtimeFetch(input, {
      ...(init ?? {}),
      signal: controller.signal,
    });
  } catch (error) {
    // A caller-driven abort is a cancellation, not a timeout: surface it distinctly
    // so the caller can treat it as "aborted" rather than a network/timeout failure.
    if (externalSignal?.aborted) {
      throw new Error('aborted');
    }
    if (isAbortError(error)) {
      throw new Error(timeoutErrorCode);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}
