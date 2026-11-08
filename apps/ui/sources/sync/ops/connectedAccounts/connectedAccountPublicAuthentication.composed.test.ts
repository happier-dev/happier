import { afterEach, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { encodeBase64 } from '@/encryption/base64';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { ConnectedAccountAttemptTransactionRecord } from '@happier-dev/cli-common/connectedAccounts';
import type { ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const packaged = vi.hoisted(() => ({
    artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0,
}));
// Existing direct Account-runtime cases exercise the desktop native HTTP host.
// The browser placement case below disables that physical adapter explicitly.
const nativeHttpHost = vi.hoisted(() => ({ available: false }));
vi.mock('@/utils/platform/tauri/transferFetch', () => ({
    resolveTauriRuntimeFetch: async () => nativeHttpHost.available
        ? (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init) : null,
}));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
// Only packaged inventory, native asset IO and OS randomness leave the real
// compiler → availability → activation → Action → credential/resource path.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    get BUNDLED_PLUGIN_UI_APP_ARTIFACTS() { return packaged.artifacts; },
    get BUNDLED_PLUGIN_UI_APP_DECLARATIONS() { return packaged.declarations; },
    BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({ localUri: `file:///public-auth-fixture/${asset}`, downloadAsync: async () => {} }) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private readonly uri: string) {}
    async bytes() {
        packaged.reads += 1;
        const file = packaged.files.get(Number(this.uri.split('/').at(-1)));
        if (!file) throw new Error('Missing packaged fixture asset');
        return file;
    }
} }));
vi.mock('expo-crypto', async original => ({ ...await original<typeof import('expo-crypto')>(),
    randomUUID: (await import('node:crypto')).randomUUID }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
// Cold source-graph loading belongs to collection after transport installation;
// the test's own timeout measures the composed operation rather than transforms.
const [{ createDefaultActionExecutor }, { reconcileProjectedPluginUiClientExecutables },
    { preparePublicAuthorInventory, prepareAuthenticationInventory, answerAttemptTransaction }, { definePlugin }] = await Promise.all([
    import('@/sync/ops/actions/defaultActionExecutor'),
    import('@/components/plugins/reactNative/clientExecutableActivation'),
    import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
    import('../../../../../../packages/plugin-sdk/src/definePlugin'),
]);

afterEach(async () => {
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    await getInstalledPluginUiClientExecutableComposition().unload();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
    packaged.reads = 0;
    nativeHttpHost.available = false;
});

async function prepareDeviceInventory() {
    const { deviceAuthentication } = await import('@/dev/testkit/fixtures/connectedAccountDeviceAuthentication');
    const target = { artifactId: 'private-device-auth', exportName: 'activate' };
    const authored = definePlugin({ id: 'acme.device-auth', version: '1.0.0', connectedAccountDescriptors: {
        example: { declaration: { title: 'Device example', authentication: { account: target, defaultModeId: 'device', modes: [{
            id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none',
        }, {
            id: 'configured-device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none',
            configuration: { scope: 'service', changeBehavior: 'reconnect', fields: [{
                id: 'region', title: 'Region', schema: { type: 'string' }, required: false, default: 'fixture',
            }] },
        }] } }, accountRuntime: deviceAuthentication, runtime: { ...deviceAuthentication,
            async refresh() { return { status: 'connected' as const }; },
            async revoke() { return { status: 'remoteUnsupported' as const }; },
            async status() { return { status: 'connected' as const }; },
            async materialize() { return { kind: 'httpHeaders' as const, headers: {} }; },
        } },
    } });
    return prepareAuthenticationInventory(packaged, { manifest: authored.manifest, target, projectPath: 'apps/ui',
        entryPath: 'apps/ui/sources/dev/testkit/fixtures/connectedAccountDeviceAuthentication.ts', packageName: '@acme/device-auth' });
}

async function prepareVercelInventory() {
    const [{ PLUGIN_MANIFEST }, { ACCOUNT_ID }] = await Promise.all([
        import('../../../../../../packages/plugins/machine-vercel/src/manifest'),
        import('../../../../../../packages/plugins/machine-vercel/src/account'),
    ]);
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(value => value.id === ACCOUNT_ID);
    const target = descriptor?.authentication.account;
    if (!descriptor || !target) throw new Error('Actual Vercel descriptor has no Account authentication artifact');
    await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST, target,
        projectPath: 'packages/plugins/machine-vercel', entryPath: 'packages/plugins/machine-vercel/src/account.ts',
        packageName: '@happier-dev/plugins-machine-vercel' });
    return { pluginId: PLUGIN_MANIFEST.id, localId: ACCOUNT_ID };
}

async function prepareCloudflareInventory() {
    const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/deploy-cloudflare/src/manifest');
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(value => value.id === 'cloudflare');
    const target = descriptor?.authentication.account;
    if (!descriptor || !target) throw new Error('Actual Cloudflare descriptor has no Account authentication artifact');
    await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST, target,
        projectPath: 'packages/plugins/deploy-cloudflare',
        entryPath: 'packages/plugins/deploy-cloudflare/src/connectedAccounts/portableAuthentication.ts',
        packageName: '@happier-dev/plugins-deploy-cloudflare',
        additionalArtifacts: [{ target: { artifactId: 'account-runtime', exportName: 'activateAccount' },
            entryPath: 'packages/plugins/deploy-cloudflare/src/accountRuntime.ts' }] });
    return { pluginId: PLUGIN_MANIFEST.id, localId: descriptor.id };
}

async function prepareClaudeInventory() {
    const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/claude/src/manifest');
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(value => value.id === 'claude-subscription');
    const target = descriptor?.authentication.account;
    if (!descriptor || !target) throw new Error('Actual Claude descriptor has no Account authentication artifact');
    await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST, target,
        projectPath: 'packages/plugins/claude', entryPath: 'packages/plugins/claude/src/connectedAccounts/account.ts',
        packageName: '@happier-dev/plugins-claude' });
    const declaration = packaged.declarations.at(-1);
    if (!declaration || typeof declaration !== 'object' || !('normalizedManifest' in declaration)
        || !('entriesById' in declaration)) throw new Error('Missing compiled Claude declaration');
    const { projectBundledPluginUiFirstPaintDeclaration } = await import('../../../../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs');
    packaged.declarations[packaged.declarations.length - 1] = {
        ...await projectBundledPluginUiFirstPaintDeclaration(declaration),
        loadDeclaration: async () => declaration,
    };
    return { pluginId: PLUGIN_MANIFEST.id, localId: descriptor.id };
}

async function prepareOtherOAuthInventory(provider: 'antigravity' | 'codex') {
    const { PLUGIN_MANIFEST } = provider === 'antigravity'
        ? await import('../../../../../../packages/plugins/antigravity/src/manifest')
        : await import('../../../../../../packages/plugins/codex/src/manifest');
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(value => value.authentication.account);
    const target = descriptor?.authentication.account;
    if (!descriptor || !target) throw new Error('Missing actual OAuth Account artifact');
    await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST, target,
        projectPath: `packages/plugins/${provider}`, entryPath: `packages/plugins/${provider}/src/connectedAccounts/account.ts`,
        packageName: `@happier-dev/plugins-${provider}` });
    return { service: { pluginId: PLUGIN_MANIFEST.id, localId: descriptor.id }, modeId: descriptor.authentication.defaultModeId,
        modeIds: descriptor.authentication.modes.filter(mode => mode.kind !== 'manual').map(mode => mode.id) };
}

type TransactionRecord = ConnectedAccountAttemptTransactionRecord;

// Host bundles are immutable for the loaded process, just like the real app.
// Prepare every artifact before the first Home can acquire that inventory.
let coldDeclarationLoads = 0;
const inventories = {
    device: await prepareDeviceInventory(),
    public: await preparePublicAuthorInventory(packaged),
    staging: await preparePublicAuthorInventory(packaged, false, { requireAccountConfiguration: true }),
    materialization: await preparePublicAuthorInventory(packaged, true),
    cold: await preparePublicAuthorInventory(packaged, false, { deferDeclaration: true,
        onDeclarationLoad: () => { coldDeclarationLoads += 1; } }),
    // Authentication description and Action materialization each need a
    // provider that has never been demanded in this loaded process.
    coldMaterialization: await preparePublicAuthorInventory(packaged, false, {
        deferDeclaration: true, pluginId: 'acme.portable-cold-materialization-auth' }),
    cloudflare: await prepareCloudflareInventory(),
    vercel: await prepareVercelInventory(),
    claude: await prepareClaudeInventory(),
    antigravity: await prepareOtherOAuthInventory('antigravity'),
    codex: await prepareOtherOAuthInventory('codex'),
};

