import { access } from 'node:fs/promises';
import axios from 'axios';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderConnectionIdSchema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { DaemonProviderModelProjectionRequestV1Schema, DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { createProviderOperationLifetime } from '@/providers/operationLifetime';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { createRuntimeProviderModelManagementServices } from './runtimeServices';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMachineSharedProviderGatewayResolver } from '@/daemon/machine/bootstrapMachineSyncRuntime';
import { createRuntimeProviderServices } from '@/providers/probe/runtimeServices';
import { createProviderManagedCatalogRuntimePort } from '@/providers/probe/managedRuntime';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { logger } from '@/ui/logger';
import { createCliProviderActionExecuteV1 } from '@/session/actions/cliActionDeps/createCliProviderActionDeps';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import * as persistence from '@/persistence';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createProviderProbeHttpClient } from '@/providers/probe/client';
import { encryptSecretStringV1 } from '@happier-dev/protocol';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { applyProviderCatalogRefreshV1 } from '@happier-dev/protocol/providers/catalog/merge';

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); });

it('explicit requester Refresh reads A external credential and refreshes a fresh observation again', async () => {
  const controller = createPluginReloadController();
  const fixture = await createManagedRunLaunchFixture({ controller, requiredCapabilities: {} });
  try {
    const registry = fixture.contributes;
    const endpointUrl = 'https://1.1.1.1/v1';
    const base = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{ v: 1, id: 'external-a', role: 'named',
      displayName: 'A external', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
      source: { kind: 'custom', template: { v: 1, name: 'A external',
        credential: { kind: 'apiKey', slotId: 'apiKey', required: true, transports: [{ id: 'probe',
          protocols: ['openai-responses'], uses: ['probe', 'runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
        endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: endpointUrl,
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
        catalog: { source: 'probe', manualModelPolicy: 'catalog-only', probes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }] } } } }],
      secretBindingsByConnectionId: { 'external-a': { account: { apiKey: 'probe-key' } } } });
    const resolved = resolveProviderConnectionForMachine({ connectionId: 'external-a', machineId: fixture.machineId,
      providerSettings: base, registry, dnsEvidenceByEndpointUrl: new Map([[endpointUrl, ['1.1.1.1']]]) });
    if (resolved.status !== 'resolved') throw new Error('Expected external source');
    const settings = ProviderSettingsV1Schema.parse({ ...base, accountGrants: [{ v: 1, connectionId: 'external-a',
      connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1 }] });
    const key = new Uint8Array(32).fill(7);
    const accountSettings = (value: string) => AccountSettingsSchema.parse({ secrets: [{ id: 'probe-key', name: 'Probe key', kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, encryptedValue: encryptSecretStringV1(value, key, length => new Uint8Array(length).fill(3)) },
      createdAt: 1, updatedAt: 1 }] });
    const snapshot = { ...fixture.snapshot, settings: accountSettings('a-private-probe'), settingsSecretsReadKeys: [key],
      providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(settings).catalog } };
    const ambient = { ...snapshot, settings: accountSettings('b-private-probe'), scopeKey: resolveAccountSettingsScopeKeyForToken('worker-b') };
    setActiveAccountSettingsSnapshot(ambient);
    const ambientCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token: 'worker-b', encryption: null });
    let ambientReads = 0;
    let catalogReads = 0;
    const transport = vi.fn(async (request: import('@/providers/probe/client').ProviderProbeTransportRequest) => {
      expect(request.headers.authorization).toBe('Bearer a-private-probe');
      if (new URL(request.url).pathname.endsWith('/models')) catalogReads++;
      return { status: 200, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: `refreshed-${catalogReads}` }] })) };
    });
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
      featureGate: { isEnabled: () => true }, registry, getAccountSettingsSnapshot: () => { ambientReads++; return ambient; },
      acquireRuntimeLease: async () => {
        const lease = controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected live fixture registry');
        return lease;
      }, resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected mutation'); } });
    const context = { getAccountSettingsSnapshot: () => snapshot,
      resolveManagedPurposeBindingIntent: async (): Promise<never> => { throw new Error('Unexpected purpose'); },
      signal: new AbortController().signal, isCurrent: () => true };
    const request = { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, sourceConnectionId: ProviderConnectionIdSchema.parse('external-a'), mode: 'management' as const };
    await services.projectModelsForAccount(request, context);
    expect(transport).not.toHaveBeenCalled();
    for (const version of [1, 2]) {
      const refreshed = await services.projectModelsForAccount({ ...request, forceRefresh: true }, context);
      expect(catalogReads, JSON.stringify(refreshed)).toBe(version);
      expect(refreshed, JSON.stringify(refreshed)).toMatchObject({ status: 'success', groups: [{ rows:
        expect.arrayContaining([expect.objectContaining({ descriptor: expect.objectContaining({ id: `refreshed-${version}` }) })]) }] });
    }
    expect(ambientReads).toBe(0);
    expect(ambientCredentials).not.toHaveBeenCalled();
  } finally { await fixture.cleanup(); }
});

