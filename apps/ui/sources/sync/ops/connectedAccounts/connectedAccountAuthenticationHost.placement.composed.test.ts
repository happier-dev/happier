import { afterEach, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';

const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));
// Native HTTP resolution must load the real Expo platform branch. No HTTP
// request is expected while an authorization-code attempt only builds its URL.
vi.mock('expo/fetch', () => ({ fetch: () => { throw new Error('Unexpected native HTTP request'); } }));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
// Packaged bytes and native asset IO are external boundaries; compilation,
// admission, registration, Actions, persistence and RPC routing stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    get BUNDLED_PLUGIN_UI_APP_ARTIFACTS() { return packaged.artifacts; },
    get BUNDLED_PLUGIN_UI_APP_DECLARATIONS() { return packaged.declarations; },
    BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({ localUri: `file:///placement/${asset}`, downloadAsync: async () => {} }) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private readonly uri: string) {}
    async bytes() {
        packaged.reads += 1;
        const bytes = packaged.files.get(Number(this.uri.split('/').at(-1)));
        if (!bytes) throw new Error('Missing authentication artifact');
        return bytes;
    }
} }));
vi.mock('expo-crypto', async original => ({ ...await original<typeof import('expo-crypto')>(),
    randomUUID: (await import('node:crypto')).randomUUID }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const [{ prepareAuthenticationInventory, answerAttemptTransaction }, { PLUGIN_MANIFEST },
    { createDefaultActionExecutor }, { captureLazyActionAccountContext },
    { createUiConnectedAccountAuthenticationHost }] = await Promise.all([
    import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
    import('../../../../../../packages/plugins/claude/src/manifest'),
    import('@/sync/ops/actions/defaultActionExecutor'),
    import('@/sync/ops/actions/actionAccountContext'),
    import('./connectedAccountAuthenticationHost'),
]);
const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(value => value.id === 'claude-subscription');
const target = descriptor?.authentication.account;
if (!descriptor || !target) throw new Error('Actual Claude Account artifact is missing');
await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST, target,
    projectPath: 'packages/plugins/claude', entryPath: 'packages/plugins/claude/src/connectedAccounts/account.ts',
    packageName: '@happier-dev/plugins-claude' });
const service = { pluginId: PLUGIN_MANIFEST.id, localId: descriptor.id };
const { Platform } = await import('react-native');
const platformDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

afterEach(async () => {
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    await getInstalledPluginUiClientExecutableComposition().unload();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    vi.restoreAllMocks();
    packaged.reads = 0;
    Object.defineProperty(Platform, 'OS', platformDescriptor);
});

