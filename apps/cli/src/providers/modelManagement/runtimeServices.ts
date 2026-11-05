import type { z } from 'zod/mini';
import { randomUUID } from 'node:crypto';
import { logProviderUnexpectedFailure } from '@/providers/diagnostics';

import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { createProviderErrorV1, ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { selectProviderRuntimeCredentialTransportV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { resolveProviderCurrentSelectionRecoveryV1 } from '@happier-dev/protocol/providers/catalog/currentSelectionRecoveryV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ProviderCatalogDeclarationV1, ProviderBoundModelRef, ProviderConnectionId, ProviderCredentialTransportV1, ProviderBrokerApplicationBindingV1, ProviderModelDescriptorV1, ProviderWireProtocol, PersistedBackendTargetRefV2, ProviderRuntimeStateFileV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import { projectProviderConnectionBrokerApplication } from '@/providers/broker/providerConnectionCpxBridge';
import { isRemoteProviderGatewayPlacement } from '@/providers/managed/gatewayPlacement';
import type { DaemonProviderBindingStatusRequestV1, DaemonProviderBindingStatusResponseV1, DaemonProviderModelProjectionRefreshFailureV1, DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1, DaemonProviderTeamCredentialRequestPolicySupportV1, DaemonProviderTeamCredentialRequestPolicySupportRequestV1, DaemonProviderTeamCredentialRequestPolicySupportResponseV1, DaemonProviderModelSettingsMutationRequestV1, DaemonProviderModelSettingsMutationResponseV1, DaemonProviderTeamCredentialResourceTestCandidateRequestV1, DaemonProviderTeamCredentialResourceTestCandidateResponseV1, DaemonProviderTeamCredentialBrokerEligibilityRequestV1, DaemonProviderTeamCredentialBrokerEligibilityResponseV1 } from '@happier-dev/protocol/rpc/providers';
import type { TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams';
import { DaemonProviderModelProjectionRequestV1Schema, DaemonProviderModelProjectionResponseV1Schema, DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema, DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import type { ProviderContributionRegistryView, ProviderEndpointDnsEvidence } from '@/providers/registry';
import { resolveProviderConnectionForMachine, resolveProviderConnectionSecurityFingerprintMatch } from '@/providers/registry';
import { getProviderContribution } from '@/providers/registry/lookup';
import { readProviderModelNameCatalog, resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { createProviderProbeHttpClient } from '@/providers/probe/client';
import { ProviderProbeAdmissionCapacityError } from '@/providers/probe/scheduler';
import { createRuntimeProviderServices, projectProviderCatalogContextRuntimeState } from '@/providers/probe/runtimeServices';
import type {
  RuntimeProviderOperationScope,
  RuntimeProviderPresentationResolutionBasis,
  RuntimeProviderServices,
} from '@/providers/probe/runtimeServices';
import type { ProviderRuntimeStateStore } from '@/providers/runtimeState';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import type { RpcHandlerContext } from '@/api/rpc/types';

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
  projectProviderCatalogCurrentSelectionRecoveryRows,
  projectProviderCatalogForPicker,
} from '@/providers/catalog';
import type { ProviderCatalogRowPresentation, ProviderConnectionCatalog, ProviderConnectionCatalogRow } from '@/providers/catalog';
import { resolveProviderModelCompatibility } from '@/providers/catalog/compatibility';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { sameProviderConnectionsCatalogAuthority } from '@/providers/lifecycle/currentAccountSettingsSnapshot';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { prepareProviderConnectionsCatalogForCli, refreshProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
import { configuration } from '@/configuration';
import type { ProviderModelSettingsMutationIntent } from '@/providers/connections';
import { resolveProviderModelPickerVisibility } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';
import {
  resolveProviderSpawnAuthorization,
} from '@/providers/spawn/resolve';
import {
  resolveProviderRuntimeCatalogSelectionObservation,
  type ProviderRuntimeModelProjectionReader,
} from '@/providers/spawn/runtimeCatalog';
import {
  collectProviderConnectionDnsEvidence,
  collectProviderConnectionsDnsEvidence,
} from '@/providers/registry/dnsEvidence';
import {
  awaitAbortableWithinProviderOperation,
  awaitWithinProviderOperation,
  createProviderOperationLifetime,
  createProviderOperationPhaseObserver,
  observeProviderOperationPhase,
  ProviderOperationAbandonedError,
} from '@/providers/operationLifetime';
import { selectCurrentProviderEndpointHealthByTemplateId } from '@/providers/connections/runtimeSummary';
import { projectProviderBrokerApplication } from '@/providers/broker/applicationProjection';
import { resolveProviderSourceFacts } from '@/providers/registry/sourceFacts';
import { projectProviderModelReasoningForAgent, readProviderReasoningEffortOption } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import {
  indexAgentRoutingIdsByContributionIdentity,
  readAgentRoutingIdForContributionIdentity,
} from '@/plugins/projection/registry/agentRoutingIdentity';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import {
  providerManagedPurposeBindingError,
  resolveManagedProviderPurposeBindingSnapshot,
  type ResolveManagedProviderPurposeBindingIntent,
} from '@/providers/managed/resolvePurposeBindingSnapshot';
import {
  isTeamCredentialSourceModelProjectionFailureV1,
  projectTeamCredentialSourceModelFilter,
  resolveTeamCredentialBrokerEligibility,
  resolveTeamCredentialResourceTestCandidate,
} from '@/providers/broker/resourceTestCandidate';
import { projectConnectedAccountCatalog, readConnectedAccountCatalogSources, type ResolveManagedProviderPurposeBindingIntentSelection } from './connectedAccountCatalog';
import { qualifySessionTeamCredentialProviderModels, selectSessionTeamCredentialProviderModel } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { readProviderConnectionSourceCatalog, projectProviderConnectionSourceCatalog } from './providerConnectionSourceCatalog';
import type { AccountScopedProviderReadInput } from './remoteProjection';
import { createTeamCredentialNativeSourceServices, type TeamCredentialNativeSourceContext } from './nativeProviderSource';
import type { PrepareTeamCredentialNativeProviderSourceResult } from '@/providers/broker/teamCredentialNativeProviderSource';

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

/** The wire projection carrying the already admitted descriptor; its response boundary parses it once. */
export type ProjectedTeamCredentialRequestPolicySupportV1 = Omit<DaemonProviderTeamCredentialRequestPolicySupportV1, 'descriptor'>
  & Readonly<{ descriptor: ProviderModelDescriptorV1 }>;

export function projectDaemonProviderTeamCredentialRequestPolicySupportV1(input: Readonly<{
  application: ProviderBrokerApplicationBindingV1;
  sourceRevision: string;
  descriptor: ProviderModelDescriptorV1;
}>): ProjectedTeamCredentialRequestPolicySupportV1 | null {
  const protocolKind = resolveTeamCredentialRequestPolicyProtocolKind(input.application.protocol);
  if (protocolKind === null) return null;

  const reasoningOption = readProviderReasoningEffortOption(input.descriptor);
  const reasoningValues = reasoningOption?.options?.map((option) => option.value) ?? [];
  const reasoningEffort = reasoningOption
    ? {
        supported: true as const,
        allowedValues: reasoningValues,
        defaultValue: reasoningOption.currentValue,
      }
    : { supported: false as const };

  return {
    descriptor: input.descriptor,
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

/** Host-private projection authority issued to one admitted Account consumer. */
export type RuntimeProviderAccountModelProjectionContext = Readonly<{
  getAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null;
  resolveManagedPurposeBindingIntent: ResolveManagedProviderPurposeBindingIntent;
  resolveManagedPurposeBindingIntentSelection?: ResolveManagedProviderPurposeBindingIntentSelection;
  signal: AbortSignal;
  isCurrent(): boolean | Promise<boolean>;
  accountReadScope?: AccountScopedProviderReadInput;
  savedSecretOperationContext?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1;
  managedRuntimeAccount?: NonNullable<RuntimeProviderOperationScope['managedRuntimeAccount']>;
}>;

export type RuntimeProviderModelManagementServices = Readonly<{
  probe: RuntimeProviderServices['probe'];
  probeDraft: RuntimeProviderServices['probeDraft'];
  models: RuntimeProviderServices['models'];
  summary: RuntimeProviderServices['summary'];
  resolveCatalogContext: RuntimeProviderServices['resolveCatalogContext'];
  projectModels(
    request: DaemonProviderModelProjectionRequestV1,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
  ): Promise<DaemonProviderModelProjectionResponseV1>;
  projectModelsForAccount(
    request: DaemonProviderModelProjectionRequestV1,
    context: RuntimeProviderAccountModelProjectionContext,
  ): Promise<DaemonProviderModelProjectionResponseV1>;
  prepareTeamCredentialNativeSource(
    request: z.input<typeof DaemonProviderModelProjectionRequestV1Schema>,
    signal?: AbortSignal,
  ): Promise<PrepareTeamCredentialNativeProviderSourceResult>;
  resolveTeamCredentialRequestPolicySupport(
    request: DaemonProviderTeamCredentialRequestPolicySupportRequestV1,
    signal?: AbortSignal,
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
    signal?: AbortSignal,
  ): Promise<DaemonProviderModelSettingsMutationResponseV1>;
  resolveBindingStatus(
    request: DaemonProviderBindingStatusRequestV1,
    context?: Pick<RpcHandlerContext, 'signal' | 'reportOperationDiagnostics'>,
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
  resolveSharedGateway?: import('@/plugins/runtime/invocation/services/managedServicesAdapter').ResolveSharedManagedProviderGatewayBinding;
  registry?: ProviderContributionRegistryView;
  secretSources?: Parameters<typeof createRuntimeProviderServices>[0]['secretSources'];
  resolveRegistry?: () => ProviderContributionRegistryView | Promise<ProviderContributionRegistryView>;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  teamCredentialNativeSource?: TeamCredentialNativeSourceContext;
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
  resolveManagedPurposeBindingIntentSelection?: ResolveManagedProviderPurposeBindingIntentSelection;
  readModelProjection?: ProviderRuntimeModelProjectionReader;
  openTeamDirect?: Parameters<typeof createRuntimeProviderServices>[0]['openTeamDirect'];
}>): RuntimeProviderModelManagementServices {
  const readAdmittedSnapshot = async (context?: RuntimeProviderAccountModelProjectionContext, signal?: AbortSignal, reobserve = true) => {
    const readSnapshot = context?.getAccountSettingsSnapshot
      ?? input.getAccountSettingsSnapshot ?? getActiveAccountSettingsSnapshot;
    const captured = readSnapshot();
    if (!captured?.scopeKey || !input.featureGate.isEnabled('providers')) return null;
    // An issued Account context cannot hydrate the ambient Account's catalog.
    if (context && captured.providerConnectionsCatalog?.status !== 'ready') return null;
    const catalog = captured.providerConnectionsCatalog?.status === 'ready' && (context || input.getAccountSettingsSnapshot)
      ? captured.providerConnectionsCatalog
      : await (!reobserve || context || input.getAccountSettingsSnapshot ? prepareProviderConnectionsCatalogForCli
        : refreshProviderConnectionsCatalogForCli)({ expectedScopeKey: captured.scopeKey, signal });
    const snapshot = readSnapshot();
    return input.featureGate.isEnabled('providers') && catalog.status === 'ready' && snapshot?.scopeKey === captured.scopeKey
      ? snapshot : null;
  };
  const client = input.client ?? createProviderProbeHttpClient({});
  const sharedRuntime = createRuntimeProviderServices({
    ...(input.resolveSharedGateway ? { resolveSharedGateway: input.resolveSharedGateway } : {}),
    machineId: input.machineId,
    featureGate: input.featureGate,
    client,
    ...(input.happyHomeDir ? { happyHomeDir: input.happyHomeDir } : {}),
    ...(input.registry ? { registry: input.registry } : {}),
    ...(input.secretSources ? { secretSources: input.secretSources } : {}),
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
  const projectModelsFromCurrentSource = async (
    request: DaemonProviderModelProjectionRequestV1,
    accountContext?: RuntimeProviderAccountModelProjectionContext,
    signal?: AbortSignal,
    observeSnapshot?: (signal?: AbortSignal) => ReturnType<typeof readAdmittedSnapshot>,
    rpcContext?: RpcHandlerContext,
  ): Promise<DaemonProviderModelProjectionResponseV1> => {
    const admission = rpcContext?.machineAdmission;
    const foreignRequester = Boolean(admission && admission.actorAccountId !== admission.custodianAccountId)
      || [rpcContext?.callerInputAuthorization, rpcContext?.localActionContext?.externalActionExecutionAuthorization]
        .some(authorization => authorization && authorization.binding.accountId !== authorization.binding.custodianAccountId);
    // Shared workers supply Agent compatibility, never their custodian's
    // private Provider catalog. Source selectors must not reach an earlier
    // catalog branch or silently fall back to ambient Account authority.
    if (foreignRequester && (!request.teamCredentialResources || request.providerConnection || request.connectedAccountTarget
      || request.sourceCatalog || request.sourceConnectionId || request.application || request.includeDirectMaterialization)) {
      return { status: 'error', error: createProviderErrorV1('provider_authorization_changed', { machineId: request.machineId }) };
    }
    const sourceProjection = Boolean(request.connectedAccountTarget && request.sourceCatalog);
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

    if (request.nativeSource) {
      if (accountContext) return { status: 'error', error: createProviderErrorV1('provider_authorization_changed') };
      return nativeSourceServices.projectModels(request, signal);
    }

    const target = parseBackendTargetKeyV2(request.agentTargetKey);
    // Source visibility is discovery policy, never Team/broker/route authorization.
    const routeConsumer = Boolean(request.providerConnection || request.connectedAccountTarget
      || request.application || request.includeTeamCredentialRequestPolicySupport);
    const operationLifetime = createProviderOperationLifetime({
      signal: accountContext?.signal ?? signal,
      // Current-only reads serve containing launch/broker admission and never
      // dispatch a catalog probe. Their caller owns cancellation; borrowing a
      // probe budget here would cut off that admission on a slow Home read.
      ...(request.refreshPolicy !== 'current_only' && !request.connectedAccountTarget
        ? { wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs }
        : {}),
    });
    const isAccountCurrent = async () => !accountContext || (
      !accountContext.signal.aborted
      && await awaitWithinProviderOperation(Promise.resolve(accountContext.isCurrent()), operationLifetime)
      && !accountContext.signal.aborted
    );
    let snapshot: Awaited<ReturnType<typeof readAdmittedSnapshot>> = null;
    // Purpose/catalog admission can update another private catalog or its
    // cleanup report. Only the captured settings and Provider authority can
    // invalidate this projection's snapshot basis.
    const isAccountSnapshotCurrent = () => {
      if (!accountContext) return true;
      const current = accountContext.getAccountSettingsSnapshot();
      return current !== null && snapshot !== null && current.scopeKey === snapshot.scopeKey
        && current.settingsVersion === snapshot.settingsVersion
        && sameProviderConnectionsCatalogAuthority(snapshot.providerConnectionsCatalog, current.providerConnectionsCatalog);
    };
    try {
      if (!await isAccountCurrent()) {
        return { status: 'error', error: createProviderErrorV1('provider_authorization_changed', { machineId: request.machineId }) };
      }
      if (!foreignRequester && !sourceProjection && !request.teamCredentialResources) snapshot = await awaitWithinProviderOperation(observeSnapshot
        ? observeSnapshot(operationLifetime.signal) : readAdmittedSnapshot(accountContext, operationLifetime.signal), operationLifetime);
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) {
        return { status: 'error', error: createProviderErrorV1('provider_catalog_unavailable', { machineId: request.machineId }) };
      }
      throw error;
    }
    if (!snapshot && !foreignRequester && !sourceProjection && !request.teamCredentialResources) {
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
          error: createProviderErrorV1('agent_timeout', {
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
          error: createProviderErrorV1('agent_unavailable', {
            machineId: request.machineId,
          }),
        };
      }
      if (request.sourceCatalog && request.providerConnection && snapshot) {
        const registry = resolveProviderContributionRegistryView(lease.registry.contributes,
          lease.registry.generation, lease.registry.readPluginOccurrenceId);
        const observation = await readProviderConnectionSourceCatalog({ machineId: request.machineId,
          source: request.providerConnection, snapshot, registry, runtime: sharedRuntime, lifetime: operationLifetime,
          ...(accountContext ? { accountScope: { getAccountSettingsSnapshot: accountContext.getAccountSettingsSnapshot,
            resolveManagedPurposeBindingIntent: accountContext.resolveManagedPurposeBindingIntent,
            isAccountCurrent: accountContext.isCurrent,
            savedSecretOperationContext: accountContext.savedSecretOperationContext ?? null,
            managedRuntimeAccount: accountContext.managedRuntimeAccount ?? null } } : {}),
          resolveAddresses: input.resolveAddresses, refreshPolicy: request.refreshPolicy, forceRefresh: request.forceRefresh });
        if (observation.status === 'error') return observation;
        if (!await isAccountCurrent() || !isAccountSnapshotCurrent()) {
          return { status: 'error', error: createProviderErrorV1('provider_authorization_changed') };
        }
        const projected = projectProviderConnectionSourceCatalog({ observation, registry, request,
          localModelManagementEnabled: input.featureGate.isEnabled('providers.localModelManagement'),
          delivery: request.includeDirectMaterialization ? 'direct' : 'brokered' });
        if (projected.status !== 'success' || !request.includeTeamCredentialRequestPolicySupport) return projected;
        return DaemonProviderModelProjectionResponseV1Schema.parse({ ...projected,
          groups: projected.groups.map(group => ({ ...group, rows: group.rows.map(row => ({ ...row,
            requestPolicySupport: row.application ? projectDaemonProviderTeamCredentialRequestPolicySupportV1({
              application: row.application, sourceRevision: group.sourceRevision!, descriptor: row.descriptor,
            }) ?? undefined : undefined,
          })) })) });
      }
      const agentId = sourceProjection ? null : resolveAgentRoutingIdForTarget(lease.registry.contributes, target);
      if (!agentId && !sourceProjection) {
        return {
          status: 'error',
          error: createProviderErrorV1('agent_unavailable', {
            machineId: request.machineId,
          }),
        };
      }
      try {
        if (agentId) {
          await awaitWithinProviderOperation(
            activateAgentRuntimeContributionOnDemand(lease.registry, agentId),
            operationLifetime,
          );
        }
      } catch (error) {
        if (error instanceof ProviderOperationAbandonedError) {
          return {
            status: 'error',
            error: createProviderErrorV1('agent_timeout', {
              machineId: request.machineId,
            }),
          };
        }
        throw error;
      }
      const adapter = agentId ? readLeasedAgentProviderBindingAdapter({ lease, agentId }) : null;
      if (request.teamCredentialResources) {
        const resources = await Promise.all(request.teamCredentialResources.map(async resource => {
          const qualified = await qualifySessionTeamCredentialProviderModels({ resource,
            lease, agentId: agentId!, signal: operationLifetime.signal });
          const byModel = new Map<string, typeof qualified.providerModels>();
          for (const model of qualified.providerModels) {
            if (model.selection.agentTargetKey !== request.agentTargetKey) continue;
            const rows = byModel.get(model.selection.modelId) ?? [];
            rows.push(model);
            byModel.set(model.selection.modelId, rows);
          }
          return { ...qualified, providerModels: [...byModel].map(([modelId, rows]) =>
            selectSessionTeamCredentialProviderModel({ resource: { ...qualified, providerModels: rows }, agentTargetKey: request.agentTargetKey, modelId })
              ?? { ...rows[0]!, availability: 'policy_denied' as const,
                deliveryUnavailableReason: rows[0]!.deliveryUnavailableReason ?? 'provider_catalog_unavailable' as const }) };
        }));
        return DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey: request.agentTargetKey,
          groups: [], teamCredentialResources: resources });
      }
      if (!adapter && !sourceProjection) return { status: 'success', agentTargetKey: request.agentTargetKey, groups: [] };
      const registry = resolveProviderContributionRegistryView(
        lease.registry.contributes,
        lease.registry.generation,
        lease.registry.readPluginOccurrenceId,
      );
      // A Connected Account/Pool catalog belongs to its declared upstream
      // purpose, independently of any saved Gateway configuration. Taking this
      // branch before connection resolution prevents a second competing
      // catalog, DNS work, or a managed-process probe for the same source.
      // Source-only reads use purpose selection/currentness and declarations;
      // an unrelated personal Provider catalog cannot admit or withhold them.
      if (request.connectedAccountTarget) {
        const resolveSelection = accountContext
          ? accountContext.resolveManagedPurposeBindingIntentSelection
          : input.resolveManagedPurposeBindingIntentSelection;
        const unavailable = () => ({ status: 'error' as const,
          error: createProviderErrorV1('provider_catalog_unavailable', { machineId: request.machineId }) });
        if (!resolveSelection || request.providerConnection || request.sourceConnectionId) return unavailable();
        const projection = await awaitWithinProviderOperation(projectConnectedAccountCatalog({
          request, registry, ...(adapter ? { support: adapter.support, adapterVersion: adapter.adapter.adapterVersion } : {}),
          providerSettings: snapshot ? readProviderSettingsForCli(snapshot).settings : DEFAULT_PROVIDER_SETTINGS_V1,
          resolveSelection, signal: operationLifetime.signal,
        }), operationLifetime);
        if (projection.groups.length === 0
          || !await awaitWithinProviderOperation(projection.isCurrent(), operationLifetime) || !await isAccountCurrent()
          || (accountContext && !sourceProjection && !isAccountSnapshotCurrent())) return unavailable();
        return DaemonProviderModelProjectionResponseV1Schema.parse({
          status: 'success', agentTargetKey: request.agentTargetKey,
          groups: projection.groups.map(group => ({ ...group, rows: group.rows.map(row => {
            const requestPolicySupport = request.includeTeamCredentialRequestPolicySupport && row.application
              ? projectDaemonProviderTeamCredentialRequestPolicySupportV1({
                  application: row.application, sourceRevision: group.sourceRevision!, descriptor: row.descriptor,
                }) : null;
            return { ...row, ...(requestPolicySupport ? { requestPolicySupport } : {}) };
          }) })),
          currentSelectionRecovery: null,
        });
      }
      if (!snapshot) return { status: 'error', error: createProviderErrorV1('provider_authorization_changed', { machineId: request.machineId }) };
      const settingsRead = readProviderSettingsForCli(snapshot);
      if (!adapter) return { status: 'success', agentTargetKey: request.agentTargetKey, groups: [] };
      const modelNameCatalog = readProviderModelNameCatalog(registry);
      // Exact-source browse and launch admission must not resolve DNS, purpose
      // bindings or catalogs belonging to an unrelated connection.
      const connections = settingsRead.settings.connections.filter(connection => (
        (!request.sourceConnectionId || connection.id === request.sourceConnectionId)
        && (!request.providerConnection || connection.id === request.providerConnection.connectionId)
      ));
      const hasPickerDemand = (connectionId: string, kind: Parameters<typeof resolveProviderModelPickerVisibility>[0]['kind']) => (
        resolveProviderModelPickerVisibility({ connectionId, kind,
          modelPickerVisibilityByConnectionId: settingsRead.settings.modelPickerVisibilityByConnectionId }).shown
        || request.mode === 'management' || Boolean(request.sourceConnectionId) || routeConsumer
        || request.currentSelection?.providerConnectionId === connectionId
        || settingsRead.settings.defaultsByAgentTargetKey[request.agentTargetKey]?.ref.providerConnectionId === connectionId
        || request.favoriteSelections?.some(ref => ref.providerConnectionId === connectionId) === true
      );
      const resolutionFailures = new Map<ProviderConnectionId, DaemonProviderModelProjectionRefreshFailureV1['error']>();
      const dnsEvidenceByConnectionId = new Map<string, ProviderEndpointDnsEvidence>();
      const operationScope: RuntimeProviderOperationScope = {
        registry,
        dnsEvidenceByConnectionId,
        ...(accountContext ? { getAccountSettingsSnapshot: accountContext.getAccountSettingsSnapshot,
          resolveManagedPurposeBindingIntent: accountContext.resolveManagedPurposeBindingIntent,
          isAccountCurrent: accountContext.isCurrent,
          savedSecretOperationContext: accountContext.savedSecretOperationContext ?? null,
          managedRuntimeAccount: accountContext.managedRuntimeAccount ?? null,
          accountReadScope: accountContext.accountReadScope ?? null } : {}),
        ...(snapshot.scopeKey
          ? {
              accountSettingsBasis: {
                scopeKey: snapshot.scopeKey,
                settingsVersion: snapshot.settingsVersion,
                providerConnectionsCatalog: snapshot.providerConnectionsCatalog,
                accountSettings: snapshot.settings,
                settingsRead,
              },
            }
          : {}),
        resolveContributedCatalogParsers: async (identity) => {
          const acquired = await lease.registry.acquireProviderCatalogParsers?.(identity);
          return acquired
            ? Object.freeze({
                pluginId: identity.pluginId,
                activationOccurrenceId: acquired.activationOccurrenceId,
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
        snapshot,
        settingsRead,
        modelNameCatalog,
        ...(accountContext ? { resolveManagedPurposeBindingIntent: accountContext.resolveManagedPurposeBindingIntent } : {}),
      });
      const indexRuntimeState = (runtimeState: ProviderRuntimeStateFileV1) => {
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
        return (connectionId: string): ProviderRuntimeStateFileV1 => ({
          ...runtimeState,
          endpointHealth: endpointHealthByConnectionId.get(connectionId) ?? [],
          catalogs: catalogsByConnectionId.get(connectionId) ?? [],
          // Installation checks are contribution-wide and are not consumed by
          // picker catalog assembly.
          installationChecks: [],
          modelLoadStates: modelLoadStatesByConnectionId.get(connectionId) ?? [],
        });
      };
      const initialRuntimeState = await sharedRuntime.runtimeStore.read();
      const initialRuntimeStateForConnection = indexRuntimeState(initialRuntimeState);
      const placedProjections = new Map<string, Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }>>();
      // Resolve the immutable Account/registry basis once per source. A slow
      // source spends the existing operation budget, and only that source is
      // refused; successful admissions survive the later observation refresh.
      const resolvePresentationContext = async (connection: (typeof settingsRead.settings.connections)[number]) => {
        const identity = { connectionId: connection.id, machineId: request.machineId };
        const failure = resolutionFailures.get(connection.id);
        if (failure) return { connection, context: { status: 'error' as const, error: failure } };
        try {
          if (isRemoteProviderGatewayPlacement(connection.gatewayPlacement, request.machineId)) {
            const sourceKind = connection.source.kind === 'custom' ? 'custom'
              : getProviderContribution(registry, connection.source.contributionKey)?.definition.kind;
            const demand = sourceKind === undefined || hasPickerDemand(connection.id, sourceKind);
            const placed = await awaitWithinProviderOperation(sharedRuntime.readPlacedModelProjection({
              ...request, sourceConnectionId: connection.id, mode: 'management',
              favoriteSelections: [...(request.favoriteSelections ?? []),
                ...(settingsRead.settings.defaultsByAgentTargetKey[request.agentTargetKey]?.ref
                  ? [settingsRead.settings.defaultsByAgentTargetKey[request.agentTargetKey]!.ref] : [])],
              ...(!demand ? { refreshPolicy: 'current_only' as const } : {}),
            }, operationScope), operationLifetime);
            if (placed) {
              if (placed.status === 'error') {
                resolutionFailures.set(connection.id, placed.error);
                return { connection, context: { status: 'error' as const, error: placed.error } };
              }
              placedProjections.set(connection.id, placed);
              return { connection, context: null };
            }
          }
          const context = await awaitWithinProviderOperation(sharedRuntime.resolvePresentationCatalogContext(
            identity, initialRuntimeStateForConnection(connection.id), operationScope, presentationSettingsBasis,
          ), operationLifetime);
          if (context.status === 'error') resolutionFailures.set(connection.id, context.error);
          return { connection, context };
        } catch (error) {
          if (!(error instanceof ProviderOperationAbandonedError)) throw error;
          const failure = createProviderErrorV1('provider_endpoint_unavailable', identity);
          resolutionFailures.set(connection.id, failure);
          return { connection, context: { status: 'error' as const, error: failure } };
        }
      };
      const connectionsById = new Map<string, (typeof connections)[number]>(connections.map(connection => [connection.id, connection]));
      const pendingContexts = new Map<string, ReturnType<typeof resolvePresentationContext>>();
      await collectProviderConnectionsDnsEvidence({
        connectionIds: [...connectionsById.keys()], machineId: request.machineId,
        providerSettings: settingsRead.settings, registry,
        ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
        admitResolution: sharedRuntime.probeInfrastructure.scheduler.runDns,
        isCurrent: () => input.featureGate.isEnabled('providers'), lifetime: operationLifetime,
        onConnectionResolved: (connectionId, { evidence, error }) => {
          const connection = connectionsById.get(connectionId)!;
          if (error) resolutionFailures.set(connection.id, createProviderErrorV1(
            error instanceof ProviderProbeAdmissionCapacityError ? 'provider_probe_capacity_exhausted' : 'provider_endpoint_unavailable',
            { connectionId, machineId: request.machineId },
          ));
          dnsEvidenceByConnectionId.set(connectionId, evidence);
          const pending = resolvePresentationContext(connection);
          // A different DNS lookup can still be pending when this source
          // fails. Promise.all below remains the result owner.
          void pending.catch(() => {});
          pendingContexts.set(connectionId, pending);
        },
      });
      const presentationContexts = await Promise.all([...connectionsById.keys()].map(connectionId => pendingContexts.get(connectionId)!));
      const assemble = (runtimeState: ProviderRuntimeStateFileV1) => {
        const runtimeStateForConnection = indexRuntimeState(runtimeState);
        const resolvedContexts = presentationContexts.flatMap(({ connection, context }) => {
          if (!context) return [];
          const connectionRuntimeState = runtimeStateForConnection(connection.id);
          return [{
            connection,
            connectionRuntimeState,
            context: context.status === 'success'
              ? projectProviderCatalogContextRuntimeState(context, connectionRuntimeState) : context,
          }];
        });
        const catalogs: ProviderConnectionCatalog[] = [];
        const modelLoadProjectionByConnectionId = new Map<string, Readonly<{
          action: 'available' | 'descriptor_absent' | 'feature_disabled' | 'machine_required';
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
          if (request.providerConnection && !resolveProviderConnectionSecurityFingerprintMatch(context.connection,
            request.providerConnection.expectedConnectionSecurityFingerprint).matches) continue;
          resolvedConnectionById.set(connection.id, context.connection);
          const authorizedForDemand = context.connection.authorization.authorized && hasPickerDemand(connection.id,
            context.connection.source.kind === 'custom' ? 'custom' : context.connection.source.definition.kind);
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
            modelNameCatalog,
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
            modelNameCatalog,
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
        for (const placed of placedProjections.values()) {
          const group = placed.groups[0];
          if (!group) continue;
          const connection = connectionsById.get(group.connectionId)!;
          const resolved = resolveProviderConnectionForMachine({ connectionId: group.connectionId,
            machineId: request.machineId, providerSettings: settingsRead.settings, registry,
            dnsEvidenceByEndpointUrl: dnsEvidenceByConnectionId.get(group.connectionId)!,
            ...(input.localCandidateUrlsByConnectionId ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId } : {}),
          });
          if (resolved.status !== 'resolved') continue;
          const record = resolved.record;
          resolvedConnectionById.set(group.connectionId, record);
          const sourceKind = record.source.kind === 'custom' ? 'custom' : record.source.definition.kind;
          // A source-only response can offer the same model over several
          // protocols. The worker's one compatibility owner chooses among
          // them; ordinary presentation still has one group per connection.
          const rowsByModelId = new Map(placed.groups.flatMap(source => source.rows.map(row => [row.ref.modelId, row] as const)));
          // A Provider connection's catalog serves only Provider-bound refs; native Agent rows have no connection.
          const rows: Array<Pick<ProviderConnectionCatalogRow, 'ref' | 'descriptor' | 'sources' | 'confidence' | 'gatewaySlots'>
            & Pick<ProviderCatalogRowPresentation, 'catalog' | 'loadState'>> = [...rowsByModelId.values()]
            .flatMap(row => row.ref.providerConnectionId === null ? [] : [{ ...row, ref: row.ref }]);
          const recoveryRows = projectProviderCatalogCurrentSelectionRecoveryRows({ connection: record,
            agentTargetKey: request.agentTargetKey, modelNameCatalog,
            currentSelectionForRecovery: request.currentSelection,
            agentSupportsFreeformModelIds: adapter.support.supportsFreeformModelIds,
            hasCatalogModel: modelId => rowsByModelId.has(modelId),
          });
          rows.push(...recoveryRows.map(row => ({ ref: { agentTargetKey: request.agentTargetKey,
            providerConnectionId: record.connectionId, modelId: row.row.descriptor.id },
            descriptor: row.row.descriptor, sources: row.row.sources, confidence: row.row.confidence,
            catalog: row.catalog, loadState: row.loadState })));
          catalogs.push({ ...group, agentTargetKey: request.agentTargetKey, sourceKind,
            authorization: group.authorization.authorized ? { authorized: true }
              : { authorized: false, errorCode: group.authorization.error.code },
            rows: rows.map(row => {
              const compatibility = resolveProviderModelCompatibility({ record, providerSettings: settingsRead.settings,
                agentTargetKey: request.agentTargetKey, support: adapter.support,
                adapterVersion: adapter.adapter.adapterVersion, model: row.descriptor });
              confirmedByRef.set(`${connection.id}\0${row.ref.modelId}`, compatibility.confirmed);
              return { ref: row.ref, descriptor: row.descriptor, sources: row.sources, confidence: row.confidence,
                ...(row.gatewaySlots ? { gatewaySlots: row.gatewaySlots } : {}),
                presentation: { compatibility, endpointHealth: null, catalog: row.catalog, loadState: row.loadState } };
            }), staleRows: [],
          });
          modelLoadProjectionByConnectionId.set(group.connectionId, { action: group.modelLoadAction,
            preflightPolicy: group.modelLoadPreflightPolicy ?? null });
        }
        return { catalogs, modelLoadProjectionByConnectionId, confirmedByRef, resolvedConnectionById, pickerDemand, coldDemand };
      };

      let assembly = assemble(initialRuntimeState);
      // A cold automatic read must wait because it has no rows to show. An
      // explicit user Retry waits for every eligible connection and enters the
      // scheduler's existing forced branch; no consumer retry loop or cache is
      // introduced here.
      const awaitedDemand = request.refreshPolicy === 'current_only'
        ? []
        : request.forceRefresh ? assembly.pickerDemand : assembly.coldDemand;
      const refreshFailures: DaemonProviderModelProjectionRefreshFailureV1[] = [...resolutionFailures].map(([connectionId, error]) => ({ connectionId, error }));
      if (awaitedDemand.length > 0) {
        const outcomes = await Promise.all(awaitedDemand.map(async (identity) => ({
          identity,
          error: await awaitWithinProviderOperation(sharedRuntime.scheduleDemandRefresh(
            identity, request.forceRefresh ? 'manual_refresh' : 'picker_open', operationScope,
          ), operationLifetime).catch(error => {
            if (!(error instanceof ProviderOperationAbandonedError)) throw error;
            return createProviderErrorV1('provider_endpoint_unavailable', identity);
          }),
        })));
        for (const outcome of outcomes) {
          if (outcome.error !== null) {
            refreshFailures.push({ connectionId: outcome.identity.connectionId, error: outcome.error });
          }
        }
        assembly = assemble(await sharedRuntime.runtimeStore.read());
      }
      const { catalogs, modelLoadProjectionByConnectionId, confirmedByRef, resolvedConnectionById, pickerDemand } = assembly;
      const awaitedConnectionIds = new Set(awaitedDemand.map((identity) => identity.connectionId));
      const projection = projectProviderCatalogForPicker({
        catalogs,
        modelVisibilityByRef: settingsRead.settings.modelVisibilityByRef,
        modelPickerVisibilityByConnectionId: settingsRead.settings.modelPickerVisibilityByConnectionId,
        ...(request.sourceConnectionId ? { sourceConnectionId: request.sourceConnectionId } : {}),
        ...(request.favoriteSelections ? { favoriteSelections: request.favoriteSelections } : {}),
        ...(settingsRead.settings.defaultsByAgentTargetKey[request.agentTargetKey]?.ref
          ? { defaultSelection: settingsRead.settings.defaultsByAgentTargetKey[request.agentTargetKey]!.ref } : {}),
        mode: routeConsumer ? 'management' : request.mode ?? 'picker',
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
                connectionSecurityFingerprint: request.providerConnection?.expectedConnectionSecurityFingerprint
                  ?? resolvedConnection.connectionSecurityFingerprint,
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
                    ...(request.application ? { expectedApplication: request.application } : {}),
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
              descriptor: projectProviderModelReasoningForAgent(row.descriptor, adapter.support),
              ...(row.gatewaySlots ? { gatewaySlots: row.gatewaySlots } : {}),
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
      const currentSelectionRecovery = resolveProviderCurrentSelectionRecoveryV1({
        currentSelection: request.currentSelection,
        settings: settingsRead.settings,
        readContribution: key => getProviderContribution(registry, key)?.definition ?? null,
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
      refreshFailures.push(...[...placedProjections.values()].flatMap(placed => placed.refreshFailures ?? []));
      const hiddenSources = request.application ? [] : projection.hiddenSources.flatMap((source) => {
        const catalog = catalogByConnectionId.get(source.connectionId);
        return catalog ? [{ ...source, connectionRole: catalog.connectionRole,
          connectionDisplayNameMode: catalog.connectionDisplayNameMode }] : [];
      });
      if (accountContext && (!await isAccountCurrent()
        || !isAccountSnapshotCurrent())) {
        return { status: 'error', error: createProviderErrorV1('provider_authorization_changed', { machineId: request.machineId }) };
      }
      return DaemonProviderModelProjectionResponseV1Schema.parse({
        status: 'success',
        agentTargetKey: request.agentTargetKey,
        groups,
        ...(hiddenSources.length > 0 ? { hiddenSources } : {}),
        currentSelectionRecovery,
        ...(refreshFailures.length > 0 ? { refreshFailures } : {}),
      });
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) {
        return { status: 'error', error: createProviderErrorV1('provider_endpoint_unavailable', { machineId: request.machineId }) };
      }
      throw error;
    } finally {
      await lease.release();
    }
  };

  const projectModels: typeof projectModelsFromCurrentSource = async (request, accountContext, signal, observeSnapshot, rpcContext) => {
    try {
      return await projectModelsFromCurrentSource(request, accountContext, signal, observeSnapshot, rpcContext);
    } catch (error) {
      const typed = ProviderErrorV1Schema.safeParse(error);
      if (typed.success) return { status: 'error', error: typed.data };
      logProviderUnexpectedFailure('model_projection', error);
      return { status: 'error', error: createProviderErrorV1('agent_error', { machineId: request.machineId }) };
    }
  };

  const resolveAgentTargetKeys = async (signal?: AbortSignal): Promise<string[]> => {
    const lifetime = createProviderOperationLifetime({ signal });
    const pendingLease = input.acquireRuntimeLease
      ? input.acquireRuntimeLease()
      : acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir,
        });
    let lease: Awaited<typeof pendingLease>;
    try { lease = await awaitWithinProviderOperation(pendingLease, lifetime); }
    catch (error) {
      void pendingLease.then(late => late.release(), () => {});
      throw error;
    }
    try {
      return [...lease.registry.contributes.agentDefinitionsById.values()]
        .flatMap((agent) => agent.identity
          ? listAgentExecutionTargetsV1(agent.identity).map(buildBackendTargetKeyV2)
          : []);
    } finally {
      await lease.release();
    }
  };

  const resolveTeamCredentialRequestPolicySupport: RuntimeProviderModelManagementServices['resolveTeamCredentialRequestPolicySupport'] = async (request, signal) => {
    try {
      const agentTargetKeys = await resolveAgentTargetKeys(signal);
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
          sourceCatalog: true,
          ...(request.refreshPolicy ? { refreshPolicy: request.refreshPolicy } : {}),
          ...projectTeamCredentialSourceModelFilter(request.source),
        }, undefined, signal);
        if (signal?.aborted) return { status: 'unavailable', reason: 'source_unavailable' };
        if (projection.status !== 'success') continue;
        for (const group of projection.groups) {
          if (!group.authorization.authorized || !group.sourceRevision) continue;
          sourceFound = true;
          for (const row of group.rows) {
            if (row.application) applicationFound = true;
            if (row.visibility !== 'visible'
              || row.catalog.stale
              || row.compatibility.result.status === 'incompatible'
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
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) return { status: 'unavailable', reason: 'source_unavailable' };
      throw error;
    }
  };

  const resolveResourceTestCandidate = async (
    request: DaemonProviderTeamCredentialResourceTestCandidateRequestV1,
    signal?: AbortSignal,
  ): Promise<DaemonProviderTeamCredentialResourceTestCandidateResponseV1> => {
    if (!input.featureGate.isEnabled('providers') || request.machineId !== input.machineId) {
      return { status: 'unavailable', reason: 'source_unavailable' };
    }
    let agentTargetKeys: string[];
    try { agentTargetKeys = await resolveAgentTargetKeys(signal); }
    catch (error) {
      if (error instanceof ProviderOperationAbandonedError) return { status: 'unavailable', reason: 'source_unavailable' };
      throw error;
    }
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
      }, undefined, signal),
      createRequestId: randomUUID,
      ...(signal ? { signal } : {}),
    }).catch(caught => {
      if (!isTeamCredentialSourceModelProjectionFailureV1(caught)) throw caught;
      return {
        status: 'unavailable' as const,
        reason: caught.reason === 'incompatible' ? 'model_unavailable' as const : 'source_unavailable' as const,
      };
    });
    if (candidate && 'status' in candidate) {
      return DaemonProviderTeamCredentialResourceTestCandidateResponseV1Schema.parse(candidate);
    }
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
    signal?.throwIfAborted();
    if (!input.featureGate.isEnabled('providers') || request.machineId !== input.machineId) {
      return { status: 'unavailable', reason: 'source_unavailable' };
    }
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    // Saved Provider eligibility consumes one current catalog observation.
    // Connected sources retain their purpose owner's independent currentness.
    const observation: {
      pending?: ReturnType<typeof readAdmittedSnapshot>;
      admitted?: ActiveAccountSettingsSnapshot | null;
    } = {};
    const observeSnapshot = (signal?: AbortSignal) => observation.pending ??= readAdmittedSnapshot(undefined, signal, false)
      .then(snapshot => { observation.admitted = snapshot; return snapshot; });
    const projectCurrentModels = (projectionRequest: DaemonProviderModelProjectionRequestV1) => (
      projectModels({ ...projectionRequest, refreshPolicy: 'current_only' }, undefined, signal, observeSnapshot)
    );
    const sourceSelection = input.resolveManagedPurposeBindingIntentSelection;
    const result = 'scope' in request
      ? await (async () => {
          const snapshot = request.source.kind === 'provider_connection' ? await observeSnapshot(signal) : null;
          if (request.source.kind === 'provider_connection' && !snapshot) {
            return { status: 'unavailable' as const, reason: 'source_unavailable' as const };
          }
          const lease = await (input.acquireRuntimeLease ? input.acquireRuntimeLease()
            : acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir }));
          try {
            if (typeof lease.registry.generation !== 'number') return { status: 'unavailable' as const, reason: 'source_unavailable' as const };
            const registry = resolveProviderContributionRegistryView(lease.registry.contributes, lease.registry.generation, lease.registry.readPluginOccurrenceId);
            if (request.source.kind === 'provider_connection') {
              const observation = await readProviderConnectionSourceCatalog({ machineId: request.machineId,
                source: { connectionId: request.source.connectionId, expectedConnectionSecurityFingerprint: request.source.connectionSecurityFingerprint },
                snapshot: snapshot!, registry, runtime: sharedRuntime, lifetime: createProviderOperationLifetime({ signal }),
                resolveAddresses: input.resolveAddresses, refreshPolicy: 'current_only' });
              return observation.status === 'success' && observation.presentation.rows.some(row => !row.catalog.stale)
                ? { status: 'eligible' as const }
                : { status: 'unavailable' as const, reason: 'source_unavailable' as const };
            }
            if (!sourceSelection) return { status: 'unavailable' as const, reason: 'source_unavailable' as const };
            const sources = await readConnectedAccountCatalogSources({
              registry,
              target: request.source.target, resolveSelection: sourceSelection, signal,
            });
            return sources.length > 0 && (await Promise.all([...new Set(sources.map(source => source.selection))].map(selection => selection.isCurrent(signal)))).every(Boolean)
              ? { status: 'eligible' as const }
              : { status: 'unavailable' as const, reason: 'source_unavailable' as const };
          } finally { await lease.release(); }
        })()
      : await resolveTeamCredentialBrokerEligibility({
          ...request,
          projectModels: projectCurrentModels,
          ...(signal ? { signal } : {}),
        });
    // A cancelled joiner must not wait again for another caller's transport.
    const admitted = observation.admitted;
    const current = admitted ? (input.getAccountSettingsSnapshot ?? getActiveAccountSettingsSnapshot)() : null;
    if (admitted && (signal?.aborted || current?.scopeKey !== admitted.scopeKey
      || !input.getAccountSettingsSnapshot && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken
      || !sameProviderConnectionsCatalogAuthority(admitted.providerConnectionsCatalog, current?.providerConnectionsCatalog))) {
      return { status: 'unavailable', reason: 'source_unavailable' };
    }
    return DaemonProviderTeamCredentialBrokerEligibilityResponseV1Schema.parse(result);
  };

  const resolveBrokerSourceSelection: RuntimeProviderModelManagementServices['resolveTeamCredentialBrokerSourceSelection'] = async (request) => {
    request.signal.throwIfAborted();
    const snapshot = await readAdmittedSnapshot(undefined, request.signal, false);
    if (!snapshot || !input.featureGate.isEnabled('providers') || request.machineId !== input.machineId) return null;
    const lease = await (input.acquireRuntimeLease ? input.acquireRuntimeLease()
      : acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir }));
    try {
    if (typeof lease.registry.generation !== 'number') return null;
    const registry = resolveProviderContributionRegistryView(lease.registry.contributes, lease.registry.generation, lease.registry.readPluginOccurrenceId);
    const observation = await readProviderConnectionSourceCatalog({ machineId: request.machineId,
      source: { connectionId: request.source.connectionId, expectedConnectionSecurityFingerprint: request.source.connectionSecurityFingerprint },
      snapshot, registry, runtime: sharedRuntime, lifetime: createProviderOperationLifetime({ signal: request.signal }),
      resolveAddresses: input.resolveAddresses, refreshPolicy: 'current_only' });
    if (observation.status !== 'success') return null;
    const projection = projectProviderConnectionSourceCatalog({ observation, registry, delivery: 'brokered',
      localModelManagementEnabled: input.featureGate.isEnabled('providers.localModelManagement'), request: {
      machineId: request.machineId,
      agentTargetKey: request.application.agentTargetKey,
      application: request.application,
      providerConnection: {
        connectionId: request.source.connectionId,
        expectedConnectionSecurityFingerprint: request.source.connectionSecurityFingerprint,
      },
      includeDirectMaterialization: true,
      sourceCatalog: true,
      refreshPolicy: 'current_only',
    } });
    request.signal.throwIfAborted();
    if (projection.status !== 'success') return null;
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
          expectedApplication: request.application,
        });
        if (!brokerApplication || !pluginJsonValuesEqual(brokerApplication, request.application)) return [];
        return [{
          endpointTemplateId: row.directMaterialization.endpoint.endpointTemplateId,
          protocol: row.directMaterialization.endpoint.protocol,
          credentialTransport: row.directMaterialization.credentialTransport,
        }];
      });
    });
    const current = (input.getAccountSettingsSnapshot ?? getActiveAccountSettingsSnapshot)();
    if (current?.scopeKey !== snapshot.scopeKey
      || !sameProviderConnectionsCatalogAuthority(snapshot.providerConnectionsCatalog, current?.providerConnectionsCatalog)) return null;
    return candidates.length === 1 ? Object.freeze(candidates[0]!) : null;
    } finally { await lease.release(); }
  };

  const mutateModelSettings = async (
    request: DaemonProviderModelSettingsMutationRequestV1,
    signal?: AbortSignal,
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

    const lifetime = createProviderOperationLifetime({ signal });
    try {
      if (request.action === 'manualAdd') {
        const snapshot = await awaitWithinProviderOperation(readAdmittedSnapshot(undefined, signal), lifetime);
        const read = snapshot ? readProviderSettingsForCli(snapshot) : null;
        const connection = read?.settings.connections.find((candidate) => candidate.id === request.connectionId);
        if (!connection) {
          return { status: 'error', error: createProviderErrorV1('provider_connection_not_found', context) };
        }
        if (connection.revision !== request.expectedConnectionRevision) {
          return { status: 'error', error: createProviderErrorV1('provider_connection_changed', context) };
        }
        const catalog = resolveProviderManualModelCatalog(
          await awaitWithinProviderOperation(resolveManagementRegistry(), lifetime),
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
        if (signal?.aborted) throw new ProviderOperationAbandonedError('cancelled');
        return input.modelSettingsMutation({ ...request, expectedManualSource });
      }

      if (request.action === 'confirmExperimental') {
        const projection = await projectModels({
          machineId: request.machineId,
          agentTargetKey: request.agentTargetKey,
          ...(request.connectedAccountTarget
            ? { connectedAccountTarget: request.connectedAccountTarget, refreshPolicy: 'current_only' as const }
            : { sourceConnectionId: request.connectionId }),
          mode: 'management',
        }, undefined, signal);
        if (signal?.aborted) throw new ProviderOperationAbandonedError('cancelled');
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

      if (signal?.aborted) throw new ProviderOperationAbandonedError('cancelled');
      return input.modelSettingsMutation(request);
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) return { status: 'error',
        error: createProviderErrorV1('provider_catalog_unavailable', context) };
      throw error;
    }
  };

  const resolveBindingStatus = async (
    request: DaemonProviderBindingStatusRequestV1,
    context?: Pick<RpcHandlerContext, 'signal' | 'reportOperationDiagnostics'>,
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
    const diagnostics = createProviderOperationPhaseObserver(context?.reportOperationDiagnostics);
    const lifetime = { ...createProviderOperationLifetime({ signal: context?.signal,
      wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs }), diagnostics };
    try {
      return await awaitAbortableWithinProviderOperation(async (signal): Promise<DaemonProviderBindingStatusResponseV1> => {
        const operationLifetime = { ...lifetime, signal };
        const snapshot = await observeProviderOperationPhase(operationLifetime, 'catalog', () =>
          awaitWithinProviderOperation(readAdmittedSnapshot(undefined, signal), operationLifetime));
        if (!snapshot) {
          return {
            status: 'connection_missing',
            error: createProviderErrorV1('provider_connection_not_found', errorContext),
          };
        }
        const target = parseBackendTargetKeyV2(request.agentTargetKey);
        const pendingLease = input.acquireRuntimeLease
          ? input.acquireRuntimeLease()
          : acquireAuthoritativePluginRuntimeRegistryLease({
              happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir,
            });
        let lease: Awaited<typeof pendingLease>;
        try {
          lease = await observeProviderOperationPhase(operationLifetime, 'registry', () =>
            awaitWithinProviderOperation(pendingLease, operationLifetime));
        } catch (error) {
          void pendingLease.then((lateLease) => lateLease.release(), () => {});
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
          await observeProviderOperationPhase(operationLifetime, 'registry', () => awaitWithinProviderOperation(
            activateAgentRuntimeContributionOnDemand(lease.registry, agentId), operationLifetime,
          ));
          const registry = resolveProviderContributionRegistryView(
            lease.registry.contributes,
            lease.registry.generation,
            lease.registry.readPluginOccurrenceId,
          );
          const providerSettings = readProviderSettingsForCli(snapshot).settings;
          let dnsEvidenceByEndpointUrl;
          try {
            dnsEvidenceByEndpointUrl = await observeProviderOperationPhase(operationLifetime, 'dns', () => collectProviderConnectionDnsEvidence({
              connectionId,
              machineId: request.machineId,
              providerSettings,
              registry,
              ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
              admitResolution: sharedRuntime.probeInfrastructure.scheduler.runDns,
              isCurrent: () => input.featureGate.isEnabled('providers'),
              lifetime: operationLifetime,
            }));
          } catch (error) {
            if (error instanceof ProviderProbeAdmissionCapacityError) {
              return {
                status: 'incompatible',
                error: createProviderErrorV1('provider_probe_capacity_exhausted', errorContext),
              };
            }
            throw error;
          }
          const connectionResolution = resolveProviderConnectionForMachine({
            connectionId,
            machineId: request.machineId,
            providerSettings,
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
            const { deployment } = connectionResolution.record;
            const resolveBindingIntent = input.resolveManagedPurposeBindingIntent;
            if (!resolveBindingIntent) {
              const error = createProviderErrorV1(
                'provider_connection_invalid',
                errorContext,
              );
              return { status: 'incompatible', error };
            }
            try {
              managedPurposeBindingSnapshot =
                await observeProviderOperationPhase(operationLifetime, 'purpose_bindings', () =>
                  awaitAbortableWithinProviderOperation(signal => resolveManagedProviderPurposeBindingSnapshot({
                    implementationIdentity: deployment.implementationIdentity,
                    connectedAccounts: deployment.managedRuntime.connectedAccounts,
                    purposeBindingIntents: deployment.purposeBindingIntents,
                    resolveBindingIntent,
                    signal,
                  }), operationLifetime));
              managedProviderRuntime = await observeProviderOperationPhase(operationLifetime, 'managed_runtime', () =>
                awaitWithinProviderOperation(Promise.resolve(lease.registry.acquireManagedProviderRuntime?.(
                  deployment.implementationIdentity,
                )), operationLifetime)) ?? undefined;
              if (!managedProviderRuntime?.isCurrent()) {
                throw new Error('Managed Provider runtime is unavailable');
              }
            } catch (error) {
              return { status: 'incompatible', error: providerManagedPurposeBindingError(error, errorContext) };
            }
          }
          let runtimeCatalogSelection: Awaited<ReturnType<typeof resolveProviderRuntimeCatalogSelectionObservation>>;
          try {
            runtimeCatalogSelection = await observeProviderOperationPhase(operationLifetime, 'catalog', () =>
              awaitAbortableWithinProviderOperation(signal => resolveProviderRuntimeCatalogSelectionObservation({
                selection: request.selection,
                machineId: request.machineId,
                accountSettings: snapshot.settings,
                savedSecretResources: snapshot.savedSecretResources,
                savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot, {
                  isCurrent: () => !operationLifetime.signal?.aborted,
                }),
                providerSettings,
                registry,
                dnsEvidenceByEndpointUrl,
                runtimeStateStore: sharedRuntime.runtimeStore,
                ...(input.readModelProjection ? { readModelProjection: input.readModelProjection } : {}),
                signal,
                ...(input.resolveManagedPurposeBindingIntent
                  ? { resolveManagedPurposeBindingIntent: input.resolveManagedPurposeBindingIntent }
                  : {}),
                ...(managedPurposeBindingSnapshot ? { managedPurposeBindingSnapshot } : {}),
              }), operationLifetime));
          } catch (error) {
            if (error instanceof ProviderOperationAbandonedError) throw error;
            const parsed = ProviderErrorV1Schema.safeParse(error);
            return { status: 'incompatible', error: parsed.success ? parsed.data
              : createProviderErrorV1('provider_endpoint_unavailable', errorContext) };
          }
          const resolved = resolveProviderSpawnAuthorization({
            selection: request.selection,
            machineId: request.machineId,
            agentTargetKey: request.agentTargetKey,
            agentId,
            accountSettings: snapshot.settings,
            savedSecretResources: snapshot.savedSecretResources,
            savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot, {
              isCurrent: () => !operationLifetime.signal?.aborted,
            }),
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
          await observeProviderOperationPhase(operationLifetime, 'registry', () => lease.release());
        }
      }, lifetime);
    } catch (error) {
      if (error instanceof ProviderOperationAbandonedError) {
        return { status: 'incompatible', error: createProviderErrorV1('provider_catalog_unavailable', errorContext) };
      }
      throw error;
    } finally { diagnostics.finish(); }
  };

  const projectModelsForAccount: RuntimeProviderModelManagementServices['projectModelsForAccount'] =
    (request, context) => projectModels({ ...request, refreshPolicy: request.forceRefresh ? undefined : 'current_only' }, context);
  const nativeSourceServices = createTeamCredentialNativeSourceServices({ machineId: input.machineId,
    isFeatureEnabled: () => input.featureGate.isEnabled('providers'),
    context: input.teamCredentialNativeSource,
    getAccountSettingsSnapshot: input.getAccountSettingsSnapshot ?? getActiveAccountSettingsSnapshot,
    acquireRuntimeLease: input.acquireRuntimeLease ?? (() => acquireAuthoritativePluginRuntimeRegistryLease({
      happyHomeDir: input.happyHomeDir ?? configuration.happyHomeDir })),
    projectSourceModels: (request, signal) => projectModels(request, undefined, signal),
    resolveAddresses: input.resolveAddresses,
  });
  return Object.freeze({
    probe: sharedRuntime.probe,
    probeDraft: sharedRuntime.probeDraft,
    models: sharedRuntime.models,
    summary: sharedRuntime.summary,
    resolveCatalogContext: sharedRuntime.resolveCatalogContext,
    projectModels: (request: DaemonProviderModelProjectionRequestV1, signal?: AbortSignal, context?: RpcHandlerContext) =>
      projectModels(request, undefined, signal, undefined, context),
    projectModelsForAccount,
    prepareTeamCredentialNativeSource: nativeSourceServices.prepare,
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
