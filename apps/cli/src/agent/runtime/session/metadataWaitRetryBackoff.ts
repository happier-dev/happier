export const DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS = 250;

export function resolveSessionMetadataWaitRetryBackoffMs(
  backoffMs: number | null | undefined,
  opts?: Readonly<{
    defaultMs?: number;
    minMs?: number;
  }>,
): number {
  const defaultMs = opts?.defaultMs ?? DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS;
  const minMs = opts?.minMs ?? 25;
  return typeof backoffMs === 'number' && Number.isFinite(backoffMs) && backoffMs >= minMs
    ? Math.floor(backoffMs)
    : defaultMs;
}

export async function waitForSessionMetadataRetryBackoff(opts?: Readonly<{
  abortSignal?: AbortSignal;
  backoffMs?: number | null;
  defaultMs?: number;
  minMs?: number;
}>): Promise<void> {
  const backoffMs = resolveSessionMetadataWaitRetryBackoffMs(opts?.backoffMs, {
    defaultMs: opts?.defaultMs,
    minMs: opts?.minMs,
  });
  if (backoffMs <= 0 || opts?.abortSignal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      opts?.abortSignal?.removeEventListener('abort', onAbort);
    };

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    const onAbort = () => finish();

    timer = setTimeout(finish, backoffMs);
    timer.unref?.();
    opts?.abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}
