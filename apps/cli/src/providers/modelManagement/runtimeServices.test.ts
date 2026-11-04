import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { logger } from '@/ui/logger';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as persistence from '@/persistence';
import {
  AccountSettingsSchema,
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderEndpointRuntimeStateRecordV1Schema,
  ProviderRuntimeStateFileV1Schema,
  ProviderSettingsV1Schema,
  createProviderCatalogFingerprintV1,
  createProviderEndpointFingerprintV1,
  createProviderObservationAuthorizationFingerprintV1,
  createProviderProbeRequestFingerprintV1,
  createEmptyProviderRuntimeStateFileV1,
  splitProviderSettingsV1,
  formatSharedSavedSecretRefV1,
  sealSavedSecretResourceStoredContentV1,
  ProviderConnectionsRowMutationV1Schema,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';
import { TeamCredentialProviderModelCatalogEntryV1Schema, TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';
import { admitTeamCredentialSourceModelRowsV1 } from '@happier-dev/protocol/rpc/providers';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { createBrokerProviderRegistry } from '@/providers/broker/providerBroker.testkit';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { commitActiveProviderConnectionsCatalog, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { refreshActiveProviderConnectionsCatalog, refreshDemandedActiveProviderConnectionsCatalog } from '@/providers/settings/hydrate';
import * as accountSnapshots from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineProviderRpcHandlers } from '@/api/machine/rpcHandlers.providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createLegacyProfileMigrationRpcServices } from '@/providers/migrations/rpc';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import * as providerContributions from '@/providers/registry/contributions';
import {
  resolveProviderProbeAuthorization,
  resolveProviderSpawnAuthorization,
} from '@/providers/spawn/resolve';
import {
  createProviderProbeHttpClient,
  type ProviderProbeTransportRequest,
} from '@/providers/probe/client';
import { createRuntimeProviderConnectionServices } from '@/providers/connections/runtimeServices';
import { createRuntimeProviderServices } from '@/providers/probe/runtimeServices';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS } from '@/providers/probe/scheduler';
import type { ProviderModelSettingsMutationIntent } from '@/providers/connections';

import {
  createRuntimeProviderModelManagementServices,
  resolveProviderManualModelCatalog,
} from './runtimeServices';

const temporaryPaths: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetActiveAccountSettingsSnapshotForTests();
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('returns a typed projection failure and content-free cause when the credential file boundary throws', async () => {
  setActiveAccountSettingsSnapshot({ ...providerSnapshot(DEFAULT_PROVIDER_SETTINGS_V1),
    scopeKey: resolveAccountSettingsScopeKeyForToken('projection-account'), providerConnectionsCatalog: undefined });
  vi.spyOn(persistence, 'readStoredCredentials').mockRejectedValue(new ReferenceError('private-credential-value'));
  const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  const services = createRuntimeProviderModelManagementServices({ machineId: 'machine-a',
    featureGate: { isEnabled: () => true },
    modelSettingsMutation: async (): Promise<never> => { throw new Error('No mutation during projection'); } });
  await expect(services.projectModels({ machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex' }))
    .resolves.toMatchObject({ status: 'error', error: { code: 'agent_error', machineId: 'machine-a' } });
  expect(diagnostic).toHaveBeenCalledWith('[PROVIDER] Unexpected failure', expect.objectContaining({
    operation: 'model_projection', errorType: 'ReferenceError', sourceLocations: expect.any(Array),
  }));
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-credential-value');
});

it('settles steady source-any eligibility across three Agents without replaying catalog observation behind history', async () => {
  const credentials = { token: 'eligibility-steady-polling', encryption: null };
  const scopeKey = resolveAccountSettingsScopeKeyForToken(credentials.token);
  setActiveAccountSettingsSnapshot({ ...providerSnapshot(DEFAULT_PROVIDER_SETTINGS_V1),
    scopeKey, providerConnectionsCatalog: undefined });
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  // Observe the real withdrawal owner: polling has no Account-change input.
  const withdrawals = vi.spyOn(accountSnapshots, 'beginActiveProviderConnectionsCatalogRefresh');
  const boundaryDelayMs = 20;
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  let releaseHistory = () => {};
  let enterHistory = () => {};
  let historyCompleted = false;
  const historyReleased = new Promise<void>(resolve => { releaseHistory = resolve; });
  const historyEntered = new Promise<void>(resolve => { enterHistory = resolve; });
  let revision = 1;
  let rowReads = 0;
  let sourceReads = 0;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      rowReads++;
      await delay(boundaryDelayMs);
      return { status: 200, data: { status: 'present', revision,
        content: { t: 'plain', v: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog } } };
    }
    if (path === '/v2/account/settings') {
      sourceReads++;
      await delay(boundaryDelayMs);
      return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
    }
    if (path === '/v2/account/settings/history') {
      enterHistory();
      await historyReleased;
      historyCompleted = true;
      return { status: 200, data: { snapshots: [] } };
    }
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    throw new Error(`Unexpected polling HTTP boundary: ${path}`);
  });
  const projectedTargets: string[] = [];
  let retireOnLease = false;
  // The loaded-plugin boundary declares three Agents without Provider adapters.
  // Source-only eligibility must leave every Agent contribution dormant.
  const executable = {
    generation: 7,
    contributes: { providersByContributionKey: new Map(), agentDefinitionsById: new Map(['a', 'b', 'c'].map(id => [id, {
      id, pluginId: 'acme.polling', identity: { pluginId: 'acme.polling', localId: id },
      definition: { id, kindVersion: 1 },
    }])) },
    activateContributionsOnDemand: async (demands: readonly { localId: string }[]) => {
      projectedTargets.push(...demands.map(demand => demand.localId));
      return [];
    },
    agentRuntimesByAgentId: new Map(),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  const lease: PluginRuntimeRegistryLease = { registry: executable, source: 'active', durableRevision: -1,
    release: async () => {} };
  const services = createRuntimeProviderModelManagementServices({ machineId: 'machine-a',
    featureGate: { isEnabled: () => true }, acquireRuntimeLease: async () => {
      if (retireOnLease) {
        retireOnLease = false;
        setActiveAccountSettingsSnapshot({ ...providerSnapshot(DEFAULT_PROVIDER_SETTINGS_V1), scopeKey: 'replacement-account' });
      }
      return lease;
    },
    modelSettingsMutation: async (): Promise<never> => { throw new Error('No mutation during eligibility'); } });
  const request = { machineId: 'machine-a', teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 1,
    scope: 'source_any' as const,
    source: TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'provider_connection', connectionId: 'connection-a',
      connectionSecurityFingerprint: 'connection-security:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', credentialSlotId: 'slot-a' }) };
  const calls: Promise<unknown>[] = [];
  const poll = () => {
    const call = services.resolveTeamCredentialBrokerEligibility(request).then(result => {
      expect(result).toEqual({ status: 'unavailable', reason: 'source_unavailable' });
    });
    void call.catch(() => {});
    calls.push(call);
    return call;
  };
  let changed: Promise<void> | undefined;
  const maintenance = refreshActiveProviderConnectionsCatalog({ credentials });
  try {
    poll();
    await historyEntered;
    for (let i = 0; i < 15; i++) { await delay(200); poll(); }
    await Promise.all(calls);
    // Eligibility settles while history remains blocked, without spending a
    // second row/source observation on any of the post-publication arrivals.
    expect(historyCompleted).toBe(false);
    expect(projectedTargets).toEqual([]);
    // One row+source observation despite steady post-publication demand. The
    // history owner has additionally verified destination row authority once.
    expect(sourceReads).toBe(1);
    expect(rowReads).toBe(2);
    expect(withdrawals).toHaveBeenCalledTimes(1);

    revision = 2;
    changed = refreshDemandedActiveProviderConnectionsCatalog({ token: credentials.token });
    await vi.waitFor(() => expect(withdrawals).toHaveBeenCalledTimes(2));
    await poll();
    expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({ status: 'ready', revision: 2 });
    // A real change reopens authority. This fixture has no raw Settings
    // observation, so the cleanup owner may also recheck the retained source.
    retireOnLease = true;
    await expect(services.resolveTeamCredentialBrokerEligibility(request))
      .resolves.toEqual({ status: 'unavailable', reason: 'source_unavailable' });
  } finally {
    releaseHistory();
    await Promise.allSettled([...calls, changed, maintenance]);
  }
});

it.each(['owner', 'joined'] as const)('cancels %s broker eligibility inside its pending catalog HTTP read', async custody => {
  const credentials = { token: 'eligibility-cancellation', encryption: null };
  const snapshot = providerSnapshot(DEFAULT_PROVIDER_SETTINGS_V1);
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
    providerConnectionsCatalog: undefined });
  const readCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  const controller = new AbortController();
  let enterRow = () => {};
  let releaseRow = () => {};
  const rowEntered = new Promise<void>(resolve => { enterRow = resolve; });
  const rowReleased = new Promise<void>(resolve => { releaseRow = resolve; });
  let transportAborted = false;
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      const signal = options?.signal;
      const abort = () => { transportAborted = true; releaseRow(); };
      signal?.addEventListener?.('abort', abort, { once: true });
      enterRow();
      try { await rowReleased; if (signal?.aborted) throw new Error('HTTP read cancelled'); }
      finally { signal?.removeEventListener?.('abort', abort); }
      // Cleanup also works on the unfixed path after the assertion deadline.
      return { status: 200, data: { status: 'absent' } };
    }
    throw new Error(`Unexpected cancelled eligibility HTTP boundary: ${path}`);
  });
  const services = createRuntimeProviderModelManagementServices({ machineId: 'machine-a',
    featureGate: { isEnabled: () => true },
    modelSettingsMutation: async (): Promise<never> => { throw new Error('No model mutation during eligibility'); } });
  const maintenance = custody === 'joined' ? refreshActiveProviderConnectionsCatalog({ credentials }) : undefined;
  let settled = false;
  const eligibility = services.resolveTeamCredentialBrokerEligibility({ machineId: 'machine-a',
    teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 1,
    source: TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'provider_connection', connectionId: 'connection-a',
      connectionSecurityFingerprint: 'connection-security:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', credentialSlotId: 'slot-a' }),
    application: { agentTargetKey: 'agent:acme.example/a', implementationIdentity: { pluginId: 'acme.example', localId: 'provider' },
      endpointTemplateId: 'chat', protocol: 'openai-chat' }, modelId: 'model-a', sourceRevision: 'revision-a',
  }, controller.signal).then(result => { settled = true; return result; });
  try {
    await rowEntered;
    await vi.waitFor(() => expect(readCredentials).toHaveBeenCalledTimes(1));
    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(transportAborted).toBe(custody === 'owner');
    await expect(eligibility).resolves.toMatchObject({ status: 'unavailable' });
  } finally { releaseRow(); await eligibility; await maintenance; }
});

