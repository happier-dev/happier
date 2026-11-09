import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

import type { ProviderConnectionResolution } from './types';

/** A saved but unusable connection needs configuration review, not a replacement connection. */
export function errorForProviderResolution(
  resolution: ProviderConnectionResolution,
  machineId: string,
): ProviderErrorV1 {
  const context = { connectionId: resolution.connectionId, machineId };
  switch (resolution.status) {
    case 'source_unavailable':
      return createProviderErrorV1('provider_contribution_unavailable', context);
    case 'deleted':
    case 'missing':
      return createProviderErrorV1('provider_connection_not_found', context);
    case 'invalid':
      return createProviderErrorV1('provider_connection_invalid', { ...context, reason: resolution.reason });
    case 'endpoint_unresolved':
      return createProviderErrorV1(
        resolution.reason === 'endpoint_resolution_required'
          ? 'provider_endpoint_unreachable'
          : 'provider_connection_invalid',
        context,
      );
    case 'resolved':
      return resolution.record.authorization.authorized
        ? createProviderErrorV1('provider_authorization_changed', context)
        : createProviderErrorV1(resolution.record.authorization.errorCode, context);
  }
}

/** Runtime probe/spawn admission retains its existing endpoint-unavailable recovery policy. */
export function providerConnectionResolutionError(
  resolution: Exclude<ProviderConnectionResolution, { status: 'resolved' }>,
  machineId: string,
): ProviderErrorV1 {
  return resolution.status === 'endpoint_unresolved'
    ? createProviderErrorV1('provider_endpoint_unavailable', { connectionId: resolution.connectionId, machineId })
    : errorForProviderResolution(resolution, machineId);
}
