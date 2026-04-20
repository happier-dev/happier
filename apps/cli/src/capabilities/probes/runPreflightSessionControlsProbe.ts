import type { PreflightSessionControlsProbeAdapter } from './preflightSessionControlsProbeAdapterTypes';

export type PreflightSessionControlsProbeAttempt<T> =
  | Readonly<{ kind: 'success'; value: T }>
  | Readonly<{ kind: 'retryable_failure' }>
  | Readonly<{ kind: 'unavailable' }>;

export async function runPreflightSessionControlsProbe<T>(
  params: Readonly<{
    adapter: PreflightSessionControlsProbeAdapter | null;
    probeOnce: () => Promise<T | null>;
  }>,
): Promise<PreflightSessionControlsProbeAttempt<T>> {
  if (!params.adapter) {
    return { kind: 'unavailable' };
  }

  let result = await params.probeOnce();
  if (!result && params.adapter.failureCacheStrategy === 'retry') {
    result = await params.probeOnce();
  }

  if (result) {
    return { kind: 'success', value: result };
  }

  return params.adapter.failureCacheStrategy === 'retry'
    ? { kind: 'retryable_failure' }
    : { kind: 'unavailable' };
}