it('explicit requester Refresh probes A managed source on B without B Account reads or implicit Start', async () => {
  let ambientPurposeReads = 0;
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true, probeCatalog: true,
    catalogModels: [{ id: 'refreshed-a' }], resolveAccountTarget: async () => {
      ambientPurposeReads++; throw new Error('B purpose read');
    } });
  try {
    const gateway = fixture.gateway!;
    const ambient = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken('worker-b'),
      providerConnectionsCatalog: { status: 'ready' as const, revision: 1,
        catalog: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog } };
    setActiveAccountSettingsSnapshot(ambient);
    const ambientCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token: 'worker-b', encryption: null });
    let ambientReads = 0;
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected requester mutation'); };
    const requesterPurposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected, resolveTarget: async (target, signal) => {
        signal.throwIfAborted();
        return target.kind === 'account' ? { account: target.account, displayName: 'A upstream' } : null;
      },
    });
    const requesterAuthority = createManagedProviderOperationAuthority({ materializationBaseDir: join(gateway.directory, 'requester-auth'),
      purposeBindingOwner: requesterPurposes, requestAuthRegistry: gateway.requestAuthRegistry,
      resolveRequestAuthHttpPort: () => 43123, createRedactionLease: () => ({ add() {}, close() {} }) });
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: () => { ambientReads++; return ambient; },
      managedCatalogRuntime: createProviderManagedCatalogRuntimePort({ acquireRegistryLease: async () => {
        const lease = gateway.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected real managed registry');
        return lease;
      } }),
      resolveManagedPurposeBindingIntent: async () => { ambientPurposeReads++; throw new Error('B purpose read'); },
      acquireRuntimeLease: async () => {
        const lease = gateway.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected real registry');
        return lease;
      }, modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected mutation'); } });
    let current = true;
    let retireAtCredentialRead = false;
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.fixture`, encryption: null };
    const context = { getAccountSettingsSnapshot: () => fixture.snapshot,
      resolveManagedPurposeBindingIntent: requesterPurposes.resolveBindingIntent,
      managedRuntimeAccount: { readCredentials: async () => {
        if (retireAtCredentialRead) current = false;
        return credentials;
      }, operationAuthority: requesterAuthority,
        connectedAccountsOwner: requesterPurposes,
        resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId: fixture.machineId,
          readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId: fixture.machineId }) }) },
      signal: new AbortController().signal, isCurrent: () => current };
    const request = { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey,
      mode: 'management' as const, sourceConnectionId: ProviderConnectionIdSchema.parse('run-gateway') };
    const missingPurposeRuntime = createRuntimeProviderServices({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
      registry: fixture.contributes, featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: () => { ambientReads++; return ambient; },
      resolveManagedPurposeBindingIntent: async () => { ambientPurposeReads++; throw new Error('B purpose read'); } });
    expect(await missingPurposeRuntime.scheduleDemandRefresh({ machineId: fixture.machineId, connectionId: 'run-gateway' },
      'manual_refresh', { getAccountSettingsSnapshot: () => fixture.snapshot,
        lifetime: createProviderOperationLifetime({}) })).not.toBeNull();
    expect(ambientPurposeReads).toBe(0);
    expect(ambientReads).toBe(0);
    const ordinary = await services.projectModelsForAccount(request, context);
    expect(ordinary).toMatchObject({ status: 'success', groups: [{ rows: [{ descriptor: { id: 'example' } }] }] });
    await expect(access(join(gateway.directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(services.projectModelsForAccount({ ...request, forceRefresh: true }, { ...context, managedRuntimeAccount: undefined }))
      .resolves.toMatchObject({ status: 'success', refreshFailures: [{ error: { code: 'provider_authorization_changed' } }] });
    expect(ambientCredentials).not.toHaveBeenCalled();
    expect(ambientPurposeReads).toBe(0);
    await expect(access(join(gateway.directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
    retireAtCredentialRead = true;
    await expect(services.projectModelsForAccount({ ...request, forceRefresh: true }, context))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    await expect(access(join(gateway.directory, 'gateway-started'))).resolves.toBeUndefined();
    retireAtCredentialRead = false;
    current = true;
    const refreshed = await services.projectModelsForAccount({ ...request, forceRefresh: true }, context);
    expect(ambientReads).toBe(0);
    expect(ambientPurposeReads).toBe(0);
    expect(ambientCredentials).not.toHaveBeenCalled();
    await expect(access(join(gateway.directory, 'gateway-started'))).resolves.toBeUndefined();
    expect(refreshed, JSON.stringify(refreshed)).toMatchObject({ status: 'success', groups: [{ rows:
      expect.arrayContaining([expect.objectContaining({ descriptor: expect.objectContaining({ id: 'refreshed-a' }) })]) }] });
    current = false;
    await expect(services.projectModelsForAccount({ ...request, forceRefresh: true }, context))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
  } finally { await fixture.cleanup(); }
});

it('source catalog retains declared model-load controls without activating the recipient Agent', async () => {
  const fixture = await createManagedRunLaunchFixture({ probeCatalog: true, activateAgent: false,
    modelLoad: { endpointTemplateId: 'responses', path: '/load', request: 'json-model-id-v1',
      confirmation: 'refresh-catalog-load-state', preflightPolicy: 'advisory' } });
  try {
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
      registry: fixture.contributes, getAccountSettingsSnapshot: () => fixture.snapshot,
      acquireRuntimeLease: async () => fixture.lease,
      resolveManagedPurposeBindingIntent: async (): Promise<never> => { throw new Error('Unexpected purpose'); },
      modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected mutation'); } });
    const result = await services.projectModels({ machineId: fixture.machineId,
      agentTargetKey: fixture.agentTargetKey, sourceCatalog: true, includeDirectMaterialization: true,
      providerConnection: { connectionId: ProviderConnectionIdSchema.parse('run-gateway'),
        expectedConnectionSecurityFingerprint: fixture.connectionSecurityFingerprint }, refreshPolicy: 'current_only' });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'success', groups: [{
      modelLoadAction: 'available', modelLoadPreflightPolicy: 'advisory',
    }] });
    expect(fixture.lease.registry.agentRuntimesByAgentId.has(fixture.agentId)).toBe(false);
  } finally { await fixture.cleanup(); }
});

it('uses the selected worker Agent when the personal hub cannot activate that Agent', () => withConfiguredDaemonTestHome({ prefix: 'worker-hub-source-' }, async ({ homeDir }) => {
  const catalogModels = [{ id: 'example', connectedAccountPurposes: [{
    consumer: { pluginId: 'acme.shared-registry', localId: 'gateway' }, purpose: 'upstream',
  }] }, { id: 'retained-probe' }];
  const worker = await createManagedRunLaunchFixture({ directory: join(homeDir, 'worker-fixture'),
    happyHomeDir: join(homeDir, 'worker-home'), physicalGateway: true, probeCatalog: true, catalogModels,
    manualModelPolicy: 'allowed', supportsFreeformModelIds: true });
  const hub = await createManagedRunLaunchFixture({ directory: join(homeDir, 'hub-fixture'), happyHomeDir: homeDir,
    physicalGateway: true, probeCatalog: true, catalogModels, manualModelPolicy: 'allowed', activateAgent: false,
    sessionRunnerFactoryModule: './missingHubAgent.mjs' });
  try {
    const workerId = 'selected-worker';
    const base = ProviderSettingsV1Schema.parse({ ...worker.providerSettings, machineGrants: [],
      connections: worker.providerSettings.connections.map(connection => ({ ...connection,
        gatewayPlacement: { kind: 'machine', machineId: hub.machineId } })),
    });
    const resolution = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: hub.machineId,
      providerSettings: base, registry: worker.contributes, dnsEvidenceByEndpointUrl: new Map() });
    if (resolution.status !== 'resolved') throw new Error('Expected personal Gateway');
    const settings = ProviderSettingsV1Schema.parse({ ...base, machineGrants: [workerId, hub.machineId].map(machineId => ({
      v: 1, connectionId: 'run-gateway', machineId, confirmedAt: 1,
      connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      endpointSetFingerprint: resolution.record.endpointSetFingerprint,
    })) });
    let snapshot = { ...worker.snapshot, providerConnectionsCatalog: { status: 'ready' as const,
      revision: 2, catalog: splitProviderSettingsV1(settings).catalog } };
    setActiveAccountSettingsSnapshot(snapshot);
    const createServices = (fixture: typeof worker, machineId: string) => createRuntimeProviderModelManagementServices({ machineId,
      happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => snapshot,
      registry: fixture.contributes,
      resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId,
        readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId }) }),
      managedCatalogRuntime: createProviderManagedCatalogRuntimePort({ happyHomeDir: fixture.happyHomeDir,
        acquireRegistryLease: async () => {
          const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
          if (!lease) throw new Error('Expected actual source registry');
          return lease;
        }, resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId,
          readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId }) }) }),
      acquireRuntimeLease: async () => {
        const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected actual plugin registry');
        return lease;
      }, resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
      modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected mutation'); } });
    const hubServices = createServices(hub, hub.machineId);
    const workerServices = createServices(worker, workerId);
    const probed = await hubServices.probe({ machineId: hub.machineId, connectionId: 'run-gateway' });
    expect(probed, JSON.stringify(probed)).toMatchObject({ status: 'success', models: expect.arrayContaining([
      expect.objectContaining({ id: 'example', connectedAccountPurposes: catalogModels[0]!.connectedAccountPurposes }),
      expect.objectContaining({ id: 'retained-probe' }),
    ]) });
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token: 'run-account', encryption: null });
    const transport = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request =>
      hubServices.projectModels(DaemonProviderModelProjectionRequestV1Schema.parse(request.request)));
    const projected = await workerServices.projectModels({ machineId: workerId, agentTargetKey: worker.agentTargetKey,
      mode: 'management', sourceConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), refreshPolicy: 'current_only' });
    expect(projected, JSON.stringify(projected)).toMatchObject({ status: 'success', groups: [{
      connectionName: 'Gateway', rows: expect.arrayContaining([expect.objectContaining({ descriptor: { id: 'example', name: 'Example' }, compatibility: expect.objectContaining({ result: expect.objectContaining({ status: 'verified' }) }),
        gatewaySlots: [expect.objectContaining({ purpose: catalogModels[0]!.connectedAccountPurposes![0] })] })]),
    }] });
    expect(projected.status === 'success' && projected.groups).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(hub.lease.registry.agentRuntimesByAgentId.has(hub.agentId)).toBe(false);
    const selection = { v: 1 as const, updatedAt: 1, ref: { agentTargetKey: worker.agentTargetKey,
      providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' } };
    const launch = await createRuntimeProviderSpawnAuthorizationAttempt({ selection, machineId: workerId,
      agentId: worker.agentId, agentTargetKey: worker.agentTargetKey, lease: worker.lease,
      getAccountSettingsSnapshot: () => snapshot, materializationBaseDir: worker.happyHomeDir,
      resolveManagedPurposeBindingIntent: worker.gateway!.purposeBindingOwner.resolveBindingIntent,
      readModelProjection: async request => hubServices.projectModels(request) });
    expect(launch, JSON.stringify(launch)).toMatchObject({ ok: true });
    if (launch.ok) launch.attempt.cleanupOnFailure();
    const refreshedAt = Date.now();
    await hubServices.runtimeStore.update(state => ({ ...state, catalogs: state.catalogs.map(record => {
      const refreshed = applyProviderCatalogRefreshV1({ snapshot: record.state.snapshot,
        staleProbeModels: record.state.staleProbeModels }, {
        status: 'success', observedAt: refreshedAt, models: [],
      });
      if (!refreshed.snapshot || !('catalogObservationId' in record.state)) throw new Error('Expected an observed catalog record');
      return { ...record, lastAccessedAt: refreshedAt,
        state: { ...record.state, snapshot: refreshed.snapshot, staleProbeModels: refreshed.staleProbeModels } };
    }) }));
    const request = { machineId: workerId, agentTargetKey: worker.agentTargetKey,
      sourceConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), refreshPolicy: 'current_only' as const };
    const retainedRef = { ...selection.ref, modelId: 'retained-probe' };
    for (const retained of [{ currentSelection: retainedRef }, { favoriteSelections: [retainedRef] }]) {
      const stale = await workerServices.projectModels({ ...request, ...retained });
      expect(stale, JSON.stringify(stale)).toMatchObject({ status: 'success', groups: [{ rows: expect.arrayContaining([expect.objectContaining({
        descriptor: { id: 'retained-probe', name: 'retained-probe' }, catalog: { stale: true, staleAt: refreshedAt }, loadState: 'unknown',
      })]) }] });
    }
    const withDefault = ProviderSettingsV1Schema.parse({ ...settings,
      defaultsByAgentTargetKey: { [worker.agentTargetKey]: { ...selection, ref: retainedRef } } });
    snapshot = { ...snapshot, settings: AccountSettingsSchema.parse({ ...snapshot.settings,
      providerDefaultModelSelectionsByAgentTargetKeyV1: splitProviderSettingsV1(withDefault).defaults }), settingsVersion: 2 };
    const defaultRow = await workerServices.projectModels(request);
    expect(defaultRow, JSON.stringify(defaultRow)).toMatchObject({ status: 'success', groups: [{ rows: expect.arrayContaining([expect.objectContaining({
      descriptor: { id: 'retained-probe', name: 'retained-probe' }, catalog: { stale: true, staleAt: refreshedAt },
    })]) }] });
    const sourceOnly = await hubServices.projectModels({ machineId: hub.machineId,
      agentTargetKey: worker.agentTargetKey, sourceCatalog: true,
      providerConnection: { connectionId: ProviderConnectionIdSchema.parse('run-gateway'),
        expectedConnectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint }, refreshPolicy: 'current_only' });
    expect(sourceOnly).toMatchObject({ status: 'success' });
    expect(sourceOnly.status === 'success' && sourceOnly.groups.flatMap(group => group.rows).map(row => row.ref.modelId)).not.toContain('retained-probe');
    const staleLaunch = await createRuntimeProviderSpawnAuthorizationAttempt({ selection: { ...selection, ref: retainedRef }, machineId: workerId,
      agentId: worker.agentId, agentTargetKey: worker.agentTargetKey, lease: worker.lease,
      getAccountSettingsSnapshot: () => snapshot, materializationBaseDir: worker.happyHomeDir,
      resolveManagedPurposeBindingIntent: worker.gateway!.purposeBindingOwner.resolveBindingIntent,
      readModelProjection: async projection => hubServices.projectModels(projection) });
    expect(staleLaunch).toMatchObject({ ok: false });
    const freeform = await workerServices.projectModels({ ...request,
      currentSelection: { ...retainedRef, modelId: 'never-listed' } });
    expect(freeform, JSON.stringify(freeform)).toMatchObject({ status: 'success', currentSelectionRecovery: null,
      groups: [{ rows: expect.arrayContaining([expect.objectContaining({ descriptor: { id: 'never-listed', name: 'never-listed' },
        confidence: 'manual', catalog: { stale: true }, loadState: 'unknown' })]) }] });
  } finally { await hub.cleanup(); await worker.cleanup(); }
}));

it.each(['issued', 'missing'] as const)('projects requester A personal hub through exact Account transport on worker B without reading B credentials (scope: %s)', async readScope => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
  try {
    if (!fixture.gateway) throw new Error('Expected installed managed hub');
    const workerId = 'foreign-worker';
    const registry = resolveProviderContributionRegistryView(fixture.lease.registry.contributes,
      fixture.lease.registry.generation!, fixture.lease.registry.readPluginOccurrenceId);
    const base = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
      connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
        gatewayPlacement: { kind: 'machine', machineId: fixture.machineId } })),
    });
    const resolved = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
      providerSettings: base, registry, dnsEvidenceByEndpointUrl: new Map() });
    if (resolved.status !== 'resolved') throw new Error('Expected exact personal hub');
    const settings = ProviderSettingsV1Schema.parse({ ...base, machineGrants: [workerId, fixture.machineId].map(machineId => ({
      v: 1, connectionId: 'run-gateway', machineId, confirmedAt: 1,
      connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
      endpointSetFingerprint: resolved.record.endpointSetFingerprint,
    })) });
    const snapshot = { ...fixture.snapshot, providerConnectionsCatalog: { status: 'ready' as const,
      revision: 2, catalog: splitProviderSettingsV1(settings).catalog } };
    let accountSnapshot = snapshot;
    const ambient = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken('worker-b') };
    setActiveAccountSettingsSnapshot(ambient);
    const ambientCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token: 'worker-b', encryption: null });
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected model mutation'); };
    let ambientReads = 0;
    const createServices = (machineId: string) => createRuntimeProviderModelManagementServices({ machineId,
      happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: () => { ambientReads++; return ambient; },
      acquireRuntimeLease: async () => {
        const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected actual plugin registry');
        return lease;
      }, modelSettingsMutation: unexpected });
    const hub = createServices(fixture.machineId);
    const worker = createServices(workerId);
    let current = true;
    const signal = new AbortController().signal;
    const accountReadScope = { serverUrl: 'https://account-a-hub.test',
      readCredentials: async () => ({ token: 'run-account', encryption: null }),
      readAccountSettingsSnapshot: async () => accountSnapshot, isCurrent: () => current };
    const accountContext = { getAccountSettingsSnapshot: () => accountSnapshot,
      resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
      signal, isCurrent: () => current, accountReadScope };
    const transport = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
      expect(request.credentials.token).toBe('run-account');
      expect(request.serverUrl).toBe(accountReadScope.serverUrl);
      expect(request.machineId).toBe(fixture.machineId);
      const projection = DaemonProviderModelProjectionRequestV1Schema.parse(request.request);
      return hub.projectModelsForAccount(projection, accountContext);
    });
    const request = { machineId: workerId, agentTargetKey: fixture.agentTargetKey, mode: 'management' as const,
      sourceConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), refreshPolicy: 'current_only' as const };
    if (readScope === 'missing') {
      await expect(worker.projectModelsForAccount(request, { ...accountContext, accountReadScope: undefined }))
        .resolves.toMatchObject({ status: 'success', groups: [], refreshFailures: [{ error: { code: 'provider_authorization_changed' } }] });
      expect(transport).not.toHaveBeenCalled();
      expect(ambientCredentials).not.toHaveBeenCalled();
      expect(ambientReads).toBe(0);
      return;
    }
    const projected = await worker.projectModelsForAccount(request, accountContext);
    expect(projected, JSON.stringify(projected)).toMatchObject({ status: 'success', groups: [{ connectionName: 'Gateway',
      rows: [{ descriptor: { id: 'example' } }] }] });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ambientCredentials).not.toHaveBeenCalled();
    expect(ambientReads).toBe(0);
    for (const change of ['catalog', 'settings'] as const) {
      transport.mockImplementationOnce(async request => {
        const result = await hub.projectModelsForAccount(DaemonProviderModelProjectionRequestV1Schema.parse(request.request), accountContext);
        accountSnapshot = change === 'catalog'
          ? { ...snapshot, providerConnectionsCatalog: { ...snapshot.providerConnectionsCatalog, revision: 3 } }
          : { ...snapshot, settingsVersion: snapshot.settingsVersion + 1 };
        return result;
      });
      await expect(worker.projectModelsForAccount(request, accountContext)).resolves.toMatchObject({ status: 'success',
        groups: [{ rows: [{ descriptor: { id: 'example' } }] }] });
      accountSnapshot = snapshot;
    }
    const readsBeforeRetirement = transport.mock.calls.length;
    transport.mockImplementationOnce(async request => {
      const result = await hub.projectModelsForAccount(DaemonProviderModelProjectionRequestV1Schema.parse(request.request), accountContext);
      current = false;
      return result;
    });
    await expect(worker.projectModelsForAccount(request, accountContext)).resolves.toMatchObject({ status: 'error',
      error: { code: 'provider_authorization_changed' } });
    expect(transport).toHaveBeenCalledTimes(readsBeforeRetirement + 1);
    await expect(worker.projectModelsForAccount(request, accountContext)).resolves.toMatchObject({ status: 'error',
      error: { code: 'provider_authorization_changed' } });
    expect(transport).toHaveBeenCalledTimes(readsBeforeRetirement + 1);
    expect(ambientCredentials).not.toHaveBeenCalled();
  } finally { await fixture.cleanup(); }
});

it('reports missing packaged Agent factory activation as internal failure in both projection and launch', async () => {
  const fixture = await createManagedRunLaunchFixture({ activateAgent: false, sessionRunnerFactoryModule: './missingFactory.mjs' });
  const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  try {
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      getAccountSettingsSnapshot: () => fixture.snapshot, featureGate: { isEnabled: () => true },
      acquireRuntimeLease: async () => fixture.lease,
      modelSettingsMutation: async (): Promise<never> => { throw new Error('No mutation during projection'); } });
    await expect(services.projectModels({ machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'agent_error' } });
    expect(diagnostic).toHaveBeenCalledWith('[PROVIDER] Unexpected failure', expect.objectContaining({
      operation: 'model_projection', errorType: 'Error',
      sourceLocations: expect.arrayContaining([expect.stringMatching(/adapter\.ts:\d+:\d+/)]),
    }));
    const result = await createRuntimeProviderSpawnAuthorizationAttempt({
      selection: { v: 1, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'model-a' } },
      machineId: fixture.machineId, agentId: fixture.agentId, agentTargetKey: fixture.agentTargetKey,
      lease: fixture.lease, getAccountSettingsSnapshot: () => fixture.snapshot, materializationBaseDir: fixture.happyHomeDir,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'agent_error' } });
    expect(fixture.lease.registry.agentRuntimesByAgentId.has(fixture.agentId)).toBe(false);
  } finally { await fixture.cleanup(); }
});

it('admits a cold peer catalog through the real hub projection before optional history cleanup', () => withConfiguredDaemonTestHome({ prefix: 'cold-peer-catalog-' }, async ({ homeDir }) => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true, probeCatalog: true,
    directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
    controller: pluginReloadController, catalogModels: [{ id: 'peer-only-probed', connectedAccountPurposes: [{
      consumer: { pluginId: 'acme.shared-registry', localId: 'gateway' }, purpose: 'upstream',
    }] }],
  });
  try {
    if (!fixture.gateway || typeof fixture.lease.registry.generation !== 'number') throw new Error('Expected managed gateway registry');
    const peerMachineId = 'peer-worker';
    const base = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
      connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
        gatewayPlacement: { kind: 'machine', machineId: fixture.machineId } })),
    });
    const connection = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
      providerSettings: base, registry: fixture.contributes, dnsEvidenceByEndpointUrl: new Map() });
    if (connection.status !== 'resolved') throw new Error('Expected exact hub connection');
    const settings = ProviderSettingsV1Schema.parse({ ...base, machineGrants: [peerMachineId, fixture.machineId].map(machineId => ({
      v: 1, connectionId: 'run-gateway', machineId, confirmedAt: 1,
      connectionSecurityFingerprint: connection.record.connectionSecurityFingerprint,
      endpointSetFingerprint: connection.record.endpointSetFingerprint,
    })) });
    const snapshot = { ...fixture.snapshot, providerConnectionsCatalog: {
      status: 'ready' as const, revision: 2, catalog: splitProviderSettingsV1(settings).catalog,
    } };
    const probes = createRuntimeProviderServices({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
      featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => snapshot,
      registry: resolveProviderContributionRegistryView(fixture.lease.registry.contributes,
        fixture.lease.registry.generation, fixture.lease.registry.readPluginOccurrenceId),
      resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId: fixture.machineId,
        readAccountId: () => 'account', readOrigin: async () => ({ serverIdentityId: 'home', machineId: fixture.machineId }) }),
      resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
    });
    const probed = await probes.probe({ connectionId: 'run-gateway', machineId: fixture.machineId });
    expect(probed, JSON.stringify(probed)).toMatchObject({ status: 'success', models: [{ id: 'peer-only-probed' }] });
    const hubModels = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: () => snapshot,
      acquireRuntimeLease: async () => {
        const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected canonical hub registry lease');
        return lease;
      },
      resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
      modelSettingsMutation: async (): Promise<never> => { throw new Error('No model mutations during admission'); },
    });
    const modelSelection = { v: 1 as const, updatedAt: 1, ref: { agentTargetKey: fixture.agentTargetKey,
      providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'peer-only-probed' } };
    // A peer's invocation starts with no Provider row loaded. Exercise the real
    // catalog store, publication and remote hub projection while the Home's
    // optional history maintenance remains pending at its HTTP boundary.
    const { providerConnectionsCatalog: _catalog, ...coldSnapshot } = snapshot;
    const operationContext = createInvocationSavedSecretOperationContextV1({
      credentials: { token: 'run-account', encryption: null }, snapshot: coldSnapshot,
      serverHttpBaseUrl: 'https://peer-catalog-home.invalid', isCurrent: async () => true,
    });
    let enterHistory = () => {};
    let releaseHistory = () => {};
    const historyEntered = new Promise<void>(resolve => { enterHistory = resolve; });
    const historyReleased = new Promise<void>(resolve => { releaseHistory = resolve; });
    const originalGet = axios.get.bind(axios);
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const endpoint = new URL(String(url));
      if (endpoint.origin !== operationContext.serverHttpBaseUrl) return originalGet(url, config);
      if (endpoint.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (endpoint.pathname === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
        status: 'present', revision: 2, content: { t: 'plain', v: snapshot.providerConnectionsCatalog.catalog },
      } };
      if (endpoint.pathname === '/v2/account/settings') return { status: 200, data: {
        version: 1, content: { t: 'plain', v: {} },
      } };
      if (endpoint.pathname === '/v2/account/settings/history') {
        enterHistory(); await historyReleased;
        return { status: 200, data: { snapshots: [] } };
      }
      const history = emptyAccountSettingsHistoryCaptureResponse(endpoint.pathname);
      if (history) return history;
      throw new Error(`Unexpected peer catalog HTTP boundary: ${endpoint.pathname}`);
    });
    let coldPreparation: Promise<Awaited<ReturnType<typeof createRuntimeProviderSpawnAuthorizationAttempt>>> | undefined;
    let projectedOnHub = false;
    try {
      let coldAdmission: Awaited<ReturnType<typeof createRuntimeProviderSpawnAuthorizationAttempt>> | undefined;
      coldPreparation = createRuntimeProviderSpawnAuthorizationAttempt({
        selection: modelSelection, machineId: peerMachineId, agentTargetKey: fixture.agentTargetKey,
        agentId: fixture.agentId, lease: fixture.lease,
        getAccountSettingsSnapshot: operationContext.readSnapshot, savedSecretOperationContext: operationContext,
        materializationBaseDir: fixture.happyHomeDir,
        resolveManagedPurposeBindingIntent: fixture.gateway!.purposeBindingOwner.resolveBindingIntent,
        readModelProjection: async request => {
          expect(request.machineId).toBe(fixture.machineId);
          const response = await hubModels.projectModels(request);
          DaemonProviderModelProjectionResponseV1Schema.parse(response);
          projectedOnHub = true;
          return response;
        },
      }).then(result => { coldAdmission = result; return result; });
      await historyEntered;
      await vi.waitFor(() => expect(coldAdmission, JSON.stringify(coldAdmission)).toMatchObject({ ok: true }));
      expect(projectedOnHub).toBe(true);
      expect(operationContext.readSnapshot()?.providerConnectionsCatalog).toMatchObject({ status: 'ready', revision: 2 });
    } finally {
      releaseHistory();
      try {
        const result = await coldPreparation;
        if (result?.ok) result.attempt.cleanupOnFailure();
        await vi.waitFor(() => expect(operationContext.readSnapshot()?.providerConnectionsCatalog)
          .toMatchObject({ status: 'ready', cleanup: { status: 'complete' } }));
      } finally { http.mockRestore(); }
    }
  } finally { await fixture.cleanup(); }
}));

it.each(['purpose', 'dns', 'selected'] as const)('retains healthy models and scopes failed source work (%s)', async slowBoundary => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true, probeCatalog: false });
  let releaseTarget = () => {};
  try {
    if (!fixture.gateway || typeof fixture.lease.registry.generation !== 'number') throw new Error('Expected managed fixture');
    const registry = resolveProviderContributionRegistryView(fixture.lease.registry.contributes,
      fixture.lease.registry.generation, fixture.lease.registry.readPluginOccurrenceId);
    const base = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings,
      connections: [...fixture.providerSettings.connections, {
        v: 1, id: 'healthy', role: 'named', displayName: 'Healthy', displayNameMode: 'custom',
        revision: 1, createdAt: 1, updatedAt: 1,
        source: { kind: 'custom', template: { v: 1, name: 'Healthy', endpointTemplates: [{
          id: 'responses', protocol: 'openai-responses', baseUrl: 'https://1.1.1.1/v1',
          capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
        }], catalog: { source: 'manual', manualModelPolicy: 'allowed' } } },
      }],
      manualModelsByConnectionId: { ...fixture.providerSettings.manualModelsByConnectionId, healthy: [{ id: 'healthy-model', addedAt: 1 }] },
    });
    const healthy = resolveProviderConnectionForMachine({ connectionId: 'healthy', machineId: fixture.machineId,
      providerSettings: base, registry, dnsEvidenceByEndpointUrl: new Map([['https://1.1.1.1/v1', ['1.1.1.1']]]) });
    if (healthy.status !== 'resolved') throw new Error('Expected healthy source');
    const settings = ProviderSettingsV1Schema.parse({ ...base, accountGrants: [...base.accountGrants, {
      v: 1, connectionId: 'healthy', connectionSecurityFingerprint: healthy.record.connectionSecurityFingerprint, confirmedAt: 1,
    }] });
    if (slowBoundary === 'dns') {
      const slow = settings.connections.find(connection => connection.id === 'healthy');
      if (!slow || slow.source.kind !== 'custom') throw new Error('Expected custom source');
      settings.connections.push({ ...slow, id: ProviderConnectionIdSchema.parse('slow-dns'), source: { ...slow.source, template: {
        ...slow.source.template, endpointTemplates: slow.source.template.endpointTemplates.map(endpoint => ({
          ...endpoint, baseUrl: 'https://slow.example/v1',
        })),
      } } });
    }
    const { catalog, defaults } = splitProviderSettingsV1(settings);
    const snapshot = { ...fixture.snapshot,
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
      providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog },
    };
    let targetEntered = () => {};
    const entered = new Promise<void>(resolve => { targetEntered = resolve; });
    const released = new Promise<void>(resolve => { releaseTarget = resolve; });
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected mutation'); };
    // The Home target lookup is the external boundary. Keep purpose validation,
    // registry activation, catalog assembly and the strict response consumer real.
    const purposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async (target, signal) => {
        if (slowBoundary !== 'dns') { targetEntered(); await released; throw new Error('Fixture Home unavailable'); }
        signal.throwIfAborted();
        return target.kind === 'account' ? { account: target.account, displayName: 'Upstream' } : null;
      },
    });
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      happyHomeDir: fixture.happyHomeDir, registry, getAccountSettingsSnapshot: () => snapshot,
      featureGate: { isEnabled: () => true }, resolveAddresses: async hostname => {
        if (hostname === 'slow.example') { targetEntered(); await released; throw new Error('Fixture DNS unavailable'); }
        return ['1.1.1.1'];
      },
      acquireRuntimeLease: async () => {
        const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected canonical lease');
        return lease;
      },
      resolveManagedPurposeBindingIntent: purposes.resolveBindingIntent, modelSettingsMutation: unexpected,
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = services.projectModels(DaemonProviderModelProjectionRequestV1Schema.parse({ machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey,
      mode: 'management',
      ...(slowBoundary === 'selected' ? { sourceConnectionId: 'healthy' } : {}),
    })).then(result => { settled = true; return result; });
    if (slowBoundary !== 'selected') {
      await entered;
      // Let the healthy source complete its real filesystem/catalog work while
      // only the unrelated Home/DNS boundary remains held.
      await new Promise<void>(resolve => setImmediate(resolve));
      releaseTarget();
    }
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
      const result = DaemonProviderModelProjectionResponseV1Schema.parse(await pending);
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'success', groups: expect.arrayContaining([expect.objectContaining({ connectionId: 'healthy', rows: [expect.objectContaining({
        ref: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: 'healthy', modelId: 'healthy-model' },
      })] })]) });
      if (result.status !== 'success') throw new Error('Expected partial projection');
      expect(result.refreshFailures).toEqual(slowBoundary !== 'purpose' ? undefined : [{
        connectionId: 'run-gateway',
        error: expect.objectContaining({ code: 'provider_connection_invalid' }),
      }]);
      if (slowBoundary === 'dns') expect(result.groups.some(group => group.connectionId === 'slow-dns')).toBe(false);
    } finally {
      vi.useRealTimers();
      releaseTarget();
      await pending;
    }
  } finally {
    vi.useRealTimers();
    releaseTarget();
    await fixture.cleanup();
  }
});

it.each([true, false])('G1 projects only the owning Account source and purpose without ambient fallback or refresh (probe catalog: %s)', async probeCatalog => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true, probeCatalog });
  try {
    if (!fixture.gateway) throw new Error('Expected physical gateway fixture');
    if (typeof fixture.lease.registry.generation !== 'number') throw new Error('Expected authoritative registry generation');
    const registry = resolveProviderContributionRegistryView(fixture.lease.registry.contributes,
      fixture.lease.registry.generation, fixture.lease.registry.readPluginOccurrenceId);
    const ambientSettings = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings, machineGrants: [],
      connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
        displayName: 'Ambient Gateway', displayNameMode: 'custom',
        purposeBindingDefaults: { upstream: { kind: 'account', account: {
          service: { pluginId: fixture.gateway!.pluginId, localId: 'accounts' }, accountId: 'ambient-upstream',
        } } },
      })),
    });
    const ambientResolution = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
      providerSettings: ambientSettings,
      registry, dnsEvidenceByEndpointUrl: new Map() });
    if (ambientResolution.status !== 'resolved') throw new Error('Expected ambient connection');
    const admittedAmbientSettings = ProviderSettingsV1Schema.parse({ ...ambientSettings, machineGrants: [{ v: 1,
      connectionId: 'run-gateway', machineId: fixture.machineId, confirmedAt: 1,
      connectionSecurityFingerprint: ambientResolution.record.connectionSecurityFingerprint,
      endpointSetFingerprint: ambientResolution.record.endpointSetFingerprint,
    }] });
    const { catalog, defaults } = splitProviderSettingsV1(admittedAmbientSettings);
    const ambientSnapshot = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken('ambient-account'),
      settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
      providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog },
    };
    setActiveAccountSettingsSnapshot(ambientSnapshot);
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected account materialization'); };
    // Account transport truth is the boundary. Purpose validation remains the
    // real owner and refuses the other Account's upstream binding.
    const ambientPurposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async (target, signal) => {
        signal.throwIfAborted();
        return target.kind === 'account' && target.account.accountId === 'ambient-upstream'
          ? { account: target.account, displayName: 'Ambient upstream' } : null;
      },
    });
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
      acquireRuntimeLease: async () => {
        const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected canonical registry lease');
        return lease;
      },
      resolveManagedPurposeBindingIntent: ambientPurposes.resolveBindingIntent,
      modelSettingsMutation: unexpected,
    });
    const request = DaemonProviderModelProjectionRequestV1Schema.parse({ machineId: fixture.machineId,
      agentTargetKey: fixture.agentTargetKey, mode: 'management', sourceConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), refreshPolicy: 'current_only' });
    const ambient = await services.projectModels(request);
    expect(ambient, JSON.stringify(ambient)).toMatchObject({ status: 'success', groups: [{ connectionId: 'run-gateway', connectionName: 'Ambient Gateway',
      sourceAuthority: { connectionSecurityFingerprint: ambientResolution.record.connectionSecurityFingerprint },
      rows: [{ descriptor: { id: 'example' } }],
    }] });
    const admittedAmbient = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId: fixture.machineId,
      providerSettings: admittedAmbientSettings, registry, dnsEvidenceByEndpointUrl: new Map() });
    if (admittedAmbient.status !== 'resolved') throw new Error('Expected admitted ambient connection');
    await expect(services.summary({ connectionId: 'run-gateway', machineId: fixture.machineId,
      accountSettings: ambientSnapshot.settings, providerSettings: admittedAmbientSettings, registry,
      dnsEvidence: new Map(), resolution: admittedAmbient,
      lifetime: createProviderOperationLifetime({}),
    })).resolves.toMatchObject({ status: 'success' });

    const controller = new AbortController();
    let current = true;
    const context = { getAccountSettingsSnapshot: () => fixture.snapshot,
      resolveManagedPurposeBindingIntent: fixture.gateway.purposeBindingOwner.resolveBindingIntent,
      signal: controller.signal, isCurrent: async () => current };
    const owned = await services.projectModelsForAccount(request, context);
    expect(owned).toMatchObject({ status: 'success', groups: [{ connectionId: 'run-gateway', connectionName: 'Gateway',
      sourceAuthority: { connectionSecurityFingerprint: fixture.connectionSecurityFingerprint },
      rows: [{ descriptor: { id: 'example' } }],
    }] });
    expect(owned).not.toEqual(ambient);
    let ambientReads = 0;
    const foreignServices = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
      getAccountSettingsSnapshot: () => { ambientReads++; return ambientSnapshot; },
      acquireRuntimeLease: async () => {
        const lease = fixture.gateway!.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected canonical registry lease');
        return lease;
      }, resolveManagedPurposeBindingIntent: ambientPurposes.resolveBindingIntent, modelSettingsMutation: unexpected,
    });
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials: { token: 'run-account', encryption: null },
      snapshot: fixture.snapshot, serverHttpBaseUrl: 'https://requester-projection.invalid',
      machineAdmission: { actorAccountId: 'requester-a', custodianAccountId: 'worker-b' }, isCurrent: async () => current });
    const execute = createCliProviderActionExecuteV1({ credentials: operationContext.credentials,
      serverId: 'requester-home', serverHttpBaseUrl: operationContext.serverHttpBaseUrl, operationContext,
      projectModelsForAccount: (projection, actionContext) => foreignServices.projectModelsForAccount(projection, {
        ...context, getAccountSettingsSnapshot: operationContext.readSnapshot,
        signal: actionContext.signal ?? controller.signal, isCurrent: () => operationContext.isCurrent(actionContext.signal),
      }),
      callMachineAction: async () => foreignServices.projectModels(request, controller.signal, {
        signal: controller.signal,
        machineAdmission: { actorAccountId: 'requester-a', custodianAccountId: 'worker-b', machineId: fixture.machineId,
          installationId: 'worker-installation', role: 'use', encryptionMode: 'plain' },
      }),
    });
    for (const actionId of ['providers.models.projection'] as const) {
      const selected = await execute({ actionId, input: { ...request, forceRefresh: undefined } },
      { serverId: 'requester-home', signal: controller.signal });
      expect(selected).toMatchObject({ ok: true, result: { status: 'success', groups: [{ connectionName: 'Gateway',
        rows: [{ descriptor: { id: 'example' } }] }] } });
      expect(ambientReads).toBe(0);
    }
    await expect(access(join(fixture.gateway.directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(services.projectModelsForAccount(request, { ...context, getAccountSettingsSnapshot: () => null }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_settings_invalid' } });
    current = false;
    await expect(services.projectModelsForAccount(request, context))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
    current = true;
    let releaseTransport = () => {};
    let transportStarted = () => {};
    const entered = new Promise<void>(resolve => { transportStarted = resolve; });
    const released = new Promise<void>(resolve => { releaseTransport = resolve; });
    const pausedPurposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async (target, signal) => {
        transportStarted();
        await released;
        signal.throwIfAborted();
        return target.kind === 'account' ? { account: target.account, displayName: 'Owning upstream' } : null;
      },
    });
    const pending = services.projectModelsForAccount(request, {
      ...context, resolveManagedPurposeBindingIntent: pausedPurposes.resolveBindingIntent,
    });
    await entered;
    current = false;
    releaseTransport();
    await expect(pending).resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
  } finally { await fixture.cleanup(); }
});
