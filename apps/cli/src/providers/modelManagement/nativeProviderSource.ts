import type { z } from 'zod/mini';
import type { DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { DaemonProviderModelProjectionRequestV1Schema, DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { collectProviderConnectionDnsEvidence } from '@/providers/registry/dnsEvidence';
import { createProviderOperationLifetime } from '@/providers/operationLifetime';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareTeamCredentialNativeProviderSource, type PrepareTeamCredentialNativeProviderSourceResult,
  type PrepareTeamCredentialNativeProviderSourceInput, type TeamCredentialNativeProviderSourceAuthority } from '@/providers/broker/teamCredentialNativeProviderSource';

type DnsEvidence = ReturnType<PrepareTeamCredentialNativeProviderSourceInput['collectDnsEvidence']>;

export type TeamCredentialNativeSourceContext = Readonly<{
  controllerAccountId: string;
  readResource(resourceId: string, signal: AbortSignal): Promise<Omit<TeamCredentialNativeProviderSourceAuthority, 'sourceRevision'> | null>;
}>;

/** One source-custodian service feeds private catalog tickets and actual
 * installation. Catalog projection never reads credential plaintext. */
export function createTeamCredentialNativeSourceServices(input: Readonly<{
  machineId: string;
  isFeatureEnabled(): boolean;
  context?: TeamCredentialNativeSourceContext;
  getAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null;
  acquireRuntimeLease(): Promise<PluginRuntimeRegistryLease>;
  projectSourceModels(request: DaemonProviderModelProjectionRequestV1, signal?: AbortSignal): Promise<DaemonProviderModelProjectionResponseV1>;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
}>) {
  const fail = () => ({ ok: false as const,
    error: createProviderErrorV1('provider_authorization_changed', { machineId: input.machineId }) });
  const sourceRequest = (request: DaemonProviderModelProjectionRequestV1): DaemonProviderModelProjectionRequestV1 => {
    const { nativeSource: _native, ...source } = request;
    return { ...source, includeDirectMaterialization: true, refreshPolicy: 'current_only', forceRefresh: undefined };
  };
  const readResource = async (request: DaemonProviderModelProjectionRequestV1, signal: AbortSignal) => {
    if (!input.isFeatureEnabled() || !request.nativeSource || !request.providerConnection || !input.context || request.machineId !== input.machineId) return null;
    const resource = await input.context.readResource(request.nativeSource.resourceId, signal);
    return resource && resource.resourceId === request.nativeSource.resourceId
      && resource.resourceRevision === request.nativeSource.expectedResourceRevision
      && resource.custodianAccountId === input.context.controllerAccountId
      && resource.source.kind === 'provider_connection'
      && resource.source.connectionId === request.providerConnection.connectionId
      && resource.source.connectionSecurityFingerprint === request.providerConnection.expectedConnectionSecurityFingerprint
      ? resource : null;
  };
  const activateTarget = async (lease: PluginRuntimeRegistryLease, agentTargetKey: string) => {
    const target = parseBackendTargetKeyV2(agentTargetKey);
    const agentId = target.kind === 'backend' ? target.backendId : readAgentRoutingIdForContributionIdentity(
      indexAgentRoutingIdsByContributionIdentity([...lease.registry.contributes.agentDefinitionsById.values()]), target.identity);
    if (agentId) await activateAgentRuntimeContributionOnDemand(lease.registry, agentId);
    return agentId;
  };
  const createFromProjection = async (request: DaemonProviderModelProjectionRequestV1,
    projection: Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }>,
    resource: NonNullable<Awaited<ReturnType<typeof readResource>>>, lease: PluginRuntimeRegistryLease, agentId: string,
    signal: AbortSignal, metadataDns?: Map<string, DnsEvidence>): Promise<PrepareTeamCredentialNativeProviderSourceResult> => {
    const selected = request.currentSelection;
    const application = request.application;
    const group = projection.groups.find(group => group.connectionId === selected?.providerConnectionId
      && group.authorization.authorized && group.sourceRevision);
    const row = group?.rows.find(row => row.ref.modelId === selected?.modelId && !row.catalog.stale
      && row.application && application && pluginJsonValuesEqual(row.application, application));
    const snapshot = input.getAccountSettingsSnapshot();
    if (!selected || !application || !row || !group?.sourceRevision || !snapshot?.scopeKey || !input.context) return fail();
    return prepareTeamCredentialNativeProviderSource({ controllerAccountId: input.context.controllerAccountId,
      controllerMachineId: input.machineId, accountScopeKey: snapshot.scopeKey,
      resource: { ...resource, sourceRevision: group.sourceRevision }, application,
      binding: { selection: { v: 1, ref: selected, updatedAt: 0 }, agentTargetKey: request.agentTargetKey,
        agentId, lease, runtimeModelDescriptor: row.descriptor },
      getAccountSettingsSnapshot: input.getAccountSettingsSnapshot,
      readCurrentResource: async () => ({ ...resource, sourceRevision: group.sourceRevision! }), signal,
      withRegistry: async read => {
        const current = await input.acquireRuntimeLease();
        try { return await read(resolveProviderContributionRegistryView(current.registry.contributes,
          current.registry.generation, current.registry.readPluginOccurrenceId)); }
        finally { await current.release(); }
      },
      collectDnsEvidence: async ({ source, registry, signal, accountSettingsSnapshot }) => {
        const key = JSON.stringify([source, registry.runtimeRegistryGeneration]);
        let evidence = metadataDns?.get(key);
        if (!evidence) {
          evidence = collectProviderConnectionDnsEvidence({ connectionId: source.connectionId, machineId: input.machineId,
            providerSettings: readProviderSettingsForCli(accountSettingsSnapshot).settings,
            registry, resolveAddresses: input.resolveAddresses, lifetime: createProviderOperationLifetime({ signal }) });
          metadataDns?.set(key, evidence);
        }
        return evidence;
      },
    });
  };
  const prepare = async (rawRequest: z.input<typeof DaemonProviderModelProjectionRequestV1Schema>, signal = new AbortController().signal)
    : Promise<PrepareTeamCredentialNativeProviderSourceResult> => {
    if (!input.isFeatureEnabled()) return { ok: false, error: createProviderErrorV1('provider_feature_disabled') };
    let lease: PluginRuntimeRegistryLease | null = null;
    try {
      const request = DaemonProviderModelProjectionRequestV1Schema.parse(rawRequest);
      const resource = await readResource(request, signal);
      if (!resource) return fail();
      const projection = await input.projectSourceModels(sourceRequest(request), signal);
      if (projection.status !== 'success') return { ok: false, error: projection.error };
      lease = await input.acquireRuntimeLease();
      const agentId = await activateTarget(lease, request.agentTargetKey);
      if (!agentId) return fail();
      const prepared = await createFromProjection(request, projection, resource, lease, agentId, signal);
      if (!prepared.ok) { await lease.release(); lease = null; return prepared; }
      const heldLease = lease;
      lease = null;
      let cleaned = false;
      return { ok: true, source: { ...prepared.source, async cleanup() {
        if (cleaned) return;
        cleaned = true;
        try { await prepared.source.cleanup(); } finally { await heldLease.release(); }
      } } };
    } catch { return fail(); }
    finally { await lease?.release(); }
  };
  const projectModels = async (request: DaemonProviderModelProjectionRequestV1, signal = new AbortController().signal)
    : Promise<DaemonProviderModelProjectionResponseV1> => {
    const unavailable = () => ({ status: 'error' as const, error: fail().error });
    let lease: PluginRuntimeRegistryLease | null = null;
    try {
      const resource = await readResource(request, signal);
      if (!resource) return unavailable();
      const projection = await input.projectSourceModels(sourceRequest(request), signal);
      if (projection.status !== 'success') return projection;
      lease = await input.acquireRuntimeLease();
      const agentId = await activateTarget(lease, request.agentTargetKey);
      if (!agentId) return unavailable();
      // One demanded metadata projection shares source DNS evidence across its
      // rows. Real installation/currentness calls never receive this map.
      const metadataDns = new Map<string, DnsEvidence>();
      const groups = [];
      for (const group of projection.groups) {
        const rows = [];
        for (const row of group.rows) {
          if (request.currentSelection && row.ref.modelId !== request.currentSelection.modelId) continue;
          if (!row.application || row.catalog.stale) continue;
          const prepared = await createFromProjection({ ...request, currentSelection: row.ref, application: row.application },
            projection, resource, lease, agentId, signal, metadataDns);
          if (!prepared.ok) continue;
          try {
            const { directMaterialization: _direct, ...metadata } = row;
            const { resolvedAddresses: _dns, ...endpoint } = prepared.source.endpoint;
            rows.push({ ...metadata, nativeSource: { authorizationTicket: prepared.source.authorizationTicket,
              providerTicket: prepared.source.providerTicket, endpoint, credentialTransport: prepared.source.credentialTransport } });
          } finally { await prepared.source.cleanup(); }
        }
        groups.push({ ...group, rows });
      }
      const current = await readResource(request, signal);
      if (!current || !pluginJsonValuesEqual(current, resource) || signal.aborted) return unavailable();
      const currentCatalog = await input.projectSourceModels(sourceRequest(request), signal);
      if (currentCatalog.status !== 'success' || !pluginJsonValuesEqual(
        projection.groups.map(group => [group.connectionId, group.sourceRevision]),
        currentCatalog.groups.map(group => [group.connectionId, group.sourceRevision]),
      )) return unavailable();
      return DaemonProviderModelProjectionResponseV1Schema.parse({ ...projection, groups });
    } catch { return unavailable(); }
    finally { await lease?.release(); }
  };
  return { prepare, projectModels };
}
