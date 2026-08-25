import {
  createProviderErrorV1,
  type ProviderErrorV1,
} from '@happier-dev/protocol';

import type { ProviderConnectionResolution } from '@/providers/registry';
import { describeProviderConnections } from './describe';
import type {
  ProviderConnectionRegistryProjection,
  ProviderConnectionServiceDeps,
} from './types';
import type { ProviderOperationLifetime } from '@/providers/operationLifetime';

export type ProviderConnectionServiceContext = Readonly<{
  deps: ProviderConnectionServiceDeps;
  featureError(connectionId?: string): ProviderErrorV1;
  assertMachine(machineId: string, connectionId?: string): ProviderErrorV1 | null;
  describe: (input: Readonly<{
    machineId: string;
    connectionId?: string;
    registryProjection?: ProviderConnectionRegistryProjection;
    lifetime?: ProviderOperationLifetime;
  }>) =>
    ReturnType<typeof describeProviderConnections>;
}>;

export function createProviderConnectionServiceContext(
  deps: ProviderConnectionServiceDeps,
): ProviderConnectionServiceContext {
  return Object.freeze({
    deps,
    featureError: (connectionId?: string) => createProviderErrorV1('provider_feature_disabled', {
      ...(connectionId ? { connectionId } : {}), machineId: deps.machineId,
    }),
    assertMachine: (machineId: string, connectionId?: string) =>
      machineId === deps.machineId ? null : createProviderErrorV1('provider_not_enabled_on_machine', {
        ...(connectionId ? { connectionId } : {}), machineId,
      }),
    describe: (input) => describeProviderConnections(deps, input),
  });
}

export function errorForProviderResolution(
  resolution: ProviderConnectionResolution,
  machineId: string,
): ProviderErrorV1 {
  switch (resolution.status) {
    case 'source_unavailable':
      return createProviderErrorV1('provider_contribution_unavailable', { connectionId: resolution.connectionId, machineId });
    case 'deleted':
    case 'missing':
    case 'invalid':
      return createProviderErrorV1('provider_connection_not_found', { connectionId: resolution.connectionId, machineId });
    case 'endpoint_unresolved':
      return createProviderErrorV1(
        resolution.reason === 'endpoint_resolution_required'
          ? 'provider_endpoint_unreachable'
          : 'provider_connection_invalid',
        { connectionId: resolution.connectionId, machineId },
      );
    case 'resolved':
      return resolution.record.authorization.authorized
        ? createProviderErrorV1('provider_authorization_changed', { connectionId: resolution.connectionId, machineId })
        : createProviderErrorV1(resolution.record.authorization.errorCode, { connectionId: resolution.connectionId, machineId });
  }
}