async function restorePlacementAccount(input: Readonly<{
    service?: typeof service; modeId?: string; kind?: 'manual';
    machineId?: string; supportsAuthentication?: boolean; guestRole?: 'use' | 'manage';
}> = {}) {
    const selectedService = input.service ?? service;
    const modeId = input.modeId ?? 'oauth';
    const accountId = 'claude-placement';
    const credentials = { token: createAccountTokenForTests(accountId) };
    const url = 'https://claude-placement.test';
    const serverId = await homes.addHome({ name: 'Claude placement', serverUrl: url, accountId, credentials, accountEncryptionMode: 'plain' });
    const { QualifiedConnectedAccountCredentialSnapshotV4Schema } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
    const account = { service: selectedService, accountId: 'subscription' };
    const credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId: modeId,
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null,
        content: { t: 'plain', v: {} }, metadata: {} });
    const transactions: Parameters<typeof answerAttemptTransaction>[2] = new Map();
    const outgoing: SocketRpcRequestPayload[] = [];
    let continuationUnavailable = false;
    const bootstrap = createDeferred<void>();
    let vendorRequests = 0;
    let machineReads = 0;
    const publishedMachine = input.machineId ? { ...createPlainMachineRowFixture({ id: input.machineId, accountId }),
        ...(input.supportsAuthentication ? { operationProtocolCapabilities: { connectedAccountAuthentication: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } : {}) } : null;
    if (publishedMachine && input.guestRole) {
        publishedMachine.access = { custodian: { accountId: 'machine-custodian', displayName: 'Machine custodian' },
            role: input.guestRole, resourceMode: 'plain', accessState: 'ready' };
    }
    connection = await restoreServerAccountForTest({ serverUrl: url, accountId, credentials,
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'timeout').mockReturnValue(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
                if (event.includes('rpc')) {
                    outgoing.push(payload);
                    if (payload.method.endsWith(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD)) {
                        const { ConnectedAccountDaemonControlResponseSchema } = await import('@happier-dev/protocol/connect/connectedAccountDaemonRpcV1');
                        const captured = await captureLazyActionAccountContext(serverId);
                        try {
                            const declared = (await import('@/sync/domains/connectedServices/accountDeclarations'))
                                .readUiAccountConnectedServiceDeclarations(captured.accountLifetime)
                                .find(value => value.service.pluginId === selectedService.pluginId && value.service.localId === selectedService.localId);
                            if (!declared) throw new Error('Missing fixture service declaration');
                            return { ok: true, result: ConnectedAccountDaemonControlResponseSchema.parse({ status: 'described',
                                service: selectedService, descriptor: declared.descriptor, accounts: [], occurrenceId: declared.occurrenceId,
                                sourceCustody: declared.sourceCustody }) };
                        } finally { captured.dispose(); }
                    }
                    const { ConnectedAccountAuthenticationCommandRequestSchema, ConnectedAccountAttemptResponseSchema } =
                        await import('@happier-dev/protocol/connect/connectedAccountDaemonRpcV1');
                    const request = ConnectedAccountAuthenticationCommandRequestSchema.parse(payload.params);
                    if (request.command.operation === 'read' && continuationUnavailable) return { ok: true,
                        result: ConnectedAccountAttemptResponseSchema.parse({ status: 'unavailable',
                            code: 'target_unavailable', attemptId: 'machine-attempt' }) };
                    if (request.command.operation === 'beginConnect' || request.command.operation === 'beginReconnect') {
                        const { createNativeAttemptAddressBoundary } = await import('@/dev/testkit/fixtures/connectedAccountAuthentication');
                        const captured = await captureLazyActionAccountContext(serverId);
                        try {
                            const address = await createNativeAttemptAddressBoundary(captured, request.machineId);
                            await address.acknowledge({ attemptId: 'machine-attempt', kind: input.kind ?? 'oauth',
                                phase: input.kind === 'manual' ? 'awaitingManual' : 'awaitingOAuth',
                                createdAtMs: Date.now(), intent: request.command.operation === 'beginConnect' ? 'connect' : 'reconnect',
                                service: selectedService, modeId });
                        } finally { captured.dispose(); }
                    }
                    if (input.kind === 'manual') return { ok: true, result: ConnectedAccountAttemptResponseSchema.parse({
                        status: 'awaitingManual', attemptId: 'machine-attempt' }) };
                    return { ok: true, result: ConnectedAccountAttemptResponseSchema.parse({ status: 'awaitingOAuth',
                        attemptId: 'machine-attempt', authorizationUrl: 'https://authorization.fixture.test/authorize',
                        callbackUrl: 'https://callback.fixture.test/return' }) };
                }
                return { ok: true };
            });
        },
        request: async (input, init) => {
            const request = new URL(String(input));
            if (request.origin !== url) { vendorRequests += 1; return new Response('{}', { status: 503 }); }
            if (request.pathname === '/v1/machines') { bootstrap.resolve(); return Response.json(publishedMachine ? [publishedMachine] : []); }
            const machine = createPlainMachineReadHttpResponseFixture(request.pathname, init, accountId);
            if (machine) { machineReads += 1; return machine; }
            const transaction = await answerAttemptTransaction(request, init, transactions);
            if (transaction) return transaction;
            if (request.pathname === '/v4/connect/qualified/credential') return Response.json(credential);
            return homes.request(input, init);
        },
    });
    await bootstrap.promise;
    if (input.machineId) {
        const { storage } = await import('@/sync/domains/state/storage');
        await vi.waitFor(() => expect(storage.getState().machines[input.machineId!]).toBeDefined());
    }
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    const { reconcileProjectedPluginUiClientExecutables } = await import('@/components/plugins/reactNative/clientExecutableActivation');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing restored Account');
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(lifetime.scope);
    const projection = reader.readAccountUiProjection();
    if (!projection) throw new Error('Missing Claude projection');
    const { resolvePluginUiClientExecutablePlatform } = await import('@/sync/domains/plugins/ui/projection');
    await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: resolvePluginUiClientExecutablePlatform(),
        reader, accountLifetime: lifetime, loaderBackend: createPluginUiCommonJsLoaderBackend() });
    return { serverId, accountId, account, transactions, outgoing, vendorRequests: () => vendorRequests, machineReads: () => machineReads,
        makeContinuationUnavailable() { continuationUnavailable = true; },
        context: { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: accountId } };
}

