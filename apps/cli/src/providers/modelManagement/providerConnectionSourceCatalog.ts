import type { DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ProviderModelBindingSourceV1Schema, projectProviderModelSourceStateV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { getProviderExperimentalConfirmationCatalogSourceKeyV1 } from '@happier-dev/protocol/providers/settings/v1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { collectProviderConnectionDnsEvidence } from '@/providers/registry/dnsEvidence';
import { resolveProviderConnectionSecurityFingerprintMatch } from '@/providers/registry';
import { resolveProviderSourceFacts } from '@/providers/registry/sourceFacts';
import { readProviderModelNameCatalog } from '@/providers/registry/contributions';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { assembleProviderConnectionCatalog, projectProviderCatalogForPicker, readProviderConnectionCatalogPresentation } from '@/providers/catalog';
import { awaitWithinProviderOperation, type ProviderOperationLifetime } from '@/providers/operationLifetime';
import { projectProviderCatalogContextRuntimeState, type RuntimeProviderServices, type RuntimeProviderOperationScope } from '@/providers/probe/runtimeServices';
import { projectProviderBrokerApplication } from '@/providers/broker/applicationProjection';
import { projectProviderConnectionBrokerApplication } from '@/providers/broker/providerConnectionCpxBridge';

type SourceInput = Readonly<{
  machineId: string;
  source: NonNullable<DaemonProviderModelProjectionRequestV1['providerConnection']>;
  snapshot: ActiveAccountSettingsSnapshot;
  registry: ProviderContributionRegistryView;
  runtime: RuntimeProviderServices;
  lifetime: ProviderOperationLifetime;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  refreshPolicy?: 'current_only';
  forceRefresh?: boolean;
  accountScope?: Pick<RuntimeProviderOperationScope, 'getAccountSettingsSnapshot' | 'resolveManagedPurposeBindingIntent'
    | 'isAccountCurrent' | 'savedSecretOperationContext' | 'managedRuntimeAccount'>;
}>;

/** The incumbent resolver and catalog merge own grants, DNS, observations and
 * source membership. Source observation has no Agent input. */
export async function readProviderConnectionSourceCatalog(input: SourceInput) {
  const settingsRead = readProviderSettingsForCli(input.snapshot);
  const identity = { machineId: input.machineId, connectionId: input.source.connectionId };
  const evidence = await collectProviderConnectionDnsEvidence({ ...identity, providerSettings: settingsRead.settings,
    registry: input.registry, resolveAddresses: input.resolveAddresses,
    admitResolution: input.runtime.probeInfrastructure.scheduler.runDns, lifetime: input.lifetime });
  const scope: RuntimeProviderOperationScope = { ...input.accountScope, registry: input.registry, lifetime: input.lifetime,
    dnsEvidenceByConnectionId: new Map([[identity.connectionId, evidence]]),
    ...(input.snapshot.scopeKey ? { accountSettingsBasis: { scopeKey: input.snapshot.scopeKey,
      settingsVersion: input.snapshot.settingsVersion, providerConnectionsCatalog: input.snapshot.providerConnectionsCatalog,
      accountSettings: input.snapshot.settings, settingsRead } } : {}),
  };
  let context = await awaitWithinProviderOperation(input.runtime.resolvePresentationCatalogContext(identity,
    await input.runtime.runtimeStore.read(), scope, { snapshot: input.snapshot, settingsRead,
      resolveManagedPurposeBindingIntent: input.accountScope?.resolveManagedPurposeBindingIntent,
      modelNameCatalog: readProviderModelNameCatalog(input.registry) }), input.lifetime);
  if (context.status === 'error') return context;
  const sourceFingerprint = resolveProviderConnectionSecurityFingerprintMatch(context.connection, input.source.expectedConnectionSecurityFingerprint);
  if (!sourceFingerprint.matches) {
    return { status: 'error' as const, error: createProviderErrorV1('provider_connection_changed', identity) };
  }
  if (!context.connection.authorization.authorized) {
    return { status: 'success' as const, context, sourceFingerprints: sourceFingerprint.fingerprints, presentation: { rows: [], staleRows: [] } };
  }
  const present = () => {
    if (context.status !== 'success') throw new TypeError('Expected admitted source');
    return readProviderConnectionCatalogPresentation({ connection: context.connection, providerSettings: context.providerSettings,
      runtimeState: context.runtimeState, catalogRuntimeKey: context.catalogRuntimeKey, modelNameCatalog: context.modelNameCatalog });
  };
  let presentation = present();
  const cold = presentation.rows.length === 0 && (context.catalogRuntimeRecord?.state.snapshot ?? null) === null;
  if (input.refreshPolicy !== 'current_only' && (input.forceRefresh || cold)) {
    const error = await awaitWithinProviderOperation(input.runtime.scheduleDemandRefresh(identity,
      input.forceRefresh ? 'manual_refresh' : 'picker_open', scope), input.lifetime);
    if (error) return { status: 'error' as const, error };
    context = projectProviderCatalogContextRuntimeState(context, await input.runtime.runtimeStore.read());
    presentation = present();
  }
  return { status: 'success' as const, context, sourceFingerprints: sourceFingerprint.fingerprints, presentation };
}

/** Binds source declarations to an application label, never to an Agent
 * compatibility decision. The same result feeds catalog reads and acquisition. */
export function projectProviderConnectionSourceCatalog(input: Readonly<{
  observation: Extract<Awaited<ReturnType<typeof readProviderConnectionSourceCatalog>>, { status: 'success' }>;
  registry: ProviderContributionRegistryView;
  request: DaemonProviderModelProjectionRequestV1;
  delivery: 'direct' | 'brokered';
  localModelManagementEnabled: boolean;
}>): DaemonProviderModelProjectionResponseV1 {
  const { context, presentation } = input.observation;
  const record = context.connection;
  const facts = resolveProviderSourceFacts(record);
  const modelLoad = record.source.kind === 'contribution' ? record.source.definition.modelLoad : undefined;
  const groupBase = { connectionId: record.connectionId,
    providerName: record.source.kind === 'contribution' ? record.source.definition.name : record.source.template.name,
    connectionName: record.displayName, connectionRole: record.connection.role, connectionDisplayNameMode: record.connection.displayNameMode,
    connectionRevision: record.connection.revision,
    modelLoadAction: modelLoad
      ? input.localModelManagementEnabled ? 'available' as const : 'feature_disabled' as const
      : 'descriptor_absent' as const,
    modelLoadPreflightPolicy: modelLoad?.preflightPolicy ?? null,
    manualModelPolicy: facts.catalog.manualModelPolicy, supportsFreeformModelIds: false, suppressedConnectedServiceIds: [] };
  if (!record.authorization.authorized) {
    return DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey: input.request.agentTargetKey,
      groups: [{ ...groupBase, authorization: { authorized: false,
        error: createProviderErrorV1(record.authorization.errorCode, { machineId: input.request.machineId, connectionId: record.connectionId }) }, rows: [] }] });
  }
  if (!input.request.application) {
    const groups = [...new Set(facts.endpointTemplates.map(endpoint => endpoint.protocol))].flatMap(protocol => {
      const application = input.delivery === 'brokered'
        ? projectProviderConnectionBrokerApplication({ registry: input.registry, agentTargetKey: input.request.agentTargetKey, protocol })
        : projectProviderBrokerApplication({ connection: record, agentTargetKey: input.request.agentTargetKey, protocol });
      if (!application) return [];
      const projection = projectProviderConnectionSourceCatalog({ ...input, request: { ...input.request, application } });
      return projection.status === 'success' ? projection.groups : [];
    });
    return DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey: input.request.agentTargetKey, groups });
  }
  const endpoints = facts.endpointTemplates.filter(endpoint => !input.request.application || endpoint.protocol === input.request.application.protocol);
  const endpoint = endpoints[0];
  if (!endpoint) return { status: 'error', error: createProviderErrorV1('provider_incompatible_with_agent') };
  const application = input.delivery === 'brokered'
    ? projectProviderConnectionBrokerApplication({ registry: input.registry, agentTargetKey: input.request.agentTargetKey,
      protocol: endpoint.protocol, expectedApplication: input.request.application })
    : projectProviderBrokerApplication({ connection: record, agentTargetKey: input.request.agentTargetKey, protocol: endpoint.protocol });
  if (!application || input.request.application && !pluginJsonValuesEqual(application, input.request.application)) {
    return { status: 'error', error: createProviderErrorV1('provider_incompatible_with_agent') };
  }
  const sourceFacts = ProviderModelBindingSourceV1Schema.parse({ endpoint: { id: endpoint.id, protocol: endpoint.protocol, capabilities: endpoint.capabilities },
    ...(facts.credential ? { credential: facts.credential } : {}),
    compatibilityOverrides: facts.compatibilityOverrides?.filter(override => override.agentTargetKey === input.request.agentTargetKey && override.protocol === endpoint.protocol),
  });
  const compatibilityByModelId = new Map([...presentation.rows, ...presentation.staleRows].map(row => [
    row.row.descriptor.id, projectProviderModelSourceStateV1(sourceFacts, row.row.descriptor),
  ]));
  const catalog = assembleProviderConnectionCatalog({ agentTargetKey: input.request.agentTargetKey,
    connection: record, providerSettings: context.providerSettings, runtimeState: context.runtimeState,
    catalogRuntimeKey: context.catalogRuntimeKey, modelNameCatalog: context.modelNameCatalog, compatibilityByModelId });
  // Only explicit presentation exceptions may retain absent source models.
  // Broker/launch reads carry none and therefore still see current membership.
  const rows = projectProviderCatalogForPicker({ catalogs: [catalog], modelVisibilityByRef: {}, mode: 'management',
    currentSelection: input.request.currentSelection, favoriteSelections: input.request.favoriteSelections,
  }).groups.flatMap(group => group.rows);
  const states = rows.map(row => compatibilityByModelId.get(row.ref.modelId)!);
  const sourceRevision = computeCanonicalDomainSeparatedDigest('happier.team-credential-provider-model-catalog.v1', [
    record.connectionSecurityFingerprint, record.endpointSetFingerprint, String(record.connection.revision),
    record.source.kind === 'contribution' ? input.registry.providerActivationOccurrenceIdsByPluginId?.get(record.source.pluginId) ?? 'no-provider-activation-occurrence' : 'custom-provider',
    JSON.stringify(rows.map((row, index) => ({ descriptor: row.descriptor, catalog: row.presentation.catalog,
      compatibilityFingerprint: states[index]!.compatibilityFingerprint, selectedProtocol: endpoint.protocol }))),
  ]);
  const transports = facts.credential?.transports.filter(transport => transport.protocols.includes(endpoint.protocol) && transport.uses.includes('runtime')) ?? [];
  // A direct export witness needs one declared transport. Source observation
  // cannot choose between transports using an Agent installed on the broker.
  const directEndpoint = record.deployment.kind !== 'managedLocal' ? record.endpoints.find(candidate => candidate.endpointTemplateId === endpoint.id) : null;
  return DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey: input.request.agentTargetKey,
    groups: [{ ...groupBase,
      ...(record.source.kind === 'contribution' ? { sourceAuthority: { provider: { identity: { pluginId: record.source.pluginId,
        localId: record.source.definition.id }, definitionRevision: 1 }, connectionSecurityFingerprint: record.connectionSecurityFingerprint } } : {}),
      sourceRevision, authorization: { authorized: true },
      rows: rows.map((row, index) => ({ ref: row.ref,
        descriptor: row.descriptor, sources: row.sources, confidence: row.confidence, application,
        ...(row.gatewaySlots ? { gatewaySlots: row.gatewaySlots } : {}),
        sourceFacts: { ...sourceFacts, endpoint: { ...sourceFacts.endpoint, id: application.endpointTemplateId } },
        confirmationSource: { connectionId: record.connectionId, catalogSourceKey: getProviderExperimentalConfirmationCatalogSourceKeyV1({ connectionId: record.connectionId }) },
        compatibility: states[index], endpointHealth: 'not_checked', catalog: row.presentation.catalog, loadState: row.presentation.loadState, visibility: 'visible',
        ...(input.request.includeDirectMaterialization && directEndpoint && transports.length === 1 ? { directMaterialization: {
          endpoint: { endpointTemplateId: directEndpoint.endpointTemplateId, normalizedUrl: directEndpoint.normalizedUrl, protocol: directEndpoint.protocol, publicHeaders: directEndpoint.publicHeaders },
          credentialTransport: transports[0],
        } } : {}),
      })),
    }], currentSelectionRecovery: null });
}
