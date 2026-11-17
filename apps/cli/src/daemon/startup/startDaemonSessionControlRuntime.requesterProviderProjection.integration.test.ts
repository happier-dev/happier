import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import axios from 'axios';
import { AccountSettingsSchema, FeaturesResponseSchema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderModelManagementServices, createProviderAccountOperationScope } from '@/providers/modelManagement/runtimeServices';
import { createRuntimeProviderConnectionServices } from '@/providers/connections/runtimeServices';
import { resolveProviderContributionRegistryView } from '@/providers/registry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';

// Only the daemon's OS listener is substituted. The installed requester opener,
// credentialed Action factory, provider projector and external plugin stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['providers.models.projection', 'providers.models.refresh', 'providers.connections.describe', 'providers.models.list', 'sessions.spawn.connected_services.list'] as const)(
  'uses requester Account policy through the real daemon factory without ambient disclosure (%s)', async actionId => {
  const inventory = actionId === 'sessions.spawn.connected_services.list';
  // Inventory consumes the executing daemon's active Agent declaration.
  const controller = inventory ? pluginReloadController : createPluginReloadController();
  const fixture = await createManagedRunLaunchFixture({ controller, physicalGateway: true,
    ...(inventory ? { connectedAccounts: [{ purpose: 'inference', service: 'accounts', materializationKinds: ['httpHeaders'] as const }] } : {}) });
  const homeId = 'srv_requester_provider';
  const endpoint = 'https://requester-provider.test';
  const features = FeaturesResponseSchema.parse({ features: { providers: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: homeId } } });
  // This requester Account explicitly waives the UI Refresh approval. The
  // worker Account below does not; production approval routing stays real.
  const requesterSettings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {},
    approvalWaivedSurfaces: { 'providers.models.refresh': ['ui'] } } });
  const requesterToken = `e30.${Buffer.from(JSON.stringify({ sub: 'requester-a', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const custodianToken = `e30.${Buffer.from(JSON.stringify({ sub: 'worker-b' })).toString('base64url')}.signature`;
  let authorizationAccepted = true;
  let purposeReachable = true;
  let privateCustodianReads = 0;
  let requesterSourceReads = 0;
  let providerDispatches = 0;
  const ambient = { ...fixture.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken(custodianToken),
    providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(ProviderSettingsV1Schema.parse({
      ...fixture.providerSettings, connections: fixture.providerSettings.connections.map(connection => ({ ...connection,
        displayName: 'Private B source', displayNameMode: 'custom' })),
    })).catalog } };
  setActiveAccountSettingsSnapshot(ambient);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return Response.json({ id: 'requester-a' });
    if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
    throw new Error('Unexpected requester fetch');
  }));
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    if (options?.headers?.Authorization === `Bearer ${custodianToken}`) privateCustodianReads++;
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'requester-a' } };
    if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, settingsVersion: 1, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: requesterSettings } } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: { status: 'present', revision: 1,
      content: { t: 'plain', v: fixture.snapshot.providerConnectionsCatalog?.status === 'ready' ? fixture.snapshot.providerConnectionsCatalog.catalog : {} } } };
    if (path === '/v1/account/entity-rows/connected-accounts/purposes') {
      if (inventory) expect(options?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('admitted-provider-root');
      else expect(options?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
      requesterSourceReads++;
      if (!purposeReachable) return { status: 503, data: { error: 'gateway down' } };
      return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
    }
    if (path === '/v4/connect/qualified/accounts') {
      expect(options?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
      requesterSourceReads++;
      const service = { pluginId: fixture.gateway!.pluginId, localId: 'accounts' };
      return { status: 200, data: QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
        ref: { service, accountId: 'upstream-account' }, status: 'connected', authenticationModeId: 'manual',
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationReady: true, configurationRevision: null, scopes: [],
      }] }) };
    }
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    throw new Error(`Unexpected requester read: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async url => {
    if (String(url).endsWith('/execution-authorization/verify')) return { status: authorizationAccepted ? 200 : 401, data: { ok: authorizationAccepted } };
    throw new Error(`Unexpected requester write: ${new URL(String(url)).pathname}`);
  });
  const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId,
    happyHomeDir: fixture.happyHomeDir, featureGate: { isEnabled: () => true },
    getAccountSettingsSnapshot: () => { privateCustodianReads++; return ambient; },
    acquireRuntimeLease: async () => {
      const lease = controller.tryAcquireRuntimeRegistry();
      if (!lease) throw new Error('Expected external plugin registry');
      return lease;
    }, resolveRegistry: async () => {
      const lease = controller.tryAcquireRuntimeRegistry();
      if (!lease) throw new Error('Expected external plugin registry');
      try { return resolveProviderContributionRegistryView(lease.registry.contributes,
        lease.registry.generation, lease.registry.readPluginOccurrenceId); }
      finally { await lease.release(); }
    }, modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected model mutation'); },
  });
  const host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: fixture.happyHomeDir,
    activeServerDir: join(fixture.happyHomeDir, 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
    machineId: fixture.machineId, custodianAccountId: 'worker-b', credentials: { token: custodianToken, encryption: null },
    connectedServicesMaterializationBaseDir: join(fixture.happyHomeDir, 'connected-services'), registry: new ConnectedServiceRuntimeRegistry(),
    trackedSessions: new Map(), getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    startup: { pluginRuntimeController: controller, projectProviderModelsForAccount: (...args) => {
      providerDispatches++;
      return services.projectModelsForAccount(...args);
    },
      readProviderForAccount: async (request, context) => {
        providerDispatches++;
        const scope = createProviderAccountOperationScope(context);
        if (request.actionId === 'providers.models.list') {
          const account = context.managedRuntimeAccount;
          if (!account) throw new Error('Expected admitted requester managed Account');
          expect(await account.connectedAccountsOwner.getBinding({
            purpose: { consumer: { pluginId: fixture.gateway!.pluginId, localId: 'gateway' }, purpose: 'upstream' },
            serviceRefs: [{ pluginId: fixture.gateway!.pluginId, localId: 'accounts' }],
            signal: context.signal,
          })).toBeNull();
          return services.models(request.input, context.signal, scope);
        }
        if (!context.savedSecretOperationContext) throw new Error('Expected admitted requester custody');
        return createRuntimeProviderConnectionServices({ machineId: fixture.machineId,
          happyHomeDir: fixture.happyHomeDir, credentials: context.savedSecretOperationContext.credentials,
          operationContext: context.savedSecretOperationContext, featureGate: { isEnabled: id => id === 'providers' },
          runtimeSummary: input => services.summary(input, scope),
          resolveManagedPurposeBindingIntent: context.resolveManagedPurposeBindingIntent,
          resolveRegistry: async () => {
            const lease = controller.tryAcquireRuntimeRegistry();
            if (!lease) throw new Error('Expected external plugin registry');
            try { return resolveProviderContributionRegistryView(lease.registry.contributes,
              lease.registry.generation, lease.registry.readPluginOccurrenceId); }
            finally { await lease.release(); }
          },
        }).describeConnections(request.input, context.signal);
      },
      resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }),
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: fixture.machineId, serverIdentityId: homeId }) } });
  const channel = await createRequesterCurrentnessSocketHarness();
  try {
    privateCustodianReads = 0;
    const installation = host.installation;
    const prepare = host.runtime.externalActionIngressOwner?.prepareRequesterAccountContext;
    if (!installation || !prepare) throw new Error('Expected real daemon Account ingress');
    const input = { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, mode: 'management',
      sourceConnectionId: 'run-gateway' } as const;
    const target = { kind: 'machine', machineId: fixture.machineId } as const;
    {
      const actionInput = inventory ? { machineId: fixture.machineId, agentId: fixture.agentId, includeDefaults: true }
        : actionId === 'providers.models.refresh' ? { ...input, forceRefresh: true as const }
        : actionId === 'providers.models.projection' ? input : { machineId: fixture.machineId, connectionId: 'run-gateway' };
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: actionId, target, input: actionInput });
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-provider-root', binding: {
        accountId: 'requester-a', custodianAccountId: 'worker-b', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
        serverIdentityId: homeId, machineId: fixture.machineId, installationId: installation.installationId,
        actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose: { kind: 'external_action' },
        installationPublicKey: decodeBase64(installation.publicKey, 'base64url'), credentials: { token: requesterToken },
        randomBytes: length => new Uint8Array(randomBytes(length)) });
      authorizationAccepted = false;
      expect(await prepare({ authorization })).toBeNull();
      expect(privateCustodianReads).toBe(0);
      expect(requesterSourceReads).toBe(0);
      expect(providerDispatches).toBe(0);
      authorizationAccepted = true;
      const admitted = await prepare({ authorization });
      expect(admitted).not.toBeNull();
      if (!admitted) throw new Error('Expected admitted requester Account');
      try {
        const operation = new AbortController();
        const execute = () => admitted.executor.execute(actionId, actionInput, { surface: 'ui', authority: 'present_user',
          serverId: homeId, defaultSessionMachineId: fixture.machineId, actionRequestId: envelope.requestId,
          externalActionExecutionAuthorization: admitted.authorization, externalActionTarget: target, signal: operation.signal });
        const result = await execute();
        const expected = inventory ? { supportedServiceIds: ['acme.managed-run/accounts'], items: [] }
          : actionId === 'providers.connections.describe' ? { connections: [{ connectionId: 'run-gateway', authorized: true }] }
          : actionId === 'providers.models.list' ? { connectionId: 'run-gateway', models: [{ id: 'example', source: 'static' }],
            sourceCatalogs: [{ purpose: 'upstream', catalogObserved: false, models: [] }] }
          : { groups: [{ connectionName: 'Gateway', rows: [{ descriptor: { id: 'example' } }] }] };
        expect(result, JSON.stringify({ actionId, result })).toMatchObject({ ok: true,
          result: { ...(inventory ? {} : { status: 'success' }), ...expected } });
        if (!result.ok) throw new Error('Expected successful Provider Action');
        if (actionId === 'providers.models.projection' || actionId === 'providers.models.refresh') {
          DaemonProviderModelProjectionResponseV1Schema.parse(result.result);
        }
        expect(privateCustodianReads).toBe(0);
        expect(requesterSourceReads).toBeGreaterThan(0);
        if (inventory) {
          purposeReachable = false;
          expect(await execute()).toMatchObject({ ok: false, errorCode: 'connected_services_default_unavailable',
            details: { source: 'account_default', phase: 'purpose_binding', catalogReason: 'unreachable' } });
          purposeReachable = true;
          expect(await execute()).toMatchObject({ ok: true, result: expected });
          expect(privateCustodianReads).toBe(0);
        }
        const sourceReadsBeforeStop = requesterSourceReads;
        const providerDispatchesBeforeStop = providerDispatches;
        operation.abort();
        await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(privateCustodianReads).toBe(0);
        expect(requesterSourceReads).toBe(sourceReadsBeforeStop);
        expect(providerDispatches).toBe(providerDispatchesBeforeStop);
      } finally { await admitted.dispose(); }
    }
  } finally {
    try { await host.dispose(); } finally { try { await channel.close(); } finally { await fixture.cleanup(); } }
  }
});
