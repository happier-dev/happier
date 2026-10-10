import { performance } from 'node:perf_hooks';

/** One caller-owned deadline/cancellation for DNS, redirects and body consumption. */
export function createPluginAcquisitionLifetime(params: Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number | null;
  deadlineAtMonotonicMs?: number;
  errorLabel: string;
}>): Readonly<{ signal?: AbortSignal; dispose(): void }> {
  if (params.timeoutMs != null && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 1)) {
    throw new Error(`Invalid ${params.errorLabel} timeout`);
  }
  const deadline = params.deadlineAtMonotonicMs
    ?? (params.timeoutMs == null ? undefined : performance.now() + params.timeoutMs);
  if (deadline === undefined) return { signal: params.signal, dispose() {} };
  if (!Number.isFinite(deadline)) throw new Error(`Invalid ${params.errorLabel} deadline`);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) {
      controller.abort(new Error(`${params.errorLabel} timed out${params.timeoutMs == null ? '' : ` after ${params.timeoutMs}ms`}`));
    } else {
      // Node timers represent signed 32-bit delays; longer explicit lifetimes
      // retain their deadline rather than overflowing into an immediate timer.
      timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
      timer.unref?.();
    }
  };
  tick();
  return {
    signal: params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal,
    dispose() { if (timer) clearTimeout(timer); },
  };
}

export async function awaitPluginAcquisition<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    signal.throwIfAborted();
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function pluginAcquisitionAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Plugin acquisition cancelled', { cause: signal.reason });
}
