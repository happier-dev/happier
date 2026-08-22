import type { ProviderEndpointRuntimeStateV1 } from '@happier-dev/protocol';

import { ProviderProbeClientError } from './client';

/**
 * Projects a probe failure onto observed endpoint health.
 *
 * Returns `null` when the failure carries no fact about the endpoint: a
 * declared catalog format whose contributing plugin is unavailable means the
 * host could not interpret the response, not that the endpoint is unhealthy.
 * Recording a health verdict from that would misreport a working endpoint.
 */
export function providerProbeFailureHealthState(
  error: ProviderProbeClientError,
  timing: Readonly<{ observedAt: number }>,
): ProviderEndpointRuntimeStateV1 | null {
  const common = { activity: 'idle' as const, observedAt: timing.observedAt };
  switch (error.code) {
    case 'provider_endpoint_unreachable':
      return { ...common, status: 'unreachable', errorCode: error.code };
    case 'provider_endpoint_unavailable':
      return { ...common, status: 'temporarily_unavailable', errorCode: error.code };
    case 'provider_endpoint_rate_limited':
      return { ...common, status: 'rate_limited', errorCode: error.code };
    case 'provider_endpoint_auth_required':
    case 'provider_endpoint_unauthorized':
      return { ...common, status: 'unauthorized', errorCode: error.code };
    case 'provider_probe_response_invalid':
      return { ...common, status: 'invalid_response', errorCode: error.code };
    case 'provider_contribution_unavailable':
      return null;
  }
}

export function providerProbeSuccessHealthState(observedAt: number): ProviderEndpointRuntimeStateV1 {
  return { status: 'available', activity: 'idle', observedAt };
}

export function createProviderHealthProbeService(dependencies: Readonly<{
  refresh(input: Readonly<{
    connectionId: string;
    machineId: string;
    endpoints: readonly import('./catalog').ProviderProbeEndpoint[];
    probes: readonly import('@happier-dev/protocol').ProviderCatalogProbeV1[];
    mode: 'health';
    signal?: AbortSignal;
  }>): Promise<import('./catalog').ProviderCatalogRefreshResult>;
}>) {
  return {
    refresh(input: Omit<Parameters<typeof dependencies.refresh>[0], 'mode'>) {
      if (input.probes.length !== 1) {
        throw new TypeError('Provider availability checks require exactly one declared probe');
      }
      return dependencies.refresh({ ...input, mode: 'health' });
    },
  };
}
