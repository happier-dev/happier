import {
  createProviderErrorV1,
  type ProviderErrorV1,
} from '@happier-dev/protocol';

import type {
  ManagedProviderEndpointHttpAccess,
} from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import type {
  PluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/controller';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import {
  startPublicManagedProviderRuntime,
  type PublicManagedProviderRuntimeStartFailureCode,
} from '@/providers/lifecycle/publicManagedProviderRuntimeStart';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import type {
  ProviderManagedProbeHostAuthorizationTicket,
  ProviderProbeHostAuthorizationTicket,
} from '@/providers/spawn/resolve';

import type { ProviderManagedCatalogRuntimePort } from './catalog';
import type { ProviderProbeManagedServiceRequest } from './client';

type AcquireProviderCatalogRegistryLease = () => Promise<PluginRuntimeRegistryLease>;

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function managedCatalogLaunchError(input: Readonly<{
  ticket: ProviderManagedProbeHostAuthorizationTicket;
  code: PublicManagedProviderRuntimeStartFailureCode;
}>): ProviderErrorV1 {
  const context = {
    connectionId: input.ticket.connectionId,
    machineId: input.ticket.machineId,
  };
  switch (input.code) {
    case 'managed_provider_request_invalid':
      return createProviderErrorV1('provider_probe_authorization_invalid', context);
    case 'managed_provider_authorization_changed':
      return createProviderErrorV1('provider_authorization_changed', context);
    case 'managed_provider_runtime_unavailable':
    case 'managed_provider_start_aborted':
    case 'managed_provider_start_failed':
    case 'managed_provider_result_invalid':
    case 'managed_provider_endpoint_access_unavailable':
    case 'managed_provider_custody_adoption_failed':
    case 'managed_provider_cleanup_failed':
      return createProviderErrorV1('provider_endpoint_unavailable', context);
  }
}

function isExactManagedCatalogLaunch(input: Readonly<{
  source: Parameters<ProviderManagedCatalogRuntimePort<ProviderProbeHostAuthorizationTicket>['launch']>[0]['source'];
  request: Parameters<ProviderManagedCatalogRuntimePort<ProviderProbeHostAuthorizationTicket>['launch']>[0]['request'];
  ticket: ProviderProbeHostAuthorizationTicket;
}>): input is typeof input & Readonly<{
  request: Extract<typeof input.request, { deployment: 'managedLocal' }>;
  ticket: ProviderManagedProbeHostAuthorizationTicket;
}> {
  if (
    input.ticket.deployment !== 'managedLocal'
    || input.request.deployment !== 'managedLocal'
  ) return false;
  const ticket = input.ticket;
  const request = input.request;
  return ticket.connectionId === request.connectionId
    && ticket.machineId === request.machineId
    && ticket.implementationIdentity.pluginId
      === input.source.implementationIdentity.pluginId
    && ticket.implementationIdentity.localId
      === input.source.implementationIdentity.localId
    && request.implementationIdentity.pluginId
      === input.source.implementationIdentity.pluginId
    && request.implementationIdentity.localId
      === input.source.implementationIdentity.localId
    && ticket.endpointTemplateId === input.source.endpointTemplateId
    && request.endpointTemplateId === input.source.endpointTemplateId
    && ticket.protocol === input.source.protocol
    && request.protocol === input.source.protocol
    && ticket.path === request.path
    && ticket.parser === request.parser
    && sameJson(ticket.managedRuntime, input.source.managedRuntime)
    && sameJson(request.managedRuntime, input.source.managedRuntime)
    && sameJson(ticket.purposeBindings, input.source.purposeBindings)
    && sameJson(request.purposeBindings, input.source.purposeBindings)
    && input.source.managedRuntime.endpointTemplateIds.includes(
      input.source.endpointTemplateId,
    );
}

/**
 * Daemon-only catalog activation through the authoritative public managed
 * Provider runtime and SVC09 custody. One operation-scoped registry lease owns
 * every acquired service, access projection, and handle until the probe closes.
 */
