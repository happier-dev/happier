import type { ConnectedAccountSessionModelRefV2, SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { join } from 'node:path';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createProviderErrorV1, ProviderErrorV1Schema, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { resolveProviderBindingCompatibilityFromSourceFactsV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import type { ConnectedServiceBindingsV2, PluginExecutionScopeV1, SessionEnvOverlayV1 } from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { openConnectedAccountProviderTransport } from '@/providers/broker/connectedAccountTransport';
import type { ProviderConnectionHttpTransport } from '@/providers/broker/providerConnectionHttpTransport';
import type { resolveProviderAddresses } from '@/providers/registry/dnsEvidence';
import { readLeasedAgentProviderBindingAdapter, prepareLeasedAgentProviderBinding, materializeLeasedAgentProviderBinding, readLeasedAgentProviderNativeHome } from '@/plugins/runtime/providerBindings/adapter';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { readConnectedAccountModelCatalog, readProviderConnectedAccountSessionBindings, type ResolveManagedProviderPurposeBindingIntentSelection } from '@/providers/modelManagement/connectedAccountCatalog';
import { resolveProviderManagedRuntimeFromContributionV1 } from '@happier-dev/protocol/providers/contributions';
import { resolveManagedProviderPurposeBindingSnapshot } from '@/providers/managed/resolvePurposeBindingSnapshot';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { acquireBrokerSourceOperation } from '@/providers/broker/brokerSourceOperationAcquisition';
import { startManagedProviderConsumerApplication, type ExposeManagedProviderConsumerEndpoint } from '@/providers/broker/managedProviderConsumerApplication';
import { providerBrokerLocalCredentialRequirement } from '@/providers/broker/providerBrokerPrivateProtocol';
import { composeProviderBindingMaterialization } from '@/providers/spawn/compose';
import { resolveProviderCompatibilityConfirmation } from '@/providers/catalog/compatibility';
import type { ProviderSettingsV1 } from '@happier-dev/protocol';
import { createProviderLaunchResourceScope } from './resourceScope';
import type { ProviderRuntimeModelProjectionReader } from '@/providers/spawn/runtimeCatalog';
import { createConnectedAccountModelObserver, type ObserveConnectedAccountSourceModels } from '@/providers/modelManagement/connectedAccountModelObservation';

export type ManagedPurposeLaunchContext = Readonly<{
  lease: PluginRuntimeRegistryLease;
  happyHomeDir: string;
  readProviderSettings?: () => ProviderSettingsV1 | null | Promise<ProviderSettingsV1 | null>;
  readModelProjection?: ProviderRuntimeModelProjectionReader;
  accountAuthority?: import('@/plugins/runtime/providerBindings/runtimeTypes').ManagedProviderInvocationAccountAuthority | null;
  signal?: AbortSignal;
  resolveManagedPurposeBindingIntentSelection?: ResolveManagedProviderPurposeBindingIntentSelection;
  purposeBindings?: Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings'>;
  connectedAccountRequestAuth?: Pick<ConnectedAccountRequestAuthService, 'lookupRequestAuth' | 'refreshAfterAuthFailure'>;
  providerConnectionHttpTransport?: ProviderConnectionHttpTransport;
  observeConnectedAccountSourceModels?: ObserveConnectedAccountSourceModels;
  resolveProviderAddresses?: typeof resolveProviderAddresses;
}>;

export type MaterializedManagedPurposeLaunch = Readonly<{
  ok: true;
  kind: 'managedPurpose';
  agentTargetKey: string;
  providerBinding: AgentSessionProviderBinding;
  environmentOverlay: SessionEnvOverlayV1;
  additionalRedactionValues: readonly string[];
  connectedServices: ConnectedServiceBindingsV2;
  revalidateBeforeCommit(signal?: AbortSignal): Promise<Readonly<{ ok: true } | { ok: false; error: ProviderErrorV1 }>>;
  cleanup(): Promise<void>;
}>;

export type PreparedManagedPurposeLaunch = Readonly<{
  ok: true;
  kind: 'managedPurpose';
  agentTargetKey: string;
  selection: ConnectedAccountSessionModelRefV2;
  model: AgentSessionProviderBinding['model'];
  connectedServices: ConnectedServiceBindingsV2;
  materialize(scope: Extract<PluginExecutionScopeV1, { kind: 'session' | 'execution_run' }>, exposeEndpoint?: ExposeManagedProviderConsumerEndpoint): Promise<MaterializedManagedPurposeLaunch | Readonly<{ ok: false; error: ProviderErrorV1 }>>;
}>;

/** Admits the selected Provider source through the shared catalog, purpose and broker custody. */
export async function prepareManagedPurposeLaunch(input: ManagedPurposeLaunchContext & Readonly<{
  agentId: string;
  featureEnabled: import('./prepareLaunch').PrepareProviderLaunchInput['featureEnabled'];
  machineId?: string;
  selection?: SessionModelSelection;
  resolveSelectionTarget(): Readonly<{ agentTargetKey: string; selection: SessionModelSelection }> | null;
  connectedServices: ConnectedServiceBindingsV2 | null;
}>): Promise<PreparedManagedPurposeLaunch | Readonly<{ ok: false; error: ProviderErrorV1 }> | null> {
  const requested = input.selection;
  if (requested?.v !== 2 || requested.ref.source !== 'connected_account') return null;
  const connectedRef = requested.ref;
  const refuse = (code: Parameters<typeof createProviderErrorV1>[0], cause?: unknown) => ({ ok: false as const,
    error: createProviderErrorV1(code, input.machineId ? { machineId: input.machineId } : {}, cause) });
  if ((typeof input.featureEnabled === 'function' ? await input.featureEnabled() : input.featureEnabled) !== true) return refuse('provider_feature_disabled');
  const selectedTarget = input.resolveSelectionTarget();
  if (!selectedTarget) return refuse('provider_incompatible_with_agent');
  const { agentTargetKey } = selectedTarget;
  if (!input.machineId || !input.resolveManagedPurposeBindingIntentSelection) return refuse('provider_endpoint_unavailable');
  const machineId = input.machineId;
  const signal = input.signal ?? new AbortController().signal;
  const registry = resolveProviderContributionRegistryView(input.lease.registry.contributes, undefined);
  const candidates = readProviderConnectedAccountSessionBindings({
    registry, connectedServices: input.connectedServices, purpose: connectedRef.purpose,
  });
  if (!candidates.length) return refuse('provider_authorization_changed');
  await activateAgentRuntimeContributionOnDemand(input.lease.registry, input.agentId);
  const adapter = readLeasedAgentProviderBindingAdapter(input);
  if (!adapter) return refuse('provider_incompatible_with_agent');
  const observeModels = input.observeConnectedAccountSourceModels
    ? createConnectedAccountModelObserver({ registry, observe: input.observeConnectedAccountSourceModels,
      resolveContributedCatalogParsers: async identity => {
        const acquired = await input.lease.registry.acquireProviderCatalogParsers?.(identity);
        return acquired ? { pluginId: identity.pluginId, parsersByFormat: acquired.parsersByFormat } : null;
      } })
    : undefined;
  const admitted = [];
  let unconfirmed = false;
  let catalogError: ProviderErrorV1 | undefined;
  for (const candidate of candidates) {
    const { provider, binding } = candidate;
    if (binding.target.kind !== 'account' && binding.target.kind !== 'group') return refuse('provider_authorization_changed');
    const catalog = await readConnectedAccountModelCatalog({ registry, provider, purpose: binding.purpose.purpose,
      endpointTemplateId: connectedRef.endpointTemplateId,
      request: { machineId, agentTargetKey, connectedAccountTarget: binding.target, mode: 'management',
        includeDirectMaterialization: true, refreshPolicy: 'current_only' },
      resolveSelection: input.resolveManagedPurposeBindingIntentSelection, readModelProjection: input.readModelProjection,
      observeModels: provider.definition.managedRuntime ? undefined : observeModels, signal });
    if (catalog.error) { catalogError ??= catalog.error; continue; }
    const modelId = connectedRef.modelId;
    for (const group of catalog.groups) {
      if (!adapter.support.acceptsProtocols.includes(group.application.protocol)) continue;
      const row = group.rows.find(row => row.descriptor.id === modelId || row.descriptor.aliases?.includes(modelId));
      if (!row?.sourceFacts) continue;
      const credential = providerBrokerLocalCredentialRequirement(group.application.protocol, adapter.support);
      if (!credential) continue;
      const transport = credential.transports[0];
      const compatibility = resolveProviderBindingCompatibilityFromSourceFactsV1({
        agentTargetKey: agentTargetKey, agent: adapter.support, adapterVersion: adapter.adapter.adapterVersion,
        endpoints: [row.sourceFacts.endpoint], credential,
        compatibilityOverrides: row.sourceFacts.compatibilityOverrides, model: row.descriptor });
      if (compatibility.result.status === 'incompatible') continue;
      const confirmed = resolveProviderCompatibilityConfirmation({ compatibility,
        declaredManagedModel: group.catalogObserved === true || group.source.family.staticModels?.some(model => model.id === row.descriptor.id) === true,
        providerSettings: compatibility.result.status === 'experimental' ? await input.readProviderSettings?.() : undefined,
        confirmationSource: row.confirmationSource!, agentTargetKey, modelId: row.descriptor.id });
      if (!confirmed.confirmed) { unconfirmed = true; continue; }
      admitted.push({ candidate, provider, group, row, selection: group.source.selection, catalog, transport, compatibility });
    }
  }
  const chosen = admitted[0];
  if (!chosen) return catalogError ? { ok: false, error: catalogError }
    : refuse(unconfirmed ? 'provider_compatibility_unverified' : 'provider_model_not_found');
  const { candidate, provider, group, row, selection, catalog, transport, compatibility } = chosen;
  const connectedServices = input.connectedServices!;
  const selectedModelRef = { ...connectedRef, agentTargetKey, modelId: row.descriptor.id };
  return { ok: true, kind: 'managedPurpose', agentTargetKey, selection: selectedModelRef,
    model: row.descriptor, connectedServices,
    materialize: async (scope, exposeEndpoint) => {
  const exactTarget = { kind: 'account' as const, account: selection.resolved.account };
  const purpose = candidate.binding.purpose;
  const resources = createProviderLaunchResourceScope();
  try {
    const managedRuntime = provider.definition.managedRuntime;
    let source: NonNullable<Awaited<ReturnType<ProviderConnectionHttpTransport['open']>>>;
    const carrierEndpointTemplateId = group.application.endpointTemplateId;
    if (managedRuntime) {
      const custody = createManagedProviderExplicitStartCustody({ machineId, happyHomeDir: input.happyHomeDir,
        runtimeRegistryLease: input.lease, accountAuthority: input.accountAuthority });
      const runtime = resolveProviderManagedRuntimeFromContributionV1({ implementationIdentity: provider.identity,
        definition: { ...provider.definition, managedRuntime }, connectedAccountDeclarations: provider.connectedAccountDeclarations });
      const purposeBindings = await resolveManagedProviderPurposeBindingSnapshot({ implementationIdentity: provider.identity,
        connectedAccounts: [group.source.family], purposeBindingIntents: { v: 1, bindings: [{ purpose, target: exactTarget }] },
        resolveBindingIntent: async () => ({ purpose, target: exactTarget }), signal });
      const acquired = await acquireBrokerSourceOperation({ custody, identity: provider.identity,
        contributionKey: buildQualifiedPluginContributionKey(provider.identity), endpointTemplateId: carrierEndpointTemplateId,
        operationClaim: { kind: 'providerBroker', operation: scope }, purposeBindings,
        sourceEnvelopeTransport: runtime.sourceEnvelopeTransport,
        isSourceCurrent: async currentSignal => !currentSignal.aborted && await catalog.isCurrent(),
        callerSignal: signal });
      if (!acquired) return refuse('provider_endpoint_unavailable');
      if ('unavailable' in acquired) return refuse('provider_endpoint_unavailable', acquired.failureCause ? acquired : undefined);
      source = { ...acquired.projection, retire: acquired.retire };
    } else {
      const { connectedAccountRequestAuth, purposeBindings } = input;
      const { endpoint, requestAuthUses, family } = group.source;
      if (!connectedAccountRequestAuth || !purposeBindings || !endpoint.baseUrl) return refuse('provider_endpoint_unavailable');
      const use = requestAuthUses.find(use => use.purpose === family.purpose);
      if (!use) return refuse('provider_authorization_changed');
      const lease = purposeBindings.activatePurposeBindings({
        subject: { kind: 'operation', operationId: scope.kind === 'session' ? scope.sessionId : scope.executionRunId,
          consumer: provider.identity, ...(scope.kind === 'session' ? { sessionId: scope.sessionId } : {}),
          isCurrent: () => !signal.aborted },
        purposes: [purpose], bindings: [{ purpose, target: exactTarget }],
      });
      resources.register(() => lease.dispose());
      const opened = await openConnectedAccountProviderTransport({
        endpoint, purpose, materialization: use.materialization, bindingLease: lease,
        requestAuth: connectedAccountRequestAuth, signal,
        isCurrent: async currentSignal => !currentSignal?.aborted && await catalog.isCurrent(),
        resolveAddresses: input.resolveProviderAddresses, transport: input.providerConnectionHttpTransport,
      });
      if (!opened) return refuse('provider_endpoint_unavailable');
      source = opened;
    }
    resources.register(source.retire);
    resources.register(source.cleanup);
    const endpointUrl = source.access.endpointUrl(carrierEndpointTemplateId);
    if (!endpointUrl) return refuse('provider_endpoint_unavailable');
    const consumer = await startManagedProviderConsumerApplication({ signal, endpointUrl, credentialTransport: transport, exposeEndpoint,
      request: async request => ({ ok: true, response: await source.access.request(request) }) });
    resources.register(consumer.cleanup);
    const bindingKey = 'connected_account:' + JSON.stringify(candidate.binding.purpose);
    const prepared = prepareLeasedAgentProviderBinding({ ...input,
      input: { v: 1, agentTargetKey: agentTargetKey, bindingKey } });
    const materialization = await materializeLeasedAgentProviderBinding({ ...input, prepared,
      binding: { v: 1, agentTargetKey: agentTargetKey,
        selection: { bindingKey, model: row.descriptor }, contributionKey: buildQualifiedPluginContributionKey(provider.identity),
        endpoint: { endpointTemplateId: group.application.endpointTemplateId, normalizedUrl: consumer.endpointUrl,
          protocol: group.application.protocol, publicHeaders: {} }, runtimeCredentialTransport: transport,
        compatibilityFingerprint: compatibility.compatibilityFingerprint },
      credential: { kind: 'apiKey', transport, value: consumer.credential } });
    const composed = await composeProviderBindingMaterialization({ materialization,
      materializationBaseDir: join(input.happyHomeDir, 'providers', 'materialized'),
      nativeHome: readLeasedAgentProviderNativeHome(input),
      sessionId: scope.kind === 'session' ? scope.sessionId : scope.executionRunId });
    resources.register(composed.takeCleanupOwnership() ?? (() => {}));
    const cleanup = resources.transfer() ?? (async () => {});
    return { ok: true, kind: 'managedPurpose', agentTargetKey: agentTargetKey,
      providerBinding: { source: { kind: 'connected_account', purpose: candidate.binding.purpose, account: selection.resolved.account },
        model: row.descriptor, upstream: { protocol: group.application.protocol, normalizedUrl: consumer.endpointUrl, credential: 'apiKey' },
        materialization: composed.launchMaterialization }, environmentOverlay: composed.providerEnvironmentOverlay,
      additionalRedactionValues: [consumer.credential, consumer.renderedCredential, ...composed.additionalRedactionValues],
      connectedServices, cleanup: async () => { await cleanup(); },
      revalidateBeforeCommit: async currentSignal => !currentSignal?.aborted && consumer.isCurrent()
        && source.isCurrent()
        ? { ok: true } : refuse('provider_authorization_changed') };
  } catch (error) {
    const typed = ProviderErrorV1Schema.safeParse(error);
    return typed.success ? { ok: false, error: typed.data } : refuse('provider_materialization_failed', error);
  } finally { await resources.release(); }
    } };
}
