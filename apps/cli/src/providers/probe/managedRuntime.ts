import { createProviderManagedProbeRequestFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import { randomUUID } from 'node:crypto';
import { createProviderErrorV1, ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import { projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

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

function managedCatalogAcquisitionError(error: unknown, ticket: ProviderManagedProbeHostAuthorizationTicket,
  phase: string): ProviderErrorV1 {
  const providerError = ProviderErrorV1Schema.safeParse(error);
  return providerError.success ? providerError.data : createProviderErrorV1('provider_endpoint_unavailable', {
    connectionId: ticket.connectionId, machineId: ticket.machineId,
    failureCause: projectActionFailureCauseV1(error, phase),
  });
}

function managedCatalogLaunchError(input: Readonly<{
  ticket: ProviderManagedProbeHostAuthorizationTicket;
  code: PublicManagedProviderRuntimeStartFailureCode;
  failureCause?: ActionFailureCauseV1;
}>): ProviderErrorV1 {
  const context = {
    connectionId: input.ticket.connectionId,
    machineId: input.ticket.machineId,
    ...(input.failureCause ? { failureCause: input.failureCause } : {}),
  };
  switch (input.code) {
    case 'managed_provider_request_invalid':
      return createProviderErrorV1('provider_probe_authorization_invalid', context);
    case 'managed_provider_authorization_changed':
      return createProviderErrorV1('provider_authorization_changed', context);
    case 'managed_provider_runtime_unavailable':
      return createProviderErrorV1('provider_contribution_unavailable', context);
    case 'managed_provider_start_aborted':
    case 'managed_provider_start_failed':
    case 'managed_provider_result_invalid':
    case 'managed_provider_endpoint_access_unavailable':
    case 'managed_provider_custody_adoption_failed':
    case 'managed_provider_cleanup_failed':
      return createProviderErrorV1('provider_endpoint_unavailable', context);
  }
}

export function isExactManagedCatalogLaunch(input: Readonly<{
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
  let expectedProbeRequestFingerprint: typeof request.probeRequestFingerprint;
  let ticketProbeRequestFingerprint: typeof request.probeRequestFingerprint;
  let requestProbeRequestFingerprint: typeof request.probeRequestFingerprint;
  try {
    expectedProbeRequestFingerprint = createProviderManagedProbeRequestFingerprintV1({
      implementationIdentity: input.source.implementationIdentity,
      managedRuntime: input.source.managedRuntime,
      purposeBindings: input.source.purposeBindings,
      endpointTemplateId: input.source.endpointTemplateId,
      protocol: input.source.protocol,
      sourceRegistryVersion: input.source.sourceRegistryVersion,
      method: 'GET',
      path: request.path,
      parser: request.parser,
      publicHeaders: input.source.publicHeaders,
    });
    ticketProbeRequestFingerprint = createProviderManagedProbeRequestFingerprintV1({
      implementationIdentity: ticket.implementationIdentity,
      managedRuntime: ticket.managedRuntime,
      purposeBindings: ticket.purposeBindings,
      endpointTemplateId: ticket.endpointTemplateId,
      protocol: ticket.protocol,
      sourceRegistryVersion: ticket.sourceRegistryVersion,
      method: 'GET',
      path: ticket.path,
      parser: ticket.parser,
      publicHeaders: input.source.publicHeaders,
    });
    requestProbeRequestFingerprint = createProviderManagedProbeRequestFingerprintV1({
      implementationIdentity: request.implementationIdentity,
      managedRuntime: request.managedRuntime,
      purposeBindings: request.purposeBindings,
      endpointTemplateId: request.endpointTemplateId,
      protocol: request.protocol,
      sourceRegistryVersion: request.sourceRegistryVersion,
      method: 'GET',
      path: request.path,
      parser: request.parser,
      publicHeaders: input.source.publicHeaders,
    });
  } catch {
    return false;
  }
  return ticket.connectionId === request.connectionId
    && ticket.machineId === request.machineId
    && ticket.sourceRegistryVersion === input.source.sourceRegistryVersion
    && request.sourceRegistryVersion === input.source.sourceRegistryVersion
    && ticketProbeRequestFingerprint === expectedProbeRequestFingerprint
    && requestProbeRequestFingerprint === expectedProbeRequestFingerprint
    && ticket.probeRequestFingerprint === expectedProbeRequestFingerprint
    && request.probeRequestFingerprint === expectedProbeRequestFingerprint;
}

/**
 * Daemon-only catalog activation through the authoritative public managed
 * Provider runtime and SVC09 custody. One operation-scoped registry lease owns
 * every acquired service, access projection, and handle until the probe closes.
 */
export function createProviderManagedCatalogRuntimePort(input: Readonly<{
  happyHomeDir?: string;
  acquireRegistryLease?: AcquireProviderCatalogRegistryLease;
  resolveSharedGateway?: import('@/plugins/runtime/invocation/services/managedServicesAdapter').ResolveSharedManagedProviderGatewayBinding;
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
      const accountAuthority = launchInput.operationScope?.managedRuntimeAccount;
      if (accountAuthority === null || (launchInput.operationScope?.getAccountSettingsSnapshot && !accountAuthority)) {
        return { ok: false, error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: ticket.connectionId, machineId: ticket.machineId,
        }) };
      }
      const signal = launchInput.signal ?? new AbortController().signal;
      const scope = createProviderLaunchResourceScope();
      let authorizationCurrent = !signal.aborted;
      let authorizationFailure: ProviderErrorV1 | undefined;
      const authorizationError = () => authorizationFailure ?? createProviderErrorV1(
        'provider_authorization_changed',
        { connectionId: ticket.connectionId, machineId: ticket.machineId },
      );
      const isAuthorizationCurrent = (): boolean => (
        authorizationCurrent && !signal.aborted
      );
      const revalidateAuthorization = async (): Promise<boolean> => {
        if (!isAuthorizationCurrent()) return false;
        try {
          const validation = await launchInput.revalidateBeforeEffect();
          authorizationCurrent = validation.ok;
          if (!validation.ok) authorizationFailure = validation.error;
        } catch (error) {
          const typed = ProviderErrorV1Schema.safeParse(error);
          if (typed.success) authorizationFailure = typed.data;
          authorizationCurrent = false;
        }
        return isAuthorizationCurrent();
      };
      const fail = async (error: ProviderErrorV1) => {
        try {
          await scope.release();
        } catch {
          // Cleanup cannot replace the acquisition or admission refusal.
        }
        return Object.freeze({ ok: false as const, error });
      };

      let registryLease: PluginRuntimeRegistryLease;
      try {
        registryLease = await acquireRegistryLease();
        scope.register(registryLease.release);
      } catch (error) {
        return await fail(managedCatalogAcquisitionError(error, ticket, 'providers.catalog.acquire_registry'));
      }
      const registry = registryLease.registry;
      if (
        launchInput.expectedActivationOccurrenceId !== undefined
        && registry.readPluginOccurrenceId?.(
          launchInput.source.implementationIdentity.pluginId,
        ) !== launchInput.expectedActivationOccurrenceId
      ) {
        return await fail(createProviderErrorV1(
          'provider_authorization_changed',
          { connectionId: ticket.connectionId, machineId: ticket.machineId },
        ));
      }
      const acquireRuntime = registry.acquireManagedProviderRuntime;
      const createInvocationServices =
        registry.createManagedProviderRuntimeInvocationServices;
      if (!acquireRuntime || !createInvocationServices) {
        return await fail(createProviderErrorV1(
          'provider_endpoint_unavailable',
          { connectionId: ticket.connectionId, machineId: ticket.machineId },
        ));
      }
      let invocationServices: Awaited<ReturnType<typeof createInvocationServices>>;
      try {
        const resolveSharedGateway = accountAuthority?.resolveSharedGateway ?? input.resolveSharedGateway;
        invocationServices = await createInvocationServices({
          ...(accountAuthority ? { accountAuthority } : {}),
          ...(resolveSharedGateway ? { sharedGateway: await resolveSharedGateway({
            connectionId: ticket.connectionId,
            consumerId: `catalogProbe:${randomUUID()}`,
            signal,
          }) ?? undefined } : {}),
          identity: ticket.implementationIdentity,
          purposeBindings: ticket.purposeBindings,
          signal,
          isCurrent: isAuthorizationCurrent,
        });
      } catch (error) {
        return await fail(managedCatalogAcquisitionError(error, ticket, 'providers.catalog.acquire_services'));
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
          error: started.code === 'managed_provider_authorization_changed'
            ? authorizationError()
            : managedCatalogLaunchError({ ticket, code: started.code,
              failureCause: started.startupFailure?.failureCause }),
        };
      }
      const admittedEndpointUrl = started.access.endpointUrl(
        launchInput.source.endpointTemplateId,
      );
      if (!admittedEndpointUrl) {
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
        endpointUrl: (endpointTemplateId: string) =>
          started.access.endpointUrl(endpointTemplateId),
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