it('classifies actual Claude browser OAuth before starting an attempt', async () => {
    const fixture = await restorePlacementAccount();
    const account = await captureLazyActionAccountContext(fixture.serverId);
    try {
        expect(await createUiConnectedAccountAuthenticationHost(account).readAccountAuthenticationModes(service)).toMatchObject({
            status: 'available', modeIds: ['setup-token'], machineRequiredModeIds: ['oauth'],
        });
        expect(fixture.transactions.size).toBe(0);
        expect(fixture.vendorRequests()).toBe(0);
    } finally { account.dispose(); }
});

it('keeps actual Claude portable OAuth local on a native HTTP host without a Machine', async () => {
    // RuntimeFetch is loaded with the Home harness. Change its existing OS
    // adapter object so the native path cannot be hidden by a later module mock.
    Object.defineProperty(Platform, 'OS', { ...platformDescriptor, value: 'ios' });
    expect(await (await import('@/utils/system/runtimeFetch')).readRuntimeFetchHost('https://native.fixture.test')).toBe('native');
    const fixture = await restorePlacementAccount();
    const captured = await captureLazyActionAccountContext(fixture.serverId);
    try {
        const host = createUiConnectedAccountAuthenticationHost(captured);
        expect(await host.readAccountAuthenticationModes(service)).toMatchObject({ status: 'available', modeIds: ['setup-token', 'oauth'] });
        const result = await createDefaultActionExecutor().execute('connectedServices.authentication.beginConnect', { service, modeId: 'oauth' }, fixture.context);
        const response = result.ok && result.result && typeof result.result === 'object' ? result.result : {};
        expect({ ok: result.ok, status: 'status' in response ? response.status : undefined }).toEqual({ ok: true, status: 'awaitingOAuth' });
        expect([...fixture.transactions.values()].map(value => ({ machineId: value.scope.machineId, modeId: value.scope.modeId })))
            .toEqual([{ machineId: undefined, modeId: 'oauth' }]);
        expect(fixture.outgoing.length).toBe(0);
        expect(fixture.machineReads()).toBe(0);
        expect(fixture.vendorRequests()).toBe(0);
    } finally { captured.dispose(); }
});

it('keeps browser-allowed Claude setup-token local without reading a Machine projection', async () => {
    const fixture = await restorePlacementAccount();
    const captured = await captureLazyActionAccountContext(fixture.serverId);
    try {
        const result = await createUiConnectedAccountAuthenticationHost(captured).authenticationCommand('unrelated-machine', {
            operation: 'beginConnect', service, modeId: 'setup-token',
        });
        expect(result.status).toBe('awaitingManual');
        expect(fixture.outgoing).toEqual([]);
        expect(fixture.machineReads()).toBe(0);
        expect([...fixture.transactions.values()].map(value => value.scope.machineId)).toEqual([undefined]);
    } finally { captured.dispose(); }
});

it.each(['beginConnect', 'beginReconnect'] as const)('refuses Claude %s without a Machine before creating an attempt', async operation => {
    const fixture = await restorePlacementAccount();
    const input = operation === 'beginConnect' ? { service, modeId: 'oauth' } : { account: fixture.account };
    const result = await createDefaultActionExecutor().execute(operation === 'beginConnect'
        ? 'connectedServices.authentication.beginConnect' : 'connectedServices.authentication.beginReconnect', input, fixture.context);
    const response = result.ok && result.result && typeof result.result === 'object' ? result.result : {};
    // Project lifecycle facts so a failing assertion never prints OAuth URLs or state.
    expect({ ok: result.ok, status: 'status' in response ? response.status : undefined,
        code: 'code' in response ? response.code : undefined }).toEqual({ ok: true, status: 'unavailable',
        code: 'connected_account_browser_sign_in_machine_unavailable' });
    expect(fixture.transactions.size).toBe(0);
    expect(fixture.vendorRequests()).toBe(0);
    expect(fixture.outgoing.length).toBe(0);
});

