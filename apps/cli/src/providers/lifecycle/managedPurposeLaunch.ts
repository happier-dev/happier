import { readSessionModelSelectionProviderConnectionId, type SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { join } from 'node:path';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createProviderErrorV1, ProviderErrorV1Schema, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { resolveProviderBindingCompatibilityFromSourceFactsV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import type { ConnectedServiceBindingsV2, PluginExecutionScopeV1, SessionEnvOverlayV1, ProviderBoundModelRef } from '@happier-dev/protocol';
import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import { resolveAgentManagedPurposeSelections } from '@/providers/managed/agentPurposeSelections';
import { readLeasedAgentProviderBindingAdapter, prepareLeasedAgentProviderBinding, materializeLeasedAgentProviderBinding, readLeasedAgentProviderNativeHome } from '@/plugins/runtime/providerBindings/adapter';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { getProviderContribution } from '@/providers/registry/lookup';
import { readConnectedAccountModelCatalog, type ResolveManagedProviderPurposeBindingIntentSelection } from '@/providers/modelManagement/connectedAccountCatalog';
import { resolveProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol/providers/contributions';
import { resolveManagedProviderPurposeBindingSnapshot } from '@/providers/managed/resolvePurposeBindingSnapshot';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { acquireBrokerSourceOperation } from '@/providers/broker/brokerSourceOperationAcquisition';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import { providerBrokerLocalCredentialRequirement } from '@/providers/broker/providerBrokerPrivateProtocol';
import { composeProviderBindingMaterialization } from '@/providers/spawn/compose';
import { resolveProviderCompatibilityConfirmation } from '@/providers/catalog/compatibility';
import type { ProviderSettingsV1 } from '@happier-dev/protocol';
import { createProviderLaunchResourceScope } from './resourceScope';
import type { ProviderRuntimeModelProjectionReader } from '@/providers/spawn/runtimeCatalog';

export type ManagedPurposeLaunchContext = Readonly<{
  lease: PluginRuntimeRegistryLease;
  happyHomeDir: string;
  readProviderSettings?: () => ProviderSettingsV1 | null | Promise<ProviderSettingsV1 | null>;
  readModelProjection?: ProviderRuntimeModelProjectionReader;
  accountAuthority?: import('@/plugins/runtime/providerBindings/runtimeTypes').ManagedProviderInvocationAccountAuthority | null;
  signal?: AbortSignal;
  resolveManagedPurposeBindingIntentSelection?: ResolveManagedProviderPurposeBindingIntentSelection;
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
  selection: ProviderBoundModelRef;
  model: AgentSessionProviderBinding['model'];
  connectedServices: ConnectedServiceBindingsV2;
  materialize(scope: Extract<PluginExecutionScopeV1, { kind: 'session' | 'execution_run' }>): Promise<MaterializedManagedPurposeLaunch | Readonly<{ ok: false; error: ProviderErrorV1 }>>;
}>;

/** Admits an Agent-declared source through the existing catalog, purpose and
 * managed broker custody owners. It never creates a Provider connection. */
export async function prepareManagedPurposeLaunch(input: ManagedPurposeLaunchContext & Readonly<{
  agentId: string;
  featureEnabled: import('./prepareLaunch').PrepareProviderLaunchInput['featureEnabled'];
  machineId?: string;
  selection?: SessionModelSelection;
  resolveSelectionTarget(): Readonly<{ agentTargetKey: string; selection: SessionModelSelection }> | null;
  connectedServices: ConnectedServiceBindingsV2 | null;
}>): Promise<PreparedManagedPurposeLaunch | Readonly<{ ok: false; error: ProviderErrorV1 }> | null> {
  if (input.selection?.v === 2 && input.selection.ref.source === 'team_resource') return null;
  const candidates = resolveAgentManagedPurposeSelections({ contributions: input.lease.registry.contributes,
    agentId: input.agentId, connectedServices: input.connectedServices, selection: input.selection });
  if (candidates.length === 0) return null;
  const refuse = (code: Parameters<typeof createProviderErrorV1>[0], cause?: unknown) => ({ ok: false as const,
    error: createProviderErrorV1(code, input.machineId ? { machineId: input.machineId } : {}, cause) });
  if ((typeof input.featureEnabled === 'function' ? await input.featureEnabled() : input.featureEnabled) !== true) return refuse('provider_feature_disabled');
  if (!input.selection) return refuse('model_selection_required');
  const selectedTarget = input.resolveSelectionTarget();
  if (!selectedTarget) return refuse('provider_incompatible_with_agent');
  const { agentTargetKey, selection: canonicalSelection } = selectedTarget;
  if (!input.machineId || !input.resolveManagedPurposeBindingIntentSelection) return refuse('provider_endpoint_unavailable');
  const machineId = input.machineId;
  const signal = input.signal ?? new AbortController().signal;
  const registry = resolveProviderContributionRegistryView(input.lease.registry.contributes, undefined);
  await activateAgentRuntimeContributionOnDemand(input.lease.registry, input.agentId);
  const adapter = readLeasedAgentProviderBindingAdapter(input);
  if (!adapter) return refuse('provider_incompatible_with_agent');
  const admitted = [];
  let unconfirmed = false;
  let catalogError: ProviderErrorV1 | undefined;
  for (const candidate of candidates) {
    const route = candidate.declaration.managedProviderEndpoint!;
    const provider = getProviderContribution(registry, buildQualifiedPluginContributionKey(route.provider));
    if (!provider?.definition.managedRuntime) return refuse('provider_contribution_unavailable');
    const catalog = await readConnectedAccountModelCatalog({ registry, provider, purpose: route.purpose,
      request: { machineId: input.machineId, agentTargetKey: agentTargetKey,
        connectedAccountTarget: candidate.binding.target, mode: 'management', includeDirectMaterialization: true },
      resolveSelection: input.resolveManagedPurposeBindingIntentSelection, readModelProjection: input.readModelProjection, signal });
    if (catalog.error) { catalogError ??= catalog.error; continue; }
    const selectedModelId = canonicalSelection.ref.modelId;
    const modelId = route.modelIdPrefix && selectedModelId.startsWith(route.modelIdPrefix)
      ? selectedModelId.slice(route.modelIdPrefix.length) : selectedModelId;
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
        declaredManagedModel: group.source.family.staticModels?.some(model => model.id === row.descriptor.id) === true,
        providerSettings: compatibility.result.status === 'experimental' ? await input.readProviderSettings?.() : undefined,
        confirmationSource: row.confirmationSource!, agentTargetKey, modelId: row.descriptor.id });
      if (!confirmed.confirmed) { unconfirmed = true; continue; }
      admitted.push({ candidate, provider, group, row, selection: group.source.selection, catalog, transport, compatibility });
    }
  }
  const chosen = admitted[0];
  if (!chosen) return catalogError ? { ok: false, error: catalogError }
    : refuse(unconfirmed ? 'provider_compatibility_unverified' : 'provider_model_not_found');
  // A single Agent binding consumes one endpoint. Provider endpoint declaration
  // order resolves equivalent accepted protocols, as it does for catalog routing.
  const { candidate, provider, group, row, selection, catalog, transport, compatibility } = chosen;
  const connectedServices = input.connectedServices!;
  const selectedModelRef = { agentTargetKey: canonicalSelection.ref.agentTargetKey,
    providerConnectionId: readSessionModelSelectionProviderConnectionId(canonicalSelection), modelId: canonicalSelection.ref.modelId };
  return { ok: true, kind: 'managedPurpose', agentTargetKey, selection: selectedModelRef,
    model: row.descriptor, connectedServices,
    materialize: async scope => {
  const runtime = resolveProviderManagedRuntimeDeclarationV1({ implementationIdentity: provider.identity,
    managedRuntime: provider.definition.managedRuntime! });
  const family = runtime.connectedAccounts.find(family => family.purpose === candidate.declaration.managedProviderEndpoint!.purpose);
  if (!family) return refuse('provider_contribution_unavailable');
  const exactTarget = { kind: 'account' as const, account: selection.resolved.account };
  const purpose = { consumer: provider.identity, purpose: family.purpose };
  const purposeBindings = await resolveManagedProviderPurposeBindingSnapshot({ implementationIdentity: provider.identity,
    connectedAccounts: [family], purposeBindingIntents: { v: 1, bindings: [{ purpose, target: exactTarget }] },
    resolveBindingIntent: async () => ({ purpose, target: exactTarget }), signal });
  const resources = createProviderLaunchResourceScope();
  try {
    const custody = createManagedProviderExplicitStartCustody({ machineId, happyHomeDir: input.happyHomeDir,
      runtimeRegistryLease: input.lease, accountAuthority: input.accountAuthority });
    const source = await acquireBrokerSourceOperation({ custody, identity: provider.identity,
      contributionKey: buildQualifiedPluginContributionKey(provider.identity), endpointTemplateId: group.application.endpointTemplateId,
      operationClaim: { kind: 'providerBroker', operation: scope }, purposeBindings,
      sourceEnvelopeTransport: runtime.sourceEnvelopeTransport,
      isSourceCurrent: async currentSignal => !currentSignal.aborted && await catalog.isCurrent(),
      callerSignal: signal });
    if (!source) return refuse('provider_endpoint_unavailable');
    if ('unavailable' in source) return refuse('provider_endpoint_unavailable', source.failureCause ? source : undefined);
    resources.register(source.retire);
    resources.register(source.projection.cleanup);
    const endpointUrl = source.projection.access.endpointUrl(group.application.endpointTemplateId);
    if (!endpointUrl) return refuse('provider_endpoint_unavailable');
    const consumer = await startManagedProviderConsumerApplication({ signal, endpointUrl, credentialTransport: transport,
      request: async request => ({ ok: true, response: await source.projection.access.request(request) }) });
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
        && source.isAuthorizationCurrent()
        ? { ok: true } : refuse('provider_authorization_changed') };
  } catch (error) {
    const typed = ProviderErrorV1Schema.safeParse(error);
    return typed.success ? { ok: false, error: typed.data } : refuse('provider_materialization_failed', error);
  } finally { await resources.release(); }
    } };
}
