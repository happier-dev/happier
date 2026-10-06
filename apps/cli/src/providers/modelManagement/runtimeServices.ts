import { randomUUID } from 'node:crypto';

import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { sameQualifiedConnectedAccountGroupRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { selectProviderRuntimeCredentialTransportV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import type { ProviderCatalogDeclarationV1, ProviderBoundModelRef, ProviderConnectionId, ProviderCredentialTransportV1, ProviderBrokerApplicationBindingV1, ProviderModelDescriptorV1, ProviderWireProtocol, PersistedBackendTargetRefV2, ProviderRuntimeStateFileV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import { projectProviderConnectionBrokerApplication } from '@/providers/broker/providerConnectionCpxBridge';
import type { DaemonProviderBindingStatusRequestV1, DaemonProviderBindingStatusResponseV1, DaemonProviderCurrentSelectionRecoveryV1, DaemonProviderModelProjectionRefreshFailureV1, DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1, DaemonProviderTeamCredentialRequestPolicySupportV1, DaemonProviderTeamCredentialRequestPolicySupportRequestV1, DaemonProviderTeamCredentialRequestPolicySupportResponseV1, DaemonProviderModelSettingsMutationRequestV1, DaemonProviderModelSettingsMutationResponseV1, DaemonProviderTeamCredentialResourceTestCandidateRequestV1, DaemonProviderTeamCredentialResourceTestCandidateResponseV1, DaemonProviderTeamCredentialBrokerEligibilityRequestV1, DaemonProviderTeamCredentialBrokerEligibilityResponseV1 } from '@happier-dev/protocol/rpc/providers';
import type { TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams';
import { DaemonProviderModelProjectionResponseV1Schema, DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema, DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { getProviderContribution } from '@/providers/registry/lookup';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { createProviderProbeHttpClient } from '@/providers/probe/client';
import { ProviderProbeAdmissionCapacityError } from '@/providers/probe/scheduler';
import { createRuntimeProviderServices } from '@/providers/probe/runtimeServices';
import type {
  RuntimeProviderOperationScope,
  RuntimeProviderPresentationResolutionBasis,
  RuntimeProviderServices,
} from '@/providers/probe/runtimeServices';
import type { ProviderRuntimeStateStore } from '@/providers/runtimeState';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import {
  createProviderModelLoadHttpPort,
  createProviderModelLoadService,
  type ProviderModelLoadRequest,
  type ProviderModelLoadResult,
} from './load';
import { createProviderModelLoadRpcHandler } from './rpc';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import {
  assembleProviderConnectionCatalog,
  projectProviderCatalogForPicker,
} from '@/providers/catalog';
import type { ProviderConnectionCatalog } from '@/providers/catalog';
import { resolveProviderModelCompatibility } from '@/providers/catalog/compatibility';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { configuration } from '@/configuration';
import type { ProviderModelSettingsMutationIntent } from '@/providers/connections';
import {
  resolveProviderSpawnAuthorization,
} from '@/providers/spawn/resolve';
import {
  resolveProviderRuntimeCatalogSelectionObservation,
} from '@/providers/spawn/runtimeCatalog';
import {
  collectProviderConnectionDnsEvidence,
  collectProviderConnectionsDnsEvidence,
} from '@/providers/registry/dnsEvidence';
import {
  awaitWithinProviderOperation,
  createProviderOperationLifetime,
  ProviderOperationAbandonedError,
} from '@/providers/operationLifetime';
import { selectCurrentProviderEndpointHealthByTemplateId } from '@/providers/connections/runtimeSummary';
import { projectProviderBrokerApplication } from '@/providers/broker/applicationProjection';
import { resolveProviderSourceFacts } from '@/providers/registry/sourceFacts';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import {
  indexAgentRoutingIdsByContributionIdentity,
  readAgentRoutingIdForContributionIdentity,
} from '@/plugins/projection/registry/agentRoutingIdentity';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import {
  resolveManagedProviderPurposeBindingSnapshot,
  type ResolveManagedProviderPurposeBindingIntent,
} from '@/providers/managed/resolvePurposeBindingSnapshot';
import {
  projectTeamCredentialSourceModelFilter,
  resolveTeamCredentialBrokerEligibility,
  resolveTeamCredentialResourceTestCandidate,
} from '@/providers/broker/resourceTestCandidate';

export type ProviderModelManagementFeatureGate = Readonly<{
  isEnabled(featureId: 'providers' | 'providers.localModelManagement'): boolean;
}>;

type TeamCredentialRequestPolicyProtocolKind =
  DaemonProviderTeamCredentialRequestPolicySupportV1['protocolKind'];

function resolveTeamCredentialRequestPolicyProtocolKind(
  protocol: ProviderWireProtocol,
): TeamCredentialRequestPolicyProtocolKind | null {
  if (protocol === 'openai-responses') return 'openai_responses';
  if (protocol === 'openai-chat') return 'openai_chat_completions';
  if (protocol === 'anthropic') return 'anthropic_messages';
  return null;
}

export function projectDaemonProviderTeamCredentialRequestPolicySupportV1(input: Readonly<{
  application: ProviderBrokerApplicationBindingV1;
  sourceRevision: string;
  descriptor: ProviderModelDescriptorV1;
}>): DaemonProviderTeamCredentialRequestPolicySupportV1 | null {
  const protocolKind = resolveTeamCredentialRequestPolicyProtocolKind(input.application.protocol);
  if (protocolKind === null) return null;

  const reasoningOption = input.descriptor.capabilities?.reasoningControls === 'supported'
    ? input.descriptor.modelOptions?.find((option) => (
        option.id === 'reasoning_effort'
        && option.type === 'select'
      ))
    : undefined;
  const reasoningValues = reasoningOption?.options?.map((option) => option.value) ?? [];
  const reasoningEffort = reasoningOption
    && reasoningValues.length > 0
    && new Set(reasoningValues).size === reasoningValues.length
    && reasoningValues.includes(reasoningOption.currentValue)
    ? {
        supported: true as const,
        allowedValues: reasoningValues,
        defaultValue: reasoningOption.currentValue,
      }
    : { supported: false as const };

  return {
    descriptor: ProviderModelDescriptorV1Schema.parse(input.descriptor),
    application: input.application,
    sourceRevision: input.sourceRevision,
    protocolKind,
    model: {
      canonicalId: input.descriptor.id,
      aliases: [...(input.descriptor.aliases ?? [])],
    },
    reasoningEffort,
  };
}

function resolveAgentRoutingIdForTarget(
  registry: Pick<ResolvedContributionRegistry, 'agentDefinitionsById'>,
  target: PersistedBackendTargetRefV2,
): string | null {
  if (target.kind === 'backend') return target.backendId;
  return readAgentRoutingIdForContributionIdentity(
    indexAgentRoutingIdsByContributionIdentity([...registry.agentDefinitionsById.values()]),
    target.identity,
  );
}

export type RuntimeProviderModelManagementServices = Readonly<{
  probe: RuntimeProviderServices['probe'];
  probeDraft: RuntimeProviderServices['probeDraft'];
  models: RuntimeProviderServices['models'];
  summary: RuntimeProviderServices['summary'];
  resolveCatalogContext: RuntimeProviderServices['resolveCatalogContext'];
  projectModels(
    request: DaemonProviderModelProjectionRequestV1,
  ): Promise<DaemonProviderModelProjectionResponseV1>;
  resolveTeamCredentialRequestPolicySupport(
    request: DaemonProviderTeamCredentialRequestPolicySupportRequestV1,
  ): Promise<DaemonProviderTeamCredentialRequestPolicySupportResponseV1>;
  resolveTeamCredentialResourceTestCandidate(
    request: DaemonProviderTeamCredentialResourceTestCandidateRequestV1,
    signal?: AbortSignal,
  ): Promise<DaemonProviderTeamCredentialResourceTestCandidateResponseV1>;
  resolveTeamCredentialBrokerEligibility(
    request: DaemonProviderTeamCredentialBrokerEligibilityRequestV1,
    signal?: AbortSignal,
  ): Promise<DaemonProviderTeamCredentialBrokerEligibilityResponseV1>;
  resolveTeamCredentialBrokerSourceSelection(request: Readonly<{
    machineId: string;
    teamId: string;
    resourceId: string;
    expectedResourceRevision: number;
    source: Extract<TeamCredentialSourceBindingV1, { kind: 'provider_connection' }>;
    application: ProviderBrokerApplicationBindingV1;
    modelId: string;
    sourceRevision: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    endpointTemplateId: string;
    protocol: ProviderWireProtocol;
    credentialTransport: ProviderCredentialTransportV1;
  }> | null>;
  mutateModelSettings(
    request: DaemonProviderModelSettingsMutationRequestV1,
  ): Promise<DaemonProviderModelSettingsMutationResponseV1>;
  resolveBindingStatus(
    request: DaemonProviderBindingStatusRequestV1,
  ): Promise<DaemonProviderBindingStatusResponseV1>;
  runtimeStore: ProviderRuntimeStateStore;
  probeInfrastructure: RuntimeProviderServices['probeInfrastructure'];
  loadModel(input: ProviderModelLoadRequest): Promise<ProviderModelLoadResult>;
  cancelModelLoad(input: ProviderModelLoadRequest): Promise<ProviderModelLoadResult>;
  rpcHandler: ReturnType<typeof createProviderModelLoadRpcHandler>;
}>;

export function resolveProviderManualModelCatalog(
  registry: ProviderContributionRegistryView,
  source: Readonly<
    | { kind: 'custom'; template: Readonly<{ catalog: ProviderCatalogDeclarationV1 }> }
    | { kind: 'contribution'; contributionKey: string }
  >,
) {
  return source.kind === 'custom'
    ? source.template.catalog
    : getProviderContribution(registry, source.contributionKey)?.definition.catalog;
}

function resolveCurrentSelectionRecovery(input: Readonly<{
  currentSelection: ProviderBoundModelRef | undefined;
  settings: ProviderSettingsV1;
  registry: ProviderContributionRegistryView;
  projectedGroups: readonly Readonly<{
    rows: readonly Readonly<{ ref: ProviderBoundModelRef }>[];
  }>[];
  machineId: string;
}>): DaemonProviderCurrentSelectionRecoveryV1 | null {
  const ref = input.currentSelection;
  if (!ref?.providerConnectionId) return null;
  const exactRowExists = input.projectedGroups.some((group) => group.rows.some((row) => (
    row.ref.agentTargetKey === ref.agentTargetKey
    && row.ref.providerConnectionId === ref.providerConnectionId
    && row.ref.modelId === ref.modelId
  )));
  if (exactRowExists) return null;

  const errorContext = { connectionId: ref.providerConnectionId, machineId: input.machineId };
  const connection = input.settings.connections.find((candidate) => candidate.id === ref.providerConnectionId);
  if (!connection) {
    const tombstone = input.settings.connectionTombstones.find((candidate) => candidate.id === ref.providerConnectionId);
    return {
      kind: tombstone ? 'connection_deleted' : 'connection_missing',
      ref,
      error: createProviderErrorV1('provider_connection_not_found', errorContext),
      displaySnapshot: tombstone ? { connectionName: tombstone.lastDisplayName, modelName: ref.modelId } : null,
    };
  }

  const contribution = connection.source.kind === 'contribution'
    ? getProviderContribution(input.registry, connection.source.contributionKey)
    : null;
  const displaySnapshot = {
    providerName: connection.source.kind === 'custom'
      ? connection.source.template.name
      : contribution?.definition.name ?? connection.displayName,
    connectionName: connection.displayName,
    modelName: ref.modelId,
  };
  if (connection.source.kind === 'contribution' && !contribution) {
    return {
      kind: 'contribution_unavailable',
      ref,
      error: createProviderErrorV1('provider_contribution_unavailable', errorContext),
      displaySnapshot,
    };
  }
  return {
    kind: 'model_not_found',
    ref,
    error: createProviderErrorV1('provider_model_not_found', errorContext),
    displaySnapshot,
  };
}

/**
 * Canonical daemon composition for provider probing, catalog reads, and the
 * explicit local-model load action. The caller supplies identity and shared
 * host owners only; endpoint, descriptor, credential, request body, and grant
 * facts are always re-derived inside the provider runtime.
 */
export function createRuntimeProviderModelManagementServices(input: Readonly<{
  machineId: string;
  featureGate: ProviderModelManagementFeatureGate;
  happyHomeDir?: string;
  registry?: ProviderContributionRegistryView;
  resolveRegistry?: () => ProviderContributionRegistryView | Promise<ProviderContributionRegistryView>;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  runtimeStore?: ProviderRuntimeStateStore;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  localCandidateUrlsByConnectionId?: Parameters<typeof createRuntimeProviderServices>[0]['localCandidateUrlsByConnectionId'];
  client?: ReturnType<typeof createProviderProbeHttpClient>;
  modelSettingsMutation(
    intent: ProviderModelSettingsMutationIntent,
  ): Promise<DaemonProviderModelSettingsMutationResponseV1>;
  acquireRuntimeLease?: () => Promise<PluginRuntimeRegistryLease>;
  localCatalogFallback?: Parameters<typeof createRuntimeProviderServices>[0]['localCatalogFallback'];
  managedCatalogRuntime?: Parameters<
    typeof createRuntimeProviderServices
  >[0]['managedCatalogRuntime'];
  resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
  openTeamDirect?: Parameters<typeof createRuntimeProviderServices>[0]['openTeamDirect'];
}>): RuntimeProviderModelManagementServices {
  const client = input.client ?? createProviderProbeHttpClient({});
  const sharedRuntime = createRuntimeProviderServices({
    machineId: input.machineId,
    featureGate: input.featureGate,
    client,
    ...(input.happyHomeDir ? { happyHomeDir: input.happyHomeDir } : {}),
    ...(input.registry ? { registry: input.registry } : {}),
    ...(input.resolveRegistry ? { resolveRegistry: input.resolveRegistry } : {}),
    ...(input.getAccountSettingsSnapshot
      ? { getAccountSettingsSnapshot: input.getAccountSettingsSnapshot }
      : {}),
    ...(input.runtimeStore ? { runtimeStore: input.runtimeStore } : {}),
    ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
    ...(input.localCatalogFallback ? { localCatalogFallback: input.localCatalogFallback } : {}),
    ...(input.managedCatalogRuntime
      ? { managedCatalogRuntime: input.managedCatalogRuntime }
      : {}),
    ...(input.resolveManagedPurposeBindingIntent
      ? {
          resolveManagedPurposeBindingIntent:
            input.resolveManagedPurposeBindingIntent,
        }
      : {}),
    ...(input.openTeamDirect ? { openTeamDirect: input.openTeamDirect } : {}),
    modelLoadEnabled: () => input.featureGate.isEnabled('providers.localModelManagement'),
  });
  const resolveManagementRegistry = async (): Promise<ProviderContributionRegistryView> => {
    if (input.registry) return input.registry;
    if (input.resolveRegistry) return input.resolveRegistry();
    const lease = input.acquireRuntimeLease
      ? await input.acquireRuntimeLease()
      : await acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir,
        });
    try {
      if (typeof lease.registry.generation !== 'number') {
        throw new TypeError('Authoritative Provider registry is missing its generation');
      }
      return resolveProviderContributionRegistryView(
        lease.registry.contributes,
        lease.registry.generation,
        lease.registry.readPluginOccurrenceId,
      );
    } finally {
      await lease.release();
    }
  };
  const service = createProviderModelLoadService({
    isFeatureEnabled: () => input.featureGate.isEnabled('providers.localModelManagement'),
    authorization: sharedRuntime.modelLoadAuthorization,
    catalog: sharedRuntime.modelLoadCatalog,
    http: createProviderModelLoadHttpPort(client),
  });
  const rpcHandler = createProviderModelLoadRpcHandler({
    machineId: input.machineId,
    loadNow: service.loadNow,
    cancelNow: service.cancelNow,
  });
  const projectModels = async (
    request: DaemonProviderModelProjectionRequestV1,
  ): Promise<DaemonProviderModelProjectionResponseV1> => {
    if (!input.featureGate.isEnabled('providers')) {
      return DaemonProviderModelProjectionResponseV1Schema.parse({
        status: 'error',
        error: createProviderErrorV1('provider_feature_disabled', { machineId: request.machineId }),
      });
    }
    if (request.machineId !== input.machineId) {
      return DaemonProviderModelProjectionResponseV1Schema.parse({
        status: 'error',
        error: createProviderErrorV1('provider_not_enabled_on_machine', { machineId: request.machineId }),
      });
    }

    const target = parseBackendTargetKeyV2(request.agentTargetKey);
    const operationLifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    const snapshot = input.getAccountSettingsSnapshot?.() ?? getActiveAccountSettingsSnapshot();
    if (!snapshot) {
      return { status: 'error', error: createProviderErrorV1('provider_settings_invalid', { machineId: request.machineId }) };
    }
    const pendingLease = input.acquireRuntimeLease
      ? input.acquireRuntimeLease()
      : acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir,
        });
    let lease: Awaited<typeof pendingLease>;
    try {
      lease = await awaitWithinProviderOperation(pendingLease, operationLifetime);
    } catch (error) {
      void pendingLease.then((lateLease) => lateLease.release(), () => {});
      if (error instanceof ProviderOperationAbandonedError) {
        return {
          status: 'error',
          error: createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: request.machineId,
          }),
        };
      }
      throw error;
    }
    try {
      if (typeof lease.registry.generation !== 'number') {
        return {
          status: 'error',
          error: createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: request.machineId,
          }),
        };
      }
      const agentId = resolveAgentRoutingIdForTarget(lease.registry.contributes, target);
      if (!agentId) {
        return {
          status: 'error',
          error: createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: request.machineId,
          }),
        };
      }
      try {
        await awaitWithinProviderOperation(
          activateAgentRuntimeContributionOnDemand(lease.registry, agentId),
          operationLifetime,
        );
      } catch (error) {
        if (error instanceof ProviderOperationAbandonedError) {
          return {
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
              machineId: request.machineId,
            }),
          };
        }
        throw error;
      }
      const adapter = readLeasedAgentProviderBindingAdapter({ lease, agentId });
      if (!adapter) return { status: 'success', agentTargetKey: request.agentTargetKey, groups: [] };
      const settingsRead = readProviderSettingsForCli(snapshot.settings);
      const registry = resolveProviderContributionRegistryView(
        lease.registry.contributes,
        lease.registry.generation,
        lease.registry.readPluginOccurrenceId,
      );
      let dnsEvidenceByConnectionId;
      try {
        dnsEvidenceByConnectionId = await collectProviderConnectionsDnsEvidence({
          connectionIds: settingsRead.settings.connections.map((connection) => connection.id),
          machineId: request.machineId,
          providerSettings: settingsRead.settings,
          registry,
          ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
          admitResolution: sharedRuntime.probeInfrastructure.scheduler.runDns,
          isCurrent: () => input.featureGate.isEnabled('providers'),
          lifetime: operationLifetime,
        });
      } catch (error) {
        if (error instanceof ProviderProbeAdmissionCapacityError) {
          return {
            status: 'error',
            error: createProviderErrorV1('provider_probe_capacity_exhausted', {
              machineId: request.machineId,
            }),
          };
        }
        if (error instanceof ProviderOperationAbandonedError) {
          return {
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
              machineId: request.machineId,
            }),
          };
        }
        throw error;
      }
      const operationScope: RuntimeProviderOperationScope = {
        registry,
        dnsEvidenceByConnectionId,
        ...(snapshot.scopeKey
          ? {
              accountSettingsBasis: {
                scopeKey: snapshot.scopeKey,
                settingsVersion: snapshot.settingsVersion,
                accountSettings: snapshot.settings,
                settingsRead,
              },
            }
          : {}),
        resolveContributedCatalogParsers: async (identity) => {
          const acquired = await lease.registry.acquireProviderCatalogParsers?.(identity);
          return acquired
            ? Object.freeze({
                parsersByFormat: acquired.parsersByFormat,
                isCurrent: () => acquired.isCurrent(),
              })
            : null;
        },
        lifetime: operationLifetime,
      };
      // One picker projection is a point-in-time Account-settings read. Reuse
      // its already-parsed Provider settings through the canonical resolver;
      // queued scheduler work still re-derives current settings at its own
      // admitted operation boundary.
      const presentationSettingsBasis: RuntimeProviderPresentationResolutionBasis = Object.freeze({
        accountSettings: snapshot.settings,
        savedSecretResources: snapshot.savedSecretResources,
        settingsRead,
      });
      const assemble = async (runtimeState: ProviderRuntimeStateFileV1) => {
        // This projection is a single point-in-time read. Index the immutable
        // runtime snapshot once, then give each connection only its own rows.
        // The canonical selectors and assemblers still make every semantic
        // decision; this only avoids rescanning machine-wide collections for
        // every connection.
        const endpointHealthByConnectionId = new Map<string, typeof runtimeState.endpointHealth>();
        const catalogsByConnectionId = new Map<string, typeof runtimeState.catalogs>();
        const modelLoadStatesByConnectionId = new Map<string, typeof runtimeState.modelLoadStates>();
        const append = <T>(index: Map<string, T[]>, connectionId: string, value: T) => {
          const rows = index.get(connectionId);
          if (rows) rows.push(value);
          else index.set(connectionId, [value]);
        };
        for (const row of runtimeState.endpointHealth) {
          append(endpointHealthByConnectionId, row.key.connectionId, row);
        }
        for (const row of runtimeState.catalogs) {
          append(catalogsByConnectionId, row.key.connectionId, row);
        }
        for (const row of runtimeState.modelLoadStates) {
          append(modelLoadStatesByConnectionId, row.key.connectionId, row);
        }
        const runtimeStateForConnection = (connectionId: string): ProviderRuntimeStateFileV1 => ({
          ...runtimeState,
          endpointHealth: endpointHealthByConnectionId.get(connectionId) ?? [],
          catalogs: catalogsByConnectionId.get(connectionId) ?? [],
          // Installation checks are contribution-wide and are not consumed by
          // picker catalog assembly.
          installationChecks: [],
          modelLoadStates: modelLoadStatesByConnectionId.get(connectionId) ?? [],
        });
        // DNS and canonical connection resolution are independent across this
        // immutable settings basis. Resolve them together; Promise.all retains
        // settings order, and no consumer queue competes with the sole probe
        // scheduler that owns later refresh admission.
        const resolvedContexts = await Promise.all(settingsRead.settings.connections.map(async (connection) => {
          const connectionRuntimeState = runtimeStateForConnection(connection.id);
          return {
            connection,
            connectionRuntimeState,
            context: await sharedRuntime.resolvePresentationCatalogContext({
              connectionId: connection.id,
              machineId: request.machineId,
            }, connectionRuntimeState, operationScope, presentationSettingsBasis),
          };
        }));
        const catalogs: ProviderConnectionCatalog[] = [];
        const modelLoadProjectionByConnectionId = new Map<string, Readonly<{
          action: 'available' | 'descriptor_absent' | 'feature_disabled';
          preflightPolicy: 'advisory' | 'required' | null;
        }>>();
        const confirmedByRef = new Map<string, boolean>();
        const resolvedConnectionById = new Map<string, Parameters<typeof projectProviderBrokerApplication>[0]['connection']>();
        const pickerDemand: Array<Readonly<{
          connectionId: ProviderConnectionId;
          machineId: string;
        }>> = [];
        const coldDemand: Array<Readonly<{
          connectionId: ProviderConnectionId;
          machineId: string;
        }>> = [];
        for (const { connection, connectionRuntimeState, context } of resolvedContexts) {
          if (context.status === 'error') continue;
          if (request.providerConnection && (
            connection.id !== request.providerConnection.connectionId
            || context.connection.connectionSecurityFingerprint
              !== request.providerConnection.expectedConnectionSecurityFingerprint
          )) continue;
          if (request.connectedAccountTarget) {
            if (context.connection.deployment.kind !== 'managedLocal') continue;
            const expectedTarget = request.connectedAccountTarget;
            const expectedConsumer = request.application?.implementationIdentity
              ?? context.connection.deployment.implementationIdentity;
            const targetMatches = context.connection.deployment.purposeBindingIntents.bindings.some((binding) => {
              if (
                binding.purpose.consumer.pluginId !== expectedConsumer.pluginId
                || binding.purpose.consumer.localId !== expectedConsumer.localId
                || binding.target.kind !== expectedTarget.kind
              ) return false;
              return expectedTarget.kind === 'account'
                ? binding.target.kind === 'account'
                  && sameQualifiedConnectedAccountRef(binding.target.account, expectedTarget.account)
                : binding.target.kind === 'group'
                  && sameQualifiedConnectedAccountGroupRef(binding.target, expectedTarget);
            });
            if (!targetMatches) continue;
          }
          resolvedConnectionById.set(connection.id, context.connection);
          const authorizedForDemand = context.connection.authorization.authorized;
          if (authorizedForDemand) {
            pickerDemand.push({
              connectionId: connection.id,
              machineId: request.machineId,
            });
          }
          const modelLoadDescriptor =
            context.connection.source.kind === 'contribution'
              ? context.connection.source.definition.modelLoad
              : undefined;
          modelLoadProjectionByConnectionId.set(connection.id, {
            action: modelLoadDescriptor
              ? input.featureGate.isEnabled('providers.localModelManagement')
                ? 'available'
                : 'feature_disabled'
              : 'descriptor_absent',
            preflightPolicy: modelLoadDescriptor?.preflightPolicy ?? null,
          });
          // The recovery-row decision belongs to the catalog assembler, so this
          // first pass carries the same current selection: whatever it retains is
          // exactly what needs compatibility, and nothing re-derives the rule.
          const recoveryInput = {
            ...(request.currentSelection
              ? { currentSelectionForRecovery: request.currentSelection }
              : {}),
            agentSupportsFreeformModelIds: adapter.support.supportsFreeformModelIds,
          };
          const initial = assembleProviderConnectionCatalog({
            agentTargetKey: request.agentTargetKey,
            connection: context.connection,
            providerSettings: context.providerSettings,
            runtimeState: connectionRuntimeState,
            catalogRuntimeKey: context.catalogRuntimeKey,
            ...recoveryInput,
          });
          const compatibilityByModelId = new Map(
            [...initial.rows, ...initial.staleRows]
              .map((row) => row.descriptor)
              .map((descriptor) => {
              const compatibility = resolveProviderModelCompatibility({
                record: context.connection,
                providerSettings: context.providerSettings,
                agentTargetKey: request.agentTargetKey,
                support: adapter.support,
                adapterVersion: adapter.adapter.adapterVersion,
                model: descriptor,
              });
              confirmedByRef.set(`${connection.id}\0${descriptor.id}`, compatibility.confirmed);
              return [descriptor.id, compatibility] as const;
            }),
          );
          const currentEndpointHealthByTemplateId = selectCurrentProviderEndpointHealthByTemplateId({
            machineId: request.machineId,
            connectionId: connection.id,
            expectedEndpoints: context.expectedEndpointObservations,
            allowedObservationAuthorizationFingerprints: context.allowedObservationAuthorizationFingerprints,
            endpointHealth: connectionRuntimeState.endpointHealth,
          });
          const assembled = assembleProviderConnectionCatalog({
            agentTargetKey: request.agentTargetKey,
            connection: context.connection,
            providerSettings: context.providerSettings,
            runtimeState: connectionRuntimeState,
            catalogRuntimeKey: context.catalogRuntimeKey,
            compatibilityByModelId,
            currentEndpointHealthByTemplateId,
            ...recoveryInput,
          });
          catalogs.push(assembled);
          // A connection with no probe observation yet AND no row to show contributes
          // nothing to the picker: returning now is the silently empty list. Anything
          // that already probed — even to an empty or incompatible catalog — is warm and
          // stays advisory, so a failing endpoint never blocks a later read.
          if (authorizedForDemand
            && assembled.rows.length === 0
            && (context.catalogRuntimeRecord?.state.snapshot ?? null) === null) {
            coldDemand.push({ connectionId: connection.id, machineId: request.machineId });
          }
        }
        return { catalogs, modelLoadProjectionByConnectionId, confirmedByRef, resolvedConnectionById, pickerDemand, coldDemand };
      };

      let assembly = await assemble(await sharedRuntime.runtimeStore.read());
      // A cold automatic read must wait because it has no rows to show. An
      // explicit user Retry waits for every eligible connection and enters the
      // scheduler's existing forced branch; no consumer retry loop or cache is
      // introduced here.
      const awaitedDemand = request.refreshPolicy === 'current_only'
        ? []
        : request.forceRefresh ? assembly.pickerDemand : assembly.coldDemand;
      const refreshFailures: DaemonProviderModelProjectionRefreshFailureV1[] = [];
      if (awaitedDemand.length > 0) {
        const outcomes = await Promise.all(awaitedDemand.map(async (identity) => ({
          identity,
          error: await sharedRuntime.scheduleDemandRefresh(
            identity,
            request.forceRefresh ? 'manual_refresh' : 'picker_open',
            operationScope,
          ),
        })));
        for (const outcome of outcomes) {
          if (outcome.error !== null) {
            refreshFailures.push({ connectionId: outcome.identity.connectionId, error: outcome.error });
          }
        }
        assembly = await assemble(await sharedRuntime.runtimeStore.read());
      }
      const { catalogs, modelLoadProjectionByConnectionId, confirmedByRef, resolvedConnectionById, pickerDemand } = assembly;
      const awaitedConnectionIds = new Set(awaitedDemand.map((identity) => identity.connectionId));
      const projection = projectProviderCatalogForPicker({
        catalogs,
        modelVisibilityByRef: settingsRead.settings.modelVisibilityByRef,
        mode: request.mode ?? 'picker',
        ...(request.currentSelection ? { currentSelection: request.currentSelection } : {}),
      });
      const catalogByConnectionId = new Map(
        catalogs.map((catalog) => [catalog.connectionId, catalog] as const),
      );
      const connectionById = new Map(
        settingsRead.settings.connections.map((connection) => [connection.id, connection] as const),
      );
      const groups = projection.groups.map((group) => {
          const catalog = catalogByConnectionId.get(group.connectionId);
          if (!catalog) throw new TypeError('Projected Provider catalog is absent');
          const connection = connectionById.get(group.connectionId);
          if (!connection) throw new TypeError('Projected Provider connection is absent');
          const resolvedConnection = resolvedConnectionById.get(group.connectionId);
          if (!resolvedConnection) throw new TypeError('Resolved Provider connection is absent');
          const sourceAuthority = resolvedConnection.source.kind === 'contribution'
            ? {
                provider: {
                  identity: {
                    pluginId: resolvedConnection.source.pluginId,
                    localId: resolvedConnection.source.definition.id,
                  },
                  definitionRevision: resolvedConnection.source.definition.v,
                },
                connectionSecurityFingerprint: resolvedConnection.connectionSecurityFingerprint,
              } as const
            : null;
          const sourceRevision = computeCanonicalDomainSeparatedDigest(
            'happier.team-credential-provider-model-catalog.v1',
            [
              resolvedConnection.connectionSecurityFingerprint,
              resolvedConnection.endpointSetFingerprint,
              String(connection.revision),
              resolvedConnection.source.kind === 'contribution'
                ? registry.providerActivationOccurrenceIdsByPluginId?.get(
                    resolvedConnection.source.pluginId,
                  ) ?? 'no-provider-activation-occurrence'
                : 'custom-provider',
              JSON.stringify(group.rows.map((row) => ({
                descriptor: row.descriptor,
                catalog: row.presentation.catalog,
                compatibilityFingerprint: row.presentation.compatibility?.compatibilityFingerprint ?? null,
                selectedProtocol: row.presentation.compatibility?.result.status === 'incompatible'
                  ? null
                  : row.presentation.compatibility?.result.selectedProtocol ?? null,
              }))),
            ],
          );
          return {
            connectionId: group.connectionId,
            providerName: group.providerName,
            connectionName: group.connectionName,
            connectionRole: catalog.connectionRole,
            connectionDisplayNameMode: catalog.connectionDisplayNameMode,
            connectionRevision: connection.revision,
            ...(sourceAuthority ? { sourceAuthority } : {}),
            sourceRevision,
            modelLoadAction:
              modelLoadProjectionByConnectionId.get(group.connectionId)?.action
              ?? 'descriptor_absent',
            modelLoadPreflightPolicy:
              modelLoadProjectionByConnectionId.get(group.connectionId)
                ?.preflightPolicy
              ?? null,
            authorization: group.authorization.authorized
              ? { authorized: true as const }
              : { authorized: false as const, error: createProviderErrorV1(group.authorization.errorCode, {
                  connectionId: group.connectionId, machineId: request.machineId,
                }) },
            manualModelPolicy: catalog.manualModelPolicy,
            supportsFreeformModelIds: adapter.support.supportsFreeformModelIds,
            suppressedConnectedServiceIds: adapter.support.authIsolation.suppressConnectedServiceIds,
            rows: group.rows.map((row) => {
              const brokeredProviderConnection = request.providerConnection !== undefined
                && request.includeDirectMaterialization !== true;
              const selectedProtocol = row.presentation.compatibility!.result.status === 'incompatible'
                ? null
                : row.presentation.compatibility!.result.selectedProtocol;
              const sourceApplication = selectedProtocol
                ? projectProviderBrokerApplication({
                    connection: resolvedConnection,
                    agentTargetKey: request.agentTargetKey,
                    protocol: selectedProtocol,
                    ...(!brokeredProviderConnection && request.application
                      ? { expectedApplication: request.application }
                      : {}),
                  })
                : null;
              // A Team Provider Connection keeps the external Provider as the
              // endpoint/catalog/credential authority, but the executable on
              // the broker Machine is the existing managed CLIProxyAPI
              // gateway. Publishing the source Provider identity here made
              // the canonical source opener reject every otherwise-valid
              // broker request. Project the executable application once at
              // this owner and still bind it to the source-selected protocol.
              const application = sourceApplication && brokeredProviderConnection
                ? projectProviderConnectionBrokerApplication({
                    registry,
                    agentTargetKey: request.agentTargetKey,
                    protocol: sourceApplication.protocol,
                  })
                : sourceApplication;
              const exactApplication = application && request.application
                && !pluginJsonValuesEqual(application, request.application)
                ? null
                : application;
              const requestPolicySupport = request.includeTeamCredentialRequestPolicySupport
                && exactApplication
                ? projectDaemonProviderTeamCredentialRequestPolicySupportV1({
                    application: exactApplication,
                    sourceRevision,
                    descriptor: row.descriptor,
                  })
                : null;
              const sourceFacts = resolveProviderSourceFacts(resolvedConnection);
              const directEndpoint = selectedProtocol && resolvedConnection.deployment.kind !== 'managedLocal'
                ? resolvedConnection.endpoints.find((candidate) => candidate.protocol === selectedProtocol)
                : null;
              const directCredentialTransport = selectedProtocol && sourceFacts.credential && directEndpoint
                ? selectProviderRuntimeCredentialTransportV1({
                    transports: sourceFacts.credential.transports,
                    protocol: selectedProtocol,
                    agent: adapter.support,
                  })
                : null;
              return ({
              ref: row.ref,
              descriptor: row.descriptor,
              ...(exactApplication ? { application: exactApplication } : {}),
              ...(requestPolicySupport ? { requestPolicySupport } : {}),
              ...(request.includeDirectMaterialization && directEndpoint && directCredentialTransport ? {
                directMaterialization: {
                  endpoint: {
                    endpointTemplateId: directEndpoint.endpointTemplateId,
                    normalizedUrl: directEndpoint.normalizedUrl,
                    protocol: directEndpoint.protocol,
                    publicHeaders: directEndpoint.publicHeaders,
                  },
                  credentialTransport: directCredentialTransport,
                },
              } : {}),
              sources: row.sources,
              confidence: row.confidence,
              compatibility: {
                result: row.presentation.compatibility!.result,
                compatibilityFingerprint: row.presentation.compatibility!.compatibilityFingerprint,
                confirmed: confirmedByRef.get(`${group.connectionId}\0${row.ref.modelId}`) ?? false,
              },
              endpointHealth: row.presentation.endpointHealth?.status ?? 'not_checked',
              catalog: row.presentation.catalog,
              loadState: row.presentation.loadState,
              visibility: row.visibility,
              });
            }).filter((row) => !request.application || (
              row.application?.agentTargetKey === request.application.agentTargetKey
              && row.application.implementationIdentity.pluginId === request.application.implementationIdentity.pluginId
              && row.application.implementationIdentity.localId === request.application.implementationIdentity.localId
              && row.application.endpointTemplateId === request.application.endpointTemplateId
              && row.application.protocol === request.application.protocol
            )),
          };
        });
      const currentSelectionRecovery = resolveCurrentSelectionRecovery({
        currentSelection: request.currentSelection,
        settings: settingsRead.settings,
        registry,
        projectedGroups: groups,
        machineId: request.machineId,
      });
      // Warm connections already render from their cached observation, so their
      // refresh goes straight to the sole probe scheduler, which owns admission,
      // coalescing and the typed capacity refusal. A consumer-side queue here would be
      // a second work owner retaining work the canonical scheduler already refused.
      if (request.refreshPolicy !== 'current_only') {
        for (const identity of pickerDemand) {
          if (awaitedConnectionIds.has(identity.connectionId)) continue;
          void sharedRuntime.scheduleDemandRefresh(identity, 'picker_open', operationScope);
        }
      }
      return DaemonProviderModelProjectionResponseV1Schema.parse({
        status: 'success',
        agentTargetKey: request.agentTargetKey,
        groups,
        currentSelectionRecovery,
        ...(refreshFailures.length > 0 ? { refreshFailures } : {}),
      });
    } finally {
      await lease.release();
    }
  };

  const resolveAgentTargetKeys = async (): Promise<string[]> => {
    const lease = await (input.acquireRuntimeLease
      ? input.acquireRuntimeLease()
      : acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir,
        }));
    try {
      return [...lease.registry.contributes.agentDefinitionsById.values()]
        .flatMap((agent) => agent.identity
          ? [buildBackendTargetKeyV2({ kind: 'agent', identity: agent.identity })]
          : []);
    } finally {
      await lease.release();
    }
  };

  const resolveTeamCredentialRequestPolicySupport: RuntimeProviderModelManagementServices['resolveTeamCredentialRequestPolicySupport'] = async (request) => {
    const agentTargetKeys = await resolveAgentTargetKeys();
    if (agentTargetKeys.length === 0) {
      return { status: 'unavailable', reason: 'application_unavailable' };
    }
    const models = new Map<string, DaemonProviderTeamCredentialRequestPolicySupportV1>();
    let sourceFound = false;
    let applicationFound = false;
    for (const agentTargetKey of [...new Set(agentTargetKeys)].sort()) {
      const projection = await projectModels({
        machineId: request.machineId,
        agentTargetKey,
        includeTeamCredentialRequestPolicySupport: true,
        ...(request.refreshPolicy ? { refreshPolicy: request.refreshPolicy } : {}),
        ...projectTeamCredentialSourceModelFilter(request.source),
      });
      if (projection.status !== 'success') continue;
      for (const group of projection.groups) {
        if (!group.authorization.authorized || !group.sourceRevision) continue;
        sourceFound = true;
        for (const row of group.rows) {
          if (row.application) applicationFound = true;
          if (row.visibility !== 'visible'
            || row.catalog.stale
            || row.compatibility.result.status === 'incompatible'
            || (row.compatibility.result.status === 'experimental' && !row.compatibility.confirmed)
            || !row.requestPolicySupport) continue;
          const support = row.requestPolicySupport;
          models.set(JSON.stringify([
            support.application,
            support.sourceRevision,
            support.model.canonicalId,
          ]), support);
        }
      }
    }
    if (models.size > 0) {
      return { status: 'success', models: [...models.values()] };
    }
    return {
      status: 'unavailable',
      reason: !sourceFound
        ? 'source_unavailable'
        : !applicationFound
          ? 'application_unavailable'
          : 'model_unavailable',
    };
  };

  const resolveResourceTestCandidate = async (
    request: DaemonProviderTeamCredentialResourceTestCandidateRequestV1,
    signal?: AbortSignal,
  ): Promise<DaemonProviderTeamCredentialResourceTestCandidateResponseV1> => {
    if (!input.featureGate.isEnabled('providers') || request.machineId !== input.machineId) {
      return { status: 'unavailable', reason: 'source_unavailable' };
    }
    const agentTargetKeys = await resolveAgentTargetKeys();
    const candidate = await resolveTeamCredentialResourceTestCandidate({
      machineId: request.machineId,
      teamId: request.teamId,
      resourceId: request.resourceId,
      expectedResourceRevision: request.expectedResourceRevision,
      source: request.source,
      agentTargetKeys,
      projectModels: projectionRequest => projectModels({
        ...projectionRequest,
        ...(request.refreshPolicy === 'current_only' ? { refreshPolicy: 'current_only' as const } : {}),
      }),
      createRequestId: randomUUID,
      ...(signal ? { signal } : {}),
    });
    return DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema.parse(candidate
      ? { status: 'success', ...candidate }
      : {
          status: 'unavailable',
          reason: agentTargetKeys.length === 0 ? 'application_unavailable' : 'model_unavailable',
        });
  };

  const resolveBrokerEligibility = async (
    request: DaemonProviderTeamCredentialBrokerEligibilityRequestV1,
    signal?: AbortSignal,
  ): Promise<DaemonProviderTeamCredentialBrokerEligibilityResponseV1> => {
    const projectCurrentModels = (projectionRequest: DaemonProviderModelProjectionRequestV1) => (
      projectModels({ ...projectionRequest, refreshPolicy: 'current_only' })
    );
    const result = 'scope' in request
      ? await resolveTeamCredentialBrokerEligibility({
          ...request,
          agentTargetKeys: await resolveAgentTargetKeys(),
          projectModels: projectCurrentModels,
          ...(signal ? { signal } : {}),
        })
      : await resolveTeamCredentialBrokerEligibility({
          ...request,
          projectModels: projectCurrentModels,
          ...(signal ? { signal } : {}),
        });
    return DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema.parse(result);
  };

  const resolveBrokerSourceSelection: RuntimeProviderModelManagementServices['resolveTeamCredentialBrokerSourceSelection'] = async (request) => {
    request.signal.throwIfAborted();
    const projection = await projectModels({
      machineId: request.machineId,
      agentTargetKey: request.application.agentTargetKey,
      providerConnection: {
        connectionId: request.source.connectionId,
        expectedConnectionSecurityFingerprint: request.source.connectionSecurityFingerprint,
      },
      includeDirectMaterialization: true,
      refreshPolicy: 'current_only',
    });
    request.signal.throwIfAborted();
    if (projection.status !== 'success') return null;
    const registry = await resolveManagementRegistry();
    const candidates = projection.groups.flatMap((group) => {
      if (
        group.connectionId !== request.source.connectionId
        || group.sourceRevision !== request.sourceRevision
        || !group.authorization.authorized
      ) return [];
      return group.rows.flatMap((row) => {
        if (
          row.ref.modelId !== request.modelId
          || !row.application
          || !row.directMaterialization
        ) return [];
        const brokerApplication = projectProviderConnectionBrokerApplication({
          registry,
          agentTargetKey: request.application.agentTargetKey,
          protocol: row.application.protocol,
        });
        if (!brokerApplication || !pluginJsonValuesEqual(brokerApplication, request.application)) return [];
        return [{
          endpointTemplateId: row.directMaterialization.endpoint.endpointTemplateId,
          protocol: row.directMaterialization.endpoint.protocol,
          credentialTransport: row.directMaterialization.credentialTransport,
        }];
      });
    });
    return candidates.length === 1 ? Object.freeze(candidates[0]!) : null;
  };

  const mutateModelSettings = async (
    request: DaemonProviderModelSettingsMutationRequestV1,
  ): Promise<DaemonProviderModelSettingsMutationResponseV1> => {
    const context = 'connectionId' in request
      ? { connectionId: request.connectionId, machineId: request.machineId }
      : { machineId: request.machineId };
    if (!input.featureGate.isEnabled('providers')) {
      return { status: 'error', error: createProviderErrorV1('provider_feature_disabled', context) };
    }
    if (request.machineId !== input.machineId) {
      return { status: 'error', error: createProviderErrorV1('provider_not_enabled_on_machine', context) };
    }

    if (request.action === 'manualAdd') {
      const snapshot = input.getAccountSettingsSnapshot?.() ?? getActiveAccountSettingsSnapshot();
      const read = snapshot ? readProviderSettingsForCli(snapshot.settings) : null;
      const connection = read?.settings.connections.find((candidate) => candidate.id === request.connectionId);
      if (!connection) {
        return { status: 'error', error: createProviderErrorV1('provider_connection_not_found', context) };
      }
      if (connection.revision !== request.expectedConnectionRevision) {
        return { status: 'error', error: createProviderErrorV1('provider_connection_changed', context) };
      }
      const catalog = resolveProviderManualModelCatalog(
        await resolveManagementRegistry(),
        connection.source,
      );
      if (!catalog || catalog.manualModelPolicy !== 'allowed') {
        return { status: 'error', error: createProviderErrorV1('provider_model_not_found', context) };
      }
      const expectedManualSource: Readonly<
        { kind: 'custom' } | { kind: 'contribution'; contributionKey: string }
      > = connection.source.kind === 'custom'
        ? { kind: 'custom' }
        : { kind: 'contribution', contributionKey: connection.source.contributionKey };
      return input.modelSettingsMutation({ ...request, expectedManualSource });
    }

    if (request.action === 'confirmExperimental') {
      const projection = await projectModels({
        machineId: request.machineId,
        agentTargetKey: request.agentTargetKey,
      });
      if (projection.status === 'error') return projection;
      const group = projection.groups.find((candidate) => candidate.connectionId === request.connectionId);
      const row = group?.rows.find((candidate) =>
        candidate.compatibility.result.status === 'experimental'
        && candidate.compatibility.compatibilityFingerprint === request.compatibilityFingerprint
        && candidate.compatibility.result.confirmationScope.kind === (request.modelId === null ? 'connection' : 'model')
        && (request.modelId === null || candidate.ref.modelId === request.modelId));
      if (!group) {
        return { status: 'error', error: createProviderErrorV1('provider_compatibility_unverified', context) };
      }
      if (group.connectionRevision !== request.expectedConnectionRevision) {
        return { status: 'error', error: createProviderErrorV1('provider_connection_changed', context) };
      }
      if (!row) {
        return { status: 'error', error: createProviderErrorV1('provider_compatibility_unverified', context) };
      }
    }

    return input.modelSettingsMutation(request);
  };

  const resolveBindingStatus = async (
    request: DaemonProviderBindingStatusRequestV1,
  ): Promise<DaemonProviderBindingStatusResponseV1> => {
    const connectionId = request.selection.ref.providerConnectionId;
    const errorContext = { ...(connectionId ? { connectionId } : {}), machineId: request.machineId };
    if (!input.featureGate.isEnabled('providers')) {
      return {
        status: 'disabled',
        error: createProviderErrorV1('provider_feature_disabled', errorContext),
      };
    }
    if (request.machineId !== input.machineId || connectionId === null) {
      return {
        status: 'disabled',
        error: createProviderErrorV1('provider_not_enabled_on_machine', errorContext),
      };
    }
    const snapshot = input.getAccountSettingsSnapshot?.() ?? getActiveAccountSettingsSnapshot();
    if (!snapshot) {
      return {
        status: 'connection_missing',
        error: createProviderErrorV1('provider_connection_not_found', errorContext),
      };
    }
    const target = parseBackendTargetKeyV2(request.agentTargetKey);
    const operationLifetime = createProviderOperationLifetime({
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
    });
    const pendingLease = input.acquireRuntimeLease
      ? input.acquireRuntimeLease()
      : acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir,
        });
    let lease: Awaited<typeof pendingLease>;
    try {
      lease = await awaitWithinProviderOperation(pendingLease, operationLifetime);
    } catch (error) {
      void pendingLease.then((lateLease) => lateLease.release(), () => {});
      if (error instanceof ProviderOperationAbandonedError) {
        return {
          status: 'incompatible',
          error: createProviderErrorV1('provider_endpoint_unavailable', errorContext),
        };
      }
      throw error;
    }
    try {
      if (typeof lease.registry.generation !== 'number') {
        return {
          status: 'incompatible',
          error: createProviderErrorV1('provider_endpoint_unavailable', errorContext),
        };
      }
      const agentId = resolveAgentRoutingIdForTarget(lease.registry.contributes, target);
      if (!agentId) {
        return {
          status: 'incompatible',
          error: createProviderErrorV1('provider_endpoint_unavailable', errorContext),
        };
      }
      try {
        await awaitWithinProviderOperation(
          activateAgentRuntimeContributionOnDemand(lease.registry, agentId),
          operationLifetime,
        );
      } catch (error) {
        if (error instanceof ProviderOperationAbandonedError) {
          return {
            status: 'incompatible',
            error: createProviderErrorV1('provider_endpoint_unavailable', errorContext),
          };
        }
        throw error;
      }
      const registry = resolveProviderContributionRegistryView(
        lease.registry.contributes,
        lease.registry.generation,
        lease.registry.readPluginOccurrenceId,
      );
      const providerSettings = readProviderSettingsForCli(snapshot.settings).settings;
      let dnsEvidenceByEndpointUrl;
      try {
        dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
          connectionId,
          machineId: request.machineId,
          providerSettings,
          registry,
          ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
          admitResolution: sharedRuntime.probeInfrastructure.scheduler.runDns,
          isCurrent: () => input.featureGate.isEnabled('providers'),
          lifetime: operationLifetime,
        });
      } catch (error) {
        if (error instanceof ProviderProbeAdmissionCapacityError) {
          return {
            status: 'incompatible',
            error: createProviderErrorV1('provider_probe_capacity_exhausted', errorContext),
          };
        }
        if (error instanceof ProviderOperationAbandonedError) {
          const unavailable = createProviderErrorV1('provider_endpoint_unavailable', errorContext);
          return { status: 'incompatible', error: unavailable };
        }
        throw error;
      }
      const connectionResolution = resolveProviderConnectionForMachine({
        connectionId,
        machineId: request.machineId,
        accountSettings: snapshot.settings,
        registry,
        dnsEvidenceByEndpointUrl,
      });
      let managedPurposeBindingSnapshot:
        import('@happier-dev/protocol').QualifiedConnectedAccountPurposeBindingsV1
        | undefined;
      let managedProviderRuntime:
        import('@/plugins/projection/registry/types')
          .ResolvedManagedProviderRuntime
        | undefined;
      if (
        connectionResolution.status === 'resolved'
        && connectionResolution.record.deployment.kind === 'managedLocal'
      ) {
        if (!input.resolveManagedPurposeBindingIntent) {
          const error = createProviderErrorV1(
            'provider_connection_invalid',
            errorContext,
          );
          return { status: 'incompatible', error };
        }
        try {
          managedPurposeBindingSnapshot =
            await resolveManagedProviderPurposeBindingSnapshot({
              implementationIdentity:
                connectionResolution.record.deployment.implementationIdentity,
              connectedAccounts:
                connectionResolution.record.deployment.managedRuntime
                  .connectedAccounts,
              purposeBindingIntents:
                connectionResolution.record.deployment.purposeBindingIntents,
              resolveBindingIntent: input.resolveManagedPurposeBindingIntent,
            });
          managedProviderRuntime =
            await lease.registry.acquireManagedProviderRuntime?.(
              connectionResolution.record.deployment
                .implementationIdentity,
            ) ?? undefined;
          if (!managedProviderRuntime?.isCurrent()) {
            throw new Error('Managed Provider runtime is unavailable');
          }
        } catch {
          const error = createProviderErrorV1(
            'provider_connection_invalid',
            errorContext,
          );
          return { status: 'incompatible', error };
        }
      }
      const runtimeCatalogSelection = await resolveProviderRuntimeCatalogSelectionObservation({
        selection: request.selection,
        machineId: request.machineId,
        accountSettings: snapshot.settings,
        savedSecretResources: snapshot.savedSecretResources,
        providerSettings,
        registry,
        dnsEvidenceByEndpointUrl,
        runtimeStateStore: sharedRuntime.runtimeStore,
        ...(input.resolveManagedPurposeBindingIntent
          ? {
              resolveManagedPurposeBindingIntent:
                input.resolveManagedPurposeBindingIntent,
            }
          : {}),
        ...(managedPurposeBindingSnapshot
          ? { managedPurposeBindingSnapshot }
          : {}),
      });
      const resolved = resolveProviderSpawnAuthorization({
        selection: request.selection,
        machineId: request.machineId,
        agentTargetKey: request.agentTargetKey,
        agentId,
        accountSettings: snapshot.settings,
        providerSettings,
        registry,
        dnsEvidenceByEndpointUrl,
        lease,
        ...(managedProviderRuntime ? { managedProviderRuntime } : {}),
        ...(managedPurposeBindingSnapshot
          ? { managedPurposeBindingSnapshot }
          : {}),
        ...(runtimeCatalogSelection?.model
          ? { runtimeModelDescriptor: runtimeCatalogSelection.model }
          : {}),
        ...(runtimeCatalogSelection !== null
          ? { runtimeCatalogSnapshotExists: true }
          : {}),
      });
      if (resolved.ok) {
        return resolved.authorization.bindingSecurityFingerprint === request.launchBinding.bindingSecurityFingerprint
          ? { status: 'current' }
          : {
              status: 'changed',
              nextBindingSecurityFingerprint: resolved.authorization.bindingSecurityFingerprint,
            };
      }
      const error = resolved.error;
      switch (error.code) {
        case 'provider_connection_not_found':
          return { status: 'connection_missing', error };
        case 'provider_contribution_unavailable':
          return { status: 'contribution_unavailable', error };
        case 'provider_account_grant_stale':
        case 'provider_machine_grant_stale':
        case 'provider_authorization_changed':
        case 'provider_binding_changed':
          return { status: 'grant_stale', error };
        case 'provider_connection_disabled':
        case 'provider_not_enabled_on_machine':
        case 'provider_secret_missing':
        case 'provider_feature_disabled':
          return { status: 'disabled', error };
        default:
          return { status: 'incompatible', error };
      }
    } finally {
      await lease.release();
    }
  };

  return Object.freeze({
    probe: sharedRuntime.probe,
    probeDraft: sharedRuntime.probeDraft,
    models: sharedRuntime.models,
    summary: sharedRuntime.summary,
    resolveCatalogContext: sharedRuntime.resolveCatalogContext,
    projectModels,
    resolveTeamCredentialRequestPolicySupport,
    resolveTeamCredentialResourceTestCandidate: resolveResourceTestCandidate,
    resolveTeamCredentialBrokerEligibility: resolveBrokerEligibility,
    resolveTeamCredentialBrokerSourceSelection: resolveBrokerSourceSelection,
    mutateModelSettings,
    resolveBindingStatus,
    runtimeStore: sharedRuntime.runtimeStore,
    probeInfrastructure: sharedRuntime.probeInfrastructure,
    loadModel: service.loadNow,
    cancelModelLoad: service.cancelNow,
    rpcHandler,
  });
}