it.each(['beginConnect', 'beginReconnect'] as const)('refuses Claude %s on a Machine without the authentication operation before issuing RPC', async operation => {
    // Inspected predecessor 1321319f311d has neither connected-account RPC method nor this capability projection.
    const fixture = await restorePlacementAccount({ machineId: 'old-machine' });
    const result = await createDefaultActionExecutor().execute(operation === 'beginConnect'
        ? 'connectedServices.authentication.beginConnect' : 'connectedServices.authentication.beginReconnect',
    operation === 'beginConnect' ? { service, modeId: 'oauth', machineId: 'old-machine' }
        : { account: fixture.account, machineId: 'old-machine' }, fixture.context);
    const response = result.ok && result.result && typeof result.result === 'object' ? result.result : {};
    expect({ ok: result.ok, status: 'status' in response ? response.status : undefined,
        code: 'code' in response ? response.code : undefined }).toEqual({ ok: true, status: 'unavailable', code: 'cli_update_required' });
    expect(fixture.outgoing).toEqual([]);
    expect(fixture.transactions.size).toBe(0);
    expect(fixture.vendorRequests()).toBe(0);
});

it.each([
    { operation: 'beginConnect', role: 'use' }, { operation: 'beginConnect', role: 'manage' },
    { operation: 'beginReconnect', role: 'use' }, { operation: 'beginReconnect', role: 'manage' },
] as const)('refuses Claude $operation through a capable shared $role Machine before dispatch', async ({ operation, role }) => {
    const machineId = 'shared-executor';
    const fixture = await restorePlacementAccount({ machineId, supportsAuthentication: true, guestRole: role });
    const result = await createDefaultActionExecutor().execute(operation === 'beginConnect'
        ? 'connectedServices.authentication.beginConnect' : 'connectedServices.authentication.beginReconnect',
    operation === 'beginConnect' ? { service, modeId: 'oauth', machineId } : { account: fixture.account, machineId }, fixture.context);
    const response = result.ok && result.result && typeof result.result === 'object' ? result.result : {};
    expect({ ok: result.ok, status: 'status' in response ? response.status : undefined,
        code: 'code' in response ? response.code : undefined }).toEqual({ ok: true, status: 'unavailable', code: 'custodian_only' });
    expect(fixture.outgoing).toEqual([]);
    expect(fixture.transactions.size).toBe(0);
    expect(fixture.vendorRequests()).toBe(0);
    expect(fixture.machineReads()).toBe(0);
});

it.each(['beginConnect', 'beginReconnect'] as const)('routes Claude %s and its addressed continuation through the selected Machine', async operation => {
    const machineId = 'oauth-executor';
    const fixture = await restorePlacementAccount({ machineId, supportsAuthentication: true });
    const input = operation === 'beginConnect' ? { service, modeId: 'oauth', machineId } : { account: fixture.account, machineId };
    const result = await createDefaultActionExecutor().execute(operation === 'beginConnect'
        ? 'connectedServices.authentication.beginConnect' : 'connectedServices.authentication.beginReconnect', input, fixture.context);
    const response = result.ok && result.result && typeof result.result === 'object' ? result.result : {};
    expect({ ok: result.ok, status: 'status' in response ? response.status : undefined }).toEqual({ ok: true, status: 'awaitingOAuth' });
    expect(fixture.outgoing.map(value => value.method)).toEqual([`${machineId}:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`]);
    expect([...fixture.transactions.values()].map(value => ({ machineId: value.scope.machineId, intent: value.scope.intent })))
        .toEqual([{ machineId, intent: operation === 'beginConnect' ? 'connect' : 'reconnect' }]);
    const captured = await captureLazyActionAccountContext(fixture.serverId);
    try {
        // Continuations use their retained address even if support is no longer advertised.
        const { storage } = await import('@/sync/domains/state/storage');
        const current = storage.getState().machines[machineId]!;
        storage.getState().applyMachines([{ ...current, operationProtocolCapabilities: null }]);
        if (operation === 'beginReconnect') fixture.makeContinuationUnavailable();
        const continued = await createUiConnectedAccountAuthenticationHost(captured).authenticationCommand('new-selection', {
            operation: 'read', attemptId: 'machine-attempt',
        });
        expect(continued.status).toBe(operation === 'beginReconnect' ? 'unavailable' : 'awaitingOAuth');
        if (operation === 'beginReconnect') expect(continued).toEqual({ status: 'unavailable', code: 'target_unavailable', attemptId: 'machine-attempt' });
        expect(fixture.outgoing.map(value => value.method)).toEqual([
            `${machineId}:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`, `${machineId}:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`,
        ]);
        expect(fixture.vendorRequests()).toBe(0);
    } finally { captured.dispose(); }
});