async function runtimeStoreWithState(state = createEmptyProviderRuntimeStateFileV1('machine-a')) {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-model-management-'));
  temporaryPaths.push(happyHomeDir);
  const store = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine-a' });
  await store.update(() => state);
  return store;
}

it.each(['projection', 'manualAdd', 'models'] as const)('cancels the registered Provider %s handler inside its pending Home catalog read', async operation => {
  const credentials = { token: 'provider-read-cancellation', encryption: null };
  setActiveAccountSettingsSnapshot({ ...providerSnapshot(DEFAULT_PROVIDER_SETTINGS_V1),
    scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token), providerConnectionsCatalog: undefined });
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  let enterRow = () => {};
  let releaseRow = () => {};
  const rowEntered = new Promise<void>(resolve => { enterRow = resolve; });
  const rowReleased = new Promise<void>(resolve => { releaseRow = resolve; });
  let transportSignal: AbortSignal | undefined;
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      transportSignal = options?.signal as AbortSignal;
      enterRow(); await rowReleased;
      return { status: 200, data: { status: 'absent' } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    throw new Error(`Unexpected cancelled Provider HTTP boundary: ${path}`);
  });
  const services = createRuntimeProviderModelManagementServices({ machineId: 'machine-a',
    featureGate: { isEnabled: () => true }, modelSettingsMutation: async (): Promise<never> => {
      throw new Error('Cancelled catalog admission must not mutate');
    } });
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-read-cancellation-'));
  temporaryPaths.push(happyHomeDir);
  const connections = createRuntimeProviderConnectionServices({ machineId: 'machine-a', credentials, happyHomeDir,
    featureGate: { isEnabled: () => true }, runtimeSummary: services.summary });
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine-a', encryptionMode: 'plain', logger: () => {} });
  registerMachineProviderRpcHandlers({ rpcHandlerManager: rpc, machineId: 'machine-a', featureGate: { isEnabled: () => true },
    services: { ...services, ...connections, ...createLegacyProfileMigrationRpcServices({ credentials }),
      // The machine runtime projects its manual-refresh probe onto the RPC adapter.
      probe: (input, waiterLifetime) => services.probe(input, 'manual_refresh', waiterLifetime),
      probeDraft: (input, waiterLifetime) => services.probeDraft(input, waiterLifetime) } });
  const controller = new AbortController();
  const method = operation === 'projection' ? RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION
    : operation === 'models' ? RPC_METHODS.DAEMON_PROVIDERS_MODELS : RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE;
  const request = operation === 'projection' ? { machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', refreshPolicy: 'current_only' }
    : operation === 'models' ? { machineId: 'machine-a', connectionId: 'pc_missing' }
      : { action: 'manualAdd', machineId: 'machine-a', connectionId: 'pc_missing', expectedConnectionRevision: 1,
          models: [{ id: 'model-a', name: 'Model A' }] };
  let settled = false;
  const pending = rpc.invokeLocal(method, request, { signal: controller.signal }).then(result => { settled = true; return result; });
  try {
    await Promise.race([rowEntered, pending.then(result => { throw new Error(`Settled before Home read: ${JSON.stringify(result)}`); })]);
    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(transportSignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 'error', error: { code: 'provider_catalog_unavailable', action: 'retry' } });
  } finally { releaseRow(); await pending; }
});

function providerSnapshot(
  providerSettings: ProviderSettingsV1,
  savedSecretResources: ActiveAccountSettingsSnapshot['savedSecretResources'] = [],
): ActiveAccountSettingsSnapshot {
  const { catalog, defaults } = splitProviderSettingsV1(providerSettings);
  return {
    source: 'cache',
    settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
    providerConnectionsCatalog: { status: 'ready', revision: 1, catalog },
    savedSecretResources,
    savedSecretCatalogState: 'ready',
    settingsVersion: 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKeyForToken('provider-model-snapshot-account'),
  };
}

