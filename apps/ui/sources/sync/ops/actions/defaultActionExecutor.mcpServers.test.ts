import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createDeferred, renderHook } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { encodeBase64 } from '@/encryption/base64';
import { McpServerCatalogRowMutationV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginProjectionV2Schema, buildDeferredDaemonProjectionSections,
    DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { parseMcpServerImportV1 } from '@happier-dev/protocol/mcp/servers/import/parseMcpServerImportV1';
import { act } from 'react-test-renderer';
import { ConnectedAccountDaemonControlResponseSchema, ConnectedAccountAttemptResponseSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';

const projectionRpc = vi.hoisted(() => vi.fn());
// The daemon RPC is the boundary; projection admission, adaptation and the Action remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: projectionRpc,
}));

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
// Native/navigation and network/credential persistence are the substituted
// boundaries. Account context, storage, catalog and Action owners remain real.
installApprovalCommonModuleMocks({ storage: original => original(), reactNavigation: async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock() });
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { useWhereItsOnNames } = await import('@/components/capabilities/where/useWhereItsOnNames');
const { useMcpServerTools } = await import('@/components/settings/mcpServers/tools/useMcpServerTools');
const { describeMcpToolAgents } = await import('@/components/settings/mcpServers/tools/McpServerToolsSection');
const { resolveUiAccountActionFallbackMachineId } = await import('./accountActionDeps');
const { observeMcpServerCatalog, refreshMcpServerCatalog, resetMcpServerCatalogEngineForTests } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { getMcpServerCatalogSnapshot, resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const initialState = getStorage().getState();
const credentialWrites: Array<NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>> = [];
afterEach(async () => {
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
    invalidateAccountEncryptionModeCache();
    resetServerFeaturesClientForTests();
    getStorage().setState(initialState, true);
    clearDaemonMergedProjectionCacheForTests();
    projectionRpc.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const write of credentialWrites.splice(0).reverse()) await write.rollback();
});

