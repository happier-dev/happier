import {
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  createProviderErrorV1,
  createProviderManagedRuntimeBindingEqualityKeyV1,
  normalizeProviderEndpointUrlSyntax,
  type AssessedProviderEndpoint,
  type ProviderErrorV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type {
  ProviderProbeAuthorizationPort,
  ProviderProbeOperationScope,
} from '../probe/authorization';
import type {
  ProviderContributionRegistryView,
  ProviderEndpointDnsEvidence,
} from '../registry/types';
import { readProviderSettingsForCli } from '../settings/read';
import { createAccountBoundProviderSnapshotReader } from '../lifecycle/currentAccountSettingsSnapshot';
import { collectProviderConnectionDnsEvidence } from '../registry/dnsEvidence';
import {
  createProviderOperationLifetime,
  ProviderOperationAbandonedError,
} from '../operationLifetime';
import { resolveProviderConnectionForMachine } from '../registry/resolve';
import {
  resolveManagedProviderPurposeBindingSnapshot,
  type ResolveManagedProviderPurposeBindingIntent,
} from '../managed/resolvePurposeBindingSnapshot';

import {
  resolveProviderModelLoadAuthorization,
  resolveProviderProbeAuthorization,
  type ProviderModelLoadHostAuthorizationResult,
  type ProviderModelLoadHostAuthorizationTicket,
  type ProviderModelLoadHostRequest,
  type ProviderProbeHostAuthorizationResult,
  type ProviderProbeHostAuthorizationTicket,
} from './resolve';
import type { ProviderProbeHostCredentialReference } from './credentials';
import { resolveRuntimeProviderCredential } from './runtimeCredential';
import type { ProviderModelLoadOperationScope } from '../modelManagement/load';

export type RuntimeProviderModelLoadAuthorizationPort = Readonly<{
  authorize(
    request: ProviderModelLoadHostRequest,
    scope?: ProviderModelLoadOperationScope,
  ): Promise<ProviderModelLoadHostAuthorizationResult>;
  revalidate(
    ticket: ProviderModelLoadHostAuthorizationTicket,
    request: ProviderModelLoadHostRequest,
    scope?: ProviderModelLoadOperationScope,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: ProviderErrorV1 }>>;
  authorizeDestination(
    ticket: ProviderModelLoadHostAuthorizationTicket,
    request: ProviderModelLoadHostRequest,
    destination: import('@happier-dev/protocol').AssessedProviderEndpoint,
    scope?: ProviderModelLoadOperationScope,
  ): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: ProviderErrorV1 }>>;
  resolveCredential(
    reference: ProviderProbeHostCredentialReference,
  ): ReturnType<ProviderProbeAuthorizationPort<ProviderProbeHostAuthorizationTicket, ProviderProbeHostCredentialReference>['resolveCredential']>;
}>;

function bindExactDispatchAddressEvidence(
  evidence: ProviderEndpointDnsEvidence,
  destination: Readonly<{ endpointUrl: string; endpoint: AssessedProviderEndpoint }>,
): ProviderEndpointDnsEvidence {
  const exactEvidence = new Map(evidence);
  exactEvidence.set(
    normalizeProviderEndpointUrlSyntax(destination.endpointUrl).normalizedUrl,
    destination.endpoint.resolvedAddresses,
  );
  return exactEvidence;
}

/**
 * Direct authorization calls are public admission boundaries. Nested catalog
 * work supplies its existing scope, so DNS and later destination checks spend
 * the same deadline rather than creating a second timer.
 */
function startProbeOperationScope(
  scope: ProviderProbeOperationScope | undefined,
): ProviderProbeOperationScope {
  return scope ?? {
    lifetime: createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    }),
  };
}

function startModelLoadOperationScope(
  scope: ProviderModelLoadOperationScope | undefined,
): ProviderModelLoadOperationScope {
  return scope ?? {
    lifetime: createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    }),
  };
}