it.each([
    { relayFailure: false, mountedCaller: false },
    { relayFailure: true, mountedCaller: false },
    { relayFailure: false, mountedCaller: true },
])('places a browser Cloudflare Account Action on an own Machine relay (failure=$relayFailure, mounted=$mountedCaller)', async ({ relayFailure, mountedCaller }) => {
    nativeHttpHost.available = false;
    const [{ answerExternalActionAccountForHome }, { createMachineFixture }, { storage },
        { captureActiveServerAccountScopeLifetime }, { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability },
        { createPluginUiCommonJsLoaderBackend }, { dispatchPluginSurfaceAction }] = await Promise.all([
        import('@/dev/testkit/harness/externalActionAccountHttpBoundary'),
        import('@/dev/testkit/fixtures/machineFixtures'), import('@/sync/domains/state/storage'),
        import('@/sync/domains/scope/activeServerAccountScope'), import('@/sync/domains/plugins/availability/projection'),
        import('@/components/plugins/reactNative/commonJsLoaderBackend'),
        import('@/components/plugins/surfaces/pluginSurfaceActionDispatch'),
    ]);
    const accountId = 'browser-action-account';
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverUrl = 'https://browser-action-home.test';
    const serverIdentityId = 'srv_browser_action';
    const serverId = await homes.addHome({ name: 'Browser Action', serverUrl, serverIdentityId,
        accountId, credentials, accountEncryptionMode: 'plain' });
    const action = { pluginId: inventories.cloudflare.pluginId, localId: 'cloudflare-named/selections-read' };
    const input = { credentialRef: { service: inventories.cloudflare, accountId: 'selected-cloudflare' }, hostname: 'example.test' };
    homes.answer(serverId, 'GET /v4/connect/qualified/accounts', { body: { service: inventories.cloudflare,
        accounts: [{ ref: input.credentialRef, status: 'connected', authenticationModeId: 'token', configurationReady: true,
            configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] } });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    let browserCredentialReads = 0;
    let browserVendorRequests = 0;
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId, credentials,
        configureSocket: configureConnectedServerSocketBoundary,
        request: async (input, init) => {
            const url = new URL(String(input));
            if (url.origin !== serverUrl) {
                browserVendorRequests += 1;
                throw new TypeError('Provider does not permit browser CORS');
            }
            if (url.pathname === '/v4/connect/qualified/credential') {
                browserCredentialReads += 1;
                throw new Error('Selected credential belongs at the daemon');
            }
            return homes.request(input, init);
        } });
    const result = { kind: 'ready', zones: [{ zoneId: 'zone-selected', name: 'example.test' }], options: [],
        defaults: { connector: { imageRef: 'cloudflare/cloudflared', version: 'fixture' } },
        connectorDiscovery: { kind: 'unavailable', reason: 'connector_discovery_unavailable' } };
    const failureCause = { phase: 'plugin.http.execute', errorClass: 'TypeError', errorCode: null, httpStatus: null };
    let received: unknown;
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'browser-action-machine',
        actionId: 'action.invoke', tokenEpoch: 0,
        execute: (value) => { received = value; return relayFailure
            ? { ok: false, errorCode: 'plugin_fetch_adapter_unavailable', error: 'plugin_fetch_adapter_unavailable', failureCause }
            : { ok: true, result }; } });
    const machine = createMachineFixture({ id: 'browser-action-machine', activeAt: Date.now(),
        access: { custodian: { accountId, displayName: 'Test Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
    storage.setState({ machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] },
        machineListStatusByServerId: { [serverId]: 'idle' } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing browser Account lifetime');
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(lifetime.scope);
    const selected = await reader.ensureCurrentAccountExecution(action.pluginId);
    expect(selected.kind).toBe('available');
    const projection = reader.readAccountUiProjection();
    if (!projection) throw new Error('Missing browser Account projection');
    await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: 'web', reader,
        accountLifetime: lifetime, loaderBackend: createPluginUiCommonJsLoaderBackend() });
    const callerAction = projection.actionsById[`${action.pluginId}/${action.localId}`];
    if (!callerAction?.hostAccountOrigin) throw new Error('Missing Account caller custody');
    const outcome = await dispatchPluginSurfaceAction({ action, input, clientAction: {}, pluginUiProjection: projection,
        ...(mountedCaller ? { callerPluginId: action.pluginId, callerContributionLocalId: action.localId,
            callerBinding: { pluginId: action.pluginId, contributionLocalId: action.localId,
                occurrenceId: callerAction.occurrenceId, sourceCustody: callerAction.hostAccountOrigin.sourceCustody } } : {}),
        invocationSurface: 'ui', originSurface: 'ui',
        resolveContributedAction: identity => projection.actionsById[`${identity.pluginId}/${identity.localId}`] ?? null,
        hostAction: { execute: createDefaultActionExecutor().execute,
            context: { serverId, expectedAccountId: accountId, surface: 'ui', authority: 'present_user' } } });
    expect(outcome, JSON.stringify(outcome)).toMatchObject(relayFailure
        ? { ok: false, reason: 'plugin_fetch_adapter_unavailable', failureCause } : { ok: true, result });
    expect(received).toEqual({ action, input });
    expect(browserCredentialReads).toBe(0);
    expect(browserVendorRequests).toBe(0);
});

it.each([
    { provider: 'cold public-author', service: inventories.cold, defaultModeId: 'manual', modeIds: ['manual'], declarationLoads: 1 },
    { provider: 'Cloudflare', service: inventories.cloudflare, defaultModeId: 'oauth',
        modeIds: ['token', 'oauth'], declarationLoads: 0 },
    { provider: 'Antigravity', service: inventories.antigravity.service, defaultModeId: inventories.antigravity.modeId,
        modeIds: inventories.antigravity.modeIds, declarationLoads: 0, beginStatus: 'awaitingOAuth' },
    { provider: 'Codex', service: inventories.codex.service, defaultModeId: inventories.codex.modeId,
        modeIds: inventories.codex.modeIds, declarationLoads: 0, beginStatus: 'awaitingOAuth' },
    { provider: 'Vercel', service: inventories.vercel, defaultModeId: 'token', modeIds: ['token'], declarationLoads: 0 },
])('demands $provider Account authentication through the service description wrapper', async testCase => {
    const { service, defaultModeId, modeIds, declarationLoads } = testCase;
    const priorDeclarationLoads = coldDeclarationLoads;
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const { describeConnectedAccountAuthenticationService } = await import('./connectedAccountDaemon');
    const { QualifiedConnectedAccountListResponseV4Schema } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
    const accountId = 'public-auth-cold';
    const credentials = { token: createAccountTokenForTests(accountId) };
    const url = 'https://public-auth-cold.test';
    const serverId = await homes.addHome({ name: 'Cold public authentication', serverUrl: url,
        accountId, credentials, accountEncryptionMode: 'plain' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    const bootstrapMachineRead = createDeferred<void>();
    let machineReads = 0;
    let machineRpcs = 0;
    let accountListReads = 0;
    let vendorRequests = 0;
    const transactions: Parameters<typeof answerAttemptTransaction>[2] = new Map();
    connection = await restoreServerAccountForTest({ serverUrl: url, accountId, credentials,
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string) => {
                if (event.includes('rpc')) { machineRpcs += 1; throw new Error('Cold Account authentication must not invoke Machine RPC'); }
                return { ok: true };
            });
        },
        request: async (input, init) => {
            const request = new URL(String(input));
            if (request.origin !== url) { vendorRequests += 1; return new Response('{}', { status: 503 }); }
            const transaction = await answerAttemptTransaction(request, init, transactions);
            if (transaction) return transaction;
            if (request.pathname.startsWith('/v1/machines')) {
                machineReads += 1;
                if (request.pathname === '/v1/machines') bootstrapMachineRead.resolve();
                return Response.json([]);
            }
            if (request.pathname === '/v4/connect/qualified/accounts') {
                accountListReads += 1;
                return Response.json(QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [] }));
            }
            return homes.request(input, init);
        } });
    await bootstrapMachineRead.promise;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing cold Account lifetime');
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(lifetime.scope);
    const projection = reader.readAccountUiProjection();
    if (!projection) throw new Error('Missing cold presentation projection');
    const [{ projectConnectedServiceRegistryEntries }, { createConnectedAccountDescriptorProjectionLoadingState },
        { projectConnectedAccountDescriptorV1 }, { buildConnectedServicesIndexModel }, { buildConnectedServiceSetupCatalog },
        { presentConnectedServiceIndexDiagnostics }] = await Promise.all([
        import('@/sync/domains/connectedServices/connectedServiceRegistry'),
        import('@/sync/domains/connectedServices/connectedAccountDescriptorProjection'),
        import('@happier-dev/protocol/connect/connectedAccountUiProjectionV1'),
        import('@/components/settings/connectedServices/model/buildConnectedServicesIndexModel'),
        import('@/components/settings/connectedServices/setup/buildConnectedServiceSetupCatalog'),
        import('@/components/settings/connectedServices/model/presentConnectedServiceIndexDiagnostics'),
    ]);
    const descriptors = Object.values(projection.connectedAccountDescriptorsById ?? {}).map(({ pluginId, definition }) =>
        projectConnectedAccountDescriptorV1({ descriptor: definition, pluginId, serviceId: definition.id,
            provenance: 'first_party', sourceKind: 'bundled', availability: { state: 'available', reason: 'account_declaration' }, diagnostics: [] }));
    const catalog = buildConnectedServiceSetupCatalog(buildConnectedServicesIndexModel({
        transport: 'advertised-v4', registryStatus: 'loading',
        entries: projectConnectedServiceRegistryEntries(createConnectedAccountDescriptorProjectionLoadingState('catalog'), descriptors),
        qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {},
        resolveLabel: (_entry, identity) => identity.localId, resolveFallbackEntry: () => null,
        presentDiagnostics: entry => presentConnectedServiceIndexDiagnostics({ entry }), loadingLabel: 'Loading', agentUses: [],
    }));
    expect(catalog.find(entry => entry.serviceKey === `${service.pluginId}/${service.localId}`))
        .toMatchObject({ service, canAdd: true });
    // AppShell publishes the complete presentation-derived set before demand.
    // Neither full declaration admission nor a second reconciliation is seeded.
    await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: 'web',
        reader, accountLifetime: lifetime, loaderBackend: createPluginUiCommonJsLoaderBackend() });
    expect(coldDeclarationLoads).toBe(priorDeclarationLoads);
    expect(packaged.reads).toBe(0);
    machineReads = 0;
    machineRpcs = 0;
    const described = await describeConnectedAccountAuthenticationService({ serverId, expectedAccountId: accountId, service });
    expect(described, JSON.stringify(described)).toMatchObject({
        description: { status: 'described', service, descriptor: { authentication: { defaultModeId } }, accounts: [] },
        accountAuthenticationModes: { status: 'available' },
    });
    expect(described.accountAuthenticationModes.status === 'available'
        ? [...described.accountAuthenticationModes.modeIds].sort() : []).toEqual([...modeIds].sort());
    expect(described.accountAuthenticationModes).not.toHaveProperty('machineRequiredModeIds');
    expect(coldDeclarationLoads).toBe(priorDeclarationLoads + declarationLoads);
    expect(packaged.reads).toBe(1);
    expect(accountListReads).toBe(1);
    if ('beginStatus' in testCase) {
        const begin = await createDefaultActionExecutor().execute('connectedServices.authentication.beginConnect', {
            service, modeId: defaultModeId,
        }, { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: accountId });
        const result = begin.ok && begin.result && typeof begin.result === 'object' ? begin.result : {};
        expect({ ok: begin.ok, status: 'status' in result ? result.status : undefined,
            ...('code' in result ? { code: result.code } : {}) }).toEqual({ ok: true, status: testCase.beginStatus });
        expect([...transactions.values()].map(value => value.scope.machineId)).toEqual([undefined]);
    }
    expect(vendorRequests).toBe(0);
    expect(machineReads).toBe(0);
    expect(machineRpcs).toBe(0);
});