async function registeredProviderProjectionFixture(
  requiredCapabilities: NonNullable<Parameters<typeof createManagedRunLaunchFixture>[0]>['requiredCapabilities'] = { streaming: true },
) {
  const fixture = await createManagedRunLaunchFixture({ acceptedCredentialFormats: ['raw', 'bearer'],
    requiredCapabilities });
  const credentials = { token: 'custodian-projection', encryption: null };
  let snapshotReads = 0;
  let leaseRequests = 0;
  let snapshotAvailable = true;
  const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
    featureGate: { isEnabled: () => true },
    getAccountSettingsSnapshot: () => { snapshotReads += 1; return snapshotAvailable ? fixture.snapshot : null; },
    acquireRuntimeLease: async () => { leaseRequests += 1; return fixture.lease; },
    resolveAddresses: async () => ['1.1.1.1'],
    modelSettingsMutation: async (): Promise<never> => { throw new Error('No mutation during projection'); } });
  const connections = createRuntimeProviderConnectionServices({ machineId: fixture.machineId, credentials,
    happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true }, runtimeSummary: services.summary });
  const rpc = new RpcHandlerManager({ scopePrefix: fixture.machineId, encryptionMode: 'plain', logger: () => {} });
  registerMachineProviderRpcHandlers({ rpcHandlerManager: rpc, machineId: fixture.machineId,
    featureGate: { isEnabled: () => true },
    services: { ...services, ...connections, ...createLegacyProfileMigrationRpcServices({ credentials }),
      // The machine runtime projects its manual-refresh probe onto the RPC adapter.
      probe: (input, waiterLifetime) => services.probe(input, 'manual_refresh', waiterLifetime),
      probeDraft: (input, waiterLifetime) => services.probeDraft(input, waiterLifetime) } });
  const request = { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, refreshPolicy: 'current_only' as const };
  const envelope = { v: 1 as const, requestId: 'foreign-projection', target: { kind: 'machine' as const, machineId: fixture.machineId }, input: request };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
    serverIdentityId: 'srv_home', accountId: 'requester', custodianAccountId: 'custodian',
    authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
    machineId: fixture.machineId, installationId: 'installation', actionId: 'providers.models.projection',
    requestId: envelope.requestId, target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const admission = { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: fixture.machineId,
    installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
  const carriers = {
    machine: { rpcContext: { machineAdmission: admission } },
    httpRoot: { rpcContext: { callerInputAuthorization: authorization } },
    localRoot: { localActionContext: { externalActionExecutionAuthorization: authorization } },
  } satisfies Record<string, NonNullable<Parameters<RpcHandlerManager['invokeLocal']>[2]>>;
  const teamCredentialModel = TeamCredentialProviderModelCatalogEntryV1Schema.parse({
    selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
      expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: fixture.agentTargetKey, modelId: 'team-model' },
    descriptor: { id: 'team-model', name: 'Team model' },
    application: { agentTargetKey: fixture.agentTargetKey, implementationIdentity: { pluginId: 'acme.gateway', localId: 'gateway' },
      endpointTemplateId: 'responses', protocol: 'openai-responses' },
    sourceFacts: { endpoint: { id: 'responses', protocol: 'openai-responses', capabilities: {
      streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } },
      compatibilityOverrides: [{ agentTargetKey: fixture.agentTargetKey, protocol: 'openai-responses', status: 'verified',
        reason: 'Fixture endpoint contract', evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-23' } }] },
    sourceRevision: 'team-source', availability: 'available',
  });
  const teamCredentialResource = TeamCredentialResourceCatalogEntryV1Schema.parse({
    id: 'resource', teamId: 'team', displayName: 'Team source', resourceRevision: 1,
    readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: true,
    directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
    connectedServiceSelections: [], sourcePresentation: null, deliveryPolicy: { preferredAllowedModes: ['direct', 'brokered'] },
    allowedRoutes: ['direct', 'brokered'], providerModels: [teamCredentialModel],
  });
  return { ...fixture, services, rpc, request, carriers, admission, teamCredentialModel, teamCredentialResource,
    costs: () => ({ snapshotReads, leaseRequests }), retireAmbientSnapshot: () => { snapshotAvailable = false; } };
}

it.each(['machine', 'httpRoot', 'localRoot'] as const)(
  'refuses foreign private or competing Provider projection before Account work (%s)', async carrier => {
    const fixture = await registeredProviderProjectionFixture();
    const http = vi.spyOn(axios, 'get').mockRejectedValue(new Error('No Home read for a foreign projection'));
    try {
      for (const input of [fixture.request, { ...fixture.request, teamCredentialResources: [fixture.teamCredentialResource],
        sourceConnectionId: 'run-gateway' }]) {
        await expect(fixture.rpc.invokeLocal(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, input, fixture.carriers[carrier]))
          .resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
      }
      expect(fixture.costs()).toEqual({ snapshotReads: 0, leaseRequests: 0 });
      expect(http).not.toHaveBeenCalled();
    } finally { await fixture.cleanup(); }
  },
);

it('resolves an entire foreign Team picker batch once using custodian ordering and exact worker compatibility', async () => {
  const fixture = await registeredProviderProjectionFixture();
  const http = vi.spyOn(axios, 'get').mockRejectedValue(new Error('No Home or private catalog read for a worker batch'));
  try {
    fixture.retireAmbientSnapshot();
    const brokered = fixture.teamCredentialModel;
    const direct = { ...brokered, selection: { ...brokered.selection, deliveryMode: 'direct' as const } };
    const resource = { ...fixture.teamCredentialResource, providerModels: [brokered, direct] };
    await expect(fixture.rpc.invokeLocal(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
      { ...fixture.request, teamCredentialResources: [resource] }, fixture.carriers.machine))
      .resolves.toMatchObject({ status: 'success', groups: [], teamCredentialResources: [{
        providerModels: [{ selection: { deliveryMode: 'direct' }, compatibility: { result: { status: 'verified' }, confirmed: true } }],
      }] });
    expect(fixture.costs()).toEqual({ snapshotReads: 0, leaseRequests: 1 });
    expect(http).not.toHaveBeenCalled();
  } finally { await fixture.cleanup(); }
});

it('qualifies Team model capabilities at the worker and retains hard refusal facts for the picker', async () => {
  const fixture = await registeredProviderProjectionFixture({ streaming: true, toolRoundTrips: true });
  try {
    fixture.retireAmbientSnapshot();
    for (const toolRoundTrips of ['unsupported', 'unknown', 'supported'] as const) {
      const row = TeamCredentialProviderModelCatalogEntryV1Schema.parse({ ...fixture.teamCredentialModel,
        descriptor: { id: 'image-or-chat-model', name: 'Model', capabilities: { toolRoundTrips } },
        selection: { ...fixture.teamCredentialModel.selection, modelId: 'image-or-chat-model' } });
      const result = await fixture.rpc.invokeLocal(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        { ...fixture.request, teamCredentialResources: [{ ...fixture.teamCredentialResource, providerModels: [row] }] }, fixture.carriers.machine);
      expect(result).toMatchObject({ status: 'success', groups: [], teamCredentialResources: [{ providerModels: [{
        compatibility: { result: { status: toolRoundTrips === 'unsupported' ? 'incompatible'
          : toolRoundTrips === 'unknown' ? 'experimental' : 'verified' } },
        availability: toolRoundTrips === 'unsupported' ? 'policy_denied' : 'available',
        ...(toolRoundTrips === 'unsupported' ? { deliveryUnavailableReason: 'provider_incompatible_with_agent' } : {}),
      }] }] });
    }
    const result = await fixture.rpc.invokeLocal(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
      { ...fixture.request, teamCredentialResources: [{ ...fixture.teamCredentialResource,
        providerModels: [{ ...fixture.teamCredentialModel, sourceFacts: undefined }],
      }] }, fixture.carriers.machine);
    expect(result).toMatchObject({ status: 'success', teamCredentialResources: [{ providerModels: [{
      availability: 'policy_denied', deliveryUnavailableReason: 'provider_incompatible_with_agent',
    }] }] });
  } finally { await fixture.cleanup(); }
});

it('projects only the foreign Team model without custodian Account readiness and preserves owned reads', async () => {
  const fixture = await registeredProviderProjectionFixture();
  const http = vi.spyOn(axios, 'get').mockRejectedValue(new Error('No Home read for a worker Team projection'));
  try {
    fixture.retireAmbientSnapshot();
    for (const status of ['verified', 'experimental'] as const) {
      const teamCredentialModel = TeamCredentialProviderModelCatalogEntryV1Schema.parse({ ...fixture.teamCredentialModel,
        sourceFacts: { ...fixture.teamCredentialModel.sourceFacts, compatibilityOverrides: [{
          agentTargetKey: fixture.agentTargetKey, protocol: 'openai-responses', status,
          reason: 'Fixture endpoint contract', evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-23' },
        }] } });
      await expect(fixture.rpc.invokeLocal(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        { ...fixture.request, teamCredentialResources: [{ ...fixture.teamCredentialResource, providerModels: [teamCredentialModel] }] }, fixture.carriers.machine))
        .resolves.toMatchObject({ status: 'success', groups: [], teamCredentialResources: [{ providerModels: [{
          selection: { modelId: 'team-model' }, compatibility: { result: { status }, confirmed: true },
        }] }] });
    }
    expect(fixture.costs()).toEqual({ snapshotReads: 0, leaseRequests: 2 });
    expect(http).not.toHaveBeenCalled();
  } finally { await fixture.cleanup(); }
  const owned = await registeredProviderProjectionFixture();
  try {
    for (const options of [undefined, { rpcContext: { machineAdmission: { ...owned.admission, actorAccountId: 'custodian' } } }]) {
      const snapshotReads = owned.costs().snapshotReads;
      await expect(owned.rpc.invokeLocal(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, owned.request, options))
        .resolves.toMatchObject({ status: 'success' });
      expect(owned.costs().snapshotReads).toBeGreaterThan(snapshotReads);
    }
  } finally { await owned.cleanup(); }
});

describe('runtime provider model-management composition', () => {
  const unexpectedModelSettingsMutation = async (
    _intent: ProviderModelSettingsMutationIntent,
  ): Promise<never> => {
    throw new Error('Unexpected model-settings effect');
  };

  it('projects an admitted Connected Pool source without personal Provider catalog reads and refuses withdrawn sources', async () => {
    const fixture = await createManagedRunLaunchFixture();
    const base = createBrokerProviderRegistry();
    const registry = { ...fixture.lease.registry, contributes: { ...fixture.lease.registry.contributes,
      providersByContributionKey: new Map([...base.providersByContributionKey].map(([key, provider]) => [key, {
        ...provider, definition: ProviderContributionV1Schema.parse({ ...provider.definition,
          managedRuntime: { ...provider.definition.managedRuntime, connectedAccounts: [{
            purpose: 'openai-upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            endpointTemplateIds: ['cliproxyapi-openai-responses'], staticModels: [{ id: 'pool-model', name: 'Pool model' }],
          }] },
        }),
      }])) } };
    let sourceAvailable = true;
    const unexpected = async (): Promise<never> => { throw new Error('No credential or mutation effect during source projection'); };
    // Home target reads and the binding store are boundaries; purpose selection/currentness stay real.
    const purposes = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected,
      resolveTarget: async target => sourceAvailable && target.kind === 'group' ? {
        account: { service: target.service, accountId: 'pool-account' }, displayName: 'Pool source',
        group: { groupId: target.groupId, generation: 1 },
      } : null,
    });
    let snapshotReads = 0;
    const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
      featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => { snapshotReads += 1; return null; },
      acquireRuntimeLease: async () => ({ ...fixture.lease, registry }),
      resolveManagedPurposeBindingIntentSelection: purposes.resolveBindingIntentSelection,
      modelSettingsMutation: unexpectedModelSettingsMutation });
    const http = vi.spyOn(axios, 'get').mockRejectedValue(new Error('No personal catalog HTTP read for Connected Pool source'));
    const rpc = new RpcHandlerManager({ scopePrefix: fixture.machineId, encryptionMode: 'plain', logger: () => {} });
    registerMachineProviderRpcHandlers({ rpcHandlerManager: rpc, machineId: fixture.machineId,
      featureGate: { isEnabled: () => true }, services: { ...services,
        probe: (input, waiterLifetime) => services.probe(input, 'manual_refresh', waiterLifetime),
        ...createRuntimeProviderConnectionServices({ machineId: fixture.machineId, happyHomeDir: fixture.happyHomeDir,
          credentials: { token: 'pool-custodian', encryption: null }, featureGate: { isEnabled: () => true },
          runtimeSummary: services.summary }),
        ...createLegacyProfileMigrationRpcServices({ credentials: { token: 'pool-custodian', encryption: null } }),
      } });
    const application = { agentTargetKey: fixture.agentTargetKey,
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' as const };
    const request = { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey,
      sourceCatalog: true as const, refreshPolicy: 'current_only' as const, application,
      connectedAccountTarget: { kind: 'group' as const,
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'pool' } };
    const eligibilityRequest = { machineId: fixture.machineId, teamId: 'team', resourceId: 'resource',
      expectedResourceRevision: 1, scope: 'source_any' as const,
      source: TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'connected_pool',
        target: request.connectedAccountTarget, poolIncarnation: 'pool-incarnation' }) };
    try {
      const response = await rpc.invokeLocal(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, request);
      expect(response).toMatchObject({ status: 'success', groups: [{ rows: [{ ref: { modelId: 'pool-model' }, application }] }] });
      expect(admitTeamCredentialSourceModelRowsV1(response)).toMatchObject({ status: 'success', rows: [{
        row: { ref: { modelId: 'pool-model' }, application }, sourceRevision: expect.any(String),
      }] });
      expect(snapshotReads).toBe(0);
      expect(http).not.toHaveBeenCalled();
      const eligibility = await services.resolveTeamCredentialBrokerEligibility(eligibilityRequest);
      expect.soft(snapshotReads).toBe(0);
      expect(eligibility).toEqual({ status: 'eligible' });

      let accountCurrent = true;
      const accountContext = {
        getAccountSettingsSnapshot: (): never => { throw new Error('No personal Account snapshot read for source catalog'); },
        resolveManagedPurposeBindingIntent: purposes.resolveBindingIntent,
        resolveManagedPurposeBindingIntentSelection: purposes.resolveBindingIntentSelection,
        signal: new AbortController().signal, isCurrent: () => accountCurrent,
      };
      await expect(services.projectModelsForAccount(request, accountContext)).resolves.toMatchObject({ status: 'success' });
      await expect(services.projectModelsForAccount(request,
        { ...accountContext, resolveManagedPurposeBindingIntentSelection: undefined }))
        .resolves.toMatchObject({ status: 'error', error: { code: 'provider_catalog_unavailable' } });
      accountCurrent = false;
      await expect(services.projectModelsForAccount(request, accountContext))
        .resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });

      await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, request,
        { rpcContext: { machineAdmission: { actorAccountId: 'recipient', custodianAccountId: 'custodian',
          machineId: fixture.machineId, installationId: 'installation', role: 'use', encryptionMode: 'plain' } } }))
        .resolves.toMatchObject({ status: 'error', error: { code: 'provider_authorization_changed' } });
      sourceAvailable = false;
      await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, request))
        .resolves.toMatchObject({ status: 'error', error: { code: 'provider_catalog_unavailable' } });
      await expect(services.resolveTeamCredentialBrokerEligibility(eligibilityRequest))
        .resolves.toEqual({ status: 'unavailable', reason: 'source_unavailable' });
      expect(snapshotReads).toBe(0);
      expect(http).not.toHaveBeenCalled();
      await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, refreshPolicy: 'current_only' }))
        .resolves.toMatchObject({ status: 'error', error: { code: 'provider_settings_invalid' } });
    } finally { await fixture.cleanup(); }
  });

  it('resolves manual-model policy for a canonical-key connection through the registry', () => {
    const definition = ProviderContributionV1Schema.parse({
      v: 1,
      id: 'main',
      name: 'Gateway',
      kind: 'cloud',
      endpointTemplates: [{
        id: 'chat',
        protocol: 'openai-chat',
        baseUrl: 'https://models.example/v1',
        capabilities: {
          streaming: 'unknown', toolRoundTrips: 'unknown',
          statefulResponses: 'unknown', reasoningControls: 'unknown',
        },
      }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    });
    const contribution: ResolvedProviderContribution = {
      provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.gateway',
      identity: { pluginId: 'acme.gateway', localId: 'main' }, definition,
    };

    expect(resolveProviderManualModelCatalog(
      { providersByContributionKey: new Map([['acme.gateway/main', contribution]]) },
      { kind: 'contribution', contributionKey: 'acme.gateway/main' },
    )).toEqual(definition.catalog);
  });

  it.each(['issued', 'ambient'] as const)('projects current %s structured refs and compatibility without exposing endpoints or secrets', async custody => {
    const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
    const contributionKey = 'acme.gateway/main';
    const definition = ProviderContributionV1Schema.parse({
      v: 1, id: 'main', name: 'Gateway', kind: 'cloud',
      endpointTemplates: [{
        id: 'chat', protocol: 'openai-chat', baseUrl: 'https://models.example/v1',
        capabilities: {
          streaming: 'supported', toolRoundTrips: 'supported',
          statefulResponses: 'unknown', reasoningControls: 'unknown',
        },
      }],
      credential: {
        kind: 'apiKey',
        required: false,
        transports: [{
          id: 'authorization',
          protocols: ['openai-chat'],
          uses: ['probe', 'runtime'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
        }],
      },
      catalog: {
        source: 'static+probe', manualModelPolicy: 'catalog-only',
        staticModels: [{
          id: 'same-id',
          name: 'Provider Same',
          aliases: ['same-alias'],
          modelOptions: [{
            id: 'reasoning_effort',
            name: 'Reasoning effort',
            type: 'select',
            currentValue: 'high',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
          }],
          capabilities: { toolRoundTrips: 'supported', reasoningControls: 'supported' },
        }],
        probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'openai-models' }],
      },
      compatibilityOverrides: ['agent:happier.agent.codex/codex'].map((agentTargetKey) => ({
        agentTargetKey, protocol: 'openai-chat' as const, status: 'verified' as const, reason: 'real integration',
        evidence: { sourceUrls: ['https://docs.example.test'], verifiedAt: '2026-07-11', testIds: ['real-session'] },
      })),
    });
    const contribution: ResolvedProviderContribution = {
      provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.gateway',
      identity: { pluginId: 'acme.gateway', localId: 'main' },
      definition,
    };
    const registry = { providersByContributionKey: new Map([
      ...createBrokerProviderRegistry().providersByContributionKey,
      ['acme.gateway/main', contribution],
    ]) };
    const preparedDefinition = ProviderContributionV1Schema.parse({
      ...definition,
      catalog: {
        ...definition.catalog,
        staticModels: [{
          id: 'same-id',
          name: 'Reasoning 200k thinking generation',
          capabilities: { toolRoundTrips: 'supported' },
        }],
      },
    });
    const preparedRegistry = {
      providersByContributionKey: new Map([
        ...createBrokerProviderRegistry().providersByContributionKey,
        ['acme.gateway/main', {
        ...contribution,
        definition: preparedDefinition,
      } satisfies ResolvedProviderContribution]]),
    };
    const base = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1, id: connectionId, source: { kind: 'contribution', contributionKey }, role: 'default',
        displayName: 'Gateway', displayNameMode: 'automatic', revision: 2, createdAt: 1, updatedAt: 2,
      }],
    });
    const resolved = resolveProviderConnectionForMachine({
      connectionId, machineId: 'machine-a', providerSettings: base, registry,
      dnsEvidenceByEndpointUrl: new Map([['https://models.example/v1', ['1.1.1.1']]]),
    });
    if (resolved.status !== 'resolved') throw new Error('Expected provider connection');
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      secretBindingsByConnectionId: {
        [connectionId]: { account: { apiKey: formatSharedSavedSecretRefV1('secret-gateway') } },
      },
      accountGrants: [{
        v: 1, connectionId, connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1,
      }],
    });
    const support = {
      acceptsProtocols: ['openai-chat'], required: { streaming: true },
      credentialSupport: {
        supportsNoAuth: true,
        apiKeyTransports: [{
          protocol: 'openai-chat',
          destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['bearer'] },
        }],
      },
      authIsolation: { suppressConnectedServiceIds: ['openai-codex'], ownedEnvKeys: [] },
      materialization: 'engineConfig', applyPolicy: 'restart_session', supportsFreeformModelIds: false,
    } as const;
    const agentDefinition = (providerRequirements: unknown) => ({
      id: 'codex',
      pluginId: 'happier.agent.codex',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      definition: { id: 'codex', kindVersion: 1, providerRequirements },
    });
    const agentDefinitionsById = new Map([['codex', agentDefinition(support)]]);
    const executable = {
      generation: 7,
      contributes: {
        providersByContributionKey: registry.providersByContributionKey,
        agentDefinitionsById,
      },
      activateContributionsOnDemand: vi.fn(async () => []),
      agentRuntimesByAgentId: new Map([['codex', {
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        generation: 'fixture-generation',
        providerBinding: {
          v: 1, adapterVersion: 1,
          prepare: vi.fn(() => ({ v: 1, materialization: 'engineConfig' })),
          materialize: vi.fn(),
        },
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createRuntime: vi.fn(),
      }]]),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const lease: PluginRuntimeRegistryLease = {
      registry: executable,
      source: 'active',
      durableRevision: -1,
      release: vi.fn(async () => undefined),
    };
    const preparedLease: PluginRuntimeRegistryLease = {
      registry: {
        ...executable,
        contributes: {
          ...executable.contributes,
          providersByContributionKey: preparedRegistry.providersByContributionKey,
        },
      } as unknown as ResolvedExecutablePluginRuntimeRegistry,
      source: 'active',
      durableRevision: -1,
      release: vi.fn(async () => undefined),
    };
    let currentLease = lease;
    const resourceId = 'secret-gateway';
    const savedSecretResource = { resourceId, ownerAccountId: 'owner-account', displayName: 'Gateway key',
      kind: 'apiKey' as const, encryptionMode: 'plain' as const, revision: 1, materialStatus: 'ready' as const,
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
        content: { v: 1, name: 'Gateway key', kind: 'apiKey', value: 'gateway-secret' } }) };
    const secretInspection = createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [],
      resources: [savedSecretResource] }).inspect(formatSharedSavedSecretRefV1(resourceId));
    if (secretInspection.status !== 'ready') throw new Error('Expected captured Provider resource');
    const observationAuthorizationFingerprint = createProviderObservationAuthorizationFingerprintV1({
      selectedSecretBindingId: formatSharedSavedSecretRefV1('secret-gateway'),
      selectedSecretRecordFingerprint: secretInspection.fingerprint,
      credential: {
        selectedProtocol: 'openai-chat',
        selectedUse: 'probe',
        transport: definition.credential!.transports[0]!,
      },
    });
    const probeRequestFingerprint = createProviderProbeRequestFingerprintV1({
      method: 'GET',
      endpointUrl: 'https://models.example/v1',
      path: '/models',
      parser: 'openai-models',
      publicHeaders: {},
    });
    const currentEndpointFingerprint = createProviderEndpointFingerprintV1({
      endpointTemplateId: 'chat',
      protocol: 'openai-chat',
      probeRequestFingerprint,
    });
    const currentCatalogRecord = {
      key: {
        machineId: 'machine-a',
        connectionId,
        catalogFingerprint: createProviderCatalogFingerprintV1({
          probeRequestFingerprints: [probeRequestFingerprint],
        }),
        observationAuthorizationFingerprint,
      },
      state: {
        catalogObservationId: 'current-observation',
        snapshot: {
          models: [{ id: 'probe-current', name: 'Probe current' }],
          observedAt: 20,
          stale: true,
          staleAt: 30,
        },
        staleProbeModels: [{ id: 'probe-disappeared', name: 'Probe disappeared' }],
      },
      lastAccessedAt: 30,
    };
    const state = ProviderRuntimeStateFileV1Schema.parse({
      ...createEmptyProviderRuntimeStateFileV1('machine-a'),
      endpointHealth: [
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId, endpointTemplateId: 'chat',
            endpointFingerprint: 'endpoint-observation:v1:old-endpoint',
            observationAuthorizationFingerprint,
          },
          state: { status: 'available', activity: 'idle', observedAt: 30 },
          lastAccessedAt: 30,
        }),
        ProviderEndpointRuntimeStateRecordV1Schema.parse({
          key: {
            machineId: 'machine-a', connectionId, endpointTemplateId: 'chat',
            endpointFingerprint: currentEndpointFingerprint,
            observationAuthorizationFingerprint,
          },
          state: {
            status: 'unreachable', activity: 'idle', observedAt: 20,
            errorCode: 'provider_endpoint_unreachable',
          },
          lastAccessedAt: 20,
        }),
      ],
    });
    const runtimeStore = await runtimeStoreWithState(state);
    const token = 'provider-model-management-account';
    const authorizedAccountSettings = { ...providerSnapshot(settings, [savedSecretResource]),
      scopeKey: resolveAccountSettingsScopeKeyForToken(token) };
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token, encryption: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: { teams: { enabled: true } }, capabilities: {} }))));
    const materialResponse = { status: 200, data: { resources: [{
      resourceId, encryptionMode: 'plain', recipientEnvelope: null, storedContent: savedSecretResource.storedContent,
      entry: { ref: formatSharedSavedSecretRefV1(resourceId), source: 'shared_resource', relationship: 'recipient',
        name: 'Gateway key', kind: 'apiKey', ownerAccountId: 'owner-account', revision: savedSecretResource.revision, materialStatus: 'ready',
        capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
    }] } };
    let observedCatalog = splitProviderSettingsV1(settings).catalog;
    let observedRevision = 1;
    let catalogReadGate: Promise<void> | undefined;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/provider-connections') {
        await catalogReadGate;
        return { status: 200, data: { status: 'present', revision: observedRevision,
          content: { t: 'plain', v: observedCatalog } } };
      }
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      const history = emptyAccountSettingsHistoryCaptureResponse(path);
      return history ?? materialResponse;
    });
    const accountSettings = authorizedAccountSettings;
    setActiveAccountSettingsSnapshot(authorizedAccountSettings);
    const publishProviderSettings = (providerSettings: ProviderSettingsV1, revision: number) => {
      const { catalog } = splitProviderSettingsV1(providerSettings);
      observedCatalog = catalog;
      observedRevision = revision;
      if (!commitActiveProviderConnectionsCatalog({
        scopeKey: authorizedAccountSettings.scopeKey,
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
        catalog: { status: 'ready', revision, catalog },
      })) throw new Error('Expected the captured Provider row update to be admitted');
    };
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'same-id' }] }), 'utf8'),
    }));
    const modelSettingsMutation = unexpectedModelSettingsMutation;
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a', registry, runtimeStore,
      resolveRegistry: async () => preparedRegistry,
      resolveAddresses: async () => ['1.1.1.1'], acquireRuntimeLease: async () => currentLease,
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      ...(custody === 'issued' ? { getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot } : {}),
      featureGate: { isEnabled: () => true },
      modelSettingsMutation,
    });

    // Native discovery can reach this shared projection before its Agent has
    // been admitted. No Provider endpoint has been contacted in that case.
    await expect(services.projectModels({ machineId: 'machine-a', agentTargetKey: 'agent:acme.missing/missing' }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'agent_unavailable' } });

    if (custody === 'ambient') {
      // A different client completed this row write; this daemon has no hint yet.
      observedCatalog = { ...observedCatalog, connections: observedCatalog.connections.map(connection => ({
        ...connection, displayName: 'Current Gateway', displayNameMode: 'custom' as const,
      })) };
      observedRevision += 1;
    }
    // Observe real work; do not substitute the catalog owner or connection resolver.
    const nameCatalogReads = vi.spyOn(providerContributions, 'readProviderModelNameCatalog');
    const result = await services.projectModels({ machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex' });
    expect(nameCatalogReads).toHaveBeenCalledTimes(1);
    if (custody === 'ambient') expect(result).toMatchObject({ status: 'success', groups: [
      expect.objectContaining({ connectionId, connectionName: 'Current Gateway' }),
    ] });
    expect(executable.activateContributionsOnDemand).toHaveBeenCalledWith([{
      pluginId: 'happier.agent.codex',
      family: 'agents',
      localId: 'codex',
    }]);
    expect(result).toMatchObject({
      status: 'success', agentTargetKey: 'agent:happier.agent.codex/codex',
      groups: [{
        connectionId, connectionRevision: 2, supportsFreeformModelIds: false,
        sourceAuthority: {
          provider: {
            identity: { pluginId: 'acme.gateway', localId: 'main' },
            definitionRevision: 1,
          },
          connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
        },
        suppressedConnectedServiceIds: ['openai-codex'],
        modelLoadAction: 'descriptor_absent',
        modelLoadPreflightPolicy: null,
        rows: [{
          ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'same-id' },
          descriptor: { name: 'Provider Same' },
          compatibility: { result: { status: 'verified' }, confirmed: true },
          // The exact current unreachable observation beats a newer available
          // observation for a different endpoint fingerprint.
          endpointHealth: 'unreachable',
        }],
      }],
    });
    if (result.status !== 'success') throw new Error('Expected model projection');
    expect(result.groups[0]?.rows[0]).not.toHaveProperty('requestPolicySupport');
    const requestPolicyProjection = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      includeTeamCredentialRequestPolicySupport: true,
    });
    expect(requestPolicyProjection).toMatchObject({
      status: 'success',
      groups: [{
        rows: [{
          requestPolicySupport: {
            application: {
              agentTargetKey: 'agent:happier.agent.codex/codex',
              implementationIdentity: { pluginId: 'acme.gateway', localId: 'main' },
              endpointTemplateId: 'chat',
              protocol: 'openai-chat',
            },
            sourceRevision: result.groups[0]?.sourceRevision,
            protocolKind: 'openai_chat_completions',
            model: { canonicalId: 'same-id', aliases: ['same-alias'] },
            reasoningEffort: {
              supported: true,
              allowedValues: ['low', 'high'],
              defaultValue: 'high',
            },
          },
        }],
      }],
    });
    expect(JSON.stringify(requestPolicyProjection)).not.toContain('models.example');
    expect(JSON.stringify(requestPolicyProjection)).not.toContain('Authorization');
    // Policy enforcement keeps source facts even when this Agent has no effort control.
    expect(result.groups[0]?.rows[0]?.descriptor.modelOptions
      ?.find(option => option.id === 'reasoning_effort')).toBeUndefined();
    agentDefinitionsById.set('codex', agentDefinition({ ...support, supportsReasoningEffort: true }));
    const supportedEffortProjection = await services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex',
      includeTeamCredentialRequestPolicySupport: true,
    });
    expect(supportedEffortProjection).toMatchObject({ status: 'success', groups: [{ rows: [{
      requestPolicySupport: { reasoningEffort: { supported: true, allowedValues: ['low', 'high'] } },
    }] }] });
    if (supportedEffortProjection.status !== 'success') throw new Error('Expected model projection');
    expect(supportedEffortProjection.groups[0]?.rows[0]?.descriptor.modelOptions
      ?.find(option => option.id === 'reasoning_effort')?.options?.map(option => option.value))
      .toEqual(['low', 'high']);
    agentDefinitionsById.set('codex', agentDefinition(support));
    const parsedTeamProviderSource = TeamCredentialSourceBindingV1Schema.parse({
      v: 1 as const,
      kind: 'provider_connection' as const,
      connectionId,
      connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
      credentialSlotId: 'apiKey',
    });
    if (parsedTeamProviderSource.kind !== 'provider_connection') {
      throw new Error('Expected Provider Connection source');
    }
    const teamProviderSource = parsedTeamProviderSource;
    await expect(services.resolveTeamCredentialResourceTestCandidate({
      machineId: 'machine-a',
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 3,
      source: teamProviderSource,
    })).resolves.toMatchObject({
      status: 'success',
      application: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-chat',
        protocol: 'openai-chat',
      },
      request: { route: 'chat_completions', pathAndQuery: '/v1/chat/completions' },
    });
    const brokerApplication = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-openai-chat',
      protocol: 'openai-chat' as const,
    };
    await expect(services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: brokerApplication.agentTargetKey,
      providerConnection: {
        connectionId,
        expectedConnectionSecurityFingerprint: teamProviderSource.connectionSecurityFingerprint,
      },
      application: brokerApplication,
    })).resolves.toMatchObject({
      status: 'success',
      groups: [{ rows: [{ application: brokerApplication }] }],
    });
    const directApplication = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      implementationIdentity: { pluginId: 'acme.gateway', localId: 'main' },
      endpointTemplateId: 'chat',
      protocol: 'openai-chat' as const,
    };
    await expect(services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: directApplication.agentTargetKey,
      providerConnection: {
        connectionId,
        expectedConnectionSecurityFingerprint: teamProviderSource.connectionSecurityFingerprint,
      },
      application: directApplication,
      includeDirectMaterialization: true,
    })).resolves.toMatchObject({
      status: 'success',
      groups: [{ rows: [{
        application: directApplication,
        directMaterialization: { endpoint: { endpointTemplateId: 'chat' } },
      }] }],
    });
    const canonicalBrokerApplication = {
      ...brokerApplication,
      agentTargetKey: 'agent:happier.agent.codex/codex',
    };
    const canonicalProjection = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: canonicalBrokerApplication.agentTargetKey,
      sourceCatalog: true,
      providerConnection: {
        connectionId,
        expectedConnectionSecurityFingerprint: teamProviderSource.connectionSecurityFingerprint,
      },
      application: canonicalBrokerApplication,
      refreshPolicy: 'current_only',
    });
    if (canonicalProjection.status !== 'success' || !canonicalProjection.groups[0]?.sourceRevision) {
      throw new Error('Expected canonical broker source revision');
    }
    await expect(services.resolveTeamCredentialRequestPolicySupport({
      machineId: 'machine-a',
      source: teamProviderSource,
      refreshPolicy: 'current_only',
    })).resolves.toMatchObject({
      status: 'success',
      models: [{
        application: canonicalBrokerApplication,
        sourceRevision: canonicalProjection.groups[0].sourceRevision,
        descriptor: { id: 'same-id', name: 'Provider Same', aliases: ['same-alias'] },
        model: { canonicalId: 'same-id', aliases: ['same-alias'] },
        protocolKind: 'openai_chat_completions',
      }],
    });
    await expect(services.resolveTeamCredentialRequestPolicySupport({
      machineId: 'machine-a',
      source: { ...teamProviderSource, connectionId: ProviderConnectionIdSchema.parse('missing-connection') },
      refreshPolicy: 'current_only',
    })).resolves.toEqual({ status: 'unavailable', reason: 'source_unavailable' });
    await expect(services.resolveTeamCredentialBrokerSourceSelection({
      machineId: 'machine-a',
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 3,
      source: teamProviderSource,
      application: canonicalBrokerApplication,
      modelId: 'same-id',
      sourceRevision: canonicalProjection.groups[0].sourceRevision,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      endpointTemplateId: 'chat',
      protocol: 'openai-chat',
      credentialTransport: { destination: { kind: 'httpHeader' } },
    });
    // A prepared projection exists concurrently, but the held lease is the
    // operation's authority. The next operation observes that prepared lease.
    currentLease = preparedLease;
    nameCatalogReads.mockClear();
    const nextResult = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      includeTeamCredentialRequestPolicySupport: true,
    });
    expect(nameCatalogReads).toHaveBeenCalledTimes(1);
    expect(nextResult).toMatchObject({
      status: 'success',
      groups: [{ rows: [{
        descriptor: { name: 'Reasoning 200k thinking generation' },
        requestPolicySupport: {
          reasoningEffort: { supported: false },
        },
      }] }],
    });
    if (nextResult.status !== 'success') throw new Error('Expected next model projection');
    expect(nextResult.groups[0]?.sourceRevision).not.toBe(result.groups[0]?.sourceRevision);
    currentLease = lease;
    expect(JSON.stringify(result)).not.toContain('models.example');
    expect(JSON.stringify(result)).not.toContain('publicHeaders');
    const projectedRow = result.groups[0]?.rows[0];
    if (!projectedRow) throw new Error('Expected projected model row');
    await expect(services.mutateModelSettings({
      action: 'confirmExperimental',
      machineId: 'machine-a',
      connectionId,
      expectedConnectionRevision: 2,
      agentTargetKey: 'agent:happier.agent.codex/codex',
      modelId: projectedRow.ref.modelId,
      compatibilityFingerprint: projectedRow.compatibility.compatibilityFingerprint,
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_compatibility_unverified' },
    });
    await vi.waitFor(() => expect(transport).toHaveBeenCalled());

    const selection = {
      v: 1 as const, updatedAt: 1,
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'same-id' },
    };
    const authorization = resolveProviderSpawnAuthorization({
      selection, machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', agentId: 'codex',
      accountSettings: accountSettings.settings, savedSecretResources: accountSettings.savedSecretResources, providerSettings: settings,
      registry, dnsEvidenceByEndpointUrl: new Map([['https://models.example/v1', ['1.1.1.1']]]), lease,
    });
    if (!authorization.ok) throw new Error('Expected provider authorization');
    if (custody === 'ambient') {
      // Binding status shares the explicit read/probe budget, including Home
      // admission. A Home read that ignores withdrawal cannot retain this RPC.
      let releaseCatalog!: () => void;
      catalogReadGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
      vi.useFakeTimers();
      const pending = services.resolveBindingStatus({ machineId: 'machine-a',
        agentTargetKey: 'agent:happier.agent.codex/codex', selection,
        launchBinding: authorization.authorization.sessionBindingMetadata });
      try {
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs + 1);
        expect(settled).toBe(true);
        await expect(pending).resolves.toMatchObject({ status: 'incompatible',
          error: { code: 'provider_catalog_unavailable', retryable: true, action: 'retry' } });
        releaseCatalog();
      } finally {
        releaseCatalog(); catalogReadGate = undefined; await pending; vi.useRealTimers();
        // Drain the deliberately unabortable transport before exercising recovery.
        await refreshActiveProviderConnectionsCatalog({ credentials: { token, encryption: null } });
      }
    } else {
      await expect(services.resolveBindingStatus({ machineId: 'machine-a',
        agentTargetKey: 'agent:happier.agent.codex/codex', selection,
        launchBinding: authorization.authorization.sessionBindingMetadata })).resolves.toEqual({ status: 'current' });
    }
    await expect(services.resolveBindingStatus({
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', selection,
      launchBinding: {
        ...authorization.authorization.sessionBindingMetadata,
        bindingSecurityFingerprint: 'binding-security:v1:changed',
      },
    })).resolves.toEqual({
      status: 'changed',
      nextBindingSecurityFingerprint: authorization.authorization.bindingSecurityFingerprint,
    });

    const probeSelection = (modelId: string) => ({
      v: 1 as const,
      updatedAt: 1,
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId },
    });
    const authorizePreviouslyCurrentProbe = (modelId: string) => resolveProviderSpawnAuthorization({
      selection: probeSelection(modelId),
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentId: 'codex',
      accountSettings: accountSettings.settings, savedSecretResources: accountSettings.savedSecretResources,
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: new Map([['https://models.example/v1', ['1.1.1.1']]]),
      lease,
      runtimeModelDescriptor: { id: modelId, name: modelId },
    });
    const currentProbeAuthorization = resolveProviderProbeAuthorization({
      request: {
        connectionId,
        machineId: 'machine-a',
        endpointTemplateId: 'chat',
        endpointUrl: 'https://models.example/v1',
        protocol: 'openai-chat',
        path: '/models',
        parser: 'openai-models',
        probeRequestFingerprint,
      },
      accountSettings: accountSettings.settings, savedSecretResources: accountSettings.savedSecretResources,
      providerSettings: settings,
      registry,
      dnsEvidenceByEndpointUrl: new Map([['https://models.example/v1', ['1.1.1.1']]]),
    });
    if (!currentProbeAuthorization.ok) {
      throw new Error('Expected current probe authorization');
    }
    await runtimeStore.update(current => (ProviderRuntimeStateFileV1Schema.parse({
      ...current,
      catalogs: [{
        ...currentCatalogRecord,
        key: {
          ...currentCatalogRecord.key,
          observationAuthorizationFingerprint:
            currentProbeAuthorization.observationAuthorizationFingerprint,
        },
      }],
    })));
    const activeProbeAuthorization = authorizePreviouslyCurrentProbe('probe-current');
    const disappearedProbeAuthorization = authorizePreviouslyCurrentProbe('probe-disappeared');
    if (!activeProbeAuthorization.ok || !disappearedProbeAuthorization.ok) {
      throw new Error('Expected both probe models to represent valid prior launch bindings');
    }
    await expect(services.resolveBindingStatus({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      selection: probeSelection('probe-current'),
      launchBinding: activeProbeAuthorization.authorization.sessionBindingMetadata,
    })).resolves.toEqual({ status: 'current' });
    await expect(services.resolveBindingStatus({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      selection: probeSelection('probe-disappeared'),
      launchBinding: disappearedProbeAuthorization.authorization.sessionBindingMetadata,
    })).resolves.toMatchObject({
      status: 'incompatible',
      error: { code: 'provider_model_not_found', action: 'choose_model' },
    });

    await expect(services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      currentSelection: {
        agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'retired-model',
      },
    })).resolves.toMatchObject({
      status: 'success',
      currentSelectionRecovery: {
        kind: 'model_not_found',
        error: { code: 'provider_model_not_found', action: 'choose_model' },
      },
    });

    // A Provider that permits manual ids and an Agent that accepts freeform ids
    // make catalog membership NOT the authority over whether a model is real.
    // The exact selected model stays listed and must not be reported missing.
    const freeformDefinition = ProviderContributionV1Schema.parse({
      ...definition,
      catalog: {
        source: 'static+probe', manualModelPolicy: 'allowed',
        staticModels: [{ id: 'same-id', name: 'Provider Same', capabilities: { toolRoundTrips: 'supported' } }],
        probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'openai-models' }],
      },
    });
    registry.providersByContributionKey.set(contributionKey, { ...contribution, definition: freeformDefinition });
    agentDefinitionsById.set('codex', agentDefinition({ ...support, supportsFreeformModelIds: true }));
    const freeformSelection = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      providerConnectionId: connectionId,
      modelId: 'vendor/freeform-only',
    };
    const freeformProjection = await services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', currentSelection: freeformSelection,
    });
    expect(freeformProjection).toMatchObject({ status: 'success', currentSelectionRecovery: null });
    if (freeformProjection.status !== 'success') throw new Error('Expected model projection');
    expect(freeformProjection.groups.flatMap((group) => group.rows).map((row) => row.ref.modelId))
      .toContain('vendor/freeform-only');
    // The same selection under an Agent that refuses freeform ids stays missing.
    agentDefinitionsById.set('codex', agentDefinition(support));
    await expect(services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', currentSelection: freeformSelection,
    })).resolves.toMatchObject({
      status: 'success',
      currentSelectionRecovery: {
        kind: 'model_not_found',
        error: { code: 'provider_model_not_found', action: 'choose_model' },
      },
    });
    registry.providersByContributionKey.set(contributionKey, contribution);

    const probeOnlyDefinition = ProviderContributionV1Schema.parse({
      ...definition,
      catalog: {
        source: 'probe', manualModelPolicy: 'allowed',
        probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'openai-models' }],
      },
    });
    registry.providersByContributionKey.set(contributionKey, { ...contribution, definition: probeOnlyDefinition });
    publishProviderSettings(ProviderSettingsV1Schema.parse({
        ...settings,
        accountGrants: [],
      }), 2);
    await expect(services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', currentSelection: selection.ref,
    })).resolves.toMatchObject({
      status: 'success',
      groups: [{
        connectionId,
        authorization: {
          authorized: false,
          error: { code: 'provider_connection_disabled', action: 'enable_connection' },
        },
        rows: [{ ref: selection.ref }],
      }],
      currentSelectionRecovery: null,
    });
    registry.providersByContributionKey.set(contributionKey, contribution);
    publishProviderSettings(settings, 3);

    registry.providersByContributionKey.delete(contributionKey);
    await expect(services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', currentSelection: selection.ref,
    })).resolves.toMatchObject({
      status: 'success',
      currentSelectionRecovery: {
        kind: 'contribution_unavailable',
        error: { code: 'provider_contribution_unavailable', action: 'restore_plugin' },
      },
    });
    registry.providersByContributionKey.set(contributionKey, contribution);

    publishProviderSettings(ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connectionTombstones: [{
          v: 1, id: connectionId, contributionKey, lastDisplayName: 'Gateway', deletedAt: 3,
        }],
      }), 4);
    await expect(services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', currentSelection: selection.ref,
    })).resolves.toMatchObject({
      status: 'success',
      currentSelectionRecovery: {
        kind: 'connection_deleted',
        error: { code: 'provider_connection_not_found', action: 'choose_connection' },
        displaySnapshot: { connectionName: 'Gateway' },
      },
    });
  });

  it('fails closed at the canonical feature decision before resolving provider authorization', async () => {
    const isEnabled = vi.fn(() => false);
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => null,
      featureGate: { isEnabled },
      modelSettingsMutation: unexpectedModelSettingsMutation,
    });

    await expect(services.loadModel({
      connectionId: 'pc_local',
      machineId: 'machine-a',
      modelId: 'model-a',
    })).resolves.toEqual({ status: 'not_supported', reason: 'feature_disabled' });
    await expect(services.rpcHandler({
      action: 'load',
      connectionId: 'pc_local',
      machineId: 'machine-a',
      modelId: 'model-a',
    })).resolves.toEqual({ status: 'not_supported', reason: 'feature_disabled' });
    expect(isEnabled).toHaveBeenCalledWith('providers.localModelManagement');
  });

  it('answers a cold picker read with the catalog its own demand produced', async () => {
    const registry = { providersByContributionKey: new Map() };
    const base = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: 'pc_cold',
        source: {
          kind: 'custom',
          template: {
            v: 1,
            name: 'Cold',
            endpointTemplates: [{
              id: 'catalog',
              protocol: 'openai-chat',
              baseUrl: 'https://cold.example/v1',
              capabilities: {
                streaming: 'unknown', toolRoundTrips: 'unknown',
                statefulResponses: 'unknown', reasoningControls: 'unknown',
              },
            }],
            catalog: {
              source: 'probe',
              manualModelPolicy: 'allowed',
              probes: [{ endpointTemplateId: 'catalog', path: '/models', parser: 'openai-models' }],
            },
          },
        },
        role: 'named',
        displayName: 'Cold',
        displayNameMode: 'custom',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    const resolvedCold = resolveProviderConnectionForMachine({
      connectionId: 'pc_cold',
      machineId: 'machine-a',
      providerSettings: base,
      registry,
      dnsEvidenceByEndpointUrl: new Map([['https://cold.example/v1', ['1.1.1.1']]]),
    });
    if (resolvedCold.status !== 'resolved') throw new Error('Expected custom Provider connection');
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      accountGrants: [{
        v: 1,
        connectionId: 'pc_cold',
        connectionSecurityFingerprint: resolvedCold.record.connectionSecurityFingerprint,
        confirmedAt: 1,
      }],
    });
    const support = {
      acceptsProtocols: ['openai-chat'],
      required: { streaming: true },
      credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
      authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
      materialization: 'engineConfig',
      applyPolicy: 'restart_session',
      supportsFreeformModelIds: false,
    } as const;
    const executable = {
      generation: 7,
      contributes: {
        providersByContributionKey: registry.providersByContributionKey,
        agentDefinitionsById: new Map([['codex', {
          id: 'codex',
          pluginId: 'happier.agent.codex',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          definition: { id: 'codex', kindVersion: 1, providerRequirements: support },
        }]]),
      },
      activateContributionsOnDemand: vi.fn(async () => []),
      agentRuntimesByAgentId: new Map([['codex', {
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        generation: 'fixture-generation',
        providerBinding: {
          v: 1,
          adapterVersion: 1,
          prepare: vi.fn(() => ({ v: 1, materialization: 'engineConfig' })),
          materialize: vi.fn(),
        },
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createRuntime: vi.fn(),
      }]]),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const lease: PluginRuntimeRegistryLease = {
      registry: executable,
      source: 'active',
      durableRevision: -1,
      release: vi.fn(async () => undefined),
    };
    const state = createEmptyProviderRuntimeStateFileV1('machine-a');
    const runtimeStore = await runtimeStoreWithState(state);
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'cold-model' }] }), 'utf8'),
    }));
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry,
      runtimeStore,
      resolveAddresses: async () => ['1.1.1.1'],
      acquireRuntimeLease: async () => lease,
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
      featureGate: { isEnabled: () => true },
      modelSettingsMutation: unexpectedModelSettingsMutation,
    });

    // Pool fanout is observation-only: it must neither await nor schedule a
    // refresh on every candidate Machine when no observation exists yet.
    const currentOnly = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      refreshPolicy: 'current_only',
    });
    expect(currentOnly.status).toBe('success');
    if (currentOnly.status !== 'success') throw new Error('Expected current-only projection');
    expect(currentOnly.groups).toEqual([]);
    expect(transport).not.toHaveBeenCalled();

    // The very first ordinary picker read is cold: nothing has ever probed this connection,
    // so a projection that returns before its own demand settles is a silently
    // empty list with nothing to follow it.
    const projection = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
    });
    expect(projection.status).toBe('success');
    if (projection.status !== 'success') throw new Error('Expected model projection');
    expect(projection.groups.flatMap((group) => group.rows).map((row) => row.ref.modelId))
      .toEqual(['cold-model']);

    // A fresh observation is reusable without starting another probe. This is
    // also the default read used by an automatic chosen-hub launch.
    const probeCount = transport.mock.calls.length;
    const warmFresh = await services.projectModels({
      machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex',
    });
    expect(warmFresh).toMatchObject({ status: 'success', groups: [{ rows: [{
      ref: { modelId: 'cold-model' }, catalog: { stale: false },
    }] }] });
    expect(transport.mock.calls.length).toBe(probeCount);

    // The complement, and the reason the awaited read is safe at all: a connection
    // that already produced an observation is warm, so its refresh stays advisory.
    // Marking the retained snapshot stale makes the next read genuinely re-demand,
    // and the transport never answers — a projection that awaited warm connections
    // could not resolve, so a single dead endpoint would block every picker open.
    await runtimeStore.update(current => ({
      ...current,
      catalogs: current.catalogs.map((record) => (record.state.snapshot
        ? {
            ...record,
            state: {
              ...record.state,
              snapshot: {
                ...record.state.snapshot,
                stale: true,
                staleAt: record.state.snapshot.observedAt,
              },
            },
          }
        : record)),
    }));
    let releaseBlockedTransport!: () => void;
    const blockedTransport = new Promise<void>((resolve) => { releaseBlockedTransport = resolve; });
    transport.mockImplementation(async () => {
      await blockedTransport;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: 'cold-model' }] }), 'utf8'),
      };
    });
    const warm = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
    });
    releaseBlockedTransport();
    expect(warm.status).toBe('success');
    if (warm.status !== 'success') throw new Error('Expected model projection');
    expect(warm.groups.flatMap((group) => group.rows).map((row) => row.ref.modelId))
      .toEqual(['cold-model']);
    // The warm read intentionally returned before its refresh. Observe that
    // actual catalog commit before replacing the store for the next scenario;
    // otherwise the released writer can repopulate the supposedly cold store.
    await vi.waitFor(async () => {
      const refreshed = await runtimeStore.read();
      expect(refreshed.catalogs[0]?.state.snapshot?.stale).toBe(false);
    });

    // A cold read whose own demand refresh FAILS must return the refresh's
    // typed failure instead of a success whose group is silently missing: the
    // UI cannot distinguish "no models" from "unreachable endpoint" otherwise.
    transport.mockImplementation(async () => ({
      status: 503,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}', 'utf8'),
    }));
    await runtimeStore.update(current => (createEmptyProviderRuntimeStateFileV1('machine-a')));
    const failingCold = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
    });
    expect(failingCold.status).toBe('success');
    if (failingCold.status !== 'success') throw new Error('Expected model projection');
    expect(failingCold.groups).toEqual([]);
    expect(failingCold.refreshFailures).toEqual([{
      connectionId: 'pc_cold',
      error: expect.objectContaining({ code: 'provider_endpoint_unavailable' }),
    }]);

    // Explicit Retry must enter the existing forced scheduler branch instead
    // of replaying the cached failure from the automatic picker demand.
    transport.mockImplementation(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'recovered-model' }] }), 'utf8'),
    }));
    const recovered = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      forceRefresh: true,
    });
    expect(recovered.status).toBe('success');
    if (recovered.status !== 'success') throw new Error('Expected recovered model projection');
    expect(recovered.refreshFailures).toBeUndefined();
    expect(recovered.groups.flatMap((group) => group.rows).map((row) => row.ref.modelId))
      .toEqual(['recovered-model']);

    // Catalog success is authoritative model truth. A later health failure is
    // represented on row health and must not elevate the whole projection to a
    // catalog refresh failure.
    await runtimeStore.update(current => (createEmptyProviderRuntimeStateFileV1('machine-a')));
    transport
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: 'healthy-catalog-model' }] }), 'utf8'),
      })
      .mockResolvedValueOnce({
        status: 503,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}', 'utf8'),
      });
    const catalogSucceeded = await services.projectModels({
      machineId: 'machine-a',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      forceRefresh: true,
    });
    expect(catalogSucceeded.status).toBe('success');
    if (catalogSucceeded.status !== 'success') throw new Error('Expected catalog projection');
    expect(catalogSucceeded.refreshFailures).toBeUndefined();
    expect(catalogSucceeded.groups.flatMap((group) => group.rows).map((row) => row.ref.modelId))
      .toEqual(['healthy-catalog-model']);

  });

  it('submits picker demand to the sole scheduler and retains no tail the scheduler refused', async () => {
    // The sole probe scheduler admits four active operations and queues 64 more
    // by default, so exactly one of these legal connections must be refused.
    const schedulerAdmittedCapacity = PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS + 64;
    const connectionCount = schedulerAdmittedCapacity + 1;
    const registry = { providersByContributionKey: new Map() };
    const base = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: Array.from({ length: connectionCount }, (_, index) => ({
        v: 1,
        id: `pc_demand_${index}`,
        source: {
          kind: 'custom',
          template: {
            v: 1,
            name: `Demand ${index}`,
            endpointTemplates: [
              {
                id: 'catalog',
                protocol: 'openai-chat',
                baseUrl: `https://catalog-${index}.example/v1`,
                capabilities: {
                  streaming: 'unknown',
                  toolRoundTrips: 'unknown',
                  statefulResponses: 'unknown',
                  reasoningControls: 'unknown',
                },
              },
              {
                id: 'responses',
                protocol: 'openai-responses',
                baseUrl: `https://responses-${index}.example/v1`,
                capabilities: {
                  streaming: 'unknown',
                  toolRoundTrips: 'unknown',
                  statefulResponses: 'unknown',
                  reasoningControls: 'unknown',
                },
              },
            ],
            catalog: {
              source: 'probe',
              manualModelPolicy: 'allowed',
              probes: [
                { endpointTemplateId: 'catalog', path: '/models', parser: 'openai-models' },
                { endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' },
              ],
            },
          },
        },
        role: 'named',
        displayName: `Demand ${index}`,
        displayNameMode: 'custom',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      })),
    });
    const dnsEvidenceByEndpointUrl = new Map<string, readonly string[]>(
      base.connections.flatMap((connection) => connection.source.kind === 'custom'
        ? connection.source.template.endpointTemplates.flatMap((endpoint) => endpoint.baseUrl === undefined
          ? [] : [[endpoint.baseUrl, ['1.1.1.1']] as const])
        : []),
    );
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      accountGrants: base.connections.map((connection) => {
        const resolved = resolveProviderConnectionForMachine({
          connectionId: connection.id,
          machineId: 'machine-a',
          providerSettings: base,
          registry,
          dnsEvidenceByEndpointUrl,
        });
        if (resolved.status !== 'resolved') throw new Error('Expected custom Provider connection');
        return {
          v: 1,
          connectionId: connection.id,
          connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
          confirmedAt: 1,
        };
      }),
    });
    const support = {
      acceptsProtocols: ['openai-chat'],
      required: { streaming: true },
      credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
      authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
      materialization: 'engineConfig',
      applyPolicy: 'restart_session',
      supportsFreeformModelIds: false,
    } as const;
    const executable = {
      generation: 7,
      contributes: {
        providersByContributionKey: registry.providersByContributionKey,
        agentDefinitionsById: new Map([['codex', {
          id: 'codex',
          pluginId: 'happier.agent.codex',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          definition: { id: 'codex', kindVersion: 1, providerRequirements: support },
        }]]),
      },
      activateContributionsOnDemand: vi.fn(async () => []),
      agentRuntimesByAgentId: new Map([['codex', {
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        generation: 'fixture-generation',
        providerBinding: {
          v: 1,
          adapterVersion: 1,
          prepare: vi.fn(() => ({ v: 1, materialization: 'engineConfig' })),
          materialize: vi.fn(),
        },
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createRuntime: vi.fn(),
      }]]),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const lease: PluginRuntimeRegistryLease = {
      registry: executable,
      source: 'active',
      durableRevision: -1,
      release: vi.fn(async () => undefined),
    };
    const state = createEmptyProviderRuntimeStateFileV1('machine-a');
    const runtimeStore = await runtimeStoreWithState(state);
    const catalogHosts = new Set<string>();
    const releases: Array<() => void> = [];
    let releaseAll = false;
    const transport = vi.fn(async (request: ProviderProbeTransportRequest) => {
      if (request.hostname.startsWith('catalog-')) {
        catalogHosts.add(request.hostname);
        if (!releaseAll) {
          await new Promise<void>((resolve) => releases.push(resolve));
        }
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: 'model-a' }] }), 'utf8'),
      };
    });
    const resolveAddresses = vi.fn(async (_hostname: string) => ['1.1.1.1']);
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry,
      runtimeStore,
      resolveAddresses,
      acquireRuntimeLease: async () => lease,
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['1.1.1.1'],
        transport,
      }),
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
      featureGate: { isEnabled: () => true },
      modelSettingsMutation: unexpectedModelSettingsMutation,
    });

    try {
      // Every one of these connections is cold, so the read waits for the demand
      // it submitted rather than answering with an empty catalog.
      const projection = services.projectModels({
        machineId: 'machine-a',
        agentTargetKey: 'agent:happier.agent.codex/codex',
      });
      // Every identity is submitted immediately, so the sole scheduler holds
      // its four active operations and queues its pending maximum while the
      // transport is blocked. One identity is beyond both and is refused.
      await vi.waitFor(
        () => expect(releases.length).toBe(4),
        { timeout: 5_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      releaseAll = true;
      for (const release of releases.splice(0)) release();

      await expect(projection).resolves.toMatchObject({ status: 'success', groups: expect.any(Array) });
      expect(lease.release).toHaveBeenCalledTimes(1);
      await vi.waitFor(
        () => expect(catalogHosts.size).toBe(schedulerAdmittedCapacity),
        { timeout: 5_000 },
      );
      // A consumer-side queue would keep feeding the refused tail once the
      // scheduler drained; the sole scheduler must leave it for a later read.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(catalogHosts.size).toBe(schedulerAdmittedCapacity);
      expect(schedulerAdmittedCapacity).toBeLessThan(connectionCount);
      // DNS belongs to the immutable picker operation: each unique hostname is
      // resolved once and the same evidence is reused after cold demand.
      const resolvedHostnames = resolveAddresses.mock.calls.map(([hostname]) => hostname);
      const duplicateHostnames = resolvedHostnames.filter((hostname, index) =>
        resolvedHostnames.indexOf(hostname) !== index);
      expect(duplicateHostnames).toEqual([]);
      expect(resolveAddresses).toHaveBeenCalledTimes(connectionCount * 2);
    } finally {
      releaseAll = true;
      for (const release of releases.splice(0)) release();
    }
    // Proving the refused tail requires a fixture larger than the scheduler's
    // whole admission window, so this case is inherently the slowest in the
    // suite and needs more than the shared default budget.
  }, 240_000);

  it('owns one shared probe/catalog runtime when the caller does not provide one', () => {
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => null,
      featureGate: { isEnabled: () => false },
      modelSettingsMutation: unexpectedModelSettingsMutation,
    });

    expect(services).toMatchObject({
      probe: expect.any(Function),
      models: expect.any(Function),
      loadModel: expect.any(Function),
      cancelModelLoad: expect.any(Function),
      rpcHandler: expect.any(Function),
      runtimeStore: expect.objectContaining({ read: expect.any(Function) }),
    });
  });

  it('returns the exact runtime-state owner supplied to the one shared probe composition', async () => {
    const state = createEmptyProviderRuntimeStateFileV1('machine-a');
    const runtimeStore = await runtimeStoreWithState(state);
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: () => null,
      featureGate: { isEnabled: () => false },
      runtimeStore,
      modelSettingsMutation: unexpectedModelSettingsMutation,
    });

    expect(services.runtimeStore).toBe(runtimeStore);
  });

  it('classifies a stale model-settings connection revision without claiming authorization drift', async () => {
    const settings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: 'pc_gateway',
        source: { kind: 'contribution', contributionKey: 'acme.gateway/main' },
        role: 'default',
        displayName: 'Gateway',
        displayNameMode: 'automatic',
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
      }],
    });
    const services = createRuntimeProviderModelManagementServices({
      machineId: 'machine-a',
      registry: { providersByContributionKey: new Map() },
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
      featureGate: { isEnabled: () => true },
      modelSettingsMutation: unexpectedModelSettingsMutation,
    });

    await expect(services.mutateModelSettings({
      action: 'manualAdd',
      machineId: 'machine-a',
      connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
      expectedConnectionRevision: 1,
      models: [{ id: 'vendor/model' }],
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_changed', retryable: true, action: 'review_connection' },
    });
  });

  it('preserves the row CAS winner and revalidates a manual-model retry through the real connection service', async () => {
    const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
    const settings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: 'pc_gateway',
        source: {
          kind: 'custom',
          template: {
            v: 1,
            name: 'Gateway',
            endpointTemplates: [{
              id: 'chat',
              protocol: 'openai-chat',
              baseUrl: 'https://models.example/v1',
              capabilities: {
                streaming: 'unknown',
                toolRoundTrips: 'unknown',
                statefulResponses: 'unknown',
                reasoningControls: 'unknown',
              },
            }],
            catalog: { source: 'manual', manualModelPolicy: 'allowed' },
          },
        },
        role: 'named',
        displayName: 'Gateway',
        displayNameMode: 'custom',
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
      }],
    });
    const credentials = { token: 'provider-model-row-cas', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKeyForToken(credentials.token);
    let preferences = { memoryUseInNewSessions: false, concurrentWinner: 0 };
    let settingsVersion = 4;
    let catalog = splitProviderSettingsV1(settings).catalog;
    let revision = 7;
    let conflictPending = true;
    setActiveAccountSettingsSnapshot({ ...providerSnapshot(settings), scopeKey, source: 'network',
      settings: AccountSettingsSchema.parse(preferences), rawSettings: preferences, settingsVersion,
      providerConnectionsCatalog: { status: 'ready', revision, catalog } });
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
        status: 'present', revision, content: { t: 'plain', v: catalog } } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: preferences } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      const history = emptyAccountSettingsHistoryCaptureResponse(path);
      if (history) return history;
      throw new Error('Unexpected Provider model CAS boundary: ' + path);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (path !== '/v1/account/entity-rows/provider-connections') throw new Error('Unexpected Provider mutation: ' + path);
      const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
      if (conflictPending) {
        conflictPending = false;
        catalog = { ...catalog, manualModelsByConnectionId: { [connectionId]: [{ id: 'concurrent-model', addedAt: 99 }] } };
        revision += 1;
        preferences = { memoryUseInNewSessions: true, concurrentWinner: 1 };
        settingsVersion += 1;
        const current = getActiveAccountSettingsSnapshot();
        if (!current) throw new Error('Expected admitted Provider Account');
        setActiveAccountSettingsSnapshot({ ...current, settings: AccountSettingsSchema.parse(preferences),
          rawSettings: preferences, settingsVersion });
        return { status: 200, data: { status: 'conflict', revision } };
      }
      if (mutation.expectedRevision !== revision) return { status: 200, data: { status: 'conflict', revision } };
      if (mutation.content?.t !== 'plain') throw new Error('Expected keyless Provider catalog');
      catalog = mutation.content.v;
      revision += 1;
      return { status: 200, data: { status: 'updated', revision, cursor: revision } };
    });
    const featureGate = { isEnabled: () => true };
    const registry = { providersByContributionKey: new Map() };
    const runtimeStore = await runtimeStoreWithState();
    const runtime = createRuntimeProviderServices({ machineId: 'machine-a', registry, runtimeStore, featureGate,
      resolveAddresses: async () => ['1.1.1.1'] });
    const connectionServices = createRuntimeProviderConnectionServices({ machineId: 'machine-a', credentials,
      happyHomeDir: join(tmpdir(), 'provider-model-row-cas'), featureGate,
      runtimeSummary: runtime.summary, resolveRegistry: async () => registry,
      resolveAddresses: async () => ['1.1.1.1'], now: () => 100 });
    const services = createRuntimeProviderModelManagementServices({ machineId: 'machine-a', registry, runtimeStore,
      getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot, featureGate,
      modelSettingsMutation: intent => connectionServices.service.mutateModelSettings(intent) });
    const intent = { action: 'manualAdd' as const, machineId: 'machine-a', connectionId,
      expectedConnectionRevision: 2, models: [{ id: 'vendor/model' }] };
    await expect(services.mutateModelSettings(intent)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_connection_changed' } });
    expect(catalog.manualModelsByConnectionId[connectionId]).toEqual([{ id: 'concurrent-model', addedAt: 99 }]);
    await expect(services.mutateModelSettings(intent)).resolves.toEqual({ status: 'success', action: 'manualAdd' });
    expect(catalog.manualModelsByConnectionId[connectionId]).toMatchObject([
      { id: 'concurrent-model', addedAt: 99 }, { id: 'vendor/model', addedAt: 100 }]);
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(5);
    expect(getActiveAccountSettingsSnapshot()?.settings.memoryUseInNewSessions).toBe(true);
    expect(getActiveAccountSettingsSnapshot()?.rawSettings?.concurrentWinner).toBe(1);
  });
});