export function revalidateProviderProbeAuthorizationTicket(
  ticket: ProviderProbeHostAuthorizationTicket,
  current: ProviderProbeHostAuthorizationTicket | ProviderErrorV1,
): Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }> {
  if ('code' in current) return { ok: false, error: current };
  const equal = ticket.deployment === 'managedLocal'
    ? current.deployment === 'managedLocal'
      && ticket.connectionId === current.connectionId
      && ticket.connectionRevision === current.connectionRevision
      && ticket.machineId === current.machineId
      && ticket.connectionSecurityFingerprint === current.connectionSecurityFingerprint
      && ticket.endpointSetFingerprint === current.endpointSetFingerprint
      && ticket.grantFingerprint === current.grantFingerprint
      && ticket.connectionScope === current.connectionScope
      && ticket.contributionKey === current.contributionKey
      && createProviderManagedRuntimeBindingEqualityKeyV1({
        implementationIdentity: ticket.implementationIdentity,
        managedRuntime: ticket.managedRuntime,
        purposeBindings: ticket.purposeBindings,
      })
        === createProviderManagedRuntimeBindingEqualityKeyV1({
          implementationIdentity: current.implementationIdentity,
          managedRuntime: current.managedRuntime,
          purposeBindings: current.purposeBindings,
        })
      && ticket.endpointTemplateId === current.endpointTemplateId
      && ticket.protocol === current.protocol
      && ticket.path === current.path
      && ticket.parser === current.parser
      && ticket.probeRequestFingerprint === current.probeRequestFingerprint
    : current.deployment !== 'managedLocal'
    && ticket.connectionId === current.connectionId
    && ticket.connectionRevision === current.connectionRevision
    && ticket.machineId === current.machineId
    && ticket.connectionSecurityFingerprint === current.connectionSecurityFingerprint
    && ticket.endpointSetFingerprint === current.endpointSetFingerprint
    && ticket.grantFingerprint === current.grantFingerprint
    && ticket.connectionScope === current.connectionScope
    && ticket.endpointTemplateId === current.endpointTemplateId
    && ticket.endpointUrl === current.endpointUrl
    && ticket.protocol === current.protocol
    && ticket.probeRequestFingerprint === current.probeRequestFingerprint
    && ticket.selectedSecretBindingId === current.selectedSecretBindingId
    && ticket.selectedSecretRecordFingerprint === current.selectedSecretRecordFingerprint;
  return equal
    ? { ok: true }
    : {
        ok: false,
        error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: ticket.connectionId,
          machineId: ticket.machineId,
        }),
      };
}

export function revalidateProviderModelLoadAuthorizationTicket(
  ticket: ProviderModelLoadHostAuthorizationTicket,
  current: ProviderModelLoadHostAuthorizationTicket | ProviderErrorV1,
): Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }> {
  if ('code' in current) return { ok: false, error: current };
  const equal = ticket.connectionId === current.connectionId
    && ticket.connectionRevision === current.connectionRevision
    && ticket.machineId === current.machineId
    && ticket.modelId === current.modelId
    && ticket.connectionSecurityFingerprint === current.connectionSecurityFingerprint
    && ticket.endpointSetFingerprint === current.endpointSetFingerprint
    && ticket.grantFingerprint === current.grantFingerprint
    && ticket.connectionScope === current.connectionScope
    && ticket.endpointTemplateId === current.endpointTemplateId
    && ticket.endpointUrl === current.endpointUrl
    && ticket.protocol === current.protocol
    && JSON.stringify(ticket.descriptor) === JSON.stringify(current.descriptor)
    && ticket.selectedSecretBindingId === current.selectedSecretBindingId
    && ticket.selectedSecretRecordFingerprint === current.selectedSecretRecordFingerprint;
  return equal
    ? { ok: true }
    : {
        ok: false,
        error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: ticket.connectionId,
          machineId: ticket.machineId,
        }),
      };
}