it.each([
    { provider: 'device', service: inventories.device, modeId: 'configured-device', homeClient: false },
    { provider: 'Cloudflare without a Home client', service: inventories.cloudflare, modeId: 'oauth', homeClient: false },
    { provider: 'Cloudflare with a Home client', service: inventories.cloudflare, modeId: 'oauth', homeClient: true },
])('reads effective browser $provider configuration through the actual Account authentication host without a Machine', async ({ service, modeId, homeClient }) => {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createUiConnectedAccountAuthenticationHost } = await import('./connectedAccountAuthenticationHost');
    const { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRecordV1Schema,
        ConnectedAccountCatalogRowReadResponseV1Schema, sealConnectedAccountCatalogContentV1 } =
        await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const accountId = 'portable-configuration-reader';
    const credentials = { token: createAccountTokenForTests(accountId) };
    const url = 'https://portable-configuration-reader.test';
    const serverId = await homes.addHome({ name: 'Portable configuration', serverUrl: url, accountId, credentials, accountEncryptionMode: 'plain' });
    const features = createRootLayoutFeaturesResponse({ capabilities: { connectedServices: {
        ...createRootLayoutFeaturesResponse().capabilities.connectedServices,
        ...(homeClient ? { publicOAuthClients: [{ service, clientId: 'home-cloudflare-client',
            scopesByMode: { oauth: ['account:read'] } }] } : {}),
    } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    const record = ConnectedAccountCatalogRecordV1Schema.parse({ key: 'configurations', value: { v: 1, entries: [] } });
    const row = ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
        content: sealConnectedAccountCatalogContentV1({ record, mode: 'plain', material: null }) });
    let catalogReads = 0;
    let machineReads = 0;
    let machineRpcs = 0;
    const transactions = new Map<string, TransactionRecord>();
    let markMachineBootstrapRead!: () => void;
    const machineBootstrapRead = new Promise<void>(resolve => { markMachineBootstrapRead = resolve; });
    connection = await restoreServerAccountForTest({ serverUrl: url, accountId, credentials,
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string) => {
                if (event.includes('rpc')) { machineRpcs += 1; throw new Error('Portable configuration must not invoke Machine RPC'); }
                return { ok: true };
            });
        },
        request: async (input, init) => {
            const request = new URL(String(input));
            const transaction = await answerAttemptTransaction(request, init, transactions);
            if (transaction) return transaction;
            if (request.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`) {
                expect(init?.method ?? 'GET').toBe('GET');
                catalogReads += 1;
                return Response.json(row);
            }
            if (request.pathname.startsWith('/v1/machines')) {
                machineReads += 1;
                const response = Response.json([]);
                if (request.pathname === '/v1/machines') markMachineBootstrapRead();
                return response;
            }
            return homes.request(input, init);
        } });
    // Account restoration owns its initial inventory request. Measure the
    // configuration operation only after that real HTTP baseline has arrived.
    await machineBootstrapRead;
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const snapshot = await getServerFeaturesSnapshot({ serverId, force: true });
    expect(snapshot.status).toBe('ready');
    if (homeClient && snapshot.status === 'ready') {
        expect(snapshot.features.capabilities.connectedServices.publicOAuthClients).toEqual(features.capabilities.connectedServices.publicOAuthClients);
    }
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing configuration reader Account lifetime');
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(lifetime.scope);
    expect((await reader.ensureCurrentAccountExecution(service.pluginId)).kind).toBe('available');
    const projection = reader.readAccountUiProjection();
    if (!projection) throw new Error('Missing configuration reader Account projection');
    const executableInput = { actionProjection: { projection }, platform: 'web' as const,
        reader, accountLifetime: lifetime, loaderBackend: createPluginUiCommonJsLoaderBackend() };
    await reconcileProjectedPluginUiClientExecutables(executableInput);
    expect(packaged.reads).toBe(0);
    machineReads = 0;
    machineRpcs = 0;
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: accountId };
    let target: { kind: 'service'; service: typeof service; modeId: string } | { kind: 'attempt'; attemptId: string } =
        { kind: 'service', service, modeId };
    if (modeId === 'oauth') {
        const begin = await createDefaultActionExecutor().execute('connectedServices.authentication.beginConnect', { service, modeId }, context);
        expect(begin, JSON.stringify(begin)).toMatchObject({ ok: true, result: { status: 'configurationRequired' } });
        if (!begin.ok || !begin.result || typeof begin.result !== 'object' || !('attemptId' in begin.result)
            || typeof begin.result.attemptId !== 'string') throw new Error('Missing Cloudflare configuration draft');
        target = { kind: 'attempt', attemptId: begin.result.attemptId };
    }
    const account = await captureLazyActionAccountContext(serverId);
    const response = await (async () => {
        try {
            return await createUiConnectedAccountAuthenticationHost(account).controlCommand(undefined, {
                operation: 'readConfiguration', target,
            });
        } finally { account.dispose(); }
    })();
    expect(response, JSON.stringify(response)).toMatchObject({ status: 'configuration',
        target: { ...target, service, modeId },
        mode: { id: modeId, configuration: { scope: modeId === 'oauth' ? 'account' : 'service' } },
        configuration: { status: 'configurationRequired', revision: null,
            values: modeId === 'oauth' ? {} : { region: 'fixture' }, configuredSecretFieldIds: [],
            missingFieldIds: modeId === 'oauth' && !homeClient ? ['clientId', 'registeredScopes'] : [] } });
    if (modeId === 'oauth') {
        if (response.status !== 'configuration') {
            throw new Error('Missing effective Cloudflare configuration mode');
        }
        const { PluginConnectedAccountAuthenticationModeV2Schema } = await import('@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2');
        const mode = PluginConnectedAccountAuthenticationModeV2Schema.parse(response.mode);
        expect(mode.configuration?.fields.filter(field => ['clientId', 'registeredScopes'].includes(field.id))
            .map(field => ({ id: field.id, required: field.required, advanced: field.presentation?.advanced === true })))
            .toEqual([
                { id: 'clientId', required: !homeClient, advanced: homeClient },
                { id: 'registeredScopes', required: !homeClient, advanced: homeClient },
            ]);
    }
    if (modeId !== 'oauth') expect(catalogReads).toBeGreaterThan(0);
    expect(machineReads).toBe(0);
    expect(machineRpcs).toBe(0);
    expect(packaged.reads).toBe(1);
});

it.each([
    { mode: 'plain', coldProvider: false }, { mode: 'e2ee', coldProvider: false },
    { mode: 'plain', coldProvider: true },
] as const)('materializes the exact selected purpose through the public Account artifact without a Machine ($mode; cold provider=$coldProvider)', async ({ mode, coldProvider }) => {
    // This existing direct-execution contract belongs to native HTTP hosts.
    nativeHttpHost.available = true;
    const service = coldProvider ? inventories.coldMaterialization : inventories.materialization;
    const consumerPluginId = inventories.materialization.pluginId;
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const { createPluginSurfaceAccountActionServices } = await import('@/components/plugins/surfaces/pluginSurfaceAccountActionServices');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createUiConnectedAccountContent } = await import('./connectedAccountContent');
    const { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema } =
        await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
    const { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema,
        sealConnectedAccountCatalogContentV1 } =
        await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
    const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
    const { getRandomBytes } = await import('@/platform/cryptoRandom');
    const accountId = `public-materialization-${mode}`;
    const credentials = { token: createAccountTokenForTests(accountId),
        ...(mode === 'e2ee' ? { secret: encodeBase64(new Uint8Array(32).fill(37), 'base64url') } : {}) };
    const catalogMaterial = mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const url = 'https://public-materialization.test';
    const serverId = await homes.addHome({ name: 'Materialization', serverUrl: url, accountId, credentials,
        accountEncryptionMode: mode, credentialResourcesEnabled: true });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    const selected = { service, accountId: 'selected' };
    const other = { service, accountId: 'other' };
    let defaultAccount: typeof selected | null = selected;
    const sentinel = 'private-public-artifact-credential';
    const savedSentinel = 'private-account-action-saved-secret';
    let credential: ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse> | undefined;
    let configuration: ReturnType<typeof QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse> | undefined;
    let configurationContent: ReturnType<ReturnType<typeof createUiConnectedAccountContent>['seal']> | undefined;
    let credentialReads = 0;
    let purposeCatalogReads = 0;
    let machineReads = 0;
    const machineReadOrigins: string[] = [];
    const bootstrapMachineRead = createDeferred<void>();
    let machineRpcs = 0;
    connection = await restoreServerAccountForTest({ serverUrl: url, accountId, credentials,
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string) => {
                if (event.includes('rpc')) { machineRpcs += 1; throw new Error('Account materialization must not invoke Machine RPC'); }
                return { ok: true };
            });
        },
        request: async (input, init) => {
            const request = new URL(String(input));
            if (request.pathname.startsWith('/v1/machines')) {
                machineReads += 1;
                machineReadOrigins.push(new Error('Machine read origin').stack ?? 'unknown');
                bootstrapMachineRead.resolve();
                return Response.json([]);
            }
            if (request.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) { purposeCatalogReads += 1; return Response.json(ConnectedAccountCatalogRowReadResponseV1Schema.parse({
                status: 'present', revision: 1, content: sealConnectedAccountCatalogContentV1({ mode, material: catalogMaterial,
                    randomBytes: getRandomBytes, record: { key: 'purposes', value: { v: 1,
                    bindings: defaultAccount ? [{ purpose: { consumer: { pluginId: consumerPluginId, localId: 'inspect' }, purpose: 'provision' },
                        target: { kind: 'account', account: defaultAccount } }] : [] } } }),
            })); }
            if (request.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`) return Response.json(ConnectedAccountCatalogRowReadResponseV1Schema.parse({
                status: 'present', revision: 1, content: sealConnectedAccountCatalogContentV1({ mode, material: catalogMaterial,
                    randomBytes: getRandomBytes, record: { key: 'configurations', value: { v: 1, entries: [] } } }),
            }));
            if (request.pathname === '/v4/connect/qualified/accounts') return Response.json({ service, accounts: [selected, other].map(ref => ({
                ref, status: 'connected', authenticationModeId: 'manual', configurationReady: true,
                configurationRevision: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [],
            })) });
            if (request.pathname === '/v4/connect/qualified/credential') { credentialReads += 1; return Response.json(credential); }
            if (request.pathname === '/v4/connect/qualified/configuration') return configuration ? Response.json(configuration)
                : Response.json({ error: 'connect_configuration_not_found' }, { status: 404 });
            if (request.pathname === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [{
                resourceId: 'echo-secret', encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: { t: 'plain', v: { v: 1, name: 'Echo secret', kind: 'token', value: savedSentinel } },
                entry: { ref: 'happier:shared-secret:v1:echo-secret', source: 'shared_resource', relationship: 'owner', name: 'Echo secret',
                    kind: 'token', revision: 1, materialStatus: 'ready', capabilities: {
                        use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] });
            if (request.pathname === '/vendor/echo') {
                const authorization = new Headers(init?.headers).get('authorization');
                if (authorization) expect(authorization).toBe(`Bearer ${sentinel}`);
                return Response.json({ echoed: sentinel });
            }
            return homes.request(input, init);
        } });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const content = createUiConnectedAccountContent(account);
        credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: selected, authenticationModeId: 'manual',
            revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null,
            content: content.seal('credential', await content.resolveAccountMode(), { v: 1, values: { token: sentinel } }), metadata: { scopes: [] } });
        configurationContent = content.seal('configuration', await content.resolveAccountMode(), { values: {}, secretRefs: {} });
    } finally { account.dispose(); }
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing Account lifetime');
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(lifetime.scope);
    const selectedPlugin = await reader.ensureCurrentAccountExecution(consumerPluginId);
    if (selectedPlugin.kind !== 'available') throw new Error('Missing Account declaration');
    const projection = reader.readAccountUiProjection();
    if (!projection) throw new Error('Missing Account projection');
    await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: 'web', reader,
        accountLifetime: lifetime, loaderBackend: createPluginUiCommonJsLoaderBackend() });
    // Account restoration independently bootstraps Home's Machine display list.
    // Observe that existing HTTP boundary before measuring this Action path.
    await bootstrapMachineRead.promise;
    machineReads = 0;
    machineReadOrigins.length = 0;
    const capability = createPluginSurfaceAccountActionServices({ pluginId: consumerPluginId, actionId: 'inspect',
        ...(coldProvider ? { actionInput: { account: selected } } : {}),
        occurrenceId: selectedPlugin.custodyId, sourceCustody: selectedPlugin.sourceCustody, accountLifetime: lifetime,
        signal: new AbortController().signal, isCurrent: () => true, execute: async () => null });
    try {
        if (coldProvider) {
            // The consumer is warm; its separately packaged credential provider
            // has never been described or activated in this Account lifetime.
            expect(reader.readCurrentAccountExecution(service.pluginId)).toMatchObject({ kind: 'unavailable', code: 'plugin_ui_declaration_pending' });
            const response = await capability.services.http.request({ url: `${url}/vendor/echo`, redirect: 'error',
                credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'provision', origin: url,
                    method: 'GET', headerNames: ['authorization'] } });
            expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ echoed: '[REDACTED]' });
            // The established owner reads the admitted snapshot and qualifies
            // it again at credential publication; provider demand adds no read.
            expect(credentialReads).toBe(2);
            expect(purposeCatalogReads).toBe(0);
            expect(machineReads).toBe(0);
            expect(machineRpcs).toBe(0);
            expect(packaged.reads).toBe(1);
            return;
        }
        expect(capability.services.connectedAccounts).toBeDefined();
        expect(capability.services.connectedAccounts).not.toHaveProperty('watch');
        const materialization = { kind: 'httpHeaders' as const, origin: url, headerNames: ['authorization'] };
        await expect(capability.services.connectedAccounts.materialize('unknown', materialization))
            .rejects.toMatchObject({ code: 'plugin_connected_account_purpose_undeclared' });
        await expect(capability.services.connectedAccounts.materialize('provision', materialization, { expectedAccount: other }))
            .rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
        expect(credentialReads).toBe(0);
        expect(await capability.services.connectedAccounts.getBinding('provision')).toMatchObject({ account: selected });
        const material = await capability.services.connectedAccounts.materialize('provision', materialization, { expectedAccount: selected });
        expect(material).toEqual({ kind: 'httpHeaders', headers: { Authorization: `Bearer ${sentinel}` } });
        const echo = await capability.services.http.request({ url: `${url}/vendor/echo`, redirect: 'error' });
        expect(JSON.parse(new TextDecoder().decode(echo.body))).toEqual({ echoed: '[REDACTED]' });
        const credentialBinding = { kind: 'connectedAccountPurpose' as const, purpose: 'provision',
            origin: url, method: 'GET' as const, headerNames: ['authorization'] };
        const authenticated = await capability.services.http.request({ url: `${url}/vendor/echo`, redirect: 'error', credentialBinding });
        expect(JSON.parse(new TextDecoder().decode(authenticated.body))).toEqual({ echoed: '[REDACTED]' });
        await expect(capability.services.http.request({ url: 'https://foreign.test/vendor/echo', redirect: 'error', credentialBinding }))
            .rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
        await expect(capability.services.http.request({ url: `${url}/vendor/echo`, redirect: 'error',
            credentialBinding: { ...credentialBinding, purpose: 'undeclared' } }))
            .rejects.toMatchObject({ code: 'plugin_connected_account_purpose_undeclared' });
        const { resolvePluginUiAccountConnectedAccountRegistration } = await import('@/components/plugins/reactNative/clientExecutableContributions');
        const { createUiConnectedAccountAuthenticationRuntime } = await import('./connectedAccountAuthenticationRuntime');
        const { readUiAccountConnectedServiceDeclarations } = await import('@/sync/domains/connectedServices/accountDeclarations');
        const descriptor = Object.values(projection.connectedAccountDescriptorsById ?? {}).find(candidate =>
            candidate.pluginId === service.pluginId && candidate.id === service.localId);
        const declaration = readUiAccountConnectedServiceDeclarations(lifetime).find(candidate =>
            candidate.service.pluginId === service.pluginId && candidate.service.localId === service.localId);
        if (!descriptor || !declaration) throw new Error('Missing exact Account descriptor');
        const runtimeRegistration = await resolvePluginUiAccountConnectedAccountRegistration({ descriptor, platform: 'web' });
        const holder = runtimeRegistration?.registration.connectedAccountAuthentication;
        if (!runtimeRegistration || !holder) throw new Error('Missing retained Account runtime');
        const runtime = await holder.acquire(() => createUiConnectedAccountAuthenticationRuntime({ selected: runtimeRegistration, declaration }));
        await expect(runtime.materialize({ account: selected, expectedConfigurationRevision: 'retained-other-configuration',
            request: materialization, signal: new AbortController().signal, registerRawForRedaction() {} })).rejects.toBeInstanceOf(Error);
        const cancelled = new AbortController();
        cancelled.abort();
        const beforeCancellation = credentialReads;
        await expect(capability.services.connectedAccounts.materialize('provision', materialization, { signal: cancelled.signal })).rejects.toBeDefined();
        expect(credentialReads).toBe(beforeCancellation);
        const purpose = { consumer: { pluginId: consumerPluginId, localId: 'inspect' }, purpose: 'provision' };
        const seed = { identity: purpose.consumer, operationId: 'existing-accepted-operation', purposes: [purpose],
            purposeBindings: { v: 1, bindings: [{ purpose, target: { kind: 'account', account: selected } }] },
            isCurrent: () => true, managedOperation: { role: 'acquire',
                credentialConfigurations: [{ account: selected, revision: null }], isCurrent: role => role === 'acquire' },
        } satisfies ConnectedAccountInvocationPurposeBinding;
        const privateCapability = (binding: ConnectedAccountInvocationPurposeBinding) => createPluginSurfaceAccountActionServices({
            pluginId: consumerPluginId, actionId: 'inspect', occurrenceId: selectedPlugin.custodyId,
            sourceCustody: selectedPlugin.sourceCustody, accountLifetime: lifetime, signal: new AbortController().signal,
            isCurrent: () => true, execute: async () => null, connectedAccountPurposeBinding: binding });
        const launch = privateCapability(seed);
        const noRetainedRevision = privateCapability({ ...seed, managedOperation: {
            role: 'acquire', isCurrent: role => role === 'acquire' } });
        try {
            defaultAccount = other;
            const catalogReadsBeforeLaunch = purposeCatalogReads;
            await expect.soft(launch.services.connectedAccounts.materialize('provision', materialization, { expectedAccount: selected }))
                .resolves.toEqual(material);
            expect.soft(purposeCatalogReads).toBe(catalogReadsBeforeLaunch);
            if (!credential || credential.revisionSemantics !== 'revisioned' || !configurationContent) throw new Error('Missing revisioned fixture');
            credential = { ...credential, authenticationModeId: 'configured', configurationRevision: 'retained-current' };
            configuration = QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({ target: { kind: 'account', ref: selected },
                authenticationModeId: 'configured', revisionSemantics: 'revisioned', credentialRevision: credential.credentialRevision,
                configurationRevision: 'retained-current', configurationContent });
            // Explicit null must refuse a now-configured row, while an absent
            // retained revision remains absent rather than being replaced/read back.
            await expect.soft(launch.services.connectedAccounts.materialize('provision', materialization, { expectedAccount: selected }))
                .rejects.toBeInstanceOf(Error);
            await expect.soft(noRetainedRevision.services.connectedAccounts.materialize('provision', materialization, { expectedAccount: selected }))
                .resolves.toEqual(material);
            const stale = privateCapability({ ...seed, managedOperation: { ...seed.managedOperation,
                credentialConfigurations: [{ account: selected, revision: 'retained-old' }] } });
            try { await expect.soft(stale.services.connectedAccounts.materialize('provision', materialization, { expectedAccount: selected }))
                .rejects.toBeInstanceOf(Error); } finally { stale.dispose(); }
            expect.soft(() => privateCapability({ ...seed, identity: { ...seed.identity, localId: 'other-action' } }))
                .toThrow(expect.objectContaining({ code: 'plugin_connected_account_binding_out_of_scope' }));
            const retired = privateCapability({ ...seed, isCurrent: () => false });
            const readsBeforeRetirement = credentialReads;
            try { await expect(retired.services.connectedAccounts.materialize('provision', materialization))
                .rejects.toMatchObject({ code: 'plugin_connected_account_binding_unavailable' });
            } finally { retired.dispose(); }
            expect(credentialReads).toBe(readsBeforeRetirement);
            credential = { ...credential, authenticationModeId: 'manual', configurationRevision: null };
            configuration = undefined;
        } finally { launch.dispose(); noRetainedRevision.dispose(); defaultAccount = selected; }
        const { dispatchPluginSurfaceAction } = await import('@/components/plugins/surfaces/pluginSurfaceActionDispatch');
        const dispatch = (fail: boolean, list = false, account = selected, captured = true) => dispatchPluginSurfaceAction({ action: { pluginId: consumerPluginId, localId: 'inspect' },
            input: { account, fail, list }, clientAction: {}, pluginUiProjection: projection,
            ...(captured ? { connectedAccountPurposeBinding: seed } : {}),
            invocationSurface: 'ui', originSurface: 'ui',
            resolveContributedAction: identity => projection.actionsById[`${identity.pluginId}/${identity.localId}`] ?? null,
            hostAction: { execute: createDefaultActionExecutor().execute,
                context: { serverId, expectedAccountId: accountId, surface: 'ui', authority: 'present_user' } } });
        defaultAccount = null;
        // Configured source Actions select their declared operand, without an
        // injected operation lease or a per-Action default. The real host must
        // bind it before listed-account materialization, just as daemon Actions do.
        expect.soft(await dispatch(false, true, selected, false)).toEqual({ ok: true, result: {
            listing: { status: 'complete', accounts: [{ account: selected, displayName: 'selected', state: 'connected',
                connectedAccountOrigins: [], connectedAccountBases: [] }] },
            headers: { Authorization: 'Bearer [REDACTED]' } } });
        const readsBeforeForeignOperand = credentialReads;
        expect.soft(await dispatch(false, true, { service, accountId: 'outside-this-account' }, false)).toMatchObject({ ok: false });
        expect.soft(credentialReads).toBe(readsBeforeForeignOperand);
        defaultAccount = other;
        const listed = await dispatch(false, true);
        expect.soft(listed).toEqual({ ok: true, result: { listing: { status: 'complete', accounts: [{ account: selected,
            displayName: 'selected', state: 'connected', connectedAccountOrigins: [], connectedAccountBases: [] }] },
            headers: { Authorization: 'Bearer [REDACTED]' } } });
        expect.soft(await dispatch(false, true, other)).toMatchObject({ ok: false,
            code: 'unavailable', reason: 'plugin_connected_account_binding_out_of_scope' });
        const returned = await dispatch(false);
        expect.soft(returned).toEqual({ ok: true, result: { headers: { Authorization: 'Bearer [REDACTED]' },
            saved: '[REDACTED]', echo: JSON.stringify({ echoed: '[REDACTED]' }) } });
        const failed = await dispatch(true);
        expect.soft(failed.ok).toBe(false);
        expect.soft(JSON.stringify(failed)).not.toContain(sentinel);
        expect.soft(JSON.stringify(failed)).not.toContain(savedSentinel);
        expect.soft(machineReads, machineReadOrigins.join('\n')).toBe(0);
        expect(machineRpcs).toBe(0);
        expect(packaged.reads).toBe(1);
    } finally { capability.dispose(); }
});

