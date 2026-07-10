import type { PreflightSessionControlsProbeAttempt } from './runPreflightSessionControlsProbe';

export type ProviderOwnedPreflightControlsProbeDecision<T> =
  | Readonly<{ kind: 'success'; value: T }>
  | Readonly<{ kind: 'unavailable' }>;

export function resolveProviderOwnedPreflightControlsProbeDecision<T extends ReadonlyArray<unknown>>(params: Readonly<{
  probeResult: PreflightSessionControlsProbeAttempt<T>;
  emptySuccess: 'success' | 'unavailable';
}>): ProviderOwnedPreflightControlsProbeDecision<T> {
  if (params.probeResult.kind !== 'success') {
    return { kind: 'unavailable' };
  }

  if (params.probeResult.value.length === 0 && params.emptySuccess === 'unavailable') {
    return { kind: 'unavailable' };
  }

  return { kind: 'success', value: params.probeResult.value };
}
