import { afterEach, expect, it, vi } from 'vitest';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { normalizeSessionTeamCredentialLaunch } from '@/session/services/sessionTeamCredentialLaunch';
import { createBuiltInQualifiedNativeRefreshHarness } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';
import { createCredentialHealthPoolRotation } from '../connectedServices/runtimeAuth/createCredentialHealthPoolRotation';
import { InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from '../connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../connectedServices/accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';

// This is the existing CLI/Home source-composition corridor: resolve each app's
// aliases at its owner using vitest.source.integration.config.ts.
const server = '../../../../server/sources/';
const { projectTeamCredentialProviderModels }: typeof import('../../../../server/sources/app/teams/credentials/providerModelProjection') =
  await import(server + 'app/teams/credentials/providerModelProjection');

afterEach(() => vi.unstubAllGlobals());

it('settles committed health while an existing selection owns the Pool lease, then rotates through that lease', async () => {
  let rotate!: ReturnType<typeof createCredentialHealthPoolRotation>;
  let rotation: Promise<void> | undefined;
  let entered!: () => void;
  const healthEntered = new Promise<void>(resolve => { entered = resolve; });
  const h = await createBuiltInQualifiedNativeRefreshHarness({ groupBinding: true,
    groupPolicy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
    onReauthRequired: event => { rotation = rotate(event); entered(); return rotation; },
  });
  const leases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<typeof h.service>();
  const accountScope = { serverId: 'home', accountId: 'account' };
  const owner = leases.acquire({ serviceId: h.service, groupId: 'pool', accountScope });
  if (owner.kind !== 'owner') throw new Error('Missing existing selection lease');
  let released = false;
  const release = () => { if (!released) { released = true; owner.completeResult({ status: 'stale_context', generation: 7 }); owner.finish(); } };
  let refresh: Promise<unknown> | undefined;
  try {
    rotate = createCredentialHealthPoolRotation({ token: h.credentials.token, leases, accountScope,
      nowMs: () => h.now, runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
      api: h.qualifiedApi, listGroups: h.qualifiedApi.listGroups });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'content-type': 'application/json' } })));
    let refreshSettled = false;
    refresh = h.coordinator.refreshConnectedServiceCredentialForQuota({ serviceId: 'openai-codex', profileId: 'work', force: true })
      .finally(() => { refreshSettled = true; });
    await healthEntered;
    // Observe ordering after the actual health event, without a guessed wall-time budget.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(refreshSettled).toBe(true);
    expect(h.qualifiedApi.setActiveAccount).not.toHaveBeenCalled();
    release();
    await rotation;
    expect(await h.qualifiedApi.readGroup()).toMatchObject({ activeConnectedAccountId: 'backup', generation: 8 });
  } finally { release(); await refresh; await rotation; await h.dispose(); }
});

