import { describe, expect, it } from 'vitest';

import { ProviderProbeClientError } from './client';
import { providerProbeFailureHealthState } from './health';

describe('providerProbeFailureHealthState', () => {
  it.each([
    ['provider_endpoint_unreachable', 'unreachable'],
    ['provider_endpoint_unavailable', 'temporarily_unavailable'],
    ['provider_endpoint_rate_limited', 'rate_limited'],
    ['provider_endpoint_auth_required', 'unauthorized'],
    ['provider_endpoint_unauthorized', 'unauthorized'],
    ['provider_probe_response_invalid', 'invalid_response'],
  ] as const)('maps %s to %s', (code, status) => {
    expect(providerProbeFailureHealthState(new ProviderProbeClientError(code), {
      observedAt: 1_000,
      retryAt: 2_000,
    })).toMatchObject({ status, errorCode: code, activity: 'idle', observedAt: 1_000 });
  });

  it('does not attach retry timing to terminal auth/parser failures', () => {
    expect(providerProbeFailureHealthState(
      new ProviderProbeClientError('provider_endpoint_unauthorized'),
      { observedAt: 1_000, retryAt: 2_000 },
    )).not.toHaveProperty('retryAt');
  });
});
