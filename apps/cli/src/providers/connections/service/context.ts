import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderErrorV1 } from '@happier-dev/protocol';

export { errorForProviderResolution } from '@/providers/registry/resolutionError';
import { describeProviderConnections } from './describe';
import type { ProviderConnectionServiceDeps } from './types';

export type ProviderConnectionServiceContext = Readonly<{
  deps: ProviderConnectionServiceDeps;
  featureError(connectionId?: string): ProviderErrorV1;
  assertMachine(machineId: string, connectionId?: string): ProviderErrorV1 | null;
  describe: (input: Parameters<typeof describeProviderConnections>[1]) =>
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