it.each([false, true])('commits real refresh reauth, rotates only through the owner, and carries Pool truth into Team catalog/launch (none healthy=%s)', async noneHealthy => {
  let rotate!: ReturnType<typeof createCredentialHealthPoolRotation>;
  let rotation: Promise<void> | undefined;
  let events = 0;
  const h = await createBuiltInQualifiedNativeRefreshHarness({ groupBinding: true, backupNeedsReauth: noneHealthy,
    additionalPluginIds: ['happier.provider.cliproxyapi'],
    groupPolicy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
    onReauthRequired: event => { events++; rotation = rotate(event); return rotation; },
  });
  try {
    const listGroups = vi.fn(h.qualifiedApi.listGroups);
    rotate = createCredentialHealthPoolRotation({ token: h.credentials.token,
      accountScope: { serverId: 'test-home', accountId: 'test-account' },
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
      nowMs: () => h.now, runtimeRegistry: new ConnectedServiceRuntimeRegistry(),
      api: h.qualifiedApi, listGroups,
    });
    const target = { kind: 'group' as const, service: h.service, groupId: 'pool' };
    const originalGroup = await h.qualifiedApi.readGroup();
    const registry = h.registry;
    const agentTargetKey = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' });
    const application = { agentTargetKey, implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' as const };
    const services = createRuntimeProviderModelManagementServices({ machineId: 'worker', featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: () => { throw new Error('Pool source must not read a personal Provider catalog'); },
      acquireRuntimeLease: async () => ({ ...h.admittedRuntime.lease, registry }),
      resolveManagedPurposeBindingIntentSelection: h.purposeRuntime.owner.resolveBindingIntentSelection,
      modelSettingsMutation: async () => { throw new Error('Source observation must not mutate settings'); },
    });
    const source = { v: 1 as const, kind: 'connected_pool' as const, target, poolIncarnation: originalGroup.incarnation };
    const readCatalog = async () => {
      const response = await services.projectModels({ machineId: 'worker', agentTargetKey, application,
        sourceCatalog: true, refreshPolicy: 'current_only', connectedAccountTarget: target });
      // Use Home's real producer for model/selection/currentness rows, including typed refusal.
      const projection = projectTeamCredentialProviderModels({ response, resourceId: 'resource', teamId: 'team',
        resourceRevision: 5, agentTargetKey, application, allowedModelIds: null, source, deliveryMode: 'brokered' });
      return [TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource', teamId: 'team', displayName: 'Pool', resourceRevision: 5,
        readiness: projection.status === 'success' ? { kind: 'available' }
          : { kind: 'source_unavailable', reason: projection.reason },
        recoveryAction: projection.status === 'success' ? null : 'source_owner_action',
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
        sourcePresentation: { kind: 'connected_service', service: h.service },
        connectedServiceSelections: [{ source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered' }],
        providerModels: projection.models,
      })];
    };
    const before = (await readCatalog())[0]!;
    const model = before.providerModels[0];
    if (!model) throw new Error('Real source catalog must expose a model before health failure');
    const options = { directory: h.happyHomeDir,
      modelSelection: { v: 1 as const, ref: { agentTargetKey, providerConnectionId: null, modelId: model.selection.modelId }, updatedAt: 1 },
      teamCredentialBindings: [{ v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: 'resource', teamId: 'team',
        expectedResourceRevision: 5, deliveryMode: 'brokered' as const }],
    };
    await expect(normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey,
      contributions: registry.contributes, applications: [application], readCatalog })).resolves.toMatchObject({ teamModelRow: model });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'content-type': 'application/json' } })));
    await h.coordinator.refreshConnectedServiceCredentialForQuota({ serviceId: 'openai-codex', profileId: 'work', force: true });
    if (!rotation) throw new Error('The real health producer did not dispatch rotation');
    await rotation;
    expect((await h.readCredential()).health).toMatchObject({ status: 'needs_reauth', reconnectRequired: true });
    expect(events).toBe(1);
    expect(listGroups).toHaveBeenCalledOnce();
    const after = (await readCatalog())[0]!;
    if (noneHealthy) {
      expect(h.qualifiedApi.setActiveAccount).not.toHaveBeenCalled();
      expect(after.readiness).toEqual({ kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' });
      await expect(normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey,
        contributions: registry.contributes, applications: [application], readCatalog }))
        .rejects.toMatchObject({ code: 'connected_service_credential_reconnect_required' });
    } else {
      expect(h.qualifiedApi.setActiveAccount).toHaveBeenCalledOnce();
      expect(await h.qualifiedApi.readGroup()).toMatchObject({ activeConnectedAccountId: 'backup', generation: 8 });
      expect(after.readiness).toEqual({ kind: 'available' });
      const selection = await h.purposeRuntime.owner.resolveBindingIntentSelection({ purpose: {
        consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
        target, serviceRefs: [h.service], signal: new AbortController().signal });
      expect(selection.resolved).toMatchObject({ account: { accountId: 'backup' }, group: { generation: 8 } });
      // Keep the exact pre-rotation model/resource selection; generation is not its identity.
      await expect(normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey,
        contributions: registry.contributes, applications: [application], readCatalog }))
        .resolves.toMatchObject({ teamModelRow: { selection: model.selection } });
    }
    await h.coordinator.refreshConnectedServiceCredentialForQuota({ serviceId: 'openai-codex', profileId: 'work', force: true });
    expect(events).toBe(1);
    expect(listGroups).toHaveBeenCalledOnce();
  } finally { await h.dispose(); }
});