async function runPublicManualJourney(mode: 'plain' | 'e2ee', requireAccountConfiguration = false,
    provider: 'example' | 'vercel' | 'claude' | 'claude-oauth' = 'example') {
    const isVercel = provider === 'vercel';
    const isClaude = provider === 'claude' || provider === 'claude-oauth';
    const modeId = isVercel ? 'token' : provider === 'claude-oauth' ? 'oauth' : isClaude ? 'setup-token' : 'manual';
    const service = isVercel ? inventories.vercel : isClaude ? inventories.claude
        : requireAccountConfiguration ? inventories.staging : inventories.public;
    const { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema } =
        await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
    const { SharedSavedSecretPromoteInputV1Schema, SharedSavedSecretPromoteOutputV1Schema,
        SHARED_SAVED_SECRET_ACTION_PATHS_V1 } = await import('@happier-dev/protocol/account/settings/savedSecretResourceActionsV1');
    const { SavedSecretResourceMaterialV1Schema, SavedSecretResourceMaterialsResponseV1Schema } =
        await import('@happier-dev/protocol/account/settings/savedSecretCatalogV1');
    const { formatSharedSavedSecretRefV1 } = await import('@happier-dev/protocol/account/settings/savedSecretReferenceV1');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createUiConnectedAccountCredentialPersistence } = await import('./connectedAccountCredentialPersistence');
    const accountId = `public-auth-${provider}-${mode}${requireAccountConfiguration ? '-configured' : ''}`;
    const credentials = { token: createAccountTokenForTests(accountId),
        ...(mode === 'e2ee' ? { secret: encodeBase64(new Uint8Array(32).fill(37), 'base64url') } : {}) };
    const url = `https://${accountId}.test`;
    const serverId = await homes.addHome({ name: 'Public auth', serverUrl: url, accountId, credentials,
        accountEncryptionMode: mode, teamsEnabled: true, credentialResourcesEnabled: true });
    homes.answer(serverId, '/v1/account/encryption/currentness', {
        body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials),
    });
    const sentinel = 'public-auth-fixture-sensitive-token';
    const transactions = new Map<string, TransactionRecord>();
    const resources = new Map<string, ReturnType<typeof SavedSecretResourceMaterialV1Schema.parse>>();
    const saved: { current: ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse> | null;
        configuration: ReturnType<typeof QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse> | null } =
        { current: null, configuration: null };
    let promotions = 0;
    let directCredentialWrites = 0;
    let vendorCalls = 0;
    let machineReads = 0;
    let machineRpcs = 0;
    const bootstrapMachineRead = createDeferred<void>();
    const observations: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...values) => { observations.push(values); });
    connection = await restoreServerAccountForTest({ serverUrl: url, accountId, credentials,
        ...(isVercel ? { additionalRequestOrigins: ['https://api.vercel.com'] } : {}),
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string) => {
                if (event.includes('rpc')) { machineRpcs += 1; throw new Error('Portable authentication must not invoke Machine RPC'); }
                return { ok: true };
            });
        },
        request: async (input, init) => {
            const request = new URL(String(input));
            const method = init?.method ?? 'GET';
            if (request.origin === 'https://api.vercel.com') {
                expect(isVercel).toBe(true);
                expect(method).toBe('GET');
                expect(request.pathname).toBe('/v9/projects/prj_fixture');
                expect(request.searchParams.get('teamId')).toBe('team_fixture');
                expect(new Headers(init?.headers).get('authorization') === `Bearer ${sentinel}`).toBe(true);
                vendorCalls += 1;
                return Response.json({ id: 'prj_fixture', accountId: 'team_fixture', name: 'Vercel fixture project' });
            }
            if (request.pathname.startsWith('/v1/machines')) {
                machineReads += 1;
                if (request.pathname === '/v1/machines') bootstrapMachineRead.resolve();
                return Response.json([]);
            }
            const transaction = await answerAttemptTransaction(request, init, transactions);
            if (transaction) return transaction;
            if (request.pathname === '/v4/connect/qualified/accounts') {
                return Response.json({ service, accounts: [] });
            }
            if (request.pathname === '/v4/connect/qualified/credential') {
                if (method === 'GET') return saved.current ? Response.json(saved.current)
                    : Response.json({ error: 'connect_credential_not_found' }, { status: 404 });
                directCredentialWrites += 1;
                throw new Error('Declared manual secrets must commit through atomic Saved Secret promotion');
            }
            if (request.pathname === '/v4/connect/qualified/configuration') {
                expect(method).toBe('GET');
                return saved.configuration ? Response.json(saved.configuration)
                    : Response.json({ error: 'connect_configuration_not_found' }, { status: 404 });
            }
            if (request.pathname === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) {
                const mutation = SharedSavedSecretPromoteInputV1Schema.parse(await new Response(init?.body).json());
                const credential = mutation.connectedAccountCredentialMutation;
                if (!credential) throw new Error('Promotion must atomically carry the connected credential');
                const initialConfiguration = 'initialConfiguration' in credential ? credential.initialConfiguration : undefined;
                promotions += 1;
                const creations = [mutation, ...(mutation.additionalSavedSecretResources ?? [])];
                for (const resource of creations) {
                    const envelope = resource.keyEnvelopes?.find(value => value.recipientAccountId === accountId);
                    resources.set(resource.resourceId, SavedSecretResourceMaterialV1Schema.parse({ resourceId: resource.resourceId,
                        encryptionMode: resource.encryptionMode, storedContent: resource.storedContent,
                        recipientEnvelope: envelope ? { encryptedDataKey: envelope.encryptedDataKey,
                            recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint } : null,
                        entry: { ref: formatSharedSavedSecretRefV1(resource.resourceId), source: 'shared_resource', relationship: 'owner',
                            name: resource.displayName, kind: resource.kind, encryptionMode: resource.encryptionMode,
                            ownerAccountId: accountId, revision: 1, materialStatus: 'ready',
                            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }));
                }
                saved.current = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: credential.ref,
                    authenticationModeId: credential.authenticationModeId, revisionSemantics: 'revisioned',
                    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                    configurationRevision: initialConfiguration ? 'staged-configuration-1' : null,
                    content: credential.content, metadata: credential.metadata });
                if (initialConfiguration) saved.configuration = QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
                    target: { kind: 'account', ref: credential.ref }, authenticationModeId: credential.authenticationModeId,
                    revisionSemantics: 'revisioned', credentialRevision: saved.current.credentialRevision,
                    configurationRevision: saved.current.configurationRevision,
                    configurationContent: initialConfiguration.replacementContentEnvelope,
                });
                expect(credential.savedSecretResourceIds).toEqual([...resources.keys()]);
                return Response.json(SharedSavedSecretPromoteOutputV1Schema.parse({ resourceId: mutation.resourceId, settingsVersion: 0,
                    connectedAccountCredential: { credentialRevision: saved.current.credentialRevision,
                        configurationRevision: saved.current.configurationRevision } }));
            }
            if (request.pathname === '/v1/account/saved-secrets/resources/materials') {
                const resourceId = request.searchParams.get('resourceId');
                return Response.json(SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [...resources.values()]
                    .filter(row => !resourceId || ('resourceId' in row && row.resourceId === resourceId)) }));
            }
            return await homes.request(input, init);
        } });
    await bootstrapMachineRead.promise;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing restored Account lifetime');
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(lifetime.scope);
    if (!isClaude) expect((await reader.ensureCurrentAccountExecution(service.pluginId)).kind).toBe('available');
    const projection = reader.readAccountUiProjection();
    if (!projection) throw new Error('Missing Account projection');
    await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: 'web',
        reader, accountLifetime: lifetime, loaderBackend: createPluginUiCommonJsLoaderBackend() });
    expect(packaged.reads).toBe(0);
    machineReads = 0;
    machineRpcs = 0;
    if (isClaude) {
        const { describeConnectedAccountAuthenticationService } = await import('./connectedAccountDaemon');
        const described = await describeConnectedAccountAuthenticationService({ serverId, expectedAccountId: accountId, service });
        expect(described, JSON.stringify(described)).toMatchObject({ description: { status: 'described' },
            accountAuthenticationModes: { status: 'available', modeIds: ['setup-token'], machineRequiredModeIds: ['oauth'] } });
    }
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: accountId };
    const begin = await createDefaultActionExecutor().execute('connectedServices.authentication.beginConnect', { service, modeId }, context);
    if (provider === 'claude-oauth') {
        // Project only lifecycle facts: assertion diagnostics must not disclose OAuth URLs or state.
        const response = begin.ok ? begin.result as { status?: string; code?: string; attemptId?: string } : null;
        expect({ ok: begin.ok, status: response?.status, code: response?.code }).toEqual({
            ok: true, status: 'unavailable', code: 'connected_account_browser_sign_in_machine_unavailable',
        });
        expect(transactions.size).toBe(0);
        expect(machineReads).toBe(0);
        expect(machineRpcs).toBe(0);
        return;
    }
    expect(begin.ok, JSON.stringify(begin)).toBe(true);
    expect(begin).toMatchObject({ ok: true, result: {
        status: requireAccountConfiguration ? 'configurationRequired' : 'awaitingManual',
    } });
    if (!begin.ok || !begin.result || typeof begin.result !== 'object' || !('attemptId' in begin.result)
        || typeof begin.result.attemptId !== 'string') throw new Error('Missing begun manual attempt');
    const configurationSteps: unknown[] = [];
    expect(vendorCalls).toBe(0);
    if (provider === 'claude') {
        const refused = await createDefaultActionExecutor().execute('connectedServices.authentication.submitManual', {
            attemptId: begin.result.attemptId, fields: { token: '   ' },
        }, context);
        expect(refused, JSON.stringify(refused)).toMatchObject({ ok: true, result: { status: 'rejected',
            diagnostic: { code: 'claude_subscription_setup_token_invalid' } } });
        expect(promotions).toBe(0);
        expect(machineReads).toBe(0);
        expect(machineRpcs).toBe(0);
        return;
    }
    if (isVercel) {
        const pending = await createDefaultActionExecutor().execute('connectedServices.authentication.pending.list', { service }, context);
        configurationSteps.push(pending);
        expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { status: 'pendingAttempts',
            attempts: [expect.objectContaining({ attemptId: begin.result.attemptId, kind: 'manual', modeId,
                phase: 'configurationRequired' })] } });
    }
    if (requireAccountConfiguration) {
        const target = { kind: 'attempt' as const, attemptId: begin.result.attemptId };
        expect(begin).toMatchObject({ result: { target: { ...target, service, modeId }, missingFieldIds: ['teamId'] } });
        const inspected = await createDefaultActionExecutor().execute('connectedServices.configuration.get', { target }, context);
        configurationSteps.push(inspected);
        expect(inspected, JSON.stringify(inspected)).toMatchObject({ ok: true, result: {
            target: { ...target, service, modeId }, mode: { id: modeId, configuration: { scope: 'account' } },
            configuration: { status: 'configurationRequired', revision: null, values: {}, missingFieldIds: ['teamId'], configuredSecretFieldIds: [] },
        } });
        const replaced = await createDefaultActionExecutor().execute('connectedServices.configuration.replace', {
            target, expectedRevision: null, values: { teamId: 'team_fixture', projectId: 'prj_fixture' }, secretValues: {},
        }, context);
        configurationSteps.push(replaced);
        expect(replaced, JSON.stringify(replaced)).toMatchObject({ ok: true, result: { applied: true, revision: expect.any(String) } });
        if (!replaced.ok || typeof replaced.result !== 'object' || !replaced.result || !('revision' in replaced.result)
            || typeof replaced.result.revision !== 'string') throw new Error('Missing staged configuration acknowledgement');
        const continued = await createDefaultActionExecutor().execute('connectedServices.authentication.continueConnect', {
            attemptId: begin.result.attemptId, expectedConfigurationRevision: replaced.result.revision,
        }, context);
        configurationSteps.push(continued);
        expect(continued, JSON.stringify(continued)).toMatchObject({ ok: true, result: { status: 'awaitingManual' } });
        expect(vendorCalls).toBe(0);
    }
    // A new executor must route the admitted attempt from its addressed record.
    const complete = await createDefaultActionExecutor().execute('connectedServices.authentication.submitManual',
        { attemptId: begin.result.attemptId, fields: { token: sentinel } }, context);
    expect(complete, JSON.stringify({ complete, promotions, resourceCount: resources.size, directCredentialWrites }))
        .toMatchObject({ ok: true, result: { status: 'connected' } });
    expect(promotions).toBe(1);
    expect(resources.size).toBe(1);
    expect(directCredentialWrites).toBe(0);
    expect(vendorCalls).toBe(isVercel ? 1 : 0);
    expect(machineReads).toBe(0);
    expect(machineRpcs).toBe(0);
    expect(packaged.reads).toBe(1);
    expect(JSON.stringify([begin, configurationSteps, complete, observations])).not.toContain(sentinel);
    expect(saved.current?.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
    expect([...resources.values()]).toEqual([expect.objectContaining({ encryptionMode: mode })]);
    if (mode === 'e2ee') expect(JSON.stringify([saved.current, ...resources.values()])).not.toContain(sentinel);
    const fresh = await captureLazyActionAccountContext(serverId);
    try {
        const persistence = createUiConnectedAccountCredentialPersistence(fresh);
        if (!saved.current) throw new Error('Credential was not saved');
        const reopened = await persistence.readCredential(saved.current.ref);
        if (!reopened || reopened.authenticationModeId === null) throw new Error('Credential could not be reopened');
        if (isVercel) expect(reopened.metadata.providerIdentity).toMatchObject({ organizationId: 'team_fixture' });
        const { parseQualifiedConnectedAccountCredentialPlaintextV1 } = await import('@happier-dev/protocol/connect/legacyConnectedServiceCompatibility');
        const content = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: reopened.ref,
            authenticationModeId: reopened.authenticationModeId,
            plaintext: persistence.content.open('credential', await persistence.content.resolveAccountMode(), reopened.content),
            metadata: reopened.metadata });
        expect(content.values).not.toHaveProperty('token');
        expect(content.secretRefs?.token).toBeDefined();
        expect(JSON.stringify(content)).not.toContain(sentinel);
        const { readSavedSecretReferencesInContext } = await import('@/sync/api/account/apiSavedSecretCatalog');
        const references = Object.values(content.secretRefs ?? {});
        expect(references).toHaveLength(1);
        const opened = await readSavedSecretReferencesInContext(fresh, references);
        expect(opened.ok).toBe(true);
        if (!opened.ok) throw new Error('Promoted Saved Secret could not be reopened');
        expect(opened.values.get(references[0]!)?.value === sentinel).toBe(true);
        if (requireAccountConfiguration) {
            const configuration = await persistence.readConfiguration(reopened.ref);
            if (!configuration) throw new Error('Staged account configuration was not committed');
            expect(persistence.content.open('configuration', await persistence.content.resolveAccountMode(),
                configuration.configurationContent)).toMatchObject({ values: { teamId: 'team_fixture', projectId: 'prj_fixture' }, secretRefs: {} });
        }
    } finally { fresh.dispose(); }
}

