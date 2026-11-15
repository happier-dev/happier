import type { DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
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
import { readProviderConnectionCatalogPresentation, projectProviderCatalogForPicker } from '@/providers/catalog';
import { awaitWithinProviderOperation, type ProviderOperationLifetime } from '@/providers/operationLifetime';
import { projectProviderCatalogContextRuntimeState, type RuntimeProviderServices, type RuntimeProviderOperationScope } from '@/providers/probe/runtimeServices';
import { projectProviderBrokerApplication } from '@/providers/broker/applicationProjection';
import { projectProviderConnectionBrokerApplication } from '@/providers/broker/providerConnectionCpxBridge';
import type { ProviderBrokerSourceApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createProviderSourceCatalogRevision, type ProviderSourceModelCatalog } from './sourceCatalog';
import { projectProviderCatalogGatewaySlots } from '@/providers/catalog/assemble';

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
    | 'isAccountCurrent' | 'savedSecretOperationContext' | 'managedRuntimeAccount' | 'resolveContributedCatalogParsers'>;
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
  const { context } = input.observation;
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
  const catalogs = projectProviderConnectionSourceModels({ ...input,
    agentTargetKey: input.request.agentTargetKey, application: input.request.application,
    includeDirectMaterialization: input.request.includeDirectMaterialization });
  if (input.request.application && catalogs.length === 0) {
    return { status: 'error', error: createProviderErrorV1('provider_incompatible_with_agent') };
  }
  return DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey: input.request.agentTargetKey,
    groups: catalogs.map(catalog => {
      const bind = (row: ProviderSourceModelCatalog['rows'][number]) => ({
        ref: { agentTargetKey: input.request.agentTargetKey, providerConnectionId: record.connectionId, modelId: row.descriptor.id },
        descriptor: row.descriptor, sources: row.sources, confidence: row.confidence,
        ...(row.gatewaySlots ? { gatewaySlots: row.gatewaySlots } : {}),
        presentation: { compatibility: row.compatibility, endpointHealth: null, catalog: row.catalog, loadState: row.loadState },
      });
      const visible = projectProviderCatalogForPicker({ catalogs: [{ ...groupBase,
        agentTargetKey: input.request.agentTargetKey, authorization: { authorized: true },
        sourceKind: record.source.kind === 'custom' ? 'custom' : record.source.definition.kind,
        rows: catalog.rows.filter(row => !row.catalog.stale).map(bind), staleRows: catalog.rows.filter(row => row.catalog.stale).map(bind),
      }], mode: 'management', modelVisibilityByRef: {}, currentSelection: input.request.currentSelection,
        favoriteSelections: input.request.favoriteSelections }).groups.flatMap(group => group.rows);
      const sourceRows = new Map(catalog.rows.map(row => [row.descriptor.id, row]));
      return { ...groupBase,
      ...(record.source.kind === 'contribution' ? { sourceAuthority: { provider: { identity: { pluginId: record.source.pluginId,
        localId: record.source.definition.id }, definitionRevision: 1 }, connectionSecurityFingerprint: input.observation.sourceFingerprints.connectionSecurityFingerprint } } : {}),
      sourceRevision: catalog.sourceRevision, authorization: { authorized: true },
      rows: visible.map(row => ({ ...sourceRows.get(row.descriptor.id)!, ref: row.ref })),
    }; }), currentSelectionRecovery: null });
}

/** The one source model set, shared by worker projection and external routing. */
export function projectProviderConnectionSourceModels(input: Readonly<{
  observation: Extract<Awaited<ReturnType<typeof readProviderConnectionSourceCatalog>>, { status: 'success' }>;
  registry: ProviderContributionRegistryView;
  delivery: 'direct' | 'brokered';
  agentTargetKey?: string;
  application?: ProviderBrokerSourceApplicationBindingV1;
  includeDirectMaterialization?: true;
}>): readonly ProviderSourceModelCatalog[] {
  const { context, presentation } = input.observation;
  const record = context.connection;
  if (!record.authorization.authorized) return [];
  const facts = resolveProviderSourceFacts(record);
  return [...new Set(facts.endpointTemplates.map(endpoint => endpoint.protocol))].flatMap(protocol => {
    if (input.application && input.application.protocol !== protocol) return [];
    const endpoint = facts.endpointTemplates.find(endpoint => endpoint.protocol === protocol)!;
    const application = input.delivery === 'brokered'
      ? projectProviderConnectionBrokerApplication({ registry: input.registry, agentTargetKey: input.agentTargetKey,
        protocol, expectedApplication: input.application })
      : projectProviderBrokerApplication({ connection: record, agentTargetKey: input.agentTargetKey,
        protocol, expectedApplication: input.application });
    if (!application || input.application && !pluginJsonValuesEqual(application, input.application)) return [];
    const sourceFacts = ProviderModelBindingSourceV1Schema.parse({ endpoint: { id: endpoint.id, protocol, capabilities: endpoint.capabilities,
      ...(endpoint.modelIdPattern !== undefined ? { modelIdPattern: endpoint.modelIdPattern } : {}) },
      ...(facts.credential ? { credential: facts.credential } : {}),
      compatibilityOverrides: facts.compatibilityOverrides,
    });
    const transports = facts.credential?.transports.filter(transport => transport.protocols.includes(protocol) && transport.uses.includes('runtime')) ?? [];
    const directEndpoint = record.deployment.kind !== 'managedLocal' ? record.endpoints.find(candidate => candidate.endpointTemplateId === endpoint.id) : null;
    const rows: ProviderSourceModelCatalog['rows'] = [...presentation.rows, ...presentation.staleRows].map(row => ({
      descriptor: row.row.descriptor, sources: row.row.sources, confidence: row.row.confidence, application,
      gatewaySlots: projectProviderCatalogGatewaySlots(record, row.row),
      sourceFacts: { ...sourceFacts, endpoint: { ...sourceFacts.endpoint, id: application.endpointTemplateId } },
      confirmationSource: { connectionId: record.connectionId, catalogSourceKey: getProviderExperimentalConfirmationCatalogSourceKeyV1({ connectionId: record.connectionId }) },
      compatibility: projectProviderModelSourceStateV1(sourceFacts, row.row.descriptor),
      endpointHealth: 'not_checked', catalog: row.catalog, loadState: row.loadState, visibility: 'visible',
      ...(input.includeDirectMaterialization && directEndpoint && transports.length === 1 ? { directMaterialization: {
        endpoint: { endpointTemplateId: directEndpoint.endpointTemplateId, normalizedUrl: directEndpoint.normalizedUrl, protocol: directEndpoint.protocol, publicHeaders: directEndpoint.publicHeaders },
        credentialTransport: transports[0]!,
      } } : {}),
    }));
    const sourceRevision = createProviderSourceCatalogRevision({
      connectionSecurityFingerprint: input.observation.sourceFingerprints.connectionSecurityFingerprint,
      endpointSetFingerprint: record.endpointSetFingerprint,
      activationOccurrenceId: record.source.kind === 'contribution'
        ? input.registry.providerActivationOccurrenceIdsByPluginId?.get(record.source.pluginId) ?? 'no-provider-activation-occurrence'
        : 'custom-provider',
      rows: rows.map(row => ({ descriptor: row.descriptor, catalog: row.catalog,
        compatibilityFingerprint: row.compatibility.compatibilityFingerprint, selectedProtocol: protocol })),
    });
    return [{ application, sourceRevision, rows }];
  });
}