export function createRuntimeProviderProbeAuthorizationPort(input: Readonly<{
  registry?: ProviderContributionRegistryView;
  resolveRegistry?: () => ProviderContributionRegistryView | Promise<ProviderContributionRegistryView>;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  localCandidateUrlsByConnectionId?: Parameters<typeof resolveProviderProbeAuthorization>[0]['localCandidateUrlsByConnectionId'];
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
}>): ProviderProbeAuthorizationPort<ProviderProbeHostAuthorizationTicket, ProviderProbeHostCredentialReference> {
  const getAccountSettingsSnapshot = createAccountBoundProviderSnapshotReader(
    input.getAccountSettingsSnapshot,
  );
  const authorizeWithDestination = async (
    request: Parameters<ProviderProbeAuthorizationPort<ProviderProbeHostAuthorizationTicket, ProviderProbeHostCredentialReference>['authorize']>[0],
    destination?: Readonly<{ endpointUrl: string; endpoint: AssessedProviderEndpoint }>,
    scope?: ProviderProbeOperationScope,
  ): Promise<ProviderProbeHostAuthorizationResult> => {
    const operationScope = startProbeOperationScope(scope);
    const registry = operationScope.registry ?? (input.resolveRegistry ? await input.resolveRegistry() : input.registry);
    if (!registry) throw new TypeError('Provider probe authorization requires a contribution registry');
    const snapshot = getAccountSettingsSnapshot();
    if (!snapshot) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_connection_not_found', {
          connectionId: request.connectionId,
          machineId: request.machineId,
        }),
      };
    }
    const providerSettings = readProviderSettingsForCli(snapshot.settings).settings;
    let dnsEvidenceByEndpointUrl;
    try {
      dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
        connectionId: request.connectionId,
        machineId: request.machineId,
        providerSettings,
        registry,
        ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
        lifetime: operationScope.lifetime,
      });
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
        };
      }
      throw error;
    }
    if (destination) {
      dnsEvidenceByEndpointUrl = bindExactDispatchAddressEvidence(
        dnsEvidenceByEndpointUrl,
        destination,
      );
    }
    let managedPurposeBindingResolution:
      QualifiedConnectedAccountPurposeBindingsV1 | undefined;
    if (request.deployment === 'managedLocal') {
      const resolution = resolveProviderConnectionForMachine({
        connectionId: request.connectionId,
        machineId: request.machineId,
        accountSettings: snapshot.settings,
        registry,
        dnsEvidenceByEndpointUrl,
        ...(input.localCandidateUrlsByConnectionId
          ? {
              localCandidateUrlsByConnectionId:
                input.localCandidateUrlsByConnectionId,
            }
          : {}),
      });
      if (
        resolution.status !== 'resolved'
        || resolution.record.deployment.kind !== 'managedLocal'
        || !input.resolveManagedPurposeBindingIntent
      ) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', {
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
        };
      }
      try {
        managedPurposeBindingResolution =
          await resolveManagedProviderPurposeBindingSnapshot({
            implementationIdentity:
              resolution.record.deployment.implementationIdentity,
            connectedAccounts:
              resolution.record.deployment.managedRuntime.connectedAccounts ?? [],
            purposeBindingIntents:
              resolution.record.deployment.purposeBindingIntents,
            resolveBindingIntent: input.resolveManagedPurposeBindingIntent,
          });
      } catch {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', {
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
        };
      }
    }
    return resolveProviderProbeAuthorization({
      request,
      accountSettings: snapshot.settings,
      providerSettings,
      registry,
      dnsEvidenceByEndpointUrl,
      ...(managedPurposeBindingResolution
        ? {
            managedPurposeBindingSnapshot:
              managedPurposeBindingResolution,
          }
        : {}),
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
    });
  };
  const authorize = (
    request: Parameters<typeof authorizeWithDestination>[0],
    scope?: ProviderProbeOperationScope,
  ) => authorizeWithDestination(request, undefined, scope);
  return Object.freeze({
    authorize,
    revalidate: async (ticket, request, scope) => {
      const current = await authorize(request, scope);
      return current.ok
        ? revalidateProviderProbeAuthorizationTicket(ticket, current.ticket)
        : { ok: false, error: current.error };
    },
    authorizeDestination: async (ticket, request, destination, scope) => {
      if (ticket.deployment === 'managedLocal' || request.deployment === 'managedLocal') {
        return {
          ok: false,
          error: createProviderErrorV1('provider_authorization_changed', {
            connectionId: ticket.connectionId,
            machineId: ticket.machineId,
          }),
        };
      }
      const authorizedOrigin = new URL(ticket.endpointUrl).origin;
      if (destination.origin !== authorizedOrigin || destination.scope !== ticket.connectionScope) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_authorization_changed', {
            connectionId: ticket.connectionId,
            machineId: ticket.machineId,
          }),
        };
      }
      const current = await authorizeWithDestination(request, {
        endpointUrl: ticket.endpointUrl,
        endpoint: destination,
      }, scope);
      if (!current.ok) return { ok: false, error: current.error };
      const validation = revalidateProviderProbeAuthorizationTicket(ticket, current.ticket);
      if (!validation.ok) return validation;
      return { ok: true };
    },
    resolveCredential: async (credentialRef) => resolveRuntimeProviderCredential({
      credentialRef,
      getAccountSettingsSnapshot,
    }),
  });
}

