import {
  ProviderErrorV1Schema,
  createProviderErrorV1,
  parseProviderContributionIdentityV1,
} from '@happier-dev/protocol';

import type {
  PluginReloadController,
  PluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/controller';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  startPublicManagedProviderRuntime,
  type PublicManagedProviderRuntimeStartFailureCode,
} from '@/providers/lifecycle/publicManagedProviderRuntimeStart';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';

import type { ProviderConnectionServiceDeps } from './service/types';

export type PublicManagedProviderRuntimeStartOperation = NonNullable<
  ProviderConnectionServiceDeps['startManagedProviderRuntime']
>;

function failForCoordinatorCode(
  code: PublicManagedProviderRuntimeStartFailureCode,
  machineId: string,
): never {
  if (code === 'managed_provider_request_invalid') {
    throw createProviderErrorV1('provider_connection_invalid', { machineId });
  }
  if (code === 'managed_provider_authorization_changed') {
    throw createProviderErrorV1('provider_authorization_changed', { machineId });
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
export function createPublicManagedProviderRuntimeStartOperation(input: Readonly<{
  machineId: string;
  happyHomeDir: string;
  controller?: PluginReloadController;
}>): PublicManagedProviderRuntimeStartOperation {
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

    const requestAuthorizationIsCurrent = async (): Promise<boolean> => {
      try {
        return request.isAuthorizationCurrent() === true
          && await request.revalidateAuthorization() === true
          && request.isAuthorizationCurrent() === true;
      } catch {
        return false;
      }
    };

    let lease: PluginRuntimeRegistryLease | null = request.runtimeRegistryLease ?? null;
    const ownsLease = lease === null;
    let result: Readonly<{ status: 'running' }> | null = null;
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

      if (!await requestAuthorizationIsCurrent()) {
        throw createProviderErrorV1('provider_authorization_changed', {
          machineId: input.machineId,
        });
      }
      const joined = await runManagedProviderExplicitStart({
        identity: request.identity,
        purposeBindings: request.purposeBindings,
        machineId: input.machineId,
        isCurrent: request.isAuthorizationCurrent,
        establish: async ({ signal, release }) => {
          const launchResourceScope = createProviderLaunchResourceScope();
          // The operation claim is registered before all launch resources, so
          // reverse-order cleanup retires process/authority custody first and
          // only then admits a later exact retry.
          launchResourceScope.register(release);
          try {
            const invocationServices = await createInvocationServices({
              identity: request.identity,
              purposeBindings: request.purposeBindings,
              operationClaim: {
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
              revalidateAuthorization: request.revalidateAuthorization,
              signal,
              launchResourceScope,
            });
            if (!started.ok) {
              return failForCoordinatorCode(started.code, input.machineId);
            }

            const cleanup = launchResourceScope.transfer();
            if (!cleanup) {
              throw createProviderErrorV1('provider_endpoint_unavailable', {
                machineId: input.machineId,
              });
            }
            try {
              addRuntimeDisposable(request.identity.pluginId, Object.freeze({
                dispose: cleanup,
              }));
            } catch (error) {
              await Promise.resolve(cleanup()).catch(() => undefined);
              throw error;
            }
            return Object.freeze({ status: 'running' as const });
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
      // No further authorization recheck belongs here. The coordinator owns the
      // last async revalidation and performs it while the launch resources are
      // still the caller's, releasing them itself when authority changed; the
      // join outcome above carries the operation owner's own currentness. A
      // recheck after ownership transferred could only report an error over a
      // live service it can no longer retire, latching this request's
      // authorization closure and blocking every later exact start.
      result = joined.value;
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
