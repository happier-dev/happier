import { ProviderErrorV1Schema, createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { ProviderBrokerAdmissionFailureCodeV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import type {
  PluginReloadController,
  PluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/controller';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  startPublicManagedProviderRuntime,
  type PublicManagedProviderRuntimeStartFailureCode,
  type PublicManagedProviderRuntimeStartupFailure,
} from '@/providers/lifecycle/publicManagedProviderRuntimeStart';
import type {
  ManagedProviderEndpointAccessProjection,
  ResolveSharedManagedProviderGatewayBinding,
} from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import type {
  ManagedProviderRuntimeOperationClaim,
  ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { providerManagedPurposeBindingError } from '@/providers/managed/resolvePurposeBindingSnapshot';
import { logger } from '@/ui/logger';
import type { ProviderBrokerRetainedCurrentnessInvalidation } from '@/providers/broker/brokerRetainedCurrentnessInvalidation';

import type { ProviderConnectionServiceDeps } from './service/types';

export type PublicManagedProviderRuntimeStartOperation = NonNullable<
  ProviderConnectionServiceDeps['startManagedProviderRuntime']
>;

export type ManagedProviderExplicitStartCustodyRequest =
  Parameters<PublicManagedProviderRuntimeStartOperation>[0] & Readonly<{
    retirementGroup?: import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry').ManagedProviderExplicitStartJoinInput['retirementGroup'];
    operationClaim: Extract<
      ManagedProviderRuntimeOperationClaim,
      { kind: 'providerBroker' }
    >;
    revalidateRetainedCurrentness?(signal?: AbortSignal, invalidation?: ProviderBrokerRetainedCurrentnessInvalidation): Promise<boolean>;
    signal: AbortSignal;
    modelCatalogs?: import('@/plugins/runtime/invocation/services/managedServicesAdapter').ManagedProviderRuntimeInvocationBinding['modelCatalogs'];
  }>;

export type ManagedProviderExplicitStartCustody = Readonly<{
  acquire(
    request: ManagedProviderExplicitStartCustodyRequest,
  ): Promise<ManagedProviderEndpointAccessProjection | null>;
  retire(input: Readonly<{
    identity: ManagedProviderExplicitStartCustodyRequest['identity'];
    operationClaim: ManagedProviderExplicitStartCustodyRequest['operationClaim'];
    sharedGateway?: ManagedProviderExplicitStartCustodyRequest['sharedGateway'];
  }>): Promise<boolean>;
  retireExternalApiKey(input: Readonly<{
    identity: ManagedProviderExplicitStartCustodyRequest['identity'];
    externalApiKeyId: string;
    operationId: string;
  }>): Promise<boolean>;
  revalidateRetainedClaims(
    signal?: AbortSignal,
    selector?: Parameters<ManagedProviderExplicitStartCustody['retire']>[0],
    invalidation?: ProviderBrokerRetainedCurrentnessInvalidation,
  ): Promise<number>;
  retireAll(): Promise<number>;
}>;

function failForCoordinatorCode(
  code: PublicManagedProviderRuntimeStartFailureCode,
  machineId: string,
  authorizationFailure?: ProviderErrorV1,
  startupFailure?: PublicManagedProviderRuntimeStartupFailure,
): never {
  try {
    logger.warnLocalFile('[Provider] Managed runtime start refused', { startFailureCode: code,
      ...(startupFailure ? { startupFailure } : {}) });
  } catch {
    // Preserve the original closed Provider outcome if file logging fails.
  }
  if (code === 'managed_provider_request_invalid') {
    throw createProviderErrorV1('provider_connection_invalid', { machineId });
  }
  if (code === 'managed_provider_authorization_changed') {
    throw authorizationFailure ?? createProviderErrorV1('provider_authorization_changed', { machineId });
  }
  if (code === 'managed_provider_runtime_unavailable') {
    throw createProviderErrorV1('provider_contribution_unavailable', { machineId });
  }
  throw createProviderErrorV1('provider_endpoint_unavailable', { machineId });
}

/**
 * Daemon non-Session explicit-start consumer for the public managed Provider
 * runtime. The active executable registry supplies both the exact runtime and
 * its canonical SVC09 invocation services; no private start dispatcher exists.
 */
function createManagedProviderExplicitStartOperation(input: Readonly<{
  machineId: string;
  happyHomeDir: string;
  controller?: PluginReloadController;
  operationClaim?: ManagedProviderExplicitStartCustodyRequest['operationClaim'];
  modelCatalogs?: ManagedProviderExplicitStartCustodyRequest['modelCatalogs'];
  retirementGroup?: ManagedProviderExplicitStartCustodyRequest['retirementGroup'];
  revalidateRetainedCurrentness?: ManagedProviderExplicitStartCustodyRequest['revalidateRetainedCurrentness'];
  resolveSharedGateway?: ResolveSharedManagedProviderGatewayBinding;
  signal?: AbortSignal;
}>): (request: Parameters<PublicManagedProviderRuntimeStartOperation>[0]) =>
  Promise<ManagedProviderEndpointAccessProjection> {
  return async (request) => {
    const parsed = parseProviderContributionIdentityV1(request.contributionKey);
    if (
      !parsed
      || parsed.identity.pluginId !== request.identity.pluginId
      || parsed.identity.localId !== request.identity.localId
    ) {
      throw createProviderErrorV1('provider_connection_invalid', {
        machineId: input.machineId,
      });
    }

    let authorizationFailure: ProviderErrorV1 | undefined;
    const requestAuthorizationIsCurrent = async (signal = input.signal): Promise<boolean> => {
      try {
        return request.isAuthorizationCurrent() === true
          && await request.revalidateAuthorization(signal) === true
          && request.isAuthorizationCurrent() === true;
      } catch (error) {
        authorizationFailure = providerManagedPurposeBindingError(error, {
          ...(request.connectionId ? { connectionId: request.connectionId } : {}),
          machineId: input.machineId,
        });
        return false;
      }
    };

    let lease: PluginRuntimeRegistryLease | null = request.runtimeRegistryLease ?? null;
    const ownsLease = lease === null;
    let result: ManagedProviderEndpointAccessProjection | null = null;
    let failure: unknown = null;
    try {
      if (!lease) {
        lease = await acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: input.happyHomeDir,
          ...(input.controller ? { controller: input.controller } : {}),
        });
      }
      const registry = lease.registry;
      const runManagedProviderExplicitStart =
        registry.runManagedProviderExplicitStart;
      const createInvocationServices =
        registry.createManagedProviderRuntimeInvocationServices;
      const acquireRuntime = registry.acquireManagedProviderRuntime;
      const addRuntimeDisposable = registry.addRuntimeDisposable;
      if (
        !runManagedProviderExplicitStart
        || !createInvocationServices
        || !acquireRuntime
        || !addRuntimeDisposable
      ) {
        throw createProviderErrorV1('provider_endpoint_unavailable', {
          machineId: input.machineId,
        });
      }

      const sharedGateway = request.sharedGateway ?? (request.connectionId && input.resolveSharedGateway
        ? await input.resolveSharedGateway({
            connectionId: request.connectionId,
            consumerId: `explicitStart:${request.connectionId}`,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        : null);
      // Public Start retains configuration authority just like broker claims.
      // Account catalog invalidations must be able to withdraw that exact claim
      // through the custody owner's existing settlement and idle-stop path.
      const revalidateRetainedCurrentness = input.revalidateRetainedCurrentness
        ?? (input.operationClaim ? undefined : request.revalidateAuthorization);
      const joined = await runManagedProviderExplicitStart({
        ...(sharedGateway ? { sharedGateway } : {}),
        ...(input.retirementGroup ? { retirementGroup: input.retirementGroup } : {}),
        identity: request.identity,
        purposeBindings: request.purposeBindings,
        machineId: input.machineId,
        ...(input.operationClaim ? { operationClaim: input.operationClaim } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(revalidateRetainedCurrentness
          ? {
              revalidateRetainedCurrentness,
            }
          : {}),
        isCurrent: request.isAuthorizationCurrent,
        establish: async ({ signal, release }) => {
          const launchResourceScope = createProviderLaunchResourceScope();
          // The operation claim is registered before all launch resources, so
          // reverse-order cleanup retires process/authority custody first and
          // only then admits a later exact retry.
          launchResourceScope.register(release);
          try {
            const invocationServices = await createInvocationServices({
              ...(sharedGateway ? { sharedGateway } : {}),
              identity: request.identity,
              purposeBindings: request.purposeBindings,
              ...(input.modelCatalogs ? { modelCatalogs: input.modelCatalogs } : {}),
              operationClaim: input.operationClaim ?? {
                kind: 'explicitStart',
                machineId: input.machineId,
              },
              signal,
              isCurrent: request.isAuthorizationCurrent,
            });
            if (!invocationServices) {
              throw createProviderErrorV1('provider_endpoint_unavailable', {
                machineId: input.machineId,
              });
            }
            launchResourceScope.register(invocationServices.cleanup);

            const started = await startPublicManagedProviderRuntime({
              identity: request.identity,
              request: request.request,
              acquireRuntime: async (identity) => await acquireRuntime(identity),
              connectedAccounts: invocationServices.connectedAccounts,
              custody: invocationServices,
              isAuthorizationCurrent: request.isAuthorizationCurrent,
              revalidateAuthorization: () => requestAuthorizationIsCurrent(signal),
              signal,
              launchResourceScope,
            });
            if (!started.ok) {
              return failForCoordinatorCode(started.code, input.machineId, authorizationFailure, started.startupFailure);
            }

            const cleanup = launchResourceScope.transfer();
            if (!cleanup) {
              throw createProviderErrorV1('provider_endpoint_unavailable', {
                machineId: input.machineId,
              });
            }
            try {
              addRuntimeDisposable(request.identity.pluginId, Object.freeze({
                    dispose: input.retirementGroup
                  ? async () => { await registry.retireManagedProviderExplicitStart?.({
                      ...(sharedGateway ? { sharedGateway } : {}),
                      identity: request.identity,
                      machineId: input.machineId,
                      operationClaim: input.operationClaim,
                    }); }
                  : cleanup,
              }));
            } catch (error) {
              await Promise.resolve(cleanup()).catch(() => undefined);
              throw error;
            }
            return Object.freeze({
              status: 'running' as const,
              projection: Object.freeze({
                access: started.access,
                isCurrent: started.isCurrent,
                cleanup,
              }),
            });
          } catch (error) {
            await launchResourceScope.release().catch(() => undefined);
            throw error;
          }
        },
      });
      if (joined.status === 'not_current') {
        throw createProviderErrorV1('provider_authorization_changed', {
          machineId: input.machineId,
        });
      }
      if (joined.status === 'unavailable') {
        throw createProviderErrorV1('provider_endpoint_unavailable', {
          machineId: input.machineId,
        });
      }
      // The generic public-start path needs no further authorization recheck.
      // Broker custody performs its retained-authority recheck below, where it
      // can retire the exact semantic claim after ownership has transferred.
      result = joined.value.projection;
    } catch (error) {
      failure = error;
    }

    if (lease && ownsLease) {
      try {
        await lease.release();
      } catch (error) {
        // Once the live effect has transferred into the exact generation's
        // disposable owner, a lease-release acknowledgement cannot reverse it.
        // Preserve the settled success so callers do not retry a live start.
        if (result === null) failure ??= error;
      }
    }
    if (failure !== null || result === null) {
      const providerError = ProviderErrorV1Schema.safeParse(failure);
      if (providerError.success) throw providerError.data;
      throw createProviderErrorV1('provider_endpoint_unavailable', {
        machineId: input.machineId,
      });
    }
    return result;
  };
}

export function createPublicManagedProviderRuntimeStartOperation(input: Readonly<{
  machineId: string;
  happyHomeDir: string;
  controller?: PluginReloadController;
  resolveSharedGateway?: ResolveSharedManagedProviderGatewayBinding;
}>): PublicManagedProviderRuntimeStartOperation {
  const start = createManagedProviderExplicitStartOperation(input);
  return async (request) => {
    await start(request);
    return Object.freeze({ status: 'running' as const });
  };
}

export function createManagedProviderExplicitStartCustody(input: Readonly<{
  machineId: string;
  happyHomeDir: string;
  controller?: PluginReloadController;
}>): ManagedProviderExplicitStartCustody {
  const withRegistry = async <T>(
    read: (registry: ResolvedExecutablePluginRuntimeRegistry) => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    let lease: PluginRuntimeRegistryLease | null = null;
    try {
      lease = await acquireAuthoritativePluginRuntimeRegistryLease({
        happyHomeDir: input.happyHomeDir,
        ...(input.controller ? { controller: input.controller } : {}),
      });
      return await read(lease.registry);
    } catch {
      return fallback;
    } finally {
      await lease?.release().catch(() => undefined);
    }
  };
  const withRegistryRequired = async <T>(
    read: (registry: ResolvedExecutablePluginRuntimeRegistry) => Promise<T>,
  ): Promise<T> => {
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
      happyHomeDir: input.happyHomeDir,
      ...(input.controller ? { controller: input.controller } : {}),
    });
    try {
      return await read(lease.registry);
    } finally {
      await lease.release();
    }
  };
  const retire = async ({ identity, operationClaim, sharedGateway }: Readonly<{
    identity: ManagedProviderExplicitStartCustodyRequest['identity'];
    operationClaim: ManagedProviderExplicitStartCustodyRequest['operationClaim'];
    sharedGateway?: ManagedProviderExplicitStartCustodyRequest['sharedGateway'];
  }>): Promise<boolean> => await withRegistryRequired(
    async (registry) => await registry.retireManagedProviderExplicitStart?.({
      ...(sharedGateway ? { sharedGateway } : {}),
      identity,
      machineId: input.machineId,
      operationClaim,
    }) ?? false,
  );
  return Object.freeze({
    async acquire(request) {
      const start = createManagedProviderExplicitStartOperation({
        ...input,
        operationClaim: request.operationClaim,
        ...(request.modelCatalogs ? { modelCatalogs: request.modelCatalogs } : {}),
        ...(request.retirementGroup ? { retirementGroup: request.retirementGroup } : {}),
        ...(request.revalidateRetainedCurrentness
          ? {
              revalidateRetainedCurrentness:
                request.revalidateRetainedCurrentness,
            }
          : {}),
        signal: request.signal,
      });
      try {
        const projection = await start(request);
        const retainedCurrent = request.revalidateRetainedCurrentness
          ? await request.revalidateRetainedCurrentness(request.signal)
          : true;
        if (!request.signal.aborted && !retainedCurrent) {
          if (!await retire(request)) {
            await Promise.resolve(projection.cleanup()).catch(() => undefined);
          }
          throw createProviderErrorV1('provider_authorization_changed', { machineId: input.machineId });
        }
        return projection;
      } catch (error) {
        const providerError = ProviderErrorV1Schema.safeParse(error);
        try {
          logger.warnLocalFile('[ProviderBroker] Managed source acquisition refused', {
            reasonCode: 'resource_unavailable' satisfies ProviderBrokerAdmissionFailureCodeV1,
            providerCode: providerError.success ? providerError.data.code : null,
          });
        } catch {
          // Diagnostics cannot change the existing closed source refusal.
        }
        return null;
      }
    },
    retire,
    async retireExternalApiKey({ identity, externalApiKeyId, operationId }) {
      return await withRegistry(
        async (registry) => await registry.retireManagedProviderExternalApiKey?.({
          identity,
          externalApiKeyId,
          operationId,
        }) ?? false,
        false,
      );
    },
    async revalidateRetainedClaims(signal, selector, invalidation) {
      return await withRegistryRequired(
        async (registry) => await registry.revalidateManagedProviderExplicitStarts?.(
          signal,
          selector ? { ...selector, machineId: input.machineId } : undefined,
          invalidation,
        ) ?? 0,
      );
    },
    async retireAll() {
      return await withRegistry(
        async (registry) => await registry.retireManagedProviderExplicitStarts?.('providerBroker') ?? 0,
        0,
      );
    },
  });
}
