import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import { readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { withTeamCredentialActionRuntime } from './teamCredentialActionRuntime';
import { createManagedMachineControllerClient } from '@/machines/managed/acquire';
import { createDaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';
import { createProviderBrokerMachineCarrierTunnelOpen } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import { startPeerMediationLoopbackServer } from '@/daemon/peer/mediation/loopback/server';
import { openTeamCredentialProviderBroker } from '@/api/client/providerBrokerApi';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation, listQualifiedConnectedAccountsV4,
  listQualifiedConnectedAccountGroupsV4, readQualifiedConnectedAccountGroupV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { startDaemonProviderBrokerRuntime } from './daemonProviderBrokerRuntime';
import { createTeamCredentialBrokerSourceOwner } from './teamCredentialBrokerSourceOwner';
import { createTeamCredentialBrokerActionExecutor } from './teamCredentialActionExecution';
import { createTeamCredentialBrokerActionPurposeExecutor } from './teamCredentialActionClient';
import { ProviderBrokerActionAdmissionResponseV3Schema, PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createManagedNativeInvocation } from '@/machines/managed/reconcile';
import { createDaemonManagedMachineActionAdapter } from '@/daemon/startup/managedMachineActionAdapter';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { reloadConfiguration } from '@/configuration';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { ManagedAdmissionOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { AcquireResultV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { logger } from '@/ui/logger';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { buildUniversalPluginUiArtifacts } from '../../../../../packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts';
import { sourcePluginUiBuildOptions } from '../../../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs';
import { PLUGIN_MANIFEST as AGENT37 } from '../../../../../packages/plugins/machine-agent37/src/manifest';
import { PLUGIN_MANIFEST as BOAT } from '../../../../../packages/plugins/machine-boat/src/manifest';

const provider = vi.hoisted(() => ({ request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  failures: [] as string[] }));
// Only the OS/network adapter is substituted. Home authentication, Account
// selection, native roles, purpose admission, and plugin activation remain real.
// Mocking the transport also covers concurrent HTTP without module-loader races.
vi.mock('@/plugins/runtime/fetch/globalFetchRuntime', () => ({
  createGlobalFetchRuntime: () => ({
    async request(request) {
      if (!['https://api.agent37.com', 'https://boat.dev'].includes(new URL(request.url).origin)) {
        provider.failures.push('unexpected_provider_origin');
        throw new Error('Unexpected external HTTP origin in managed sharing fixture');
      }
      const response = await provider.request(request.url, { method: request.method, headers: request.headers,
        ...(request.body === undefined ? {} : { body: Buffer.from(request.body) }) });
      return { status: response.status, finalUrl: request.url, headers: Object.fromEntries(response.headers.entries()),
        body: new Uint8Array(await response.arrayBuffer()) };
    },
  } satisfies import('@/plugins/runtime/fetch/service').PluginHttpRuntimeAdapter),
}));

describe('two-Account Team provisioner managed entry point', () => {
  beforeAll(async () => {
    // Account activation consumes the normal generated executable graphs. Build
    // current source through the SDK owner instead of substituting activation.
    const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), 'team-cloud-artifact-input-'));
    try {
      const options = await sourcePluginUiBuildOptions({ repoRoot });
      for (const [name, manifest] of [['machine-agent37', AGENT37], ['machine-boat', BOAT]] as const) {
        const manifestPath = join(directory, manifest.id + '.json');
        await writeFile(manifestPath, JSON.stringify(manifest));
        await buildUniversalPluginUiArtifacts(join(repoRoot, 'packages/plugins', name), manifestPath, options);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each([AGENT37, BOAT].flatMap(manifest => [...(['options', 'acquire'] as const).map(role => ({ manifest, role, brokerRealm: false })), { manifest, role: 'options' as const, brokerRealm: true }]))(
    'runs $manifest.id $role brokerRealm=$brokerRealm in the real Account host with a signed native root', async ({ manifest, role, brokerRealm }) => {
    const server = '../../../../server/sources/';
    const { createLightSqliteHarness, createAccountTokenForTests }: typeof import('../../../../server/sources/testkit/lightSqliteHarness') = await import(server + 'testkit/lightSqliteHarness');
    const { createAuthenticatedTestApp }: typeof import('../../../../server/sources/app/api/testkit/sqliteFastify') = await import(server + 'app/api/testkit/sqliteFastify');
    const { db }: typeof import('../../../../server/sources/storage/db') = await import(server + 'storage/db');
    const { createTeamDirectActionMaterialFixture }: typeof import('../../../../server/sources/app/teams/credentials/directActionMaterial.testkit') = await import(server + 'app/teams/credentials/directActionMaterial.testkit');
    const { registerTeamCredentialResourceRoutes }: typeof import('../../../../server/sources/app/teams/credentials/registerTeamCredentialResourceRoutes') = await import(server + 'app/teams/credentials/registerTeamCredentialResourceRoutes');
    const { registerQualifiedConnectedAccountCredentialRoutesV4 }: typeof import('../../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4') = await import(server + 'app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4');
    const { resolvePeerMediationGrantSigningConfig }: typeof import('../../../../server/sources/app/machines/peer/mediation/mintDirectRouteGrantV1') = await import(server + 'app/machines/peer/mediation/mintDirectRouteGrantV1');
    const { registerExternalActionRoutes }: typeof import('../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes') = await import(server + 'app/api/routes/actions/registerExternalActionRoutes');
    const { registerPluginAvailabilityRoutes }: typeof import('../../../../server/sources/app/plugins/availability/routes') = await import(server + 'app/plugins/availability/routes');
    const { accountRoutes }: typeof import('../../../../server/sources/app/api/routes/account/accountRoutes') = await import(server + 'app/api/routes/account/accountRoutes');
    const { featuresRoutes }: typeof import('../../../../server/sources/app/api/routes/features/featuresRoutes') = await import(server + 'app/api/routes/features/featuresRoutes');
    const { changesRoutes }: typeof import('../../../../server/sources/app/api/routes/changes/changesRoutes') = await import(server + 'app/api/routes/changes/changesRoutes');
    const { registerManagedMachineRoutes }: typeof import('../../../../server/sources/app/machines/managed/managedRoutes') = await import(server + 'app/machines/managed/managedRoutes');
    const { createReleaseLessDeclarationV1 }: typeof import('../../../../server/sources/app/plugins/availability/currentDeclaration') = await import(server + 'app/plugins/availability/currentDeclaration');
    const { startTeamCredentialActionSocketPresence }: typeof import('../../../../server/sources/testkit/teamCredentialActionSocketPresence.testkit') = await import(server + 'testkit/teamCredentialActionSocketPresence.testkit');
    const homeId = 'srv_two_account_managed';
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'two-account-managed-', initAuth: true, initEncrypt: true, env: {
      HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
      HAPPIER_SERVER_IDENTITY_ID: homeId,
    } });
    let closeTransport: (() => Promise<void>) | undefined;
    onTestFinished(async () => { try { await closeTransport?.(); } finally { await harness.close(); } });
    const descriptor = manifest.contributes.connectedAccountDescriptors[0]!;
    const shared = await createTeamDirectActionMaterialFixture({ manifest, serviceId: descriptor.id,
      authenticationModeId: descriptor.authentication.defaultModeId, homeServerIdentityId: homeId,
      deliveryMode: brokerRealm ? 'brokered' : 'direct' });
    const signing = nacl.sign.keyPair();
    const installationId = crypto.randomUUID();
    await db.machine.update({ where: { id: shared.machine.id }, data: { installationId,
      installationPublicKey: signing.publicKey, operationProtocolCapabilitiesRevision: 1, pluginMaterializationRevision: BigInt(1),
      operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
    await db.pluginMachineMaterialization.create({ data: { accountId: shared.recipient.id, serverIdentityId: homeId,
      machineId: shared.machine.id, materializationId: installationId, pluginId: manifest.id, version: manifest.version,
      sourceClass: 'bundledFirstParty', portableRelease: false,
      archiveDigestSha256: createReleaseLessDeclarationV1(manifest).manifestDigestSha256,
      uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    registerExternalActionRoutes(app);
    registerTeamCredentialResourceRoutes(app);
    registerQualifiedConnectedAccountCredentialRoutesV4(app);
    registerPluginAvailabilityRoutes(app);
    accountRoutes(app);
    featuresRoutes(app);
    changesRoutes(app);
    registerManagedMachineRoutes(app);
    const presence = startTeamCredentialActionSocketPresence(app);
    closeTransport = async () => { try { await presence.close(); } finally { await app.close(); } };
    const materialRequests: unknown[] = [];
    app.addHook('preHandler', async request => { if (request.url.endsWith('/direct-material')) materialRequests.push(request.body); });
    const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const credentials = { token: await createAccountTokenForTests(shared.recipient.id, { kind: 'account', authority: 'present_user' }), encryption: null } as const;
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'two-account-managed-runtime-'));
    onTestFinished(() => rm(happyHomeDir, { recursive: true, force: true }));
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    vi.stubEnv('HAPPIER_SERVER_URL', serverUrl);
    reloadConfiguration();
    onTestFinished(() => { vi.unstubAllEnvs(); reloadConfiguration(); });
    const homeDescriptor = { v: 1 as const, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl,
      revision: 1, endpoints: [{ kind: 'https' as const, url: serverUrl }] };
    await adoptServerProfileHomeConnectionDescriptor({ descriptor: homeDescriptor, observation: 'exact', createIfMissing: true, use: true });
    reloadConfiguration();
    const controller = { machineId: shared.machine.id, installationId };
    const contribution = { pluginId: manifest.id, localId: manifest.contributes.machineProvisioners[0]!.id };
    const input = { homeId, controller, contribution, selectors: {}, credentials: [{ purpose: { consumer: contribution, purpose: 'cloud-api' },
      teamId: shared.team.id, selection: { source: 'team_resource' as const, resourceId: shared.resource.id,
        ...(brokerRealm ? { deliveryMode: 'brokered' as const }
          : { deliveryMode: 'direct' as const, disclosedMember: shared.sourceAccount }) } }] };
    const choices = manifest.id === AGENT37.id ? { kind: 'vm', size: '2-4', region: 'eu' }
      : { size: 'small', source: { kind: 'blank' } };
    const acquireInput = { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: {
      kind: 'one-off', homeId, controller, launch: { provider: contribution, schemaVersion: 1, name: 'Shared compute', choices,
        credentials: input.credentials }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
    const rootActionId = role === 'options' ? 'machines.provisioners.options' : 'machines.managed.acquire';
    const requestId = crypto.randomUUID();
    const issued = await app.inject({ method: 'POST', url: `/v1/actions/${rootActionId}/execution-authorization`,
      headers: { authorization: `Bearer ${credentials.token}` }, payload: { v: 1, machineId: shared.machine.id,
        envelope: { v: 1, requestId, target: { kind: 'machine', machineId: shared.machine.id }, input: role === 'options' ? input : acquireInput } } });
    expect(issued.statusCode, issued.body).toBe(200);
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
    // This projection is the Machine signing/network boundary. The managed
    // driver supplies the real native effect and any reviewed child itself.
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: {
      accountId: shared.recipient.id, serverId: 'two-account-home', serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
      accountEncryptionMode: 'plain', isCurrent: async () => true,
      createRequestHeaders: async (request: Parameters<NonNullable<typeof authorization.requesterHttpProjection>['createRequestHeaders']>[0]) =>
        createExternalActionAuthorizedRequestHeaders({ authorization, target: authorization.binding.target,
          installationId, privateKey: signing.secretKey, ...request }),
    } satisfies NonNullable<typeof authorization.requesterHttpProjection> });
    const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', runtimeAccountId: shared.recipient.id,
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
      actionRequestId: requestId, serverId: 'two-account-home', serverIdentityId: homeId,
      operationAcceptance: { operationId: requestId, accept() {} }, operationOwnerUpdate: { update() {} } };

    provider.request.mockReset();
    provider.failures.length = 0;
    // Observe the real logging boundary without replacing its implementation.
    // Only the owner's closed diagnostic payload is included in test failures.
    const diagnosticLog = vi.spyOn(logger, 'warnLocalFile');
    onTestFinished(() => diagnosticLog.mockRestore());
    provider.request.mockImplementation(async (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      const supported = new URL(url).origin === 'https://api.agent37.com'
        ? path === '/v1/instances' && (method === 'GET' || method === 'POST')
        : method === 'GET' && ['/api/v1/limits', '/api/v1/saved-snapshots', '/api/v1/sandboxes'].includes(path)
          || method === 'POST' && path === '/api/v1/sandboxes';
      if (!supported) {
        provider.failures.push(`unexpected_request:${method}:${path}`);
        throw new Error('Unexpected provider request in managed sharing fixture');
      }
      if (new Headers(init?.headers).get('authorization') !== 'Bearer shared-token') {
        provider.failures.push(`authorization_mismatch:${method}:${path}`);
        throw new Error('Provider request did not receive the selected credential');
      }
      const creating = init?.method === 'POST';
      return Response.json(manifest.id === AGENT37.id ? creating ? { id: 'ab12cd34ef', status: 'running' } : { data: [] }
        : new URL(url).pathname.endsWith('/limits') ? { ok: true, type: 'limits.info', sandboxPlanKey: 'box_100', sandboxPlanDollars: 100,
          canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' }
        : creating ? { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: null,
          sandbox: { id: 'bx_23456789', state: 'provisioning' } }
        : new URL(url).pathname.endsWith('/sandboxes') ? { ok: true, type: 'sandbox.list', sandboxes: [] }
        : { ok: true, type: 'snapshot.saved.list', snapshots: [] },
        { status: creating ? manifest.id === AGENT37.id ? 201 : 202 : 200 });
    });
    await runWithServerHttpBaseUrl(serverUrl, async () => {
      await ensureCliActionPolicySettings(credentials, serverUrl);
      const snapshot = getActiveAccountSettingsSnapshot();
      expect(snapshot?.source).toBe('network');
      if (!snapshot) throw new Error('Real Home settings unavailable');
      const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl: serverUrl, isCurrent: async () => true });
      const native = await createAdmittedPluginRuntimeFixture({ happyHomeDir, runtimeOptions: { pluginIds: [manifest.id],
        scopedActionRuntime: { credentials, savedSecretOperationContext, actionsSettingsProvider: createActionSettingsProvider() } } });
      onTestFinished(native.dispose);
      let accountCompositions = 0;
      let brokerAdmissions = 0;
      let brokerExecute: Parameters<typeof resolveAccountExecutionRuntime>[0]['executeTeamCredentialBrokerAction'];
      if (brokerRealm) {
        if (!shared.broker) throw new Error('Missing custodian Machine');
        const brokerMachine = shared.broker;
        const source = await createDaemonMachineIrohRuntime({ happyHomeDir: join(happyHomeDir, 'requester-iroh'), identity: 'ephemeral', relayConfig: { relayPolicy: 'disabled', relayUrls: [] } });
        const target = await createDaemonMachineIrohRuntime({ happyHomeDir: join(happyHomeDir, 'custodian-iroh'), identity: 'ephemeral', relayConfig: { relayPolicy: 'disabled', relayUrls: [] } });
        onTestFinished(source.shutdown); onTestFinished(target.shutdown);
        expect(source.available, 'Native requester endpoint required').toBe(true);
        expect(target.available, 'Native custodian endpoint required').toBe(true);
        if (!source.available || !target.available) throw new Error('Native endpoints unavailable');
        const custodianCredentials = { token: await createAccountTokenForTests(shared.custodian.id, { kind: 'account', authority: 'present_user' }), encryption: null } as const;
        const custodianKeys = nacl.sign.keyPair();
        const custodianInstallationId = crypto.randomUUID();
        await db.machine.update({ where: { id: shared.machine.id }, data: {
          operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] }, irohMachineEndpoint: { protocolVersions: [1], ...source.endpoint } } } });
        await db.machine.update({ where: { id: brokerMachine.id }, data: { installationId: custodianInstallationId,
          installationPublicKey: custodianKeys.publicKey, operationProtocolCapabilitiesRevision: 1,
          operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1, 3] }, irohMachineEndpoint: { protocolVersions: [1], ...target.endpoint } } } });
        await presence.connect({ baseUrl: serverUrl, token: credentials.token, accountId: shared.recipient.id,
          machineId: shared.machine.id, installationId, keys: signing });
        await presence.connect({ baseUrl: serverUrl, token: custodianCredentials.token, accountId: shared.custodian.id,
          machineId: brokerMachine.id, installationId: custodianInstallationId, keys: custodianKeys });
        const routeSigning = resolvePeerMediationGrantSigningConfig(process.env);
        if (!routeSigning.ok) throw new Error('Home route signing unavailable');
        const trustRoots = [routeSigning.capability];
        brokerExecute = createTeamCredentialBrokerActionPurposeExecutor({ initiatorMachineId: shared.machine.id,
          openTunnel: createProviderBrokerMachineCarrierTunnelOpen({ accountId: shared.recipient.id,
            localMachineId: shared.machine.id, runtime: source, resolveTrustRoots: () => trustRoots }),
          openBroker: (request, signal, requestHeaders) => openTeamCredentialProviderBroker({ token: credentials.token,
            serverBaseUrl: serverUrl, request, signal, requestHeaders }) });
        const custodianHome = join(happyHomeDir, 'custodian');
        const reload = createPluginReloadController({ happyHomeDir: custodianHome });
        onTestFinished(() => reload.shutdown());
        const api = createConnectedServiceCredentialApi(custodianCredentials);
        const getAccountEncryptionMode = () => api.getAccountEncryptionMode();
        const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials: custodianCredentials, getAccountEncryptionMode,
          secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKey(custodianCredentials) }) });
        const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ credentials: custodianCredentials,
          reloadController: reload, getAccountEncryptionMode, configuration: persistence.configuration });
        const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established,
          credentialOwnerAccountId: shared.custodian.id, workerMachineId: brokerMachine.id, reloadController: reload,
          qualifiedApi: {
            listAccountsForServices: (services, signal) => listQualifiedConnectedAccountsV4({ token: custodianCredentials.token, services, signal }),
            listAccounts: (service, signal) => listQualifiedConnectedAccountsV4({ token: custodianCredentials.token, service, signal }),
            listGroups: (service, signal) => listQualifiedConnectedAccountGroupsV4({ token: custodianCredentials.token, service, signal }),
            readGroup: (group, signal) => readQualifiedConnectedAccountGroupV4({ token: custodianCredentials.token, group, signal }),
          }, resolveQualifiedConnectedAccountV4Support: async () => resolveQualifiedConnectedAccountAtomicV4Negotiation(
            await fetchServerFeaturesSnapshot({ serverUrl, token: custodianCredentials.token })) });
        const custodian = await createAdmittedPluginRuntimeFixture({ happyHomeDir: custodianHome, controller: reload,
          runtimeOptions: { connectedAccounts: purposes.owner, actionFormConnectedAccounts: purposes,
            scopedActionRuntime: { credentials: custodianCredentials, actionsSettingsProvider: createActionSettingsProvider() } } });
        onTestFinished(custodian.dispose);
        expect(custodian.registry.activatedPluginIds).not.toContain(manifest.id);
        expect(custodian.registry.targetActionInvocations.has(manifest.id, 'options')).toBe(false);
        const unreachable = async (): Promise<never> => { throw new Error('Unrelated model broker port'); };
        const broker = await startDaemonProviderBrokerRuntime({ machineId: brokerMachine.id, resolveTrustRoots: () => trustRoots,
          nowMs: Date.now, createRequestId: crypto.randomUUID, resolveRequestPolicy: unreachable, admitRequest: unreachable,
          authorizeModelCatalog: unreachable,
          sourceOwner: createTeamCredentialBrokerSourceOwner({ machineId: brokerMachine.id, custody: { retire: unreachable },
            selectConnectedServicesSourceMember: unreachable, openConnectedServicesSource: unreachable, openProviderConnectionSource: unreachable }),
          actionOperations: { execute: createTeamCredentialBrokerActionExecutor({ purposeBindings: purposes,
            withRuntime: (read, request) => withTeamCredentialActionRuntime({ native: custodian.lease, action: request.action,
              resolveAccount: async () => {
                accountCompositions++;
                const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: custodianHome, signal: request.signal,
                  connectedAccounts: purposes.owner, actionFormConnectedAccounts: purposes,
                  accountExecution: { credentials: custodianCredentials, serverUrl, serverId: 'two-account-home', serverIdentityId: homeId,
                    machineId: brokerMachine.id, explicitMachineId: brokerMachine.id, isCurrent: () => !request.signal.aborted } });
                expect(registry.activatedPluginIds).not.toContain(manifest.id);
                expect(registry.targetActionInvocations.has(manifest.id, 'options')).toBe(false);
                return registry;
              },
            }, read) }),
            admit: async (request, signal) => {
              brokerAdmissions++;
              const response = await fetch(`${serverUrl}${PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1}`, {
                method: 'POST', headers: { authorization: `Bearer ${custodianCredentials.token}`, 'content-type': 'application/json' },
                body: JSON.stringify(request), signal });
              return ProviderBrokerActionAdmissionResponseV3Schema.parse(await response.json());
            } },
        });
        onTestFinished(broker.close);
        const admission = await startPeerMediationLoopbackServer({ nowMs: Date.now, trustRoots,
          endpointExpiresAt: Date.now() + 300_000, expected: { accountId: shared.custodian.id, machineId: brokerMachine.id,
            flowKind: 'machine_rpc', routeKind: 'loopback_direct', endpointFingerprint: target.endpoint.endpointId },
          irohMachineAdmission: { localEndpointId: target.endpoint.endpointId, role: 'acceptor', allowedFlows: [],
            resolveApplicationTarget: async () => null, resolveProviderBrokerApplicationTarget: broker.resolveProviderBrokerApplicationTarget } });
        onTestFinished(admission.stop);
        await target.startAttemptAcceptor({ admissionPort: Number(new URL(admission.url).port) });
      }
      const account = await resolveAccountExecutionRuntime({ happyHomeDir, credentialRuntimeRegistry: native.registry,
        ...(brokerExecute ? { executeTeamCredentialBrokerAction: brokerExecute } : {}),
        accountExecution: { credentials, serverUrl, serverId: 'two-account-home', serverIdentityId: homeId,
          machineId: shared.machine.id, explicitMachineId: shared.machine.id,
          savedSecretOperationContext, isCurrent: () => true } });
      onTestFinished(() => account.registry.dispose());
      expect(account.registry.executionRealm).toBe('account');
      if (!account.purposeRuntime) throw new Error('Real requester purpose runtime unavailable');
      const authority = createManagedProviderOperationAuthority({ materializationBaseDir: happyHomeDir,
        purposeBindingOwner: account.purposeRuntime.purposes,
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
        resolveRequestAuthHttpPort: () => { throw new Error('These provider Actions declare no request-auth uses'); },
        createRedactionLease: () => createProviderRedactionLease({ values: [] }) });
      const driverInput = { credentials, token: credentials.token, serverUrl, homeId,
        controller, runtimeRegistry: native.registry, managedProviderOperationAuthority: authority,
        externalActionMachineRequestPrivateKey: signing.secretKey,
        resolveAccountRuntime: async () => ({ runtimeRegistry: account.registry, managedProviderOperationAuthority: authority }),
        homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
          canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https' as const, url: serverUrl }] }, authority: 'current_connection' }) };
      const options = { requestId, context, signal: new AbortController().signal };
      let invoke: () => Promise<unknown>;
      if (role === 'options') {
          const adapter = createDaemonManagedMachineActionAdapter({ credentials, machineId: shared.machine.id,
            serverBaseUrl: serverUrl, serverId: 'two-account-home',
            ...(brokerExecute ? { executeTeamCredentialBrokerAction: brokerExecute } : {}),
            installationIdentity: { installationId, privateKey: signing.secretKey }, managedProviderOperationAuthority: authority,
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl,
              resolveCurrentMachineId: () => shared.machine.id, resolveCurrentServerIdentityId: () => homeId }),
            acquireRuntimeRegistryLease: () => native.controller.acquireRuntimeRegistry() });
          invoke = () => adapter({ actionId: 'machines.provisioners.options', input, context, signal: options.signal });
      }
      else {
        const client = createManagedMachineControllerClient(driverInput, options, 'machines.managed.acquire');
        const admitted = await client.post('/v1/machines/managed/controller/admit', { input: acquireInput, requestId, continuationPresent: false }, ManagedAdmissionOutputV1Schema);
        let retained = (await client.submit(admitted.machine)).machine;
        const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine: retained,
          action: 'machines.managed.acquire' }, () => retained);
        invoke = async () => {
          const acquired = AcquireResultV1Schema.parse(await invocation.invoke('acquire', { launch: choices, managedId: retained.id }));
          if (acquired.kind !== 'bound' && acquired.kind !== 'pending') throw new Error('Provider did not allocate the admitted native resource');
          retained = await client.reportIssuedAcquireFact(retained, acquired);
          expect(retained).toMatchObject({ id: admitted.machine.id, custodianAccountId: shared.recipient.id,
            allocation: 'bound' });
          return acquired;
        };
      }
      expect(accountCompositions).toBe(0);
      let outcome: unknown;
      try { outcome = await invoke(); }
      catch (cause) {
        throw new Error(`Native ${manifest.id}/${role} refused: ${JSON.stringify({ materialAdmissions: materialRequests.length,
          providerRequests: provider.request.mock.calls.map(([url, init]) => ({ method: init?.method ?? 'GET', path: new URL(url).pathname })),
          providerBoundaryFailures: provider.failures,
          httpFailures: diagnosticLog.mock.calls.filter(([message]) => message === '[connected-account-http-failure]')
            .map(([, failure]) => readActionFailureCauseV1(failure)),
          generationFailures: diagnosticLog.mock.calls.filter(([message]) => message === 'Plugin Action generation refused')
            .flatMap(([, failure]) => failure && typeof failure === 'object' && 'reason' in failure
              && typeof failure.reason === 'string' ? [{ reason: failure.reason }] : []) })}`, { cause });
      }
      expect(outcome).toMatchObject(role === 'options' ? { dimensions: expect.any(Object) }
        : { kind: 'bound' });
      if (role === 'options') expect(outcome).toMatchObject({ dimensions: {
        size: expect.arrayContaining([expect.objectContaining({ id: choices.size })]),
      } });
      expect(accountCompositions).toBe(brokerRealm ? 1 : 0);
      expect(provider.request).toHaveBeenCalled();
      expect(provider.failures).toEqual([]);
      expect(materialRequests).toHaveLength(brokerRealm ? 0 : 1);
      expect(brokerAdmissions).toBe(brokerRealm ? 1 : 0);
      if (!brokerRealm) expect(materialRequests[0]).toMatchObject({ consumer: { kind: 'action_operation', operationId: requestId,
        actionId: `${manifest.id}/actions/${role}`, pluginVersion: manifest.version,
        purpose: { consumer: { pluginId: manifest.id, localId: role }, purpose: 'cloud-api' } } });
      expect(JSON.stringify(outcome)).not.toContain('shared-token');
      expect(authorization.binding.accountId).toBe(shared.recipient.id);
      await db.teamCredentialResource.update({ where: { id: shared.resource.id }, data: { memberGrants: { deleteMany: {} } } });
      const effectsBeforeRevocation = provider.request.mock.calls.length;
      await expect(invoke()).rejects.toMatchObject({ code: brokerRealm ? 'resource_forbidden' : role === 'options'
        ? 'plugin_connected_account_direct_access_removed' : 'admission_unavailable' });
      expect(provider.request).toHaveBeenCalledTimes(effectsBeforeRevocation);
    });
  }, 180_000);
});