it.each(['plain', 'e2ee'] as const)('activates the public author example and promotes its manual secret through fresh no-Machine Actions (%s)',
    async mode => runPublicManualJourney(mode));

it('stages generic required account configuration through fresh no-Machine Actions before manual settlement',
    async () => runPublicManualJourney('plain', true));

it('connects actual Vercel Account authentication through pending and staged configuration without a Machine',
    async () => runPublicManualJourney('plain', true, 'vercel'));

it.each(['plain', 'e2ee'] as const)('opens actual Claude setup-token input and refuses an empty dummy without a Machine (%s)',
    async mode => runPublicManualJourney(mode, false, 'claude'));

it.each(['plain', 'e2ee'] as const)('refuses actual Claude browser OAuth without a Machine before creating an attempt (%s)',
    async mode => runPublicManualJourney(mode, false, 'claude-oauth'));

it.each([{ mode: 'plain', surface: 'ui' }, { mode: 'e2ee', surface: 'agent' }] as const)(
    'restores the generic device Account host after disposing its actual registration ($mode, $surface)', async ({ mode, surface }) => {
    const service = inventories.device;
    const { DEVICE_AUTHENTICATION_VENDOR_ORIGIN } = await import('@/dev/testkit/fixtures/connectedAccountDeviceAuthentication');
    const { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema,
        QualifiedConnectedAccountCredentialMutationSuccessV4Schema } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createUiConnectedAccountCredentialPersistence } = await import('./connectedAccountCredentialPersistence');
    const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
    const accountId = `generic-device-${mode}`;
    const credentials = { token: createAccountTokenForTests(accountId),
        ...(mode === 'e2ee' ? { secret: encodeBase64(new Uint8Array(32).fill(41), 'base64url') } : {}) };
    const url = `https://generic-device-${mode}.test`;
    const serverId = await homes.addHome({ name: 'Generic device', serverUrl: url, accountId, credentials, accountEncryptionMode: mode });
    homes.answer(serverId, '/v1/account/encryption/currentness', {
        body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials),
    });
    const deviceSentinel = 'private-device-authorization-fixture-code';
    const credentialSentinel = 'private-device-credential-fixture-token';
    const transactions = new Map<string, TransactionRecord>();
    const saved: { current: ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse> | null } = { current: null };
    let vendorBegins = 0;
    let vendorPolls = 0;
    let credentialWrites = 0;
    let machineReads = 0;
    let machineRpcs = 0;
    let markMachineBootstrapRead!: () => void;
    const machineBootstrapRead = new Promise<void>(resolve => { markMachineBootstrapRead = resolve; });
    const addressedReads: { path: string; vendorPolls: number }[] = [];
    const transactionTransitions: { method: string; vendorPolls: number }[] = [];
    const observations: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...values) => { observations.push(values); });
    connection = await restoreServerAccountForTest({ serverUrl: url, accountId, credentials,
        additionalRequestOrigins: [DEVICE_AUTHENTICATION_VENDOR_ORIGIN],
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string) => {
                if (event.includes('rpc')) { machineRpcs += 1; throw new Error('Account authentication must not invoke Machine RPC'); }
                return { ok: true };
            });
        },
        request: async (input, init) => {
            const request = new URL(String(input));
            const method = init?.method ?? 'GET';
            if (request.origin === DEVICE_AUTHENTICATION_VENDOR_ORIGIN) {
                if (request.pathname === '/device') {
                    vendorBegins += 1;
                    return Response.json({ device_code: deviceSentinel, user_code: 'DEVICE-EXAMPLE',
                        verification_uri: `${DEVICE_AUTHENTICATION_VENDOR_ORIGIN}/verify`, expires_in: 600, interval: 1 });
                }
                if (request.pathname === '/token') {
                    const body = await new Response(init?.body).json() as { device_code?: unknown };
                    expect(body.device_code === deviceSentinel).toBe(true);
                    vendorPolls += 1;
                    return Response.json(vendorPolls < 3 ? { status: 'pending', retry_after_ms: 1_000 }
                        : { status: 'connected', access_token: credentialSentinel });
                }
                throw new Error('Unexpected synthetic vendor route');
            }
            if (request.pathname.startsWith('/v1/machines')) {
                machineReads += 1;
                const response = Response.json([]);
                if (request.pathname === '/v1/machines') markMachineBootstrapRead();
                return response;
            }
            if (method === 'GET' && request.pathname.startsWith('/v2/connect/connected-account-attempt-transactions/')) {
                addressedReads.push({ path: request.pathname, vendorPolls });
            }
            if (method !== 'GET' && request.pathname.startsWith('/v2/connect/connected-account-attempt-transactions/')) {
                transactionTransitions.push({ method, vendorPolls });
            }
            const transaction = await answerAttemptTransaction(request, init, transactions);
            if (transaction) return transaction;
            if (request.pathname === '/v4/connect/qualified/credential') {
                if (method === 'GET') return saved.current ? Response.json(saved.current)
                    : Response.json({ error: 'connect_credential_not_found' }, { status: 404 });
                const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(await new Response(init?.body).json());
                credentialWrites += 1;
                saved.current = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: mutation.ref,
                    authenticationModeId: mutation.authenticationModeId, revisionSemantics: 'revisioned',
                    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null,
                    content: mutation.content, metadata: mutation.metadata });
                return Response.json(QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse({ success: true,
                    credentialRevision: saved.current.credentialRevision, configurationRevision: null }));
            }
            return homes.request(input, init);
        } });
    await machineBootstrapRead;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing restored device Account lifetime');
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(lifetime.scope);
    expect((await reader.ensureCurrentAccountExecution(service.pluginId)).kind).toBe('available');
    const projection = reader.readAccountUiProjection();
    if (!projection) throw new Error('Missing device Account projection');
    const executableInput = { actionProjection: { projection }, platform: 'web' as const,
        reader, accountLifetime: lifetime, loaderBackend: createPluginUiCommonJsLoaderBackend() };
    await reconcileProjectedPluginUiClientExecutables(executableInput);
    expect(packaged.reads).toBe(0);
    machineReads = 0;
    machineRpcs = 0;
    const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const,
        serverId, expectedAccountId: accountId };
    let approvals = 0;
    const executor = () => createDefaultActionExecutor({ onBlockingApprovalPending: async ({ artifactId }) => {
        approvals += 1;
        expect(vendorPolls).toBe(0);
        expect(await decideApprovalAsInbox(serverId, artifactId, 'approve')).toMatchObject({ ok: true });
    } });
    if (surface === 'agent') {
        const { PUBLIC_ACTION_OUTPUT_SCHEMAS } = await import('@happier-dev/protocol/actions/actionSpecs');
        for (const id of ['connectedServices.authentication.beginConnect', 'connectedServices.authentication.pollDevice']) {
            const discovery = await executor().execute('action.spec.get', { id }, context);
            expect(discovery).toMatchObject({ ok: true });
            if (!discovery.ok) throw new Error('Device authentication Action was not discoverable');
            expect(PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(discovery.result).actionSpec).not.toBeNull();
        }
    }
    const begin = await executor().execute('connectedServices.authentication.beginConnect', { service, modeId: 'device' }, {
        ...context, actionRequestId: `generic-device-begin-${mode}`,
    });
    expect(begin.ok, JSON.stringify(begin)).toBe(true);
    expect(begin).toMatchObject({ ok: true, result: { status: 'awaitingDeviceAuthorization' } });
    if (!begin.ok || !begin.result || typeof begin.result !== 'object' || !('attemptId' in begin.result)
        || typeof begin.result.attemptId !== 'string') throw new Error('Missing begun device attempt');
    const attemptId = begin.result.attemptId;
    expect(vendorBegins).toBe(1);
    expect(approvals).toBe(surface === 'agent' ? 1 : 0);
    expect(packaged.reads).toBe(1);
    expect(transactions.size).toBe(1);
    expect(transactions.get(attemptId)).toMatchObject({ kind: 'device' });
    expect(transactions.get(attemptId)?.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
    if (mode === 'e2ee') expect(JSON.stringify(transactions.get(attemptId))).not.toContain(deviceSentinel);
    const pending = await executor().execute('connectedServices.authentication.pending.list', { service }, context);
    expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { status: 'pendingAttempts',
        attempts: [expect.objectContaining({ attemptId, kind: 'device', modeId: 'device' })] } });
    expect(approvals).toBe(surface === 'agent' ? 1 : 0);
    await getInstalledPluginUiClientExecutableComposition().unload();
    expect(transactions.has(attemptId)).toBe(true);
    await reconcileProjectedPluginUiClientExecutables(executableInput);
    addressedReads.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    const outcomes: unknown[] = [];
    for (let index = 0; index < 3; index += 1) {
        vi.setSystemTime(Date.now() + 10_000);
        const readsBefore = addressedReads.length;
        const transitionsBefore = transactionTransitions.length;
        const pollsBefore = vendorPolls;
        const outcome = await executor().execute('connectedServices.authentication.pollDevice', { attemptId }, context);
        outcomes.push(outcome);
        expect(outcome, JSON.stringify({ outcome, persisted: transactions.has(attemptId),
            addressedReads: addressedReads.length - readsBefore, vendorPolls })).toMatchObject({ ok: true,
            result: { status: index < 2 ? 'pending' : 'connected' } });
        const reads = addressedReads.slice(readsBefore);
        const transitions = transactionTransitions.slice(transitionsBefore);
        // Routing supplies restoration's record before the provider callback.
        // Existing acknowledge/clear CAS reads happen after that callback.
        expect(reads.filter(read => read.vendorPolls === pollsBefore)).toHaveLength(1);
        expect(reads.filter(read => read.vendorPolls !== pollsBefore)
            .every(read => read.vendorPolls === pollsBefore + 1)).toBe(true);
        expect(transitions.every(transition => transition.vendorPolls === pollsBefore + 1)).toBe(true);
        expect(reads.filter(read => read.vendorPolls === pollsBefore + 1)).toHaveLength(transitions.length);
        if (index < 2) expect(transitions).toEqual([{ method: 'PATCH', vendorPolls: pollsBefore + 1 }]);
    }
    expect(addressedReads.length).toBeGreaterThan(0);
    expect(new Set(addressedReads.map(read => read.path))).toEqual(new Set([`/v2/connect/connected-account-attempt-transactions/${encodeURIComponent(attemptId)}`]));
    expect(vendorBegins).toBe(1);
    expect(vendorPolls).toBe(3);
    expect(credentialWrites).toBe(1);
    expect(machineReads).toBe(0);
    expect(machineRpcs).toBe(0);
    expect(approvals).toBe(surface === 'agent' ? 1 : 0);
    for (const sentinel of [deviceSentinel, credentialSentinel]) expect(JSON.stringify([begin, pending, outcomes, observations])).not.toContain(sentinel);
    expect(saved.current?.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
    if (mode === 'e2ee') for (const sentinel of [deviceSentinel, credentialSentinel]) {
        expect(JSON.stringify([saved.current, ...transactions.values()])).not.toContain(sentinel);
    }
    const fresh = await captureLazyActionAccountContext(serverId);
    try {
        const persistence = createUiConnectedAccountCredentialPersistence(fresh);
        if (!saved.current) throw new Error('Device credential was not saved');
        const reopened = await persistence.readCredential(saved.current.ref);
        if (!reopened || reopened.authenticationModeId === null) throw new Error('Device credential could not be reopened');
        const { parseQualifiedConnectedAccountCredentialPlaintextV1 } = await import('@happier-dev/protocol/connect/legacyConnectedServiceCompatibility');
        const payload = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: reopened.ref,
            authenticationModeId: reopened.authenticationModeId,
            plaintext: persistence.content.open('credential', await persistence.content.resolveAccountMode(), reopened.content), metadata: reopened.metadata });
        expect(payload.values.accessToken === credentialSentinel).toBe(true);
        expect(payload.values).not.toHaveProperty('deviceCode');
    } finally { fresh.dispose(); }
});
