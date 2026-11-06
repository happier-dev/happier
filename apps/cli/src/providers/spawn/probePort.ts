import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { AssessedProviderEndpoint, ProviderErrorV1, QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import type {
  ProviderProbeAuthorizationPort,
  ProviderProbeOperationScope,
} from '../probe/authorization';
import type { ProviderContributionRegistryView } from '../registry/types';
import { readProviderSettingsForCli } from '../settings/read';
import { createAccountBoundProviderSnapshotReader } from '../lifecycle/currentAccountSettingsSnapshot';
import { collectProviderConnectionDnsEvidence } from '../registry/dnsEvidence';
import {
  awaitAbortableWithinProviderOperation,
  awaitWithinProviderOperation,
  createProviderOperationLifetime,
  observeProviderOperationPhase,
  ProviderOperationAbandonedError,
} from '../operationLifetime';
import { resolveProviderConnectionForMachineFromSettingsRead } from '../registry/resolve';
import {
  providerManagedPurposeBindingError,
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
import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';

export type RuntimeProviderModelLoadAuthorizationPort = Readonly<{
  authorize(
    request: ProviderModelLoadHostRequest,
    scope?: ProviderModelLoadOperationScope,
  ): Promise<ProviderModelLoadHostAuthorizationResult>;
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



export function createRuntimeProviderProbeAuthorizationPort(input: Readonly<{
  secretSources?: TargetSecretSourcesV1;
  registry?: ProviderContributionRegistryView;
  resolveRegistry?: () => ProviderContributionRegistryView | Promise<ProviderContributionRegistryView>;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  localCandidateUrlsByConnectionId?: Parameters<typeof resolveProviderProbeAuthorization>[0]['localCandidateUrlsByConnectionId'];
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
  openTeamDirect?: Parameters<typeof resolveRuntimeProviderCredential>[0]['openTeamDirect'];
}>): Required<ProviderProbeAuthorizationPort<ProviderProbeHostAuthorizationTicket, ProviderProbeHostCredentialReference>> {
  const getAccountSettingsSnapshot = createAccountBoundProviderSnapshotReader(
    input.getAccountSettingsSnapshot,
  );
  const authorizeWithDestination = async (
    request: Parameters<ProviderProbeAuthorizationPort<ProviderProbeHostAuthorizationTicket, ProviderProbeHostCredentialReference>['authorize']>[0],
    scope?: ProviderProbeOperationScope,
  ): Promise<ProviderProbeHostAuthorizationResult> => {
    const operationScope = startProbeOperationScope(scope);
    const readSnapshot = operationScope.getAccountSettingsSnapshot ?? getAccountSettingsSnapshot;
    const resolveBindingIntent = operationScope.getAccountSettingsSnapshot
      ? operationScope.resolveManagedPurposeBindingIntent
      : operationScope.resolveManagedPurposeBindingIntent ?? input.resolveManagedPurposeBindingIntent;
    const accountCurrent = async () => !operationScope.isAccountCurrent
      || await awaitWithinProviderOperation(Promise.resolve(operationScope.isAccountCurrent()), operationScope.lifetime);
    if (!await accountCurrent()) return { ok: false, error: createProviderErrorV1('provider_authorization_changed', {
      connectionId: request.connectionId, machineId: request.machineId,
    }) };
    let registry = operationScope.registry ?? input.registry;
    if (!registry && input.resolveRegistry) {
      registry = await awaitWithinProviderOperation(
        Promise.resolve().then(() => input.resolveRegistry!()),
        operationScope.lifetime,
      );
    }
    if (!registry) throw new TypeError('Provider probe authorization requires a contribution registry');
    const snapshot = readSnapshot();
    const admittedSettingsBasis = operationScope.accountSettingsBasis;
    if (!snapshot || !admittedSettingsBasis && snapshot.providerConnectionsCatalog?.status !== 'ready') {
      return {
        ok: false,
        error: createProviderErrorV1('provider_connection_not_found', {
          connectionId: request.connectionId,
          machineId: request.machineId,
        }),
      };
    }
    if (admittedSettingsBasis && admittedSettingsBasis.scopeKey !== snapshot.scopeKey) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: request.connectionId,
          machineId: request.machineId,
        }),
      };
    }
    const settingsRead = admittedSettingsBasis
      ? admittedSettingsBasis.settingsRead
      : readProviderSettingsForCli(snapshot);
    const providerSettings = settingsRead.settings;
    if (
      admittedSettingsBasis !== undefined
      && operationScope.dnsEvidenceByConnectionId
      && !operationScope.dnsEvidenceByConnectionId.has(request.connectionId)
    ) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: request.connectionId,
          machineId: request.machineId,
        }),
      };
    }
    // Endpoint evidence belongs to the unchanged Provider row, independently
    // of a newer Account preference version.
    let dnsEvidenceByEndpointUrl = admittedSettingsBasis !== undefined
      ? operationScope.dnsEvidenceByConnectionId?.get(request.connectionId)
      : undefined;
    if (!operationScope.dnsEvidenceByConnectionId) {
      dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
        connectionId: request.connectionId,
        machineId: request.machineId,
        providerSettings,
        registry,
        ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
        lifetime: operationScope.lifetime,
      });
    }
    if (!dnsEvidenceByEndpointUrl) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: request.connectionId,
          machineId: request.machineId,
        }),
      };
    }
    let managedPurposeBindingResolution:
      QualifiedConnectedAccountPurposeBindingsV1 | undefined;
    if (request.deployment === 'managedLocal') {
      const resolution = resolveProviderConnectionForMachineFromSettingsRead({
        connectionId: request.connectionId,
        machineId: request.machineId,
        registry,
        dnsEvidenceByEndpointUrl,
        ...(input.localCandidateUrlsByConnectionId
          ? {
              localCandidateUrlsByConnectionId:
                input.localCandidateUrlsByConnectionId,
            }
          : {}),
      }, settingsRead);
      if (
        resolution.status !== 'resolved'
        || resolution.record.deployment.kind !== 'managedLocal'
        || !resolveBindingIntent
      ) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', {
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
        };
      }
      const { deployment } = resolution.record;
      try {
        managedPurposeBindingResolution = await awaitAbortableWithinProviderOperation(
          signal => resolveManagedProviderPurposeBindingSnapshot({
            implementationIdentity: deployment.implementationIdentity,
            connectedAccounts: deployment.managedRuntime.connectedAccounts ?? [],
            purposeBindingIntents: deployment.purposeBindingIntents,
            resolveBindingIntent,
            signal,
          }),
          operationScope.lifetime,
        );
      } catch (error) {
        return {
          ok: false,
          error: providerManagedPurposeBindingError(error, {
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
        };
      }
    }
    const currentSnapshot = readSnapshot();
    if (currentSnapshot?.scopeKey !== snapshot.scopeKey) {
      return {
        ok: false,
        error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: request.connectionId,
          machineId: request.machineId,
        }),
      };
    }
    const capturedSnapshot = { ...snapshot, settings: admittedSettingsBasis?.accountSettings ?? snapshot.settings };
    const authorized = resolveProviderProbeAuthorization({
      request,
      accountSettings: capturedSnapshot.settings,
      savedSecretResources: capturedSnapshot.savedSecretResources,
      savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(capturedSnapshot, {
        isCurrent: () => !operationScope.lifetime.signal?.aborted,
      }),
      providerSettings,
      settingsRead,
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
    return authorized.ok && authorized.credentialRef
      ? { ...authorized, credentialRef: { ...authorized.credentialRef, admittedSnapshot: capturedSnapshot,
        admittedOperationContext: operationScope.savedSecretOperationContext ?? undefined } }
      : authorized;
  };
  const authorize = (
    request: Parameters<typeof authorizeWithDestination>[0],
    scope?: ProviderProbeOperationScope,
  ) => observeProviderOperationPhase(scope?.lifetime, 'pre_effect_revalidation', () =>
    authorizeWithDestination(request, scope));
  const active = async (request: Readonly<{ connectionId: string; machineId: string }>, scope?: ProviderProbeOperationScope) => {
    const errorContext = { connectionId: request.connectionId, machineId: request.machineId };
    if (scope?.lifetime.signal?.aborted) throw new ProviderOperationAbandonedError('cancelled');
    const current = (scope?.getAccountSettingsSnapshot ?? getAccountSettingsSnapshot)();
    return current && (!scope?.accountSettingsBasis || current.scopeKey === scope.accountSettingsBasis.scopeKey)
      ? { ok: true as const } : { ok: false as const,
        error: createProviderErrorV1('provider_authorization_changed', errorContext) };
  };
  return Object.freeze({
    authorize,
    revalidate: async (_ticket, request, scope) => active(request, scope),
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
      const current = await active(request, scope);
      if (!current.ok) return current;
      return ticket.authorizeDestination?.(destination) ?? { ok: false,
        error: createProviderErrorV1('provider_probe_authorization_invalid', { connectionId: ticket.connectionId, machineId: ticket.machineId }) };
    },
    resolveCredential: async (credentialRef, scope) => {
      if (scope?.isAccountCurrent && !await scope.isAccountCurrent()) return {
        ok: false, error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: credentialRef.connectionId, machineId: credentialRef.machineId,
        }),
      };
      return resolveRuntimeProviderCredential({ credentialRef,
        getAccountSettingsSnapshot: scope?.getAccountSettingsSnapshot ?? getAccountSettingsSnapshot,
        operationContext: scope?.savedSecretOperationContext ?? undefined,
        signal: scope?.lifetime.signal,
        resolveSavedSecretMaterializer: scope?.resolveSavedSecretMaterializer,
        secretSources: input.secretSources,
        ...(input.openTeamDirect ? { openTeamDirect: input.openTeamDirect } : {}),
      });
    },
  });
}