export function createRuntimeProviderModelLoadAuthorizationPort(input: Readonly<{
  registry?: ProviderContributionRegistryView;
  resolveRegistry?: () => ProviderContributionRegistryView | Promise<ProviderContributionRegistryView>;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  localCandidateUrlsByConnectionId?: Parameters<typeof resolveProviderModelLoadAuthorization>[0]['localCandidateUrlsByConnectionId'];
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
}>): RuntimeProviderModelLoadAuthorizationPort {
  const getAccountSettingsSnapshot = createAccountBoundProviderSnapshotReader(
    input.getAccountSettingsSnapshot,
  );
  const authorizeWithDestination = async (
    request: ProviderModelLoadHostRequest,
    destination?: Readonly<{ endpointUrl: string; endpoint: AssessedProviderEndpoint }>,
    scope?: ProviderModelLoadOperationScope,
  ): Promise<ProviderModelLoadHostAuthorizationResult> => {
    const operationScope = startModelLoadOperationScope(scope);
    const registry = operationScope.registry ?? (input.resolveRegistry ? await input.resolveRegistry() : input.registry);
    if (!registry) throw new TypeError('Provider model-load authorization requires a contribution registry');
    const snapshot = getAccountSettingsSnapshot();
    if (!snapshot) {
      return {
        status: 'error',
        error: createProviderErrorV1('provider_connection_not_found', {
          connectionId: request.connectionId,
          machineId: request.machineId,
        }),
      };
    }
    const providerSettings = readProviderSettingsForCli(snapshot.settings).settings;
    let dnsEvidenceByEndpointUrl;
    try {
      dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
        connectionId: request.connectionId,
        machineId: request.machineId,
        providerSettings,
        registry,
        ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
        lifetime: operationScope.lifetime,
      });
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) {
        return {
          status: 'error',
          error: createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
        };
      }
      throw error;
    }
    if (destination) {
      dnsEvidenceByEndpointUrl = bindExactDispatchAddressEvidence(
        dnsEvidenceByEndpointUrl,
        destination,
      );
    }
    const resolved = await resolveProviderModelLoadAuthorization({
      request,
      accountSettings: snapshot.settings,
      providerSettings,
      registry,
      dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
    });
    return resolved;
  };
  const authorize = (
    request: ProviderModelLoadHostRequest,
    scope?: ProviderModelLoadOperationScope,
  ) => authorizeWithDestination(request, undefined, scope);
  return Object.freeze({
    authorize,
    revalidate: async (ticket, request, scope) => {
      const current = await authorize(request, scope);
      if (current.status === 'error') return { ok: false, error: current.error };
      if (current.status === 'unavailable') {
        return {
          ok: false,
          error: createProviderErrorV1('provider_authorization_changed', {
            connectionId: ticket.connectionId,
            machineId: ticket.machineId,
          }),
        };
      }
      return revalidateProviderModelLoadAuthorizationTicket(ticket, current.authorization.ticket);
    },
    authorizeDestination: async (ticket, request, destination, scope) => {
      const authorizedOrigin = new URL(ticket.endpointUrl).origin;
      if (destination.origin !== authorizedOrigin || destination.scope !== ticket.connectionScope) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_authorization_changed', {
            connectionId: ticket.connectionId,
            machineId: ticket.machineId,
          }),
        };
      }
      const current = await authorizeWithDestination(request, {
        endpointUrl: ticket.endpointUrl,
        endpoint: destination,
      }, scope);
      if (current.status === 'error') return { ok: false, error: current.error };
      if (current.status === 'unavailable') {
        return {
          ok: false,
          error: createProviderErrorV1('provider_authorization_changed', {
            connectionId: ticket.connectionId,
            machineId: ticket.machineId,
          }),
        };
      }
      const validation = revalidateProviderModelLoadAuthorizationTicket(ticket, current.authorization.ticket);
      if (!validation.ok) return validation;
      return { ok: true };
    },
    resolveCredential: async (credentialRef) => resolveRuntimeProviderCredential({
      credentialRef,
      getAccountSettingsSnapshot,
    }),
  });
}
