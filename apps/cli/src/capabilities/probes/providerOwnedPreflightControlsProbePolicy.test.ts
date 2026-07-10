import { describe, expect, it } from 'vitest';

import { resolveProviderOwnedPreflightControlsProbeDecision } from './providerOwnedPreflightControlsProbePolicy';

describe('resolveProviderOwnedPreflightControlsProbeDecision', () => {
  it('passes through non-empty successful provider-owned preflight values', () => {
    expect(resolveProviderOwnedPreflightControlsProbeDecision({
      probeResult: { kind: 'success', value: ['dynamic'] },
      emptySuccess: 'success',
    })).toEqual({ kind: 'success', value: ['dynamic'] });
  });

  it('keeps empty successful config-option probes dynamic when requested', () => {
    expect(resolveProviderOwnedPreflightControlsProbeDecision({
      probeResult: { kind: 'success', value: [] },
      emptySuccess: 'success',
    })).toEqual({ kind: 'success', value: [] });
  });

  it('can fail closed on empty successful model probes', () => {
    expect(resolveProviderOwnedPreflightControlsProbeDecision({
      probeResult: { kind: 'success', value: [] },
      emptySuccess: 'unavailable',
    })).toEqual({ kind: 'unavailable' });
  });

  it('fails closed on repeated authoritative preflight failures', () => {
    expect(resolveProviderOwnedPreflightControlsProbeDecision({
      probeResult: { kind: 'retryable_failure' },
      emptySuccess: 'success',
    })).toEqual({ kind: 'unavailable' });
  });

  it('fails closed on provider-owned unavailable preflight results', () => {
    expect(resolveProviderOwnedPreflightControlsProbeDecision({
      probeResult: { kind: 'unavailable' },
      emptySuccess: 'success',
    })).toEqual({ kind: 'unavailable' });
  });
});