export function createRuntimeProviderModelLoadAuthorizationPort(input: Readonly<{
  secretSources?: TargetSecretSourcesV1;
  registry?: ProviderContributionRegistryView;
  resolveRegistry?: () => ProviderContributionRegistryView | Promise<ProviderContributionRegistryView>;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  localCandidateUrlsByConnectionId?: Parameters<typeof resolveProviderModelLoadAuthorization>[0]['localCandidateUrlsByConnectionId'];
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  openTeamDirect?: Parameters<typeof resolveRuntimeProviderCredential>[0]['openTeamDirect'];
}>): RuntimeProviderModelLoadAuthorizationPort {
  const getAccountSettingsSnapshot = createAccountBoundProviderSnapshotReader(
    input.getAccountSettingsSnapshot,
  );
  const authorizeWithDestination = async (
    request: ProviderModelLoadHostRequest,
    scope?: ProviderModelLoadOperationScope,
  ): Promise<ProviderModelLoadHostAuthorizationResult> => {
    const operationScope = startModelLoadOperationScope(scope);
    let registry = operationScope.registry ?? input.registry;
    if (!registry && input.resolveRegistry) {
      registry = await awaitWithinProviderOperation(
        Promise.resolve().then(() => input.resolveRegistry!()),
        operationScope.lifetime,
      );
    }
    if (!registry) throw new TypeError('Provider model-load authorization requires a contribution registry');
    const snapshot = getAccountSettingsSnapshot();
    if (snapshot?.providerConnectionsCatalog?.status !== 'ready') {
      return {
        status: 'error',
        error: createProviderErrorV1('provider_connection_not_found', {
          connectionId: request.connectionId,
          machineId: request.machineId,
        }),
      };
    }
    const providerSettings = readProviderSettingsForCli(snapshot).settings;
    const dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
      connectionId: request.connectionId,
      machineId: request.machineId,
      providerSettings,
      registry,
      ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
      lifetime: operationScope.lifetime,
    });
    const currentSnapshot = getAccountSettingsSnapshot();
    if (currentSnapshot?.scopeKey !== snapshot.scopeKey) {
      return {
        status: 'error',
        error: createProviderErrorV1('provider_authorization_changed', {
          connectionId: request.connectionId,
          machineId: request.machineId,
        }),
      };
    }
    const authorized = resolveProviderModelLoadAuthorization({
      request,
      accountSettings: snapshot.settings,
      savedSecretResources: snapshot.savedSecretResources,
      savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot, {
        isCurrent: () => !operationScope.lifetime.signal?.aborted,
      }),
      providerSettings,
      registry,
      dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
    });
    return authorized.status === 'authorized' && authorized.authorization.credentialRef
      ? { ...authorized, authorization: { ...authorized.authorization,
        credentialRef: { ...authorized.authorization.credentialRef, admittedSnapshot: snapshot,
          admittedOperationContext: operationScope.savedSecretOperationContext ?? undefined } } }
      : authorized;
  };
  const authorize = (
    request: ProviderModelLoadHostRequest,
    scope?: ProviderModelLoadOperationScope,
  ) => authorizeWithDestination(request, scope);
  return Object.freeze({
    authorize,
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
      if (scope?.lifetime.signal?.aborted) throw new ProviderOperationAbandonedError('cancelled');
      if (!getAccountSettingsSnapshot()) return { ok: false,
        error: createProviderErrorV1('provider_authorization_changed', { connectionId: ticket.connectionId, machineId: ticket.machineId }) };
      return ticket.authorizeDestination?.(destination) ?? { ok: false,
        error: createProviderErrorV1('provider_probe_authorization_invalid', { connectionId: ticket.connectionId, machineId: ticket.machineId }) };
    },
    resolveCredential: async (credentialRef) => resolveRuntimeProviderCredential({
      credentialRef,
      getAccountSettingsSnapshot,
      secretSources: input.secretSources,
      ...(input.openTeamDirect ? { openTeamDirect: input.openTeamDirect } : {}),
    }),
  });
}