export function createProviderManagedCatalogRuntimePort(input: Readonly<{
  happyHomeDir?: string;
  acquireRegistryLease?: AcquireProviderCatalogRegistryLease;
}> = {}): ProviderManagedCatalogRuntimePort<ProviderProbeHostAuthorizationTicket> {
  const acquireRegistryLease = input.acquireRegistryLease
    ?? (() => acquireAuthoritativePluginRuntimeRegistryLease(
      input.happyHomeDir === undefined
        ? undefined
        : { happyHomeDir: input.happyHomeDir },
    ));
  return Object.freeze({
    launch: async (launchInput) => {
      if (!isExactManagedCatalogLaunch(launchInput)) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', {
            connectionId: launchInput.request.connectionId,
            machineId: launchInput.request.machineId,
          }),
        };
      }
      const ticket = launchInput.ticket;
      const signal = launchInput.signal ?? new AbortController().signal;
      const scope = createProviderLaunchResourceScope();
      let authorizationCurrent = !signal.aborted;
      const isAuthorizationCurrent = (): boolean => (
        authorizationCurrent && !signal.aborted
      );
      const revalidateAuthorization = async (): Promise<boolean> => {
        if (!isAuthorizationCurrent()) return false;
        try {
          const validation = await launchInput.revalidateBeforeEffect();
          authorizationCurrent = validation.ok;
        } catch {
          authorizationCurrent = false;
        }
        return isAuthorizationCurrent();
      };
      const fail = async (error: ProviderErrorV1) => {
        try {
          await scope.release();
        } catch {
          return Object.freeze({
            ok: false as const,
            error: createProviderErrorV1('provider_endpoint_unavailable', {
              connectionId: ticket.connectionId,
              machineId: ticket.machineId,
            }),
          });
        }
        return Object.freeze({ ok: false as const, error });
      };

      if (!await revalidateAuthorization()) {
        return await fail(createProviderErrorV1(
          'provider_authorization_changed',
          { connectionId: ticket.connectionId, machineId: ticket.machineId },
        ));
      }

      let registryLease: PluginRuntimeRegistryLease;
      try {
        registryLease = await acquireRegistryLease();
        scope.register(registryLease.release);
      } catch {
        return await fail(createProviderErrorV1(
          'provider_endpoint_unavailable',
          { connectionId: ticket.connectionId, machineId: ticket.machineId },
        ));
      }
      const registry = registryLease.registry;
      const acquireRuntime = registry.acquireManagedProviderRuntime;
      const createInvocationServices =
        registry.createManagedProviderRuntimeInvocationServices;
      if (!acquireRuntime || !createInvocationServices) {
        return await fail(createProviderErrorV1(
          'provider_endpoint_unavailable',
          { connectionId: ticket.connectionId, machineId: ticket.machineId },
        ));
      }
      if (!await revalidateAuthorization()) {
        return await fail(createProviderErrorV1(
          'provider_authorization_changed',
          { connectionId: ticket.connectionId, machineId: ticket.machineId },
        ));
      }

      let invocationServices: Awaited<ReturnType<typeof createInvocationServices>>;
      try {
        invocationServices = await createInvocationServices({
          identity: ticket.implementationIdentity,
          purposeBindings: ticket.purposeBindings,
          signal,
          isCurrent: isAuthorizationCurrent,
        });
      } catch {
        invocationServices = null;
      }
      if (!invocationServices) {
        return await fail(createProviderErrorV1(
          'provider_endpoint_unavailable',
          { connectionId: ticket.connectionId, machineId: ticket.machineId },
        ));
      }
      scope.register(invocationServices.cleanup);

      const started = await startPublicManagedProviderRuntime<
        ManagedProviderEndpointHttpAccess
      >({
        identity: ticket.implementationIdentity,
        request: Object.freeze({
          reason: 'catalogProbe',
          connectionId: ticket.connectionId,
          connectionRevision: ticket.connectionRevision,
          endpointTemplateIds: Object.freeze([
            ...launchInput.source.managedRuntime.endpointTemplateIds,
          ]),
        }),
        acquireRuntime: (identity) => acquireRuntime(identity),
        connectedAccounts: invocationServices.connectedAccounts,
        custody: invocationServices,
        isAuthorizationCurrent,
        revalidateAuthorization,
        signal,
        launchResourceScope: scope,
      });
      if (!started.ok) {
        return {
          ok: false,
          error: managedCatalogLaunchError({ ticket, code: started.code }),
        };
      }
      const endpointUrl = started.access.endpointUrl(
        launchInput.source.endpointTemplateId,
      );
      if (!endpointUrl) {
        return await fail(createProviderErrorV1(
          'provider_endpoint_unavailable',
          { connectionId: ticket.connectionId, machineId: ticket.machineId },
        ));
      }
      if (!started.isCurrent()) {
        return await fail(createProviderErrorV1(
          'provider_authorization_changed',
          { connectionId: ticket.connectionId, machineId: ticket.machineId },
        ));
      }
      return Object.freeze({
        ok: true as const,
        endpointUrl,
        access: Object.freeze({
          request: (async (request) => {
            const response = await started.access.request(request);
            return Object.freeze({
              status: response.status,
              headers: response.headers,
              body: response.body,
            });
          }) satisfies ProviderProbeManagedServiceRequest,
        }),
        isCurrent: started.isCurrent,
        close: () => scope.release(),
      });
    },
  });
}
