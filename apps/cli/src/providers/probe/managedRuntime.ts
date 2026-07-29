import { randomUUID } from 'node:crypto';

import {
  createProviderErrorV1,
  type ProviderErrorV1,
} from '@happier-dev/protocol';
import type {
  ExecRuntimeServiceV1,
} from '@/plugins/runtime/exec/privateContract';

import type {
  LocalServicesDaemonRuntime,
} from '@/daemon/local/services/runtime';
import {
  prepareTransientManagedProviderEndpoint,
  type TransientManagedProviderEndpointResult,
} from '@/providers/lifecycle/transientManagedEndpoint';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import type {
  ProviderManagedProbeHostAuthorizationTicket,
  ProviderProbeHostAuthorizationTicket,
} from '@/providers/spawn/resolve';

import type { ProviderManagedCatalogRuntimePort } from './catalog';

type TrustedManagedLocalServices = Pick<
  LocalServicesDaemonRuntime['trustedManagedLocalServices'],
  'startOwned' | 'readOwnedRun' | 'registerOwnedCleanup' | 'stopOwned'
>;

function managedCatalogLaunchError(input: Readonly<{
  ticket: ProviderManagedProbeHostAuthorizationTicket;
  failure: Exclude<TransientManagedProviderEndpointResult, { ok: true }>;
}>): ProviderErrorV1 {
  const context = {
    connectionId: input.ticket.connectionId,
    machineId: input.ticket.machineId,
  };
  switch (input.failure.code) {
    case 'managed_provider_execution_denied':
      return createProviderErrorV1('provider_authorization_changed', context);
    case 'managed_provider_runtime_preparation_failed':
    case 'managed_provider_materialization_failed':
      return createProviderErrorV1('provider_materialization_failed', context);
    case 'managed_provider_runtime_unavailable':
    case 'managed_provider_start_failed':
    case 'managed_provider_run_invalid':
    case 'managed_provider_readiness_invalid':
    case 'managed_provider_activation_failed':
      return createProviderErrorV1('provider_endpoint_unavailable', context);
  }
}

/**
 * Daemon-only adapter from the canonical Provider catalog owner to the shared
 * credential-free managed lifecycle. It owns no cache or listener beyond one
 * returned scope, and never activates Connected Services request-auth.
 */
export function createProviderManagedCatalogRuntimePort(input: Readonly<{
  materializationBaseDir: string;
  resolveManagedLocalServicesEnabled: () => boolean | Promise<boolean>;
  localServices: TrustedManagedLocalServices;
  exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
  readinessTimeoutMs?: number;
}>): ProviderManagedCatalogRuntimePort<ProviderProbeHostAuthorizationTicket> {
  return Object.freeze({
    launch: async (launchInput) => {
      const ticket = launchInput.ticket;
      const request = launchInput.request;
      const binding = launchInput.source.runtimeBinding;
      if (
        ticket.deployment !== 'managedLocal'
        || request.deployment !== 'managedLocal'
        || !binding
        || binding.contribution.provenance !== 'first_party'
        || binding.contribution.source.kind !== 'bundled'
      ) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', {
            connectionId: ticket.connectionId,
            machineId: ticket.machineId,
          }),
        };
      }
      let authorizationCurrent = true;
      const isAuthorizationCurrent = () => (
        authorizationCurrent
        && launchInput.signal?.aborted !== true
      );
      const revalidateBeforeEffect = async (): Promise<boolean> => {
        const validation = await launchInput.revalidateBeforeEffect();
        authorizationCurrent = validation.ok;
        return validation.ok;
      };
      let managedLocalServicesEnabled = false;
      try {
        managedLocalServicesEnabled = await input.resolveManagedLocalServicesEnabled();
      } catch {
        managedLocalServicesEnabled = false;
      }
      const launchResourceScope = createProviderLaunchResourceScope();
      const transient = await prepareTransientManagedProviderEndpoint({
        operationId: `provider-catalog:${ticket.connectionId}:${randomUUID()}`,
        contribution: binding.contribution,
        facet: launchInput.source.managedFacet,
        runtimeAdapter: binding.runtimeAdapter,
        purposes: request.purposeBindings.bindings.map((binding) => binding.purpose),
        endpointTemplateId: launchInput.source.endpointTemplateId,
        protocol: launchInput.source.protocol,
        materializationBaseDir: input.materializationBaseDir,
        managedLocalServicesEnabled,
        isAuthorizationCurrent,
        revalidateBeforeEffect,
        localServices: input.localServices,
        exec: input.exec,
        launchResourceScope,
        ...(input.readinessTimeoutMs === undefined
          ? {}
          : { readinessTimeoutMs: input.readinessTimeoutMs }),
      });
      if (!transient.ok) {
        await launchResourceScope.release();
        return {
          ok: false,
          error: managedCatalogLaunchError({ ticket, failure: transient }),
        };
      }
      return Object.freeze({
        ok: true as const,
        endpointUrl: transient.normalizedUrl,
        downstreamBearer: transient.downstreamBearer,
        isCurrent: transient.isCurrent,
        close: () => launchResourceScope.release(),
      });
    },
  });
}
