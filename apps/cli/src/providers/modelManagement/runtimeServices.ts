import {
  createProviderErrorV1,
  parseBackendTargetKeyV2,
  type ProviderCatalogDeclarationV1,
  type ProviderBoundModelRef,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';
import type {
  DaemonProviderBindingStatusRequestV1,
  DaemonProviderBindingStatusResponseV1,
  DaemonProviderCurrentSelectionRecoveryV1,
  DaemonProviderModelProjectionRequestV1,
  DaemonProviderModelProjectionResponseV1,
  DaemonProviderModelSettingsMutationRequestV1,
  DaemonProviderModelSettingsMutationResponseV1,
} from '@happier-dev/protocol/rpc';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { getProviderContribution } from '@/providers/registry/lookup';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { createProviderProbeHttpClient } from '@/providers/probe/client';
import { createRuntimeProviderServices } from '@/providers/probe/runtimeServices';
import type { RuntimeProviderServices } from '@/providers/probe/runtimeServices';
import { PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS } from '@/providers/probe/scheduler';
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
import { assembleProviderConnectionCatalog, projectProviderCatalogForPicker } from '@/providers/catalog';
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
import { collectProviderConnectionDnsEvidence } from '@/providers/registry/dnsEvidence';
import { selectCurrentProviderEndpointHealthByTemplateId } from '@/providers/connections/runtimeSummary';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import {
  resolveManagedProviderPurposeBindingSnapshot,
  type ResolveManagedProviderPurposeBindingIntent,
} from '@/providers/managed/resolvePurposeBindingSnapshot';

export type ProviderModelManagementFeatureGate = Readonly<{
  isEnabled(featureId: 'providers' | 'providers.localModelManagement'): boolean;
}>;

export type RuntimeProviderModelManagementServices = Readonly<{
  probe: RuntimeProviderServices['probe'];
  probeDraft: RuntimeProviderServices['probeDraft'];
  models: RuntimeProviderServices['models'];
  summary: RuntimeProviderServices['summary'];
  resolveCatalogContext: RuntimeProviderServices['resolveCatalogContext'];
  projectModels(
    request: DaemonProviderModelProjectionRequestV1,
  ): Promise<DaemonProviderModelProjectionResponseV1>;
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
      return resolveProviderContributionRegistryView(lease.registry.contributes);
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
  const schedulePickerDemandRefreshes = (
    identities: readonly Readonly<{ connectionId: string; machineId: string }>[],
  ): void => {
    let nextIdentityIndex = 0;
    const refreshNext = async (): Promise<void> => {
      for (;;) {
        const identity = identities[nextIdentityIndex];
        nextIdentityIndex += 1;
        if (!identity) return;
        await sharedRuntime.scheduleDemandRefresh(identity, 'picker_open');
      }
    };
    void Promise.all(Array.from(
      { length: Math.min(PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS, identities.length) },
      refreshNext,
    )).catch(() => undefined);
  };

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
    const snapshot = input.getAccountSettingsSnapshot?.() ?? getActiveAccountSettingsSnapshot();
    if (!snapshot) {
      return { status: 'error', error: createProviderErrorV1('provider_settings_invalid', { machineId: request.machineId }) };
    }
    const lease = input.acquireRuntimeLease
      ? await input.acquireRuntimeLease()
      : await acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir,
        });
    try {
      await activateAgentRuntimeContributionOnDemand(lease.registry, target.backendId);
      const adapter = readLeasedAgentProviderBindingAdapter({ lease, agentId: target.backendId });
      if (!adapter) return { status: 'success', agentTargetKey: request.agentTargetKey, groups: [] };
      const runtimeState = await sharedRuntime.runtimeStore.read();
      const settingsRead = readProviderSettingsForCli(snapshot.settings);
      const catalogs: ProviderConnectionCatalog[] = [];
      const modelLoadProjectionByConnectionId = new Map<string, Readonly<{
        action: 'available' | 'descriptor_absent' | 'feature_disabled';
        preflightPolicy: 'advisory' | 'required' | null;
      }>>();
      const confirmedByRef = new Map<string, boolean>();
      const pickerDemand: Array<Readonly<{ connectionId: string; machineId: string }>> = [];
      for (const connection of settingsRead.settings.connections) {
        const context = await sharedRuntime.resolvePresentationCatalogContext({
          connectionId: connection.id,
          machineId: request.machineId,
        }, runtimeState);
        if (context.status === 'error') continue;
        if (context.connection.authorization.authorized) {
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
        const initial = assembleProviderConnectionCatalog({
          agentTargetKey: request.agentTargetKey,
          connection: context.connection,
          providerSettings: context.providerSettings,
          runtimeState,
          catalogRuntimeKey: context.catalogRuntimeKey,
        });
        const recoveryDescriptor = !context.connection.authorization.authorized
          && request.currentSelection?.agentTargetKey === request.agentTargetKey
          && request.currentSelection.providerConnectionId === connection.id
          && ![...initial.rows, ...initial.staleRows].some(
            (row) => row.ref.modelId === request.currentSelection!.modelId,
          )
          ? { id: request.currentSelection.modelId, name: request.currentSelection.modelId }
          : null;
        const compatibilityByModelId = new Map(
          [
            ...[...initial.rows, ...initial.staleRows].map((row) => row.descriptor),
            ...(recoveryDescriptor ? [recoveryDescriptor] : []),
          ].map((descriptor) => {
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
          endpointHealth: runtimeState.endpointHealth,
        });
        catalogs.push(assembleProviderConnectionCatalog({
          agentTargetKey: request.agentTargetKey,
          connection: context.connection,
          providerSettings: context.providerSettings,
          runtimeState,
          catalogRuntimeKey: context.catalogRuntimeKey,
          compatibilityByModelId,
          currentEndpointHealthByTemplateId,
          ...(request.currentSelection
            ? { currentSelectionForRecovery: request.currentSelection }
            : {}),
        }));
      }
      const projection = projectProviderCatalogForPicker({
        catalogs,
        modelVisibilityByRef: settingsRead.settings.modelVisibilityByRef,
        mode: request.mode ?? 'picker',
        ...(request.currentSelection ? { currentSelection: request.currentSelection } : {}),
      });
      const groups = projection.groups.map((group) => {
          const catalog = catalogs.find((candidate) => candidate.connectionId === group.connectionId)!;
          return {
            connectionId: group.connectionId,
            providerName: group.providerName,
            connectionName: group.connectionName,
            connectionRole: catalog.connectionRole,
            connectionDisplayNameMode: catalog.connectionDisplayNameMode,
            connectionRevision: settingsRead.settings.connections.find((candidate) => candidate.id === group.connectionId)!.revision,
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
            rows: group.rows.map((row) => ({
              ref: row.ref,
              descriptor: row.descriptor,
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
            })),
          };
        });
      const currentSelectionRecovery = resolveCurrentSelectionRecovery({
        currentSelection: request.currentSelection,
        settings: settingsRead.settings,
        registry: resolveProviderContributionRegistryView(lease.registry.contributes),
        projectedGroups: groups,
        machineId: request.machineId,
      });
      schedulePickerDemandRefreshes(pickerDemand);
      return DaemonProviderModelProjectionResponseV1Schema.parse({
        status: 'success',
        agentTargetKey: request.agentTargetKey,
        groups,
        currentSelectionRecovery,
      });
    } finally {
      await lease.release();
    }
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
    const lease = input.acquireRuntimeLease
      ? await input.acquireRuntimeLease()
      : await acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir,
        });
    try {
      await activateAgentRuntimeContributionOnDemand(lease.registry, target.backendId);
      const registry = resolveProviderContributionRegistryView(lease.registry.contributes);
      const providerSettings = readProviderSettingsForCli(snapshot.settings).settings;
      const dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
        connectionId,
        machineId: request.machineId,
        providerSettings,
        registry,
        ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
      });
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
        agentId: target.backendId,
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
    mutateModelSettings,
    resolveBindingStatus,
    runtimeStore: sharedRuntime.runtimeStore,
    probeInfrastructure: sharedRuntime.probeInfrastructure,
    loadModel: service.loadNow,
    cancelModelLoad: service.cancelNow,
    rpcHandler,
  });
}