const toolFactsProjection = PluginProjectionV2Schema.parse({
    ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
    installedPackagesById: { 'acme.mcp-facts': { id: 'acme.mcp-facts', displayName: 'MCP facts', version: '1.0.0',
        enabled: true, source: { kind: 'path', locator: '/plugins/acme.mcp-facts' } } },
    agentsById: {
        'acme.mcp-facts/native': { id: 'acme.mcp-facts/native', identity: { pluginId: 'acme.mcp-facts', localId: 'native' },
            title: 'Native Agent', capabilities: { tools: { delivery: 'native_mcp',
                mcpToolControl: { off: 'hidden', approval: 'native' }, mcpToolLoading: 'on_demand' } } },
        'acme.mcp-facts/host': { id: 'acme.mcp-facts/host', identity: { pluginId: 'acme.mcp-facts', localId: 'host' },
            title: 'Host Agent', capabilities: { tools: { delivery: 'native_extension',
                mcpToolControl: { off: 'blocked', approval: 'host' } } } },
        'acme.mcp-facts/unproven': { id: 'acme.mcp-facts/unproven', identity: { pluginId: 'acme.mcp-facts', localId: 'unproven' },
            title: 'Unproven Agent', capabilities: { tools: { delivery: 'shell_bridge' } } },
        'acme.mcp-facts/no-tools': { id: 'acme.mcp-facts/no-tools', identity: { pluginId: 'acme.mcp-facts', localId: 'no-tools' },
            title: 'Agent without tools', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        'acme.mcp-facts/undeclared': { id: 'acme.mcp-facts/undeclared', identity: { pluginId: 'acme.mcp-facts', localId: 'undeclared' },
            title: 'Unavailable declaration' },
    },
});

async function prepareToolFactsHome(includeMachine = true, installedAgentIds = Object.keys(toolFactsProjection.agentsById),
    onCatalogRead?: () => void, maintenanceReady?: Promise<void>, catalogState?: Readonly<{
        revision?: () => number; catalog?: () => McpServerCatalogV1; mode?: () => 'plain' | 'e2ee';
        row?: () => unknown; settings?: () => Readonly<Record<string, unknown>>;
    }>) {
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_mcp_tool_facts', canonicalServerUrl: 'https://mcp-tool-facts.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://mcp-tool-facts.test' }] } });
    await setActiveServerId(home.id);
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'tool-owner' })), 'base64url')}.signature`;
    const write = await TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: home.id }, { token });
    if (!write) throw new Error('Test Home credentials unavailable');
    credentialWrites.push(write);
    const machines = includeMachine ? [createMachineFixture({ id: 'facts-machine', activeAt: Date.now(),
        access: { custodian: { accountId: 'tool-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: Date.now(), installedAgentIds } } })] : [];
    // These rows arrive from a live Machine response, rather than a warm hydration.
    for (const machine of machines) publishMachineActivity(machine, machine, []);
    getStorage().setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [home.id]: machines }, machineListStatusByServerId: { [home.id]: 'idle' } });
    if (includeMachine) expect(resolveUiAccountActionFallbackMachineId({ serverId: home.id, accountId: 'tool-owner' })).toBe('facts-machine');
    setRuntimeFetch(async url => {
        const target = new URL(String(url));
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        expect(target.origin).toBe(home.serverUrl);
        if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (target.pathname === '/v1/account/encryption') return Response.json({ mode: catalogState?.mode?.() ?? 'plain', updatedAt: 0 });
        if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
        if (target.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: catalogState?.settings?.() ?? {} }, version: 7 });
        if (target.pathname === '/v1/account/entity-rows/mcp') {
            onCatalogRead?.();
            if (catalogState?.row) return Response.json(catalogState.row());
            return Response.json({ status: 'present', revision: catalogState?.revision?.() ?? 3,
                content: { t: 'plain', v: catalogState?.catalog?.() ?? { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
                    stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] } } });
        }
        if (target.pathname === '/v1/account/entity-rows/profiles/transfer') {
            await maintenanceReady;
            return Response.json({ status: 'absent' });
        }
        if (target.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
        return Response.json({ error: 'not_found' }, { status: 404 });
    });
    return home;
}

describe('UI MCP per-Agent tool facts', () => {
    it.each([
        { code: 'client_refused', view: { state: 'client_refused' } },
        { code: 'mcp_oauth_discovery_failed', view: { state: 'did_not_finish', diagnosticCode: 'mcp_oauth_discovery_failed' } },
    ])('retains $code across a configuration-only grant echo', async ({ code, view }) => {
        const server = { id: 'server', name: 'server', transport: 'http' as const,
            remote: { url: 'https://mcp.fixture.test/mcp', headers: {}, auth: { kind: 'oauth' as const } },
            env: {}, createdAt: 1, updatedAt: 1 };
        const home = await prepareToolFactsHome(true, [], undefined, undefined,
            { catalog: () => ({ v: 1, bindings: [], servers: [server] }) });
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(home.id), accountId: 'tool-owner' };
        const profile = (configurationRevision: string) => QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1, accountId: server.id }, status: 'connected',
            kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true, configurationRevision,
            revisionSemantics: 'revisioned', credentialRevision: 'csr_1234567890123456789012', scopes: ['read'],
        });
        let configurationRevision = 'configuration-1';
        const publishGrant = () => getStorage().setState({ profileScope: scope, profile: {
            ...getStorage().getState().profile, connectedAccountsV4: [profile(configurationRevision)],
        } });
        publishGrant();
        getStorage().setState({ settingsScope: scope, settings: { ...getStorage().getState().settings,
            machineAdministrationTargetsLocalV1: { 'mcpServers.settings': {
                serverIdentityId: home.serverIdentityId!, machineId: 'facts-machine',
            } } } });
        const provider = createDeferred<unknown>();
        let providerPending = false;
        const service = MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1;
        const mode = { id: 'oauth', kind: 'oauthAuthorizationCode' as const,
            callbackUrl: 'https://app.happier.dev/oauth/mcp/callback', pkce: 'required' as const,
            outcomeReconciliation: 'none' as const };
        const custody = { occurrenceId: 'host-occurrence', sourceCustody: { kind: 'host' as const } };
        // The daemon RPC is the external producer. Keep the mounted Action,
        // Connected Services CAS orchestration, real store and sign-in hook real.
        projectionRpc.mockImplementation(async request => {
            const command = request.payload.command;
            if (command.operation === 'describeService') return ConnectedAccountDaemonControlResponseSchema.parse({
                status: 'described', service, descriptor: { id: service.localId, title: 'MCP sign-in',
                    authentication: { defaultModeId: 'oauth', modes: [mode] } },
                accounts: [{ ref: profile(configurationRevision).ref, status: 'connected',
                    authenticationModeId: 'oauth', configurationReady: true, configurationRevision,
                    scopes: ['read'], revisionSemantics: 'revisioned', credentialRevision: profile(configurationRevision).credentialRevision }],
                ...(command.requiredOperation ? { operationTransport: { kind: 'v4' } } : {}), ...custody,
            });
            if (command.operation === 'readConfiguration' || command.operation === 'replaceConfiguration') {
                if (command.operation === 'replaceConfiguration') configurationRevision = 'configuration-2';
                return ConnectedAccountDaemonControlResponseSchema.parse({
                    status: command.operation === 'readConfiguration' ? 'configuration' : 'configurationCommitted',
                    target: { kind: 'account', account: profile(configurationRevision).ref, modeId: 'oauth' }, mode, ...custody,
                    configuration: { status: 'ready', revision: configurationRevision,
                        values: { serverId: server.id, resource: server.remote.url, registrations: {}, grantedScopes: ['read'] },
                        configuredSecretFieldIds: [], missingFieldIds: [] },
                });
            }
            if (command.operation === 'beginReconnect') return ConnectedAccountAttemptResponseSchema.parse({ status: 'starting', attemptId: 'attempt-remove' });
            if (command.operation === 'read') { providerPending = true; return provider.promise; }
            throw new Error(`Unexpected daemon command: ${command.operation}`);
        });
        const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
        const disposeLoader = await installRealActionExecutorModuleLoader();
        const { useMcpServerSignIn } = await import('@/components/settings/mcpServers/signIn/useMcpServerSignIn');
        const hook = await renderHook(() => useMcpServerSignIn(server,
            [{ machineId: 'facts-machine', name: 'QA Machine', online: true }], { scope }));
        let removing: Promise<void> | undefined;
        try {
            await vi.waitFor(() => expect(hook.getCurrent().view?.state).toBe('connected'));
            await act(async () => { removing = hook.getCurrent().start({ client: null }); });
            await vi.waitFor(() => expect(providerPending).toBe(true));
            // A real configuration CAS changes the profile's configuration basis
            // before provider admission replies; it has not replaced the credential.
            await act(async () => { publishGrant(); });
            await act(async () => {
                provider.resolve(ConnectedAccountAttemptResponseSchema.parse({ status: 'rejected', attemptId: 'attempt-remove',
                    code, diagnostic: { code, severity: 'error' } }));
                await removing;
            });
            expect(hook.getCurrent().view).toEqual(view);
        } finally {
            provider.resolve({ status: 'cancelled', attemptId: 'attempt-remove' });
            await removing;
            await hook.unmount();
            disposeLoader();
        }
    });

    it.each([false, true])('reads plugin declarations from the MCP Administration target (explicit=%s)', async explicit => {
        const home = await prepareToolFactsHome();
        const selected = createMachineFixture({ id: 'mcp-machine', active: true, activeAt: Date.now() });
        publishMachineActivity(selected, selected, []);
        const state = getStorage().getState();
        const machines = [...Object.values(state.machines), selected];
        getStorage().setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            machineListByServerId: { [home.id]: machines }, settings: { ...state.settings,
                machineAdministrationTargetsLocalV1: { 'mcpServers.settings': {
                    serverIdentityId: home.serverIdentityId!, machineId: explicit ? 'facts-machine' : selected.id,
                } } } });
        const projection = PluginProjectionV2Schema.parse({ ...toolFactsProjection,
            familiesById: { ...toolFactsProjection.familiesById, mcp: { family: 'mcp', entriesById: {
                'server:acme.mcp-facts/fixture': { id: 'server:acme.mcp-facts/fixture', pluginId: 'acme.mcp-facts',
                    localId: 'fixture', contributionKind: 'server', title: 'Fixture tools', kind: 'dynamic' },
            } } } });
        projectionRpc.mockImplementation(async request => ({ protocolVersion: 1,
            projection: request.machineId === selected.id ? projection : toolFactsProjection }));
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { createUiMcpServerActionExecuteV1 } = await import('./mcpServerActionDeps');
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const result = await createUiMcpServerActionExecuteV1(account)({ actionId: 'mcp.servers.list', input: {},
                context: { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                    ...(explicit ? { externalActionTarget: { kind: 'machine', machineId: selected.id } } : {}) } });
            expect(result).toMatchObject({ ok: true, result: { catalog: { servers: [expect.anything(), { source: {
                kind: 'plugin', pluginId: 'acme.mcp-facts',
            } }], pluginItemsStatus: 'ready' } } });
        } finally { account.dispose(); }
    });

    it('hydrates only the MCP declarations and Agent facts its Actions read from a sectioned projection', async () => {
        const home = await prepareToolFactsHome();
        const projection = PluginProjectionV2Schema.parse({ ...toolFactsProjection,
            familiesById: { ...toolFactsProjection.familiesById, mcp: { family: 'mcp', entriesById: {
                'server:acme.mcp-facts/fixture': { id: 'server:acme.mcp-facts/fixture', pluginId: 'acme.mcp-facts',
                    localId: 'fixture', contributionKind: 'server', title: 'Fixture tools', kind: 'dynamic' },
            } } } });
        // The daemon's own section producer answers the manifest and every section page.
        const deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projection, projectionDigest: 'a'.repeat(64) }));
        const sectionByIndexDigest = new Map(Object.entries(deferred.manifest.sections).map(([section, digest]) => [digest, section]));
        const sectionsRead = new Set<string>();
        projectionRpc.mockImplementation(async request => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                throw new Error(`Unexpected daemon RPC ${request.method}`);
            }
            const read = (request.payload as Readonly<{ sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } }>).sectionRead;
            if (!read) return deferred.manifest;
            for (const digest of [read.digest, ...read.includeDigests ?? []]) {
                const section = sectionByIndexDigest.get(digest);
                if (section) sectionsRead.add(section);
            }
            return deferred.read(read.digest, read.offset, read.includeDigests);
        });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { createUiMcpServerActionExecuteV1 } = await import('./mcpServerActionDeps');
        const account = await captureLazyActionAccountContext(home.id);
        const context = { serverId: home.id, surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
        try {
            const execute = createUiMcpServerActionExecuteV1(account);
            expect(await execute({ actionId: 'mcp.servers.list', input: {}, context })).toMatchObject({ ok: true, result: {
                catalog: { servers: [expect.anything(), { source: { kind: 'plugin', pluginId: 'acme.mcp-facts' } }], pluginItemsStatus: 'ready' } } });
            expect(await execute({ actionId: 'mcp.servers.tools.list', input: { serverId: 'server' }, context })).toMatchObject({ ok: true,
                result: { perAgent: { status: 'ready', machineId: 'facts-machine' } } });
            expect([...sectionsRead].sort()).toEqual(['agentsById', 'base', 'familiesById.mcp', 'installedPackagesById']);
        } finally { account.dispose(); }
    });

    it.each([false, true])('keeps sign-in on the MCP target used by Test (explicit=%s)', async explicit => {
        const home = await prepareToolFactsHome(true, [], undefined, undefined, { catalog: () => ({ v: 1, bindings: [],
            servers: [{ id: 'server', name: 'server', transport: 'http', remote: { url: 'https://mcp.fixture.test/mcp',
                headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }] }) });
        const selected = createMachineFixture({ id: 'mcp-machine', active: true, activeAt: explicit ? 1 : Date.now() });
        const state = getStorage().getState();
        const machines = [...Object.values(state.machines), selected];
        getStorage().setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            machineListByServerId: { [home.id]: machines }, settings: { ...state.settings,
                machineAdministrationTargetsLocalV1: {
                    'mcpServers.settings': { serverIdentityId: home.serverIdentityId!, machineId: explicit ? 'facts-machine' : selected.id },
                    'connectedAccounts.settings': { serverIdentityId: home.serverIdentityId!, machineId: 'facts-machine' },
                } } });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { createUiMcpServerActionExecuteV1 } = await import('./mcpServerActionDeps');
        const account = await captureLazyActionAccountContext(home.id);
        // Only the daemon RPC is replaced. The captured Account, inventory,
        // preference resolution and MCP Action owner all remain real.
        projectionRpc.mockImplementation(async request => request.method === RPC_METHODS.DAEMON_MCP_SERVERS_TEST
            ? { ok: true, toolCount: 1, durationMs: 1 }
            : { status: 'unavailable', code: 'connected_account_service_unavailable' });
        try {
            const execute = createUiMcpServerActionExecuteV1(account);
            const context = { serverId: home.id, surface: 'ui' as const, authority: 'present_user' as const,
                actionCaller: { kind: 'host' as const },
                ...(explicit ? { externalActionTarget: { kind: 'machine' as const, machineId: selected.id } } : {}) };
            expect(await execute({ actionId: 'mcp.servers.test', input: { t: 'byId', serverId: 'server',
                machineId: selected.id, directory: '/' }, context })).toMatchObject({ ok: true, result: { ok: true } });
            expect(await execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server' }, context }))
                .toMatchObject({ ok: false, errorCode: 'mcp_sign_in_not_supported' });
            expect(projectionRpc.mock.calls.map(([request]) => request.machineId)).toEqual([selected.id, selected.id]);
        } finally { account.dispose(); }
    });

    it('refuses sign-in rerouting while the saved MCP target is unavailable, then uses it after recovery', async () => {
        const home = await prepareToolFactsHome(true, [], undefined, undefined, { catalog: () => ({ v: 1, bindings: [],
            servers: [{ id: 'server', name: 'server', transport: 'http', remote: { url: 'https://mcp.fixture.test/mcp',
                headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }] }) });
        const selected = createMachineFixture({ id: 'mcp-machine', active: true, activeAt: Date.now() });
        const state = getStorage().getState();
        const machines = [...Object.values(state.machines), selected];
        getStorage().setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            // A failed read retains admitted rows; an unobserved scoped inventory
            // cannot resolve the saved preference until the recovery below.
            machineListByServerId: { [home.id]: machines }, machineListStatusByServerId: {},
            settings: { ...state.settings, machineAdministrationTargetsLocalV1: {} } });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { createUiMcpServerActionExecuteV1 } = await import('./mcpServerActionDeps');
        const account = await captureLazyActionAccountContext(home.id);
        projectionRpc.mockResolvedValue({ status: 'unavailable', code: 'connected_account_service_unavailable' });
        try {
            const execute = createUiMcpServerActionExecuteV1(account);
            const request = { actionId: 'mcp.servers.signIn.start' as const, input: { serverId: 'server' },
                context: { serverId: home.id, surface: 'ui' as const, authority: 'present_user' as const,
                    actionCaller: { kind: 'host' as const } } };
            expect(await execute(request)).toMatchObject({ ok: false, errorCode: 'mcp_sign_in_not_supported' });
            expect(projectionRpc.mock.calls.map(([request]) => request.machineId)).toEqual(['facts-machine']);
            projectionRpc.mockClear();
            getStorage().setState({ settings: { ...getStorage().getState().settings,
                machineAdministrationTargetsLocalV1: { 'mcpServers.settings': {
                    serverIdentityId: home.serverIdentityId!, machineId: selected.id,
                } } } });
            expect(await execute(request)).toMatchObject({ ok: false, errorCode: 'no_machine_online' });
            expect(projectionRpc).not.toHaveBeenCalled();

            getStorage().setState({ machineListStatusByServerId: { [home.id]: 'idle' } });
            expect(await execute(request)).toMatchObject({ ok: false, errorCode: 'mcp_sign_in_not_supported' });
            expect(projectionRpc.mock.calls.map(([request]) => request.machineId)).toEqual([selected.id]);
            projectionRpc.mockClear();
            getStorage().setState({ machines: {}, machineListByServerId: { [home.id]: [] } });
            expect(await execute(request)).toMatchObject({ ok: false, errorCode: 'no_machine_online' });
            expect(projectionRpc).not.toHaveBeenCalled();
        } finally { account.dispose(); }
    });

    it.each(['saved', 'observed'] as const)('uses the %s second MCP Machine for diagnostics, not the first online presentation row', async selection => {
        const { rememberMachineAdministrationTargetObservation, clearMachineAdministrationTargetObservation } = await import('@/sync/domains/state/machineAdministrationUiState');
        const server = { id: 'server', name: 'server', transport: 'http' as const,
            remote: { url: 'https://mcp.fixture.test/mcp', headers: {}, auth: { kind: 'oauth' as const } },
            env: {}, createdAt: 1, updatedAt: 1 };
        const home = await prepareToolFactsHome(true, [], undefined, undefined,
            { catalog: () => ({ v: 1, bindings: [], servers: [server] }) });
        const selected = createMachineFixture({ id: 'selected-second', active: true, activeAt: Date.now() });
        publishMachineActivity(selected, selected, []);
        const machines = [...Object.values(getStorage().getState().machines), selected];
        const scope = { serverId: home.serverIdentityId!, accountId: 'tool-owner' };
        const grant = QualifiedConnectedAccountProfileV4Schema.parse({
            ref: { service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1, accountId: server.id }, status: 'connected',
            kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true,
            configurationRevision: 'configuration-1', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_1234567890123456789012', scopes: ['read'],
        });
        getStorage().setState({ settingsScope: scope, profileScope: scope,
            profile: { ...getStorage().getState().profile, connectedAccountsV4: [grant] },
            machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            machineListByServerId: { [home.id]: machines }, settings: { ...getStorage().getState().settings,
                machineAdministrationTargetsLocalV1: selection === 'saved' ? { 'mcpServers.settings': {
                    serverIdentityId: home.serverIdentityId!, machineId: selected.id,
                } } : {} } });
        rememberMachineAdministrationTargetObservation(scope, 'mcpServers.settings', {
            serverIdentityId: home.serverIdentityId!, machineId: selection === 'observed' ? selected.id : machines[0]!.id,
        });
        const observed: Array<{ operation: string; machineId: string }> = [];
        projectionRpc.mockImplementation(async request => {
            const command = request.payload.command;
            observed.push({ operation: command.operation, machineId: request.machineId });
            if (request.machineId !== selected.id) throw Object.assign(new Error('Wrong Machine cannot read this grant'), { code: 'RPC_FORBIDDEN' });
            if (command.operation === 'readConfiguration') return ConnectedAccountDaemonControlResponseSchema.parse({
                status: 'configuration', target: { kind: 'account', account: grant.ref, modeId: 'oauth' },
                mode: { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://app.happier.dev/oauth/mcp/callback',
                    pkce: 'required', outcomeReconciliation: 'none' },
                configuration: { status: 'ready', revision: grant.configurationRevision,
                    values: { serverId: server.id, resource: server.remote.url }, configuredSecretFieldIds: [], missingFieldIds: [] },
                occurrenceId: 'host-selected', sourceCustody: { kind: 'host' },
            });
            throw new Error(`Unexpected daemon command: ${command.operation}`);
        });
        const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
        const disposeLoader = await installRealActionExecutorModuleLoader();
        const { useMcpServerSignIn } = await import('@/components/settings/mcpServers/signIn/useMcpServerSignIn');
        const hook = await renderHook(() => useMcpServerSignIn(server,
            machines.map(machine => ({ machineId: machine.id, name: machine.id, online: true })), { scope }));
        try {
            await vi.waitFor(() => expect(observed.length).toBeGreaterThan(0));
            expect(observed).toEqual([{ operation: 'readConfiguration', machineId: selected.id }]);
            await vi.waitFor(() => expect(hook.getCurrent().view?.state).toBe('connected'));
            await act(async () => {
                const revoked = { ...selected, revokedAt: Date.now() };
                const current = [machines[0]!, revoked];
                getStorage().setState({ machines: Object.fromEntries(current.map(m => [m.id, m])),
                    machineListByServerId: { [home.id]: current } });
            });
            // A refused exact target is settled, not an endless loading state
            // or an invitation to read/revoke on the other online Machine.
            expect(hook.getCurrent().view?.state).toBe('did_not_finish');
            await act(async () => { expect(await hook.getCurrent().signOut()).toBe(false); });
            expect(observed).toEqual([{ operation: 'readConfiguration', machineId: selected.id }]);
        } finally {
            await hook.unmount(); disposeLoader();
            clearMachineAdministrationTargetObservation(scope, 'mcpServers.settings');
        }
    });

    it('retries sign-in on the saved MCP Machine after a failed request without rerouting', async () => {
        const server = { id: 'server', name: 'server', transport: 'http' as const, remote: { url: 'https://mcp.fixture.test/mcp',
            headers: {}, auth: { kind: 'oauth' as const } }, env: {}, createdAt: 1, updatedAt: 1 };
        const home = await prepareToolFactsHome(true, [], undefined, undefined, { catalog: () => ({ v: 1, bindings: [], servers: [server] }) });
        const selected = createMachineFixture({ id: 'mcp-machine', active: true, activeAt: Date.now() });
        const state = getStorage().getState();
        const machines = [...Object.values(state.machines), selected];
        getStorage().setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            machineListByServerId: { [home.id]: machines }, settings: { ...state.settings,
                machineAdministrationTargetsLocalV1: { 'mcpServers.settings': {
                    serverIdentityId: home.serverIdentityId!, machineId: selected.id,
                } } } });
        const { recordMachineRequestFailed, clearMachineRequestReachabilityForScope } = await import('@/sync/domains/machines/reachability/machineReachability');
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { createUiMcpServerActionExecuteV1 } = await import('./mcpServerActionDeps');
        const account = await captureLazyActionAccountContext(home.id);
        recordMachineRequestFailed({ ...account.accountLifetime.scope, machineId: selected.id });
        // The actual RPC may still refuse; the person's Retry must receive that
        // response rather than synthesizing an offline verdict from the last try.
        projectionRpc.mockResolvedValue({ status: 'unavailable', code: 'connected_account_service_unavailable' });
        try {
            const execute = createUiMcpServerActionExecuteV1(account);
            expect(await execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server' },
                context: { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } }))
                .toMatchObject({ ok: false, errorCode: 'mcp_sign_in_not_supported' });
            expect(projectionRpc.mock.calls.map(([request]) => request.machineId)).toEqual([selected.id]);

            const scope = account.accountLifetime.scope;
            getStorage().setState({ settingsScope: scope, profileScope: scope,
                profile: { ...getStorage().getState().profile, connectedAccountsV4: [] },
                machines: { 'facts-machine': machines[0]! }, machineListByServerId: { [home.id]: [machines[0]!] } });
            const { useMcpServerSignIn } = await import('@/components/settings/mcpServers/signIn/useMcpServerSignIn');
            const hook = await renderHook((online: boolean) => useMcpServerSignIn(server,
                [{ machineId: selected.id, name: 'MCP Machine', online }], { scope }), { initialProps: false });
            await act(async () => { await hook.getCurrent().start(); });
            expect(hook.getCurrent().view).toEqual({ state: 'no_machine_online' });
            expect(projectionRpc).toHaveBeenCalledTimes(1);
            getStorage().setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
                machineListByServerId: { [home.id]: machines } });
            await hook.rerender(true);
            // A past no-machine refusal cannot disable Retry after presence recovers.
            // Keep its diagnostic while allowing the person to try again; never auto-start OAuth.
            expect(hook.getCurrent().view).toEqual({ state: 'did_not_finish', diagnosticCode: 'no_machine_online' });
            expect(projectionRpc).toHaveBeenCalledTimes(1);
            await act(async () => { await hook.getCurrent().start(); });
            expect(hook.getCurrent().view).toEqual({ state: 'did_not_finish', diagnosticCode: 'mcp_sign_in_not_supported' });
            expect(projectionRpc.mock.calls.map(([request]) => request.machineId)).toEqual([selected.id, selected.id]);
        } finally { clearMachineRequestReachabilityForScope(account.accountLifetime.scope); account.dispose(); }
    });

    it.each(['active', 'inactive'] as const)('lists valid neighbors from real %s partial authority while refusing tools', async authority => {
        const incomplete = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
            stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 },
            { id: 'bad', name: 'bad', transport: 'stdio' }], bindings: [] };
        // Only the HTTP row/source is incomplete. Admission, projection and strict consumers stay real.
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/host'], undefined, undefined, {
            row: () => authority === 'active' ? { status: 'present', revision: 3, content: { t: 'plain', v: incomplete } }
                : { status: 'absent' },
            settings: () => authority === 'inactive' ? { mcpServersSettingsV1: { ...incomplete, strictMode: false } } : {},
        });
        const scope = { serverId: home.serverIdentityId!, accountId: 'tool-owner' };
        getStorage().setState({ settingsScope: scope });
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const release = observeMcpServerCatalog(scope);
        const executor = createDefaultActionExecutor();
        const context = { serverId: home.id, surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
        try {
            await refreshMcpServerCatalog(scope);
            const result = await executor.execute('mcp.servers.list', {}, context);
            if (!result.ok) throw new Error(result.errorCode);
            const list = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(result.result);
            expect(list).toMatchObject({ status: 'partial', authority,
                revision: authority === 'active' ? 3 : 'absent', catalog: { servers: [{ id: 'server' }] } });
            if (list.status !== 'partial') throw new Error('The incomplete inventory must remain diagnostic');
            expect(list.catalog.servers).toHaveLength(1);
            expect(list.diagnostics).toContainEqual({ path: 'servers[1]', reason: 'invalid-stored-content' });
            expect(await executor.execute('mcp.servers.tools.list', { serverId: 'server' }, context)).toMatchObject({
                ok: false, errorCode: 'mcp_catalog_unavailable',
            });
        } finally { release(); }
    });

    it('borrows observed admitted list authority without rereading the same catalog', async () => {
        let reads = 0;
        const maintenance = createDeferred<void>();
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/host'], () => { reads += 1; }, maintenance.promise);
        const scope = { serverId: home.serverIdentityId!, accountId: 'tool-owner' };
        getStorage().setState({ settingsScope: scope });
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const release = observeMcpServerCatalog(scope);
        try {
            await refreshMcpServerCatalog(scope);
            const readsBeforeList = reads;
            const result = await createDefaultActionExecutor().execute('mcp.servers.list', {},
                { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            if (!result.ok) throw new Error(result.errorCode);
            const list = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(result.result);
            expect(list).toMatchObject({ status: 'ready', authority: 'active', revision: 3,
                catalog: { servers: [{ id: 'server' }], bindings: [] } });
            expect(reads).toBe(readsBeforeList);
        } finally {
            maintenance.resolve();
            release();
        }
    });

    it('borrows observed admitted tool authority without rereading and revalidates after an observer gap', async () => {
        let reads = 0;
        let revision = 3;
        const maintenance = createDeferred<void>();
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/host'], () => { reads += 1; }, maintenance.promise,
            { revision: () => revision });
        const scope = { serverId: home.serverIdentityId!, accountId: 'tool-owner' };
        getStorage().setState({ settingsScope: scope });
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        let release = observeMcpServerCatalog(scope);
        const executor = createDefaultActionExecutor();
        const context = { serverId: home.id, surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
        try {
            await refreshMcpServerCatalog(scope);
            expect(getMcpServerCatalogSnapshot(scope)).toMatchObject({ status: 'ready', authority: 'active', stale: false, revision: 3 });
            const readsBeforeTools = reads;
            for (let observer = 0; observer < 2; observer += 1) {
                const result = await executor.execute('mcp.servers.tools.list', { serverId: 'server' }, context);
                if (!result.ok) throw new Error(result.errorCode);
                expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(result.result)).toMatchObject({
                    serverId: 'server', revision: 3, perAgent: { status: 'ready' },
                });
                expect(reads).toBe(readsBeforeTools);
            }
            release();
            expect(getMcpServerCatalogSnapshot(scope)).toMatchObject({ status: 'loading', stale: true, revision: 3 });
            revision = 4;
            const changed = await executor.execute('mcp.servers.tools.list', { serverId: 'server' }, context);
            expect(changed).toMatchObject({ ok: true, result: { serverId: 'server', revision: 4 } });
            expect(reads).toBe(readsBeforeTools + 1);
            expect(getMcpServerCatalogSnapshot(scope).stale).toBe(true);
        } finally {
            maintenance.resolve();
            release();
        }
    });

    it('withdraws admitted plain tool authority before an Account without E2EE material can read it', async () => {
        let mode: 'plain' | 'e2ee' = 'plain';
        const maintenance = createDeferred<void>();
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/host'], undefined, maintenance.promise,
            { mode: () => mode });
        const scope = { serverId: home.serverIdentityId!, accountId: 'tool-owner' };
        getStorage().setState({ settingsScope: scope });
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const release = observeMcpServerCatalog(scope);
        try {
            await refreshMcpServerCatalog(scope);
            expect(getMcpServerCatalogSnapshot(scope).value?.servers[0]?.id).toBe('server');
            mode = 'e2ee';
            publishHomeAccountChange(scope.serverId, ['self']);
            const result = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
                { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            expect(result).toMatchObject({ ok: false });
            expect(result).not.toHaveProperty('result');
            await refreshMcpServerCatalog(scope);
            expect(getMcpServerCatalogSnapshot(scope)).toMatchObject({ status: 'unavailable', value: null });
        } finally {
            maintenance.resolve();
            release();
        }
    });

    it('joins simultaneous mounted tool reads without tying their transport to either observer', async () => {
        let catalogReads = 0;
        const maintenance = createDeferred<void>();
        // Hold optional history cleanup at HTTP so its authority rechecks do not count as foreground reads.
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/host'], () => { catalogReads += 1; }, maintenance.promise);
        getStorage().setState({ settingsScope: { serverId: home.serverIdentityId!, accountId: 'tool-owner' } });
        const projectionStarted = createDeferred<void>();
        const projection = createDeferred<unknown>();
        projectionRpc.mockImplementation(async () => { projectionStarted.resolve(); return projection.promise; });
        const first = await renderHook(() => useMcpServerTools('server', 3, ['acme.mcp-facts/host']));
        const second = await renderHook(() => useMcpServerTools('server', 3, ['acme.mcp-facts/host']));
        try {
            await projectionStarted.promise;
            // Both mounted consumers demand the same admitted revision and Agent membership.
            await vi.waitFor(() => expect(catalogReads).toBe(1));
            await first.unmount();
            projection.resolve({ protocolVersion: 1, projection: toolFactsProjection });
            await vi.waitFor(() => expect(second.getCurrent()).toMatchObject({ status: 'ready', list: {
                serverId: 'server', revision: 3, perAgent: { status: 'ready', agents: [
                    { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host' },
                ] },
            } }));
            const admitted = second.getCurrent().list;
            await second.rerender();
            expect(second.getCurrent().list).toBe(admitted);
            expect(catalogReads).toBe(1);
        } finally {
            maintenance.resolve();
            projection.resolve({ protocolVersion: 1, projection: toolFactsProjection });
            await first.unmount();
            await second.unmount();
        }
    });

    it('reloads current Agent facts through the real tools Action while observed catalog authority stays fresh', async () => {
        let reads = 0;
        const maintenance = createDeferred<void>();
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/host'], () => { reads += 1; }, maintenance.promise);
        const scope = { serverId: home.serverIdentityId!, accountId: 'tool-owner' };
        getStorage().setState({ settingsScope: scope });
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const release = observeMcpServerCatalog(scope);
        await refreshMcpServerCatalog(scope);
        const tools = await renderHook(() => useMcpServerTools('server', 3, ['acme.mcp-facts/host']));
        try {
            await vi.waitFor(() => expect(tools.getCurrent().list?.perAgent.agents).toEqual([
                { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host', loading: 'every_turn', tokens: null },
            ]));
            const before = tools.getCurrent().list;
            const readsBeforeReload = reads;
            await act(async () => {
                getStorage().setState(state => {
                    const previous = state.machines['facts-machine']!;
                    const machine = { ...previous, metadata: { ...previous.metadata!,
                        agentInventory: { checkedAt: Date.now(), installedAgentIds: ['acme.mcp-facts/native'] } } };
                    return { machines: { ...state.machines, [machine.id]: machine },
                        machineListByServerId: { ...state.machineListByServerId, [home.id]: [machine] } };
                });
                tools.getCurrent().reload();
            });
            await vi.waitFor(() => expect(tools.getCurrent().list?.perAgent.agents).toEqual([
                { agentId: 'acme.mcp-facts/native', off: 'hidden', approval: 'native', loading: 'on_demand', tokens: null },
            ]));
            expect(tools.getCurrent().list).not.toBe(before);
            expect(getMcpServerCatalogSnapshot(scope)).toMatchObject({ status: 'ready', authority: 'active', stale: false, revision: 3 });
            expect(reads).toBe(readsBeforeReload);
        } finally {
            maintenance.resolve();
            await tools.unmount();
            release();
        }
    });

    it('refuses a misbound server id at the real catalog consumer and recovers on the admitted id', async () => {
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/host']);
        getStorage().setState({ settingsScope: { serverId: home.serverIdentityId!, accountId: 'tool-owner' } });
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const tools = await renderHook(({ serverId }) => useMcpServerTools(serverId, 3, ['acme.mcp-facts/host']),
            { initialProps: { serverId: 'another-server' } });
        try {
            await vi.waitFor(() => expect(tools.getCurrent()).toMatchObject({
                status: 'unavailable', errorCode: 'mcp_server_not_found', list: null,
            }));
            await tools.rerender({ serverId: 'server' });
            await vi.waitFor(() => expect(tools.getCurrent().status).toBe('ready'));
            const consumed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(tools.getCurrent().list);
            expect(consumed).toMatchObject({ serverId: 'server', revision: 3, perAgent: { status: 'ready', agents: [
                { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host' },
            ] } });
        } finally { await tools.unmount(); }
    });

    it('refreshes the real tools Action when an installed Agent is first published', async () => {
        const home = await prepareToolFactsHome(true, []);
        getStorage().setState({ settingsScope: { serverId: home.serverIdentityId!, accountId: 'tool-owner' } });
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const tools = await renderHook(({ installedAgentIds }) => useMcpServerTools('server', 3, installedAgentIds),
            { initialProps: { installedAgentIds: [] as readonly string[] } });
        try {
            await vi.waitFor(() => expect(tools.getCurrent().status).toBe('ready'));
            expect(tools.getCurrent().list?.perAgent.agents).toEqual([]);
            getStorage().setState(state => {
                const previous = state.machines['facts-machine']!;
                const machine = { ...previous, metadata: { ...previous.metadata!,
                    agentInventory: { checkedAt: Date.now(), installedAgentIds: ['acme.mcp-facts/host'] } } };
                return { machines: { ...state.machines, [machine.id]: machine },
                    machineListByServerId: { ...state.machineListByServerId, [home.id]: [machine] } };
            });
            await tools.rerender({ installedAgentIds: ['acme.mcp-facts/host'] });
            await vi.waitFor(() => expect(tools.getCurrent().list?.perAgent.agents).toEqual([
                { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host', loading: 'every_turn', tokens: null },
            ]));
        } finally { await tools.unmount(); }
    });

    it('uses the facts Machine catalog names for installed external Agents', async () => {
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/host']);
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const receipt = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        if (!receipt.ok) throw new Error(receipt.errorCode);
        const listed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(receipt.result);
        const input = { agentIds: ['acme.mcp-facts/host'], machines: [], projects: [],
            machineId: listed.perAgent.machineId ?? null, serverId: home.id };
        const names = await renderHook(() => useWhereItsOnNames(input));
        try {
            expect(names.getCurrent().names.agentName('acme.mcp-facts/host')).toBe('Host Agent');
        } finally { await names.unmount(); }
    });

    it('returns installed Account Agent facts from the real Action composition and strict consumer', async () => {
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/native']);
        const offlineMachine = createMachineFixture({ id: 'offline-machine', active: false, activeAt: 0,
            metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['acme.mcp-facts/host'] } } });
        getStorage().setState(state => ({ machines: { ...state.machines, [offlineMachine.id]: offlineMachine },
            machineListByServerId: { ...state.machineListByServerId, [home.id]: [...(state.machineListByServerId[home.id] ?? []), offlineMachine] } }));
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const receipt = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        if (!receipt.ok) throw new Error(receipt.errorCode);
        const listed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(receipt.result);
        expect(listed.perAgent.agents).toEqual([
            { agentId: 'acme.mcp-facts/native', off: 'hidden', approval: 'native', loading: 'on_demand', tokens: null },
            { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host', loading: 'every_turn', tokens: null },
        ]);
        expect(describeMcpToolAgents(listed.perAgent, (ids: readonly string[]) => ids.map(id => toolFactsProjection.agentsById[id]!.title!),
            ['acme.mcp-facts/native', 'acme.mcp-facts/host'])).toEqual({
            onDemand: ['Native Agent'], notApply: [], blocked: ['Host Agent'], hidden: ['Native Agent'],
        });
    });

    it('returns exact admitted daemon facts, including Agents with no proven control', async () => {
        const home = await prepareToolFactsHome();
        projectionRpc.mockImplementation(async request => {
            expect(request).toMatchObject({ method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                serverId: home.serverIdentityId, accountId: 'tool-owner', machineId: 'facts-machine' });
            return { protocolVersion: 1, projection: toolFactsProjection };
        });
        const result = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: true, result: { perAgent: { status: 'ready', machineId: 'facts-machine', agents: [
            { agentId: 'acme.mcp-facts/native', off: 'hidden', approval: 'native', loading: 'on_demand', tokens: null },
            { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host', loading: 'every_turn', tokens: null },
            { agentId: 'acme.mcp-facts/unproven', off: null, approval: null, loading: 'every_turn', tokens: null },
            { agentId: 'acme.mcp-facts/no-tools', off: null, approval: null, loading: 'every_turn', tokens: null },
        ] } } });
    });

    it.each([true, false])('keeps tool facts scoped to the captured Home after focus moves (eligible Machine: %s)', async includeMachine => {
        const home = await prepareToolFactsHome(includeMachine);
        const focused = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
            homeServerIdentityId: 'srv_foreign_mcp_tool_facts', canonicalServerUrl: 'https://foreign-mcp-tool-facts.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://foreign-mcp-tool-facts.test' }] } });
        await setActiveServerId(focused.id);
        const focusedMachine = createMachineFixture({ id: 'focused-machine', activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!,
                agentInventory: { checkedAt: Date.now(), installedAgentIds: ['acme.mcp-facts/host'] } } });
        getStorage().setState(state => ({ machines: { [focusedMachine.id]: focusedMachine },
            machineListByServerId: { ...state.machineListByServerId, [focused.id]: [focusedMachine] },
            machineListStatusByServerId: { ...state.machineListStatusByServerId, [focused.id]: 'idle' } }));
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const receipt = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        if (!receipt.ok) throw new Error(receipt.errorCode);
        const listed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(receipt.result);
        if (includeMachine) {
            expect(listed.perAgent).toEqual({ status: 'ready', machineId: 'facts-machine', agents: [
                { agentId: 'acme.mcp-facts/native', off: 'hidden', approval: 'native', loading: 'on_demand', tokens: null },
                { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host', loading: 'every_turn', tokens: null },
                { agentId: 'acme.mcp-facts/unproven', off: null, approval: null, loading: 'every_turn', tokens: null },
                { agentId: 'acme.mcp-facts/no-tools', off: null, approval: null, loading: 'every_turn', tokens: null },
            ] });
            expect(projectionRpc).toHaveBeenCalledWith(expect.objectContaining({
                method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                serverId: home.serverIdentityId, accountId: 'tool-owner', machineId: 'facts-machine',
            }));
        } else {
            expect(listed.perAgent).toMatchObject({ status: 'unavailable', agents: [] });
            expect(projectionRpc).not.toHaveBeenCalled();
        }
    });

    it.each(['no-machine', 'unsupported'] as const)('keeps %s facts unavailable', async reason => {
        const home = await prepareToolFactsHome(reason !== 'no-machine');
        projectionRpc.mockImplementation(async () => {
            if (reason === 'unsupported') throw Object.assign(new Error('Projection not supported'), { code: 'RPC_METHOD_NOT_AVAILABLE' });
            // A mistaken fallback would receive usable facts and wrongly claim readiness.
            return { protocolVersion: 1, projection: toolFactsProjection };
        });
        const result = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: true, result: { perAgent: { status: 'unavailable', agents: [] } } });
    });

    it.each(['retired', 'cancelled'] as const)('never discloses projection facts after the invocation is %s', async transition => {
        const home = await prepareToolFactsHome();
        const projectionStarted = createDeferred<void>();
        const response = createDeferred<unknown>();
        projectionRpc.mockImplementation(async request => {
            expect(request.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            projectionStarted.resolve();
            return response.promise;
        });
        const cancellation = new AbortController();
        const execution = createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, signal: cancellation.signal });
        const settled = execution.catch(error => {
            expect(error).toMatchObject({ name: 'AbortError' });
            return { ok: false as const };
        });
        try {
            const phase = await Promise.race([projectionStarted.promise.then(() => 'projection'), settled.then(() => 'settled')]);
            expect(phase).toBe('projection');
            if (transition === 'retired') {
                await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
            }
            else cancellation.abort();
            response.resolve({ protocolVersion: 1, projection: toolFactsProjection });
            // The captured invocation may reject cancellation or return a typed refusal; neither discloses facts.
            const result = await settled;
            expect(result).toMatchObject({ ok: false });
            expect(result).not.toHaveProperty('result');
        } finally {
            response.resolve({ protocolVersion: 1, projection: toolFactsProjection });
            await settled;
        }
    });
});

describe('UI MCP Actions through captured Home persistence', () => {
    it('creates and reads on the requested Home after another Home receives focus', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://mcp-action-home.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://focused-mcp-action-home.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const settings = { mcpServersStrictMode: true, actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'mcp.servers.create': ['ui'] } } };
        let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
        let revision = 1;
        const writes: string[] = [];
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (target.pathname === '/v2/account/settings') {
                expect(init?.method ?? 'GET').toBe('GET');
                return Response.json({ content: { t: 'plain', v: settings }, version: 7 });
            }
            if (target.pathname === '/v1/account/entity-rows/mcp') {
                if (init?.method === 'POST') {
                    const input = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    expect(input.expectedRevision).toBe(revision);
                    if (input.content?.t !== 'plain') throw new Error('Expected plain Account row');
                    catalog = input.content.v;
                    writes.push(target.pathname);
                    return Response.json({ status: 'updated', revision: ++revision, cursor: revision });
                }
                return Response.json({ status: 'present', revision, content: { t: 'plain', v: catalog } });
            }
            if (target.pathname === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
            if (target.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        const context = { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const entry = { id: 'server', name: 'server', transport: 'stdio', stdio: { command: 'mcp-tool', args: [] },
            env: { TOKEN: { t: 'literal', v: 'private' } }, createdAt: 1, updatedAt: 1 } as const;
        // Native randomness is supplied by the UI platform adapter; Web Crypto is not required.
        vi.stubGlobal('crypto', undefined);
        expect(await executor.execute('mcp.servers.create', { entry, expectedRevision: 1 }, context))
            .toEqual({ ok: true, result: { status: 'updated', revision: 2, cursor: 2, serverId: entry.id } });
        const read = await executor.execute('mcp.servers.read', { serverId: 'server' }, context);
        expect(read).toMatchObject({ ok: true,
            result: { status: 'present', server: entry, revision: 2, complete: true, authority: 'active', installLink: expect.any(String) } });
        const output = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.read'].parse(read.ok ? read.result : null);
        if (!('installLink' in output) || typeof output.installLink !== 'string') throw new Error('Missing install link');
        expect(new URL(output.installLink).origin).toBe('https://mcp-action-home.test');
        const imported = parseMcpServerImportV1(output.installLink);
        expect(imported.errors).toEqual([]);
        expect(imported.servers).toMatchObject([{ name: 'server', stdio: { command: 'mcp-tool', args: [] }, env: {
            TOKEN: { t: 'input', inputId: 'server:env:TOKEN' },
        } }]);
        expect(JSON.stringify(imported)).not.toContain('private');
        expect(writes).toEqual(['/v1/account/entity-rows/mcp']);
        expect(catalog.bindings).toMatchObject([{ serverId: 'server', enabled: true, target: { t: 'allMachines' } }]);
    });
    it('lists an admitted catalog without awaiting retained-source maintenance', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://mcp-action-read-home.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://focused-mcp-action-read-home.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'read-owner' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const maintenanceStarted = createDeferred<void>();
        const releaseMaintenance = createDeferred<void>();
        let catalogObserved = false;
        // Only captured Home HTTP is substituted. Required Account/approval
        // reads finish; the source GET after the ready row is optional cleanup.
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (target.pathname === '/v2/account/settings') {
                expect(init?.method ?? 'GET').toBe('GET');
                if (catalogObserved) {
                    maintenanceStarted.resolve();
                    await releaseMaintenance.promise;
                }
                return Response.json({ content: { t: 'plain', v: { mcpServersStrictMode: true } }, version: 7 });
            }
            if (target.pathname === '/v1/account/entity-rows/mcp') {
                expect(init?.method ?? 'GET').toBe('GET');
                catalogObserved = true;
                return Response.json({ status: 'present', revision: 3, content: { t: 'plain', v: {
                    v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
                        stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [],
                } } });
            }
            if (target.pathname === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
            if (target.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        let settled = false;
        const list = executor.execute('mcp.servers.list', {}, { serverId: home.id, surface: 'ui',
            authority: 'present_user', actionCaller: { kind: 'host' } }).then(result => { settled = true; return result; });
        try {
            const phase = await Promise.race([list.then(() => 'read' as const), maintenanceStarted.promise.then(() => 'maintenance' as const)]);
            // Cleanup may already be running, but its deferred response must
            // not postpone the finite read or imply cleanup has completed.
            if (phase === 'maintenance') await vi.waitFor(() => expect(settled).toBe(true));
            const result = await list;
            expect(result).toMatchObject({ ok: true, result: { status: 'ready', authority: 'active', revision: 3,
                catalog: { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio', createdAt: 1, updatedAt: 1 }], bindings: [] } } });
            expect(result).not.toMatchObject({ result: { cleanup: { status: 'complete' } } });
        } finally {
            releaseMaintenance.resolve();
            await list;
        }
    });
});
