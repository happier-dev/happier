import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';
import type { CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import type { McpAddCatalogRow } from './add/mcpAddModalConfig';

import type {
    DetectedMcpServerV1} from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import type {
    McpServersSettingsV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred, renderHook } from '@/dev/testkit';
import { mcpServerRoute } from './collection/mcpServerCollectionModel';
import { measureMountedCollections, renderInCollectionLayout } from '@/dev/testkit/render/renderInCollectionLayout';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

function createEmptyDetectedServersResponse() {
    return { ok: true, servers: [] as DetectedMcpServerV1[] };
}

function createEmptyPreviewResponse() {
    return { ok: true, builtIn: [], managed: [], detected: [] as [] };
}

// Validate fake daemon receipts before dispatch so fixture drift cannot masquerade as a lost Socket acknowledgement.
const successfulTestReceipt = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.test'].parse({
    ok: true, toolCount: 1, durationMs: 2, tools: [{ name: 'write', tokens: 10 }],
});
const missingRuntimeTestReceipt = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.test'].parse({
    ok: false, errorCode: 'mcp_connect_failed', error: 'Runtime unavailable', runtimeMissing: 'npx', durationMs: 2,
});

const {
    routerPushSpy,
    routerReplaceSpy,
    routerSetParamsSpy,
} = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    routerSetParamsSpy: vi.fn(),
}));

const settingsState: { value: McpServersSettingsV1 } = {
    value: { v: 1, strictMode: false, servers: [], bindings: [] },
};

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid',
}));

function installMcpServersScreenMocks() {
    installMcpServersCommonModuleMocks({
        realComponents: true,
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            const { createCapturingFlatListMock, createCapturingSectionListMock } = await import('@/dev/testkit/mocks/virtualizedList');
            return createReactNativeWebMock({
                Dimensions: { get: () => ({ width: 1440, height: 900 }) },
                // Native list materialization is an OS boundary; retain the real Collection row/open path.
                FlatList: createCapturingFlatListMock({ renderItems: true }).module.FlatList,
                SectionList: createCapturingSectionListMock({ renderItems: true }).module.SectionList,
            });
        },
        storage: (importOriginal) => importOriginal(),
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            return createExpoRouterMock({
                pathname: '/(app)/settings/mcp-servers',
                params: () => mcpServersModuleState.routerSearchParams,
                segments: ['(app)', 'settings', 'mcp-servers'],
                router: {
                    push: routerPushSpy,
                    replace: routerReplaceSpy,
                    back: mcpServersModuleState.routerBackSpy,
                    setParams: routerSetParamsSpy,
                },
            }).module;
        },
        modal: async () => {
            const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
            return createModalModuleMock({ confirmResult: true, renderCustomModals: true }).module;
        },
    });
}

installMcpServersScreenMocks();
vi.doUnmock('@/sync/domains/state/storage');

// Load the real owners during collection rather than spending a test's deadline
// transforming the cold Home/action graph.
const { storage } = await import('@/sync/domains/state/storageStore');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
const { setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { useMachineAdministrationTargetSelection } = await import('@/sync/domains/machines/administration/useTargetSelection');
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { refreshMcpServerCatalog, resetMcpServerCatalogEngineForTests } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { McpSettingsIndex } = await import('./McpSettingsIndex');
const { McpServerCollection } = await import('./collection/McpServerCollection');
const { McpDetectedServersScreen } = await import('./McpDetectedServersScreen');
const { applyAcknowledgedMcpServerCatalog, getMcpServerCatalogSnapshot, resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { useMcpServerTools } = await import('./tools/useMcpServerTools');
const { McpServerToolsSection } = await import('./tools/McpServerToolsSection');
const { McpServerDetailPage } = await import('./detail/McpServerDetailPage');
const { McpServerEditorScreen } = await import('./McpServerEditorScreen');
const { McpServerWhereAndTools } = await import('./detail/McpServerDetailBody');
const { useMcpServerDetail } = await import('./detail/McpServerDetailBody');
const { McpAddModal } = await import('./add/openMcpAddModal');
const { CapabilityAddModalBody } = await import('@/components/capabilities/add/CapabilityAddModal');
const { CapabilityBlockingBanner } = await import('@/components/capabilities/detail/CapabilityBlockingBanner');
const { resolveSavedSecretReference } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
const { useMcpServerMachineTests } = await import('./status/useMcpServerMachineTests');
const { useMcpHome } = await import('./home/useMcpHome');
const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const initialState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let disposeActionExecutorModuleLoader: (() => void) | undefined;
let machineHome: Awaited<ReturnType<typeof upsertServerProfileOnly>>;
let detectedResponse = createEmptyDetectedServersResponse();
let detectedByMachine: Record<string, unknown> = {};
/** More Machines the collection Home publishes for this Account, beside `machine`. */
let accountMachines: ReturnType<typeof createMachineFixture>[] = [];
let catalogRevision = 1;
let accountSettingsVersion = 1;
let accountSettings: Record<string, unknown> = {};
let catalogReadGate: ReturnType<typeof createDeferred<void>> | null = null;
let holdCatalogReadsAfterWrite = false;
let testResponseGate: ReturnType<typeof createDeferred<void>> | null = null;
let runtimeMissing = false;
let registryOAuth = false;
let registryDetailReads = 0;
const catalogWrites: unknown[] = [];
const savedSecretRequests: string[] = [];
const accountSettingsWrites: unknown[] = [];
const rpcRequests: Array<Readonly<{ home: string | undefined; method: string; input: unknown }>> = [];
const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now(),
    access: { custodian: { accountId: 'collection-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' }, metadata: {
    host: 'machine-1.local', displayName: 'Machine 1', platform: 'darwin', happyCliVersion: '0.0.0-test',
    happyHomeDir: '/Users/tester/.happy-dev', homeDir: '/Users/tester',
} });
const targetMachine = createMachineFixture({ id: 'machine-target', activeAt: Date.now(),
    access: { custodian: { accountId: 'machine-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' }, metadata: {
    ...machine.metadata!, host: 'target.local', displayName: 'Target machine',
} });

async function refreshCatalogFixture() {
    if (!connection) throw new Error('The collection Home must be restored');
    await refreshMcpServerCatalog({ serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId: 'collection-owner' });
}

async function selectMachineFixture(target: { serverIdentityId: string; machineId: string }) {
    const selection = await renderHook(() => useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers));
    try {
        await vi.waitFor(() => expect(selection.getCurrent().candidates.some(candidate =>
            candidate.target.serverIdentityId === target.serverIdentityId && candidate.target.machineId === target.machineId)).toBe(true));
        await act(async () => { selection.getCurrent().selectTarget(target); });
        await vi.waitFor(() => {
            const current = selection.getCurrent();
            const state = storage.getState();
            expect(current.selectedTarget, JSON.stringify({ home: connection?.home.id, target, candidates: current.candidates,
                selectionState: current.state.kind, canExecute: current.canExecute,
                settingsScope: state.settingsScope, profileScope: state.profileScope, isDataReady: state.isDataReady })).toEqual(target);
        });
    } finally { await selection.unmount(); }
}

afterEach(async () => {
    testResponseGate?.resolve();
    testResponseGate = null;
    retirePresentationNotice();
    catalogReadGate?.resolve();
    catalogReadGate = null;
    await standardCleanup();
    await connection?.dispose();
    connection = null;
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    resetRuntimeFetch();
    storage.setState(initialState, true);
    vi.restoreAllMocks();
    disposeActionExecutorModuleLoader?.();
    disposeActionExecutorModuleLoader = undefined;
});

describe('MCP servers collection and tools', () => {
    beforeEach(async () => {
        resetMcpServersCommonModuleMockState();
        installMcpServersScreenMocks();
        routerPushSpy.mockReset();
        routerReplaceSpy.mockReset();
        routerSetParamsSpy.mockReset();
        detectedResponse = createEmptyDetectedServersResponse();
        detectedByMachine = {};
        accountMachines = [];
        catalogRevision = 1;
        accountSettingsVersion = 1;
        catalogWrites.length = 0;
        savedSecretRequests.length = 0;
        accountSettingsWrites.length = 0;
        rpcRequests.length = 0;
        runtimeMissing = false;
        registryOAuth = false;
        registryDetailReads = 0;
        holdCatalogReadsAfterWrite = false;
        accountSettings = { mcpServersStrictMode: false, actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
            'mcp.found.list': ['ui'], 'mcp.servers.create': ['ui'], 'settings.set': ['ui'],
        } } };
        settingsState.value = {
            v: 1,
            strictMode: false,
            servers: [{
                id: 'server-1',
                name: 'playwright',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
                env: {},
                createdAt: 1,
                updatedAt: 1,
            }],
            bindings: [{
                id: 'binding-1',
                serverId: 'server-1',
                enabled: true,
                target: { t: 'machine', machineId: 'machine-1' },
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        disposeActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
        const targetUrl = 'https://mcp-collection-machine.test';
        await upsertServerProfileOnly({ serverUrl: targetUrl, name: 'Machine Home' });
        const targetHome = await setServerProfileIdentityForUrl(targetUrl, 'srv_mcp_collection_machine');
        if (!targetHome) throw new Error('Expected the Machine Home identity');
        machineHome = targetHome;
        const token = (accountId: string) => `e30.${Buffer.from(JSON.stringify({ sub: accountId,
            provenance: { v: 1, kind: 'account', authority: 'present_user' }, tokenEpoch: 0 })).toString('base64url')}.signature`;
        const credentials = { token: token('collection-owner') };
        await TokenStorage.setCredentialsForServerUrl('https://mcp-collection.test', {}, credentials);
        await TokenStorage.setCredentialsForServerUrl(targetUrl, { serverId: targetHome.id }, { token: token('machine-owner') });
        installDisconnectedServerSocketBoundary((socket, home) => {
            // The fake network acknowledges genuine request-correlated RPC envelopes;
            // Machine resolution, Actions, admission, and codecs all stay real.
            configureConnectedServerSocketBoundary(socket);
            socket.emitWithAck = vi.fn(async (event: string, payload: unknown) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
                if (!payload || typeof payload !== 'object') throw new Error('Expected a wire RPC request');
                const method = Reflect.get(payload, 'method');
                if (typeof method !== 'string') throw new Error('Expected a wire RPC method');
                const content = { mode: 'plain' } as const;
                const request = await socketRpcCodec.decodeRequestParams(content, Reflect.get(payload, 'params'), method);
                rpcRequests.push({ home, method, input: request.params });
                if (method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)) {
                    await testResponseGate?.promise;
                    const result = runtimeMissing ? missingRuntimeTestReceipt : successfulTestReceipt;
                    return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, request.callId) };
                }
                return { ok: true, result: await socketRpcCodec.encodeResponse(content,
                    method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT)
                        ? detectedByMachine[method.split(':')[0]!] ?? detectedResponse : createEmptyPreviewResponse(), request.callId) };
            });
        });
        const request: Parameters<typeof setRuntimeFetch>[0] = async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname.startsWith('/v1/account/saved-secrets/')) savedSecretRequests.push(parsed.pathname);
            const target = parsed.origin === targetUrl;
            const selectedMachine = target ? targetMachine : machine;
            const accountId = target ? 'machine-owner' : 'collection-owner';
            if (parsed.origin === 'https://registry.modelcontextprotocol.io') {
                if (!parsed.pathname.endsWith('/servers')) registryDetailReads += 1;
                const item = { server: { name: registryOAuth ? 'example.test/oauth-docs' : 'example.test/stdio-docs', title: 'Docs', description: 'Read documentation.', version: '1.0.0',
                    packages: registryOAuth ? [] : [{ registryType: 'npm', identifier: '@example/docs', version: '1.0.0', transport: { type: 'stdio' } }],
                    remotes: registryOAuth ? [{ type: 'streamable-http', url: 'https://docs.example.test/mcp' }] : [],
                }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } };
                return Response.json(parsed.pathname.endsWith('/servers') ? { servers: [item], metadata: { count: 1 } } : item);
            }
            if (parsed.pathname.startsWith('/v1/account/') || parsed.pathname === '/v2/account/settings') {
                expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token(accountId)}`);
            }
            if (parsed.pathname === '/health' || parsed.pathname === '/v1/auth/ping') return Response.json({});
            if (parsed.pathname === '/v1/features' || parsed.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                capabilities: { serverIdentity: { serverIdentityId: target ? 'srv_mcp_collection_machine' : 'srv_mcp_collection' } },
            }));
            if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: accountSettingsVersion }));
            if (parsed.pathname === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: accountId }));
            if (parsed.pathname === '/v2/sessions' || parsed.pathname === '/v2/sessions/active') return Response.json(V2SessionListResponseSchema.parse({ sessions: [], nextCursor: null, hasNext: false }));
            if (parsed.pathname === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
                snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0,
                    pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
            }));
            if (parsed.pathname === '/v1/artifacts') return Response.json([]);
            if (parsed.pathname === PROMPT_LIBRARY_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows:
                PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) });
            if (parsed.pathname === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (parsed.pathname === '/v1/account/project-rows/list') return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
            if (parsed.pathname === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const mutation = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    if (mutation.content?.t !== 'plain') throw new Error('Expected a plain Account Settings write');
                    expect(mutation.expectedVersion).toBe(accountSettingsVersion);
                    accountSettingsWrites.push(mutation);
                    accountSettings = mutation.content.v;
                    accountSettingsVersion += 1;
                    return Response.json({ success: true, version: accountSettingsVersion });
                }
                return Response.json({ version: accountSettingsVersion, content: { t: 'plain', v: accountSettings } });
            }
            if (parsed.pathname === '/v1/machines/read-batch') {
                expect(init?.method).toBe('POST');
                expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token(accountId)}`);
                const input = MachineReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
                const published = new Set([selectedMachine.id, ...(target ? [] : accountMachines.map(item => item.id))]);
                return Response.json(MachineReadBatchResponseV1Schema.parse({ results: input.machineIds.map(machineId =>
                    published.has(machineId)
                        ? { machineId, status: 'found', machine: createPlainMachineRowFixture({ id: machineId, accountId,
                            machine: accountMachines.find(item => item.id === machineId) ?? createMachineFixture({ id: machineId, activeAt: Date.now() }) }) }
                        : { machineId, status: 'not_found' }),
                }));
            }
            if (parsed.pathname === `/v1/machines/${selectedMachine.id}`) return Response.json({
                machine: createPlainMachineRowFixture({ id: selectedMachine.id, accountId, machine: selectedMachine }),
            });
            if (parsed.pathname === `/v1/machines/${selectedMachine.id}/access`) {
                const custodian = { accountId, displayName: 'Machine owner' };
                return Response.json(MachineAccessGrantsListResponseV1Schema.parse({ machineId: selectedMachine.id, custodian,
                    access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                    canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] }));
            }
            if (parsed.pathname === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: selectedMachine.id, accountId }),
                ...(target ? [] : accountMachines).map(item => createPlainMachineRowFixture({ id: item.id, accountId, machine: item }))]);
            if (parsed.pathname === '/v1/account/entity-rows/mcp') {
                expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token(accountId)}`);
                if (init?.method === 'POST') {
                    const mutation = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    if (mutation.content?.t !== 'plain') throw new Error('Expected a plain MCP catalog write');
                    if (mutation.expectedRevision !== catalogRevision) return Response.json({ status: 'conflict', revision: catalogRevision });
                    catalogWrites.push(mutation);
                    settingsState.value = { ...mutation.content.v, strictMode: false };
                    catalogRevision += 1;
                    if (holdCatalogReadsAfterWrite) catalogReadGate ??= createDeferred<void>();
                    return Response.json({ status: 'updated', revision: catalogRevision, cursor: catalogRevision });
                }
                await catalogReadGate?.promise;
                const { strictMode: _strictMode, ...catalog } = settingsState.value;
                return Response.json({ status: 'present', revision: catalogRevision, content: { t: 'plain', v: catalog } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        setRuntimeFetch(request);
        await loadSyncSingletonForTests();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://mcp-collection.test',
            serverIdentityId: 'srv_mcp_collection', accountId: 'collection-owner', credentials, request });
        setRuntimeFetch(request);
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId: 'collection-owner' };
        const { sync } = await import('@/sync/sync');
        await sync.refreshSessions({ awaitSessionListHydration: true });
        await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
        await vi.waitFor(() => expect(storage.getState().settingsScope).toEqual(scope));
        await vi.waitFor(() => expect(storage.getState().settings.actionsSettingsV1).toEqual(settingsParse(accountSettings).actionsSettingsV1));
        storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId });
        storage.getState().applyMachines([targetMachine], true, { sourceServerId: resolveServerProfileScopeIdForIdentifier(targetHome.id) });
        observeMachinePresenceForTest(scope, [machine.id]);
        observeMachinePresenceForTest({ serverId: resolveServerProfileScopeIdForIdentifier(targetHome.id), accountId: 'machine-owner' }, [targetMachine.id]);
        await selectMachineFixture({ serverIdentityId: 'srv_mcp_collection', machineId: machine.id });
        await refreshCatalogFixture();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockReset();
        vi.mocked(Modal.show).mockReset();
        vi.mocked(Modal.prompt).mockReset();
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
    });

    it('follows a real Test runtime failure from the saved-detail repair button to that Machine setup', async () => {
        runtimeMissing = true;
        const scope = storage.getState().settingsScope!;
        storage.getState().applyMachines([{ ...machine, metadata: { ...machine.metadata!,
            agentInventory: { checkedAt: Date.now(), installedAgentIds: ['claude'] },
        } }], true, { sourceServerId: scope.serverId });
        const server = settingsState.value.servers[0]!;
        const screen = await renderSettingsView(<McpServerDetailPage server={server} draftServer={server}
            catalogRevision={catalogRevision} secrets={[]} secretAvailability={{ resolveReference: ref => resolveSavedSecretReference(scope, [], ref) }}
            scope={scope} onCommitConfiguration={() => {}} configurationSaveState="idle" onRemove={() => {}}
            approvalNotice={null} onDuplicate={() => {}} onChangeServer={() => {}} />);
        await screen.pressByTestIdAsync('mcp.server.machines:action');
        await vi.waitFor(() => expect(screen.findByType(McpServerWhereAndTools).props.detail.tests.results).toMatchObject({
            [machine.id]: { ok: false, errorCode: 'mcp_connect_failed', runtimeMissing: 'npx', message: 'Runtime unavailable' },
        }));
        await vi.waitFor(() => expect(screen.findByType(CapabilityBlockingBanner).props.status).toMatchObject({ kind: 'cantrun', detail: 'npx' }));
        await screen.pressByTestIdAsync('mcp.server.banner.action');
        expect(routerPushSpy).toHaveBeenCalledWith(`/machines/${encodeURIComponent(machine.id)}?serverId=${encodeURIComponent(scope.serverId)}&tab=setup&page=tools`);
    });

    it('allows a tool directly and Undo restores acknowledged inheritance after the catalog refreshes', async () => {
        const server = settingsState.value.servers[0]!;
        settingsState.value = { ...settingsState.value, servers: [{ ...server,
            toolsSnapshot: { checkedAt: 1, machineId: machine.id, tools: [{ name: 'write', tokens: 10 }] },
        }] };
        await refreshCatalogFixture();
        let lastError: string | null | undefined;
        function Tools() {
            const tools = useMcpServerTools(server.id, catalogRevision);
            return <McpServerToolsSection testID="tools" status={tools.status} list={tools.list}
                agentNames={ids => ids} installedAgentIds={[]} onChange={async patch => { lastError = await tools.set(patch); return lastError; }} />;
        }
        const screen = await renderSettingsView(<Tools />);
        await vi.waitFor(() => expect(screen.findByTestId('tools:tool:write:allow')).not.toBeNull());
        retirePresentationNotice();
        await screen.pressByTestIdAsync('tools:tool:write:allow');
        await vi.waitFor(() => expect(settingsState.value.servers[0]!.tools?.overrides.write).toBe('allow'));
        await refreshCatalogFixture();
        await vi.waitFor(() => expect(readPresentationNotice()?.undo, JSON.stringify({ lastError, error: screen.findByTestId('tools:error')?.props.diagnosticCode })).toBeDefined());
        await act(async () => { readPresentationNotice()!.undo!.run(); });
        await vi.waitFor(() => expect(settingsState.value.servers[0]!.tools?.overrides).toEqual({}));
        expect(settingsState.value.servers[0]!.tools?.default).toBe('ask');
        const { Modal } = await import('@/modal');
        expect(Modal.confirm).not.toHaveBeenCalled();
    });

    it.each(['cloudflare-api', 'cloudflare-docs'] as const)('discovers four Cloudflare Add choices and saves only %s with the chosen reach', async suggestionId => {
        const screen = await renderSettingsView(<McpAddModal params={{ query: 'Cloudflare' }} onClose={() => {}} />);
        const config = () => screen.tree.root.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<McpAddCatalogRow>;
        await vi.waitFor(() => expect(config().catalog.items.filter(row => 'suggestionId' in row).map(row => row.suggestionId)).toEqual([
            'cloudflare-api', 'cloudflare-docs', 'cloudflare-browser', 'cloudflare-containers',
        ]));
        expect(catalogWrites).toHaveLength(0);
        expect(rpcRequests).toEqual([]);
        await act(async () => { config().catalog.onQueryChange('browser'); });
        expect(config().catalog.items.filter(row => 'suggestionId' in row).map(row => row.suggestionId)).toEqual(['cloudflare-browser']);
        await act(async () => { config().catalog.onQueryChange('Cloudflare'); });
        const row = config().catalog.items.find(row => 'suggestionId' in row && row.suggestionId === suggestionId)!;
        const readsBefore = registryDetailReads;
        savedSecretRequests.length = 0;
        const details = await renderSettingsView(<>{config().renderDetail(row, { pushed: false, added: false })}</>);
        await vi.waitFor(() => expect(config().detailFooter(row).primary.disabledReason).toBeUndefined());
        const where = { kind: 'replace', rules: [{ target: { t: 'machine', machineId: 'machine-1' }, enabled: true }] } as const;
        const reachControl = details.tree.root.findAllByProps({ testID: 'mcp.add.detail.where' }).find(node => typeof node.props.onChange === 'function');
        expect(reachControl).toBeDefined();
        await act(async () => { await reachControl!.props.onChange(where); });
        await act(async () => { await config().detailFooter(row).primary.onPress(); });
        expect(catalogWrites).toHaveLength(1);
        const added = settingsState.value.servers.filter(server => server.id === 'uuid');
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ transport: 'http', remote: {
            url: suggestionId === 'cloudflare-api' ? 'https://mcp.cloudflare.com/mcp' : 'https://docs.mcp.cloudflare.com/mcp',
        } });
        expect(added[0]?.remote?.auth?.kind === 'oauth').toBe(suggestionId === 'cloudflare-api');
        expect(added[0]?.origin).toBeUndefined();
        expect(settingsState.value.bindings.filter(binding => binding.serverId === 'uuid')).toMatchObject([
            { target: { t: 'machine', machineId: 'machine-1' }, enabled: true },
        ]);
        expect(registryDetailReads).toBe(readsBefore);
        expect(savedSecretRequests).toEqual([]);
        expect(rpcRequests).toEqual([]);
    });

    it.each([false, true])('carries the acknowledged Registry Add to the saved-page follow-up (OAuth=%s)', async oauth => {
        registryOAuth = oauth;
        holdCatalogReadsAfterWrite = true;
        const itemId = oauth ? 'example.test/oauth-docs' : 'example.test/stdio-docs';
        const query = oauth ? 'oauth' : 'stdio';
        const onAdded = vi.fn();
        const onClose = vi.fn();
        const screen = await renderSettingsView(React.createElement(McpAddModal, { params: { query, onAdded }, onClose }));
        // React's renderer exposes untyped component props at its boundary.
        const config = () => screen.tree.root.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<RegistryItemSummaryV1>;
        await vi.waitFor(() => expect(config().catalog.items.some(row => row.itemId === itemId)).toBe(true));
        const row = config().catalog.items.find(row => row.itemId === itemId)!;
        const details = await renderSettingsView(React.createElement(React.Fragment, null,
            config().renderDetail(row, { pushed: false, added: false })));
        await vi.waitFor(() => expect(config().detailFooter(row).primary.disabledReason).toBeUndefined());
        // Keep the creation callback captured before its durable acknowledgement.
        const before = config();
        let receipt: Awaited<ReturnType<ReturnType<typeof before.detailFooter>['primary']['onPress']>> | undefined;
        let failure: unknown;
        // A later inventory read may still be pending after the row's durable ACK.
        // Navigation must use that ACK rather than wait for another network read.
        await act(async () => {
            void before.detailFooter(row).primary.onPress().then(value => { receipt = value; }, error => { failure = error; });
            await vi.waitFor(() => expect(catalogWrites).toHaveLength(1));
            await vi.waitFor(() => expect(receipt, String(failure)).toEqual({ itemId: 'uuid', then: 'stay' }));
        });
        if (!receipt) throw new Error('Expected an acknowledged create');
        expect(onAdded).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => { await config().detailFooter(row).afterAdd?.open?.onPress(); });
        expect(onAdded).toHaveBeenCalledWith('uuid', { afterRegistryAdd: true });
        const added = settingsState.value.servers.find(server => server.id === 'uuid');
        expect(added?.remote?.auth?.kind === 'oauth').toBe(oauth);
        expect(catalogWrites).toHaveLength(1);
        expect(rpcRequests.filter(request => request.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST))).toEqual([]);
        await details.unmount();
        await screen.unmount();
        const openAdded = vi.fn();
        const reopened = await renderSettingsView(React.createElement(McpAddModal, { params: { query, onAdded: openAdded }, onClose }));
        const reopenedConfig = () => reopened.tree.root.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<RegistryItemSummaryV1>;
        await act(async () => { expect(await reopenedConfig().detailFooter(row).primary.onPress()).toBeNull(); });
        expect(openAdded).toHaveBeenCalledWith('uuid', undefined);
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(catalogWrites).toHaveLength(1);
    });

    it.each([false, true])('Store catalog Add opens the native saved-server continuation (OAuth=%s)', async oauth => {
        registryOAuth = oauth;
        const { StoreListingController } = await import('@/components/store/StoreListingController');
        type Listing = import('@/components/store/StoreListingController').StoreListingState;
        let state: Listing = { kind: 'unavailable' };
        const itemId = oauth ? 'example.test/oauth-docs' : 'example.test/stdio-docs';
        const onClose = vi.fn();
        await renderSettingsView(<StoreListingController reference={{ type: 'registryItem', kind: 'mcpServer',
            sourceId: 'builtin:mcp-registry', itemId }} onClose={onClose}>
            {value => { state = value; return null; }}</StoreListingController>);
        const config = () => {
            if (state.kind !== 'mcpServer' || !state.config) throw new Error('Expected the MCP listing');
            return state.config;
        };
        await vi.waitFor(() => expect(config().catalog.items.some(row => row.itemId === itemId)).toBe(true));
        const row = config().catalog.items.find(row => row.itemId === itemId)!;
        await renderSettingsView(<>{config().renderDetail(row, { pushed: false, added: false })}</>);
        await vi.waitFor(() => expect(config().detailFooter(row).primary.disabledReason).toBeUndefined());
        await act(async () => { await config().detailFooter(row).primary.onPress(); });
        expect(catalogWrites).toHaveLength(1);
        expect(routerPushSpy).not.toHaveBeenCalled();
        await act(async () => { await config().detailFooter(row).afterAdd?.open?.onPress(); });
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/mcp/uuid?afterRegistryAdd=1');
        expect(onClose).toHaveBeenCalledOnce();
        expect(settingsState.value.servers.find(server => server.id === 'uuid')?.remote?.auth?.kind === 'oauth').toBe(oauth);
    });

    it('keeps an open Store listing detail still when a fact it does not show arrives', async () => {
        const { StoreMcpListing } = await import('@/components/store/StoreMcpListing');
        const { CapabilityListingDetail } = await import('@/components/capabilities/add/CapabilityAddModal');
        const selection = { sourceId: 'builtin:mcp-registry', itemId: 'example.test/stdio-docs' } as const;
        const configs: CapabilityAddModalConfig<McpAddCatalogRow>[] = [];
        const screen = await renderSettingsView(<StoreMcpListing selection={selection} onClose={() => {}}>
            {state => {
                if (state.config) configs.push(state.config);
                return state.config && state.item
                    ? <CapabilityListingDetail config={state.config} item={state.item} onClose={() => {}} pushed={false} />
                    : null;
            }}
        </StoreMcpListing>);
        // The detail's host title: React keeps its committed props object while nothing above it re-renders it.
        const title = () => screen.tree.root.find(node => typeof node.type === 'string' && node.props.testID === 'mcp.add.detail.title').props;
        await vi.waitFor(() => {
            const config = configs.at(-1)!;
            const item = config.catalog.items.find(row => !('suggestionId' in row) && row.itemId === selection.itemId)!;
            expect(config.detailFooter(item).primary.disabledReason).toBeUndefined();
        });
        await flushHookEffects();
        const settled = title();
        const configsBefore = configs.length;
        // Another server joins the Account catalog: this listing is not it, so nothing its detail reads changed.
        settingsState.value = { ...settingsState.value, servers: [...settingsState.value.servers, {
            id: 'server-2', name: 'other', transport: 'stdio', stdio: { command: 'npx', args: ['other'] }, env: {}, createdAt: 2, updatedAt: 2,
        }] };
        catalogRevision += 1;
        await act(async () => { await refreshCatalogFixture(); });
        await vi.waitFor(() => expect(configs.length).toBeGreaterThan(configsBefore));
        await flushHookEffects();
        expect(title()).toBe(settled);
    });

    it('opens a Store listing with only its catalog review, holding no Paste or Custom draft', async () => {
        const { StoreMcpListing } = await import('@/components/store/StoreMcpListing');
        const selection = { sourceId: 'builtin:mcp-registry', itemId: 'example.test/stdio-docs' } as const;
        const configs: CapabilityAddModalConfig<McpAddCatalogRow>[] = [];
        await renderSettingsView(<StoreMcpListing selection={selection} onClose={() => {}}>
            {state => { if (state.config) configs.push(state.config); return null; }}
        </StoreMcpListing>);
        await vi.waitFor(() => expect(configs.length).toBeGreaterThan(0));
        // The listing reviews one catalog item: the dialog's Paste and Custom inputs (and their drafts) are not its.
        expect(configs.at(-1)!.modes.map(mode => mode.key)).toEqual(['catalog']);
        const modal = await renderSettingsView(<McpAddModal params={{}} onClose={() => {}} />);
        await vi.waitFor(() => expect((modal.tree.root.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<McpAddCatalogRow>)
            .modes.map(mode => mode.key)).toEqual(['catalog', 'paste', 'custom']));
    });

    it.each(['split', 'stacked'] as const)('opens real header Add and returns the exact added server to the retained home (%s)', async mode => {
        registryOAuth = true;
        onTestFinished(() => { mcpServersModuleState.routerBackSpy.mockReset(); });
        const { Modal, ModalProvider } = await import('@/modal');
        let setRoute: (serverId: string | null) => void = () => { throw new Error('Route boundary not mounted'); };
        function SettingsRoute() {
            const [selected, select] = React.useState<string | null>(null);
            React.useEffect(() => { setRoute = select; }, []);
            return <ModalProvider>
                {mode === 'split' ? <McpServerCollection variant="rail" selectedServerId={selected} /> : null}
                {selected ? <McpServerEditorScreen /> : <McpSettingsIndex />}
            </ModalProvider>;
        }
        // Expo navigation is the external boundary; both destination screens and their state owners stay real.
        const openRoute = (href: string) => {
            const serverId = new URL(href, 'https://ui.example.test').pathname.split('/').at(-1)!;
            mcpServersModuleState.routerSearchParams = { serverId };
            setRoute(serverId);
        };
        routerPushSpy.mockImplementation(openRoute);
        routerReplaceSpy.mockImplementation(openRoute);
        mcpServersModuleState.routerBackSpy.mockImplementation(() => {
            mcpServersModuleState.routerSearchParams = {};
            setRoute(null);
        });
        const screen = await renderInCollectionLayout(<SettingsRoute />, mode);
        await screen.pressByTestIdAsync('settings.mcpServers.addServer');
        expect(Modal.show).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(screen.findAllByTestId('mcp.add:collection:stage').length).toBeGreaterThan(0));
        // Suggestions can populate the model before the registry read settles.
        await vi.waitFor(() => {
            const config = screen.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<McpAddCatalogRow>;
            expect(config.catalog.items.some(row => row.itemId === 'example.test/oauth-docs')).toBe(true);
        });
        await measureMountedCollections(screen, { width: mode === 'split' ? 1080 : 390 });
        if (mode === 'stacked') {
            expect(registryDetailReads).toBe(0);
        }
        await screen.pressByTestIdAsync('mcp.add.row.example.test/oauth-docs');
        await vi.waitFor(() => expect(screen.findAllByTestId('mcp.add:primary').some(node => typeof node.props.onPress === 'function' && node.props.disabled === false)).toBe(true));
        await screen.pressByTestIdAsync('mcp.add:primary');
        await vi.waitFor(() => expect(catalogWrites).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findByTestId('mcp.add:open-added')).not.toBeNull());
        await screen.pressByTestIdAsync('mcp.add:done');
        expect(routerPushSpy).not.toHaveBeenCalled();
        await refreshCatalogFixture();
        await vi.waitFor(() => expect(screen.findByTestId('mcp.server.card.uuid')).not.toBeNull());
        const reach = screen.findAllByTestId('mcp.home.reach').find(node => typeof node.props.onLayout === 'function')!;
        await act(async () => { reach.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: mode === 'split' ? 1080 : 390, height: 300 } } }); });
        expect(screen.findByTestId('mcp.home.map')).not.toBeNull();
        expect(screen.findByTestId('mcp.home.sentence')).not.toBeNull();
        const home = await renderHook(() => useMcpHome());
        expect(home.getCurrent().model.attention.map(server => server.id)).toEqual(['uuid']);
        expect(home.getCurrent().model.ring.marks.some(mark => mark.key === 'uuid' && mark.tether === 'attention')).toBe(true);
        routerPushSpy.mockClear();
        routerReplaceSpy.mockClear();
        // One fix, in the home's Needs you (wide and phone); the column row says the word only.
        expect(screen.findByTestId('mcp.server.card.uuid:status:fix')).toBeNull();
        await screen.pressByTestIdAsync('mcp.home.needs.uuid.fix');
        expect(routerPushSpy).toHaveBeenCalledExactlyOnceWith('/settings/mcp/uuid');
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.findAllByType(McpServerDetailPage)[0]?.props.server.id).toBe('uuid'));
        expect(screen.findAllByType(McpServerWhereAndTools)[0]?.props.detail.statuses).toContainEqual(
            expect.objectContaining({ kind: 'signin' }));
        expect(screen.findByTestId('mcp.server.signin:not-connected:action')).not.toBeNull();
        await act(async () => { mcpServersModuleState.routerBackSpy(); });
        await vi.waitFor(() => expect(screen.findByTestId('mcp.server.card.uuid')).not.toBeNull());
        expect(screen.findByTestId('mcp.home.sentence')).not.toBeNull();
        expect(catalogWrites).toHaveLength(1);
        expect(rpcRequests.filter(request => /mcp.*(test|detect)|mcp\.found\.list/.test(request.method))).toHaveLength(0);
        const bodyReads = registryDetailReads;
        await home.rerender();
        await flushHookEffects();
        expect(registryDetailReads).toBe(bodyReads);
    });

    it('keeps a rejected Registry Add in the modal with its draft and no saved-page follow-up', async () => {
        const onAdded = vi.fn();
        const onClose = vi.fn();
        const screen = await renderSettingsView(<McpAddModal params={{ query: 'stdio', onAdded }} onClose={onClose} />);
        const config = () => screen.tree.root.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<RegistryItemSummaryV1>;
        await vi.waitFor(() => expect(config().catalog.items.some(row => row.itemId === 'example.test/stdio-docs')).toBe(true));
        const row = config().catalog.items.find(row => row.itemId === 'example.test/stdio-docs')!;
        const details = await renderSettingsView(<>{config().renderDetail(row, { pushed: false, added: false })}</>);
        await vi.waitFor(() => expect(config().detailFooter(row).primary.disabledReason).toBeUndefined());
        const before = config();
        // Another writer advances the real HTTP CAS after this form captured its revision.
        catalogRevision += 1;
        await act(async () => {
            await expect(before.detailFooter(row).primary.onPress()).rejects.toThrow();
        });
        const failedDetail = config().renderDetail(row, { pushed: false, added: false });
        if (!React.isValidElement<{ state: unknown }>(failedDetail)) throw new Error('Expected the retained Registry detail');
        expect(failedDetail.props.state).toMatchObject({ status: 'failed', error: 'mcp_catalog_conflict' });
        expect(onAdded).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(settingsState.value.servers.map(server => server.id)).toEqual(['server-1']);
        expect(rpcRequests.filter(request => request.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST))).toEqual([]);
        await details.unmount();
    });

    it.each([true, false])('runs one administrative Test only for the Registry Add navigation intent (%s)', async afterRegistryAdd => {
        settingsState.value = { ...settingsState.value, servers: settingsState.value.servers.map(server => ({ ...server,
            origin: { kind: 'registry', provenance: { sourceId: 'source', itemId: 'docs', format: 'mcp-registry',
                sourceUrl: 'https://registry.example.test', ref: { kind: 'version', version: '1.0.0' }, importedAt: 1 } },
        })) };
        await refreshCatalogFixture();
        await selectMachineFixture({ serverIdentityId: 'srv_mcp_collection', machineId: machine.id });
        mcpServersModuleState.routerSearchParams = afterRegistryAdd ? { afterRegistryAdd: '1' } : {};
        const server = settingsState.value.servers[0]!;
        const scope = storage.getState().settingsScope;
        const hook = await renderHook(() => useMcpServerDetail(server, catalogRevision, {
            resolveReference: ref => resolveSavedSecretReference(scope, [], ref),
        }));
        if (afterRegistryAdd) {
            await vi.waitFor(() => expect(routerSetParamsSpy).toHaveBeenCalledWith({ afterRegistryAdd: undefined }));
            await vi.waitFor(() => expect(hook.getCurrent().tests.results[machine.id]).toMatchObject({ ok: true }));
        }
        else await flushHookEffects();
        expect(rpcRequests.filter(request => request.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)))
            .toHaveLength(afterRegistryAdd ? 1 : 0);
        if (afterRegistryAdd) expect(routerSetParamsSpy).toHaveBeenCalledWith({ afterRegistryAdd: undefined });
        await hook.rerender();
        await flushHookEffects();
        expect(rpcRequests.filter(request => request.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)))
            .toHaveLength(afterRegistryAdd ? 1 : 0);
    });

    it('projects held home Test attention across 101 Machines without probes and retires changed configurations', async () => {
        const scope = storage.getState().settingsScope!;
        accountMachines = Array.from({ length: 100 }, (_, index) => createMachineFixture({
            id: `held-${index}`, activeAt: Date.now(), access: machine.access, metadata: { ...machine.metadata!,
                displayName: `Build ${index}`, agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } },
        }));
        const primary = { ...machine, metadata: { ...machine.metadata!,
            agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } };
        await act(async () => {
            storage.getState().applyMachines([primary, ...accountMachines], true,
                { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
        });
        observeMachinePresenceForTest(scope, [primary.id, ...accountMachines.map(item => item.id)]);
        const other = { ...settingsState.value.servers[0]!, id: 'other-server', name: 'other' };
        settingsState.value = { ...settingsState.value, servers: [...settingsState.value.servers, other],
            bindings: [...settingsState.value.bindings, { ...settingsState.value.bindings[0]!, id: 'other-rule', serverId: other.id }] };
        await refreshCatalogFixture();
        const home = await renderHook(() => useMcpHome());
        await vi.waitFor(() => expect(home.getCurrent().loading).toBe(false));
        const before = home.getCurrent().model;
        const unchanged = before.servers.find(server => server.id === other.id);
        expect(rpcRequests.filter(request => /mcp.*(test|detect)|mcp\.found\.list/.test(request.method))).toHaveLength(0);
        expect(registryDetailReads).toBe(0);
        const tests = await renderHook(() => useMcpServerMachineTests('server-1'));
        runtimeMissing = true;
        await act(async () => { tests.getCurrent().run([primary.id]); });
        await vi.waitFor(() => expect(tests.getCurrent().results[primary.id]).toMatchObject({ ok: false, runtimeMissing: 'npx' }));
        expect(home.getCurrent().model.servers.find(server => server.id === 'server-1')?.status).toMatchObject({ kind: 'cantrun' });
        expect(home.getCurrent().model.needsYou).toBe(1);
        expect(home.getCurrent().model.attention.map(server => server.id)).toEqual(['server-1']);
        expect(home.getCurrent().model.servers.find(server => server.id === other.id)).toBe(unchanged);
        const collection = await renderSettingsView(<McpServerCollection variant="page" />);
        const row = () => collection.findAll(node => node.props.testID === 'mcp.server.card.server-1'
            && typeof node.props.whereSummary === 'string')[0];
        expect(row()?.props.status).toMatchObject({ kind: 'cantrun', machineName: expect.any(String) });
        expect(row()?.props.status.fix).toBeUndefined();
        await act(async () => { collection.findAll(node => node.props.testID === 'mcp.home.needs.server-1.fix'
            && typeof node.props.onPress === 'function')[0]!.props.onPress(); });
        expect(routerPushSpy).toHaveBeenCalledWith(mcpServerRoute('server-1'));
        vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
        onTestFinished(() => { vi.unstubAllGlobals(); });
        await act(async () => collection.findByTestId('settings.mcpServers.page-filter-open')!.props.onPress());
        const editor = () => collection.findAll(node => node.props.testID === 'settings.mcpServers.page-editor' && node.props.model)[0]!;
        expect(editor().props.model.availableFields.find((field: { id: string }) => field.id === 'status').valueOptions)
            .toContainEqual(expect.objectContaining({ value: 'cantrun' }));
        await act(async () => editor().props.onChange({ type: 'add', condition: { fieldId: 'status', operator: 'is', values: ['cantrun'] } }));
        expect(row()).toBeDefined();
        expect(collection.findAll(node => node.props.testID === `mcp.server.card.${other.id}`)).toHaveLength(0);
        const withFailure = home.getCurrent().model;
        await act(async () => { await refreshCatalogFixture(); });
        expect(home.getCurrent().model).toBe(withFailure);
        testResponseGate = createDeferred<void>();
        await act(async () => { tests.getCurrent().run([primary.id]); });
        await vi.waitFor(() => expect(rpcRequests.filter(request => request.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST))).toHaveLength(2));
        settingsState.value = { ...settingsState.value, servers: settingsState.value.servers.map(server =>
            server.id === 'server-1' ? { ...server, stdio: { command: 'new-runtime', args: [] } } : server) };
        catalogRevision += 1;
        const catalog = getMcpServerCatalogSnapshot(scope).value!;
        await act(async () => { applyAcknowledgedMcpServerCatalog(scope, { ...catalog, servers: catalog.servers.map(server =>
            server.id === 'server-1' ? { ...server, stdio: { command: 'new-runtime', args: [] } } : server) }, catalogRevision, true); });
        expect(getMcpServerCatalogSnapshot(scope).status).toBe('loading');
        expect(tests.getCurrent().results).toEqual({});
        expect(home.getCurrent().model.servers.find(server => server.id === 'server-1')?.status).toBeNull();
        expect(home.getCurrent().model.needsYou).toBe(0);
        expect(home.getCurrent().model.attention).toEqual([]);
        expect(row()).toBeUndefined();
        expect(home.getCurrent().model.servers.find(server => server.id === other.id)).toBe(unchanged);
        await act(async () => { testResponseGate!.resolve(); });
        expect(tests.getCurrent().results).toEqual({});
        expect(home.getCurrent().model.needsYou).toBe(0);
        expect(rpcRequests.filter(request => request.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST))).toHaveLength(2);
        expect(rpcRequests.filter(request => /detect|mcp\.found\.list/.test(request.method))).toHaveLength(0);
        expect(registryDetailReads).toBe(0);
    });

    it('retires held Test facts on configuration and Account changes, including when reopened', async () => {
        const hook = await renderHook(() => useMcpServerMachineTests('server-1'));
        await act(async () => { hook.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(hook.getCurrent().results[machine.id]).toMatchObject({ ok: true }));
        await hook.unmount();
        const reopened = await renderHook(() => useMcpServerMachineTests('server-1'));
        expect(reopened.getCurrent().results[machine.id]).toMatchObject({ ok: true });
        testResponseGate = createDeferred<void>();
        const before = rpcRequests.length;
        await act(async () => { reopened.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(rpcRequests.length).toBeGreaterThan(before));
        settingsState.value = { ...settingsState.value, servers: settingsState.value.servers.map(server => ({ ...server,
            stdio: { command: 'different-runtime', args: [] },
        })) };
        catalogRevision += 1;
        await act(async () => { await refreshCatalogFixture(); });
        await vi.waitFor(() => expect(reopened.getCurrent().results).toEqual({}));
        await act(async () => { testResponseGate!.resolve(); });
        await vi.waitFor(() => expect(reopened.getCurrent().running.size).toBe(0));
        expect(reopened.getCurrent().results).toEqual({});
        testResponseGate = null;
        await act(async () => { reopened.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(reopened.getCurrent().results[machine.id]).toMatchObject({ ok: true }));
        testResponseGate = createDeferred<void>();
        const nextBefore = rpcRequests.length;
        await act(async () => { reopened.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(rpcRequests.length).toBeGreaterThan(nextBefore));
        const profileScope = storage.getState().profileScope!;
        await act(async () => { storage.getState().activateProfileScope({ ...profileScope, accountId: 'other-account' }); });
        expect(reopened.getCurrent().results).toEqual({});
        await act(async () => { testResponseGate!.resolve(); });
        await reopened.unmount();
        await act(async () => { storage.getState().activateProfileScope(profileScope); });
        const returned = await renderHook(() => useMcpServerMachineTests('server-1'));
        expect(returned.getCurrent().results).toEqual({});
    });

    it('retires a plugin declaration Test at its input boundary before an old reply can publish', async () => {
        const pluginId = 'plugin:example.compute/server';
        let definition = { ...getMcpServerCatalogSnapshot(storage.getState().settingsScope!).value!.servers[0]!,
            id: pluginId, name: 'compute' };
        const hook = await renderHook(() => useMcpServerMachineTests(pluginId, definition));
        await act(async () => { hook.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(hook.getCurrent().results[machine.id]).toMatchObject({ ok: true }));
        testResponseGate = createDeferred<void>();
        const before = rpcRequests.length;
        await act(async () => { hook.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(rpcRequests.length).toBeGreaterThan(before));
        definition = { ...definition, name: 'updated-compute' };
        await hook.rerender();
        expect(hook.getCurrent().results).toEqual({});
        await act(async () => { testResponseGate!.resolve(); });
        expect(hook.getCurrent().results).toEqual({});
        testResponseGate = null;
        await act(async () => { hook.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(hook.getCurrent().results[machine.id]).toMatchObject({ ok: true }));
    });

    it('invites an empty collection on the list page with Browse first and Paste a config beside it', async () => {
        settingsState.value = { v: 1, strictMode: false, servers: [], bindings: [] };
        await refreshCatalogFixture();
        const screen = await renderInCollectionLayout(React.createElement(McpSettingsIndex), 'stacked');
        expect(screen.findByTestId('settings.mcpServers.invitation')).not.toBeNull();
        // The brand-new composition, not another scene (RETAIN M8): the ghost ring and the two ways a server reaches.
        expect(screen.findByTestId('mcp.home.reach')).not.toBeNull();
        expect(screen.getTextContent()).toContain('capabilities.mcpHome.newAccountBody');
        expect(screen.getTextContent()).toContain('capabilities.mcpHome.newMachineBody');
        // Both open the one Add modal (P7 U7.10), never a page of their own.
        const { Modal } = await import('@/modal');
        await act(async () => { screen.findByTestId('settings.mcpServers.invitation.add')!.props.onPress(); });
        await act(async () => { screen.findByTestId('settings.mcpServers.invitation.paste')!.props.onPress(); });
        expect(vi.mocked(Modal.show)).toHaveBeenCalledTimes(2);
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('beside the rail, an empty collection is the brand-new homepage', async () => {
        settingsState.value = { v: 1, strictMode: false, servers: [], bindings: [] };
        await refreshCatalogFixture();
        const screen = await renderInCollectionLayout(React.createElement(McpSettingsIndex), 'split');
        expect(screen.find((node) => node.props?.testID === 'mcp.home.header' && typeof node.props?.title === 'string')!.props.title)
            .toBe('capabilities.mcpHome.newTitle');
        expect(screen.findByTestId('mcp.home.browse')).not.toBeNull();
        expect(screen.findByTestId('mcp.home.paste')).not.toBeNull();
    });

    it('lists each server with where it applies, flags one that applies nowhere, and adds in the collection', async () => {
        settingsState.value = {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 'server-1', name: 'playwright', transport: 'stdio',
                    stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, env: {}, createdAt: 1, updatedAt: 1,
                },
                {
                    id: 'server-2', name: 'context7', transport: 'http', remote: { url: 'https://example.com/mcp', headers: {} },
                    env: {}, createdAt: 2, updatedAt: 2,
                },
            ],
            bindings: [{
                id: 'binding-1', serverId: 'server-1', enabled: true,
                target: { t: 'machine', machineId: 'machine-1' }, createdAt: 1, updatedAt: 1,
            }],
        };
        await refreshCatalogFixture();
        const screen = await renderSettingsView(React.createElement(McpServerCollection, { variant: 'rail', selectedServerId: 'server-1' }));

        const { saveFoundWarmCacheEntry } = await import('@/sync/domains/state/warmCachePersistence');
        const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
        await prepareWarmCacheEncryptionKey();
        await act(async () => {
            saveFoundWarmCacheEntry(resolveServerProfileScopeIdForIdentifier(connection!.home.id), 'collection-owner', {
                kind: 'mcp_server', machineId: 'machine-1', observedAt: 1, result: { ok: true, servers: [1, 2].map(index => ({
                    provider: 'claude', name: `found-${index}`, transport: 'stdio', stdio: { command: 'tool', args: [] },
                    envKeys: [], enabled: true, source: { kind: 'user', path: '/config.json' },
                })) },
            });
        });
        expect(screen.findByTestId('settings.mcpServers.rail.view:found')!.props.accessibilityLabel).toContain('2');
        expect(screen.findByTestId('settings.mcpServers.rail.overview')).not.toBeNull();
        expect(rpcRequests.filter(request => request.method === 'mcp.found.list')).toHaveLength(0);

        const bound = screen.find(node => node.props.testID === 'mcp.server.card.server-1'
            && typeof node.props.whereSummary === 'string');
        expect(bound!.props.title).toBe('playwright');
        expect(bound!.props.whereSummary).toBe('capabilities.where.only');
        expect(bound!.props.selected).toBe(true);
        const unbound = screen.find(node => node.props.testID === 'mcp.server.card.server-2'
            && typeof node.props.whereSummary === 'string');
        expect(unbound!.props.whereSummary).toBe('capabilities.where.off');
        expect(screen.findGroup('capabilities.mcp.inUse')).not.toBeNull();
        expect(screen.findGroup('capabilities.mcp.off')).not.toBeNull();
        expect(screen.findByTestId('settings.mcpServers.builtIn.happier')).not.toBeNull();

        await screen.pressRow('mcp.server.card.server-2');
        await vi.waitFor(() => expect(routerReplaceSpy).toHaveBeenLastCalledWith('/settings/mcp/server-2'));

        // The rail's "+" opens the one Add modal; nothing navigates until a server is added.
        const { Modal } = await import('@/modal');
        await act(async () => { screen.findByTestId('settings.mcpServers.addServer')!.props.onPress(); });
        expect(vi.mocked(Modal.show)).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({ testID: 'mcp.add' }),
        }));
    });

    it("a phone's page leads with the homepage map and its line, then the rail's own list: the shared view switch pushes Found, with no pinned Found row", async () => {
        settingsState.value = {
            v: 1,
            strictMode: false,
            servers: [{
                id: 'server-1', name: 'playwright', transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, env: {}, createdAt: 1, updatedAt: 1,
            }],
            bindings: [],
        };
        await refreshCatalogFixture();
        const screen = await renderSettingsView(React.createElement(McpServerCollection, { variant: 'page' }));

        expect(screen.findByTestId('mcp.home.summary')).not.toBeNull();
        expect(screen.findByTestId('mcp.home.reach')).not.toBeNull();
        // The legend stays beneath the phone's map (lab np:home).
        expect(screen.findByTestId('mcp.home.legend')).not.toBeNull();
        expect(screen.findByTestId('settings.mcpServers.tool.onMachine')).toBeNull();
        // Standalone, the collection is a Settings page (R6): each group is a section sheet, never the rail's light labels.
        const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
        const { CollectionListGroupLabel } = await import('@/components/ui/lists/collection/CollectionList');
        const offSection = screen.findAllByType(ItemGroup).find(group => group.props.title === 'capabilities.mcp.off');
        expect(offSection).toBeDefined();
        expect(screen.findAllByType(CollectionListGroupLabel)).toHaveLength(0);
        const row = offSection!.find(node => node.props.testID === 'mcp.server.card.server-1' && typeof node.props.whereSummary === 'string');
        expect(row.props.density).toBe('page');
        expect(row.props.selected).toBeUndefined();

        await act(async () => { screen.findByTestId('settings.mcpServers.page.view:found')!.props.onPress(); });
        await vi.waitFor(() => expect(routerPushSpy).toHaveBeenLastCalledWith('/settings/mcp/found'));
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it("holds a phone page's list column with placeholder rows while the first read is pending, never the built-in server alone", async () => {
        settingsState.value = { v: 1, strictMode: false, servers: [], bindings: [] };
        resetMcpServerCatalogSnapshotsForTests();
        catalogReadGate = createDeferred<void>();
        const { CollectionSkeletonRows } = await import('@/components/ui/lists/collection/CollectionList');
        const screen = await renderSettingsView(React.createElement(McpServerCollection, { variant: 'page' }));

        expect(screen.findAllByType(CollectionSkeletonRows)).toHaveLength(1);
        expect(screen.findByTestId('settings.mcpServers.builtIn.happier')).toBeNull();
        expect(screen.findByTestId('settings.mcpServers.addServer')).not.toBeNull();

        await act(async () => { catalogReadGate!.resolve(); });
        await vi.waitFor(() => expect(screen.findByTestId('settings.mcpServers.builtIn.happier')).not.toBeNull());
        expect(screen.findAllByType(CollectionSkeletonRows)).toHaveLength(0);
    });

    it.each([
        { t: 'machine', machineId: 'machine-1' },
        { t: 'workspace', machineId: 'machine-1', workspaceRoot: '/repo' },
        { t: 'allMachines' },
        { t: 'project', projectKey: 'project-1' },
    ] as const)('narrows the rail from held facts without inventing Machine coverage for %j (P8 R8-6)', async target => {
        settingsState.value = {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 'server-1', name: 'playwright', transport: 'stdio',
                    stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, env: {}, createdAt: 1, updatedAt: 1,
                },
                {
                    id: 'server-2', name: 'context7', transport: 'http', remote: { url: 'https://example.com/mcp', headers: {} },
                    env: {}, createdAt: 2, updatedAt: 2,
                },
            ],
            bindings: [{
                id: 'binding-1', serverId: 'server-1', enabled: true,
                target, createdAt: 1, updatedAt: 1,
            }],
        };
        await refreshCatalogFixture();
        const screen = await renderSettingsView(React.createElement(McpServerCollection, { variant: 'rail', selectedServerId: null }));
        const card = (id: string) => screen.findAll(node => node.props.testID === `mcp.server.card.${id}` && typeof node.props.whereSummary === 'string')[0] ?? null;
        expect(card('server-1')).not.toBeNull();

        // The editor is a positioned popover; its placement listens to the browser window (a platform boundary).
        vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
        onTestFinished(() => { vi.unstubAllGlobals(); });
        await act(async () => { screen.findByTestId('settings.mcpServers.rail-filter-open')!.props.onPress(); });
        const editor = () => screen.findAll(node => node.props.testID === 'settings.mcpServers.rail-editor' && node.props.model !== undefined)[0]!;
        const fields = editor().props.model.availableFields as readonly { id: string; label: string; valueOptions: readonly { value: unknown; label?: string }[] }[];
        const status = fields.find(field => field.id === 'status')!;
        const runsOn = fields.find(field => field.id === 'runsOn')!;
        expect(status.label).toBe('sessionsList.filtersStatus');
        expect(runsOn.label).toBe('sessionsList.filtersRunsOn');
        // Values are the status owner's words and machine names, never raw enums or ids.
        expect(status.valueOptions).toContainEqual({ value: 'off', label: 'capabilities.status.off' });
        const namedMachine = target.t === 'machine' || target.t === 'workspace';
        expect(runsOn.valueOptions.map(option => option.value)).toEqual(namedMachine ? ['machine-1'] : []);
        if (namedMachine) expect(runsOn.valueOptions[0]!.label).toEqual(expect.any(String));

        await act(async () => { editor().props.onChange({ type: 'add', condition: { fieldId: 'status', operator: 'is', values: ['off'] } }); });
        expect(card('server-1')).toBeNull();
        expect(card('server-2')).not.toBeNull();
        expect(screen.findByTestId('settings.mcpServers.rail-filter-token:status')).not.toBeNull();
        expect(screen.findAll(node => node.props.testID === 'settings.mcpServers.rail-filter-open' && node.props.activeCount === 1)).not.toHaveLength(0);

        await act(async () => { editor().props.onChange({ type: 'clear' }); });
        expect(card('server-1')).not.toBeNull();
        expect(screen.findByTestId('settings.mcpServers.rail-filter-token:status')).toBeNull();
        await act(async () => { editor().props.onChange({ type: 'add', condition: { fieldId: 'runsOn', operator: 'is', values: ['machine-1'] } }); });
        expect(card('server-1') !== null).toBe(namedMachine);
    });

    it('scans every discovery source and enables adoption only after the Account catalog is writable', async () => {
        detectedResponse = {
            ok: true,
            servers: [{
                provider: 'codex',
                name: 'github',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
                envKeys: [],
                enabled: true,
                source: { kind: 'user', path: '~/.codex/config.toml' },
            }],
        };
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), accountId: 'collection-owner' };
        const screen = await renderSettingsView(React.createElement(McpDetectedServersScreen));
        await flushHookEffects();

        // No provider filter travels: the selected machine's daemon scans every
        // MCP discovery source its own registry holds, including an installed
        // Agent's, instead of this binary's bundled Agent list.
        await vi.waitFor(() => expect(rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT))).toEqual([
            { home: connection!.home.serverUrl, method: `machine-1:${RPC_METHODS.DAEMON_MCP_SERVERS_DETECT}`, input: { machineId: 'machine-1' } },
        ]));
        await vi.waitFor(() => expect(screen.findByTestId('mcp.found.action.machine-1.codex.github')).not.toBeNull());
        const importButton = () => screen.find(node => node.props.testID === 'mcp.found.action.machine-1.codex.github'
            && typeof node.props.disabled === 'boolean');
        await vi.waitFor(() => expect(importButton().props.disabled).toBe(false));
        catalogReadGate = createDeferred<void>();
        let refreshing!: Promise<void>;
        act(() => { refreshing = refreshMcpServerCatalog(scope); });
        await flushHookEffects();
        // Discovery can finish while this Account's catalog is still refreshing.
        // Keep the found row, but do not offer a write the current authority refuses.
        expect(getMcpServerCatalogSnapshot(scope)).toMatchObject({ status: 'loading', authority: 'active', stale: true, revision: 1 });
        await vi.waitFor(() => expect(screen.find(node => node.props.testID === 'mcp.found.checkAgain'
            && typeof node.props.disabled === 'boolean').props.disabled).toBe(false));
        await vi.waitFor(() => expect(importButton().props.disabled).toBe(true));
        expect(catalogWrites).toEqual([]);
        await act(async () => { catalogReadGate!.resolve(); await refreshing; });
        await vi.waitFor(() => expect(importButton().props.disabled).toBe(false));

        await act(async () => {
            await screen.find((node) => node.props?.testID === 'mcp.found.action.machine-1.codex.github' && typeof node.props?.onPress === 'function').props.onPress();
        });
        await flushHookEffects();

        const { Modal } = await import('@/modal');
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(Modal.alert).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(catalogWrites).toHaveLength(1));
        const written = settingsState.value;
        const imported = written.servers.find((server) => server.name === 'github');
        expect(imported).toBeTruthy();
        await vi.waitFor(() => expect(routerReplaceSpy).toHaveBeenLastCalledWith(`/settings/mcp/${imported!.id}`));
        expect(written.bindings.find(binding => binding.serverId === imported!.id)?.target).toEqual({ t: 'allMachines' });
        expect(accountSettingsWrites).toEqual([]);
    });

    it.each([
        ['a future settings version', {
            v: 2,
            strictMode: false,
            servers: [],
            bindings: [],
        }],
        ['a schema-invalid duplicate server id', {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 'duplicate',
                    name: 'first',
                    transport: 'stdio',
                    stdio: { command: 'node', args: [] },
                    env: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'duplicate',
                    name: 'second',
                    transport: 'stdio',
                    stdio: { command: 'node', args: [] },
                    env: {},
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
            bindings: [],
        }],
        // A schema-valid v1 source is not retained here: with an active destination the
        // catalog observer legitimately retires it (serverCatalogV1 cleanup), racing this write.
    ] satisfies ReadonlyArray<readonly [string, unknown]>)('changes failure policy without overwriting retained legacy MCP data (%s)', async (_case, rawSettings) => {
        accountSettings = { ...accountSettings, mcpServersSettingsV1: rawSettings };
        storage.setState({ settings: settingsParse(accountSettings) });
        // Exercise the Settings owner independently of the catalog observer's legitimate legacy transfer.
        await act(async () => {
            const result = await createFrontDoorActionExecute()('settings.set', {
                anchor: 'session.mcpServersStrictMode', value: true,
            }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: connection!.home.id, expectedAccountId: 'collection-owner' });
            expect(result).toMatchObject({ ok: true });
        });

        await vi.waitFor(() => expect(accountSettings).toMatchObject({ mcpServersStrictMode: true, mcpServersSettingsV1: rawSettings }));
        expect(accountSettingsWrites).toEqual(expect.arrayContaining([
            expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                mcpServersStrictMode: true, mcpServersSettingsV1: rawSettings,
            }) } }),
        ]));
        expect(accountSettings.mcpServersSettingsV1).toEqual(rawSettings);
        expect(catalogWrites).toEqual([]);
    });

    it('reads every reachable Account machine once, groups each by Agent, keeps an offline machine and a failed read in their own sections, and Check again asks every machine', async () => {
        const scope = storage.getState().settingsScope!;
        const server = (provider: DetectedMcpServerV1['provider'], name: string, args: string[]): DetectedMcpServerV1 => ({
            provider, name, transport: 'stdio', stdio: { command: 'npx', args }, envKeys: [], enabled: true,
            source: { kind: 'user', path: `~/.${provider}/config` },
        });
        const second = createMachineFixture({ id: 'machine-2', activeAt: Date.now(), access: machine.access, metadata: { ...machine.metadata!, host: 'nl2', displayName: 'nl2' } });
        const away = createMachineFixture({ id: 'machine-away', active: false, activeAt: 1, access: machine.access, metadata: { ...machine.metadata!, host: 'away', displayName: 'Away' } });
        accountMachines = [second, away];
        storage.getState().applyMachines([machine, second, away], true, { sourceServerId: scope.serverId });
        observeMachinePresenceForTest(scope, [machine.id, second.id, away.id]);
        detectedByMachine = {
            'machine-1': { ok: true, servers: [
                server('codex', 'github', ['-y', '@modelcontextprotocol/server-github']),
                // The catalog already holds this command: the row says so instead of offering Add.
                server('claude', 'playwright', ['-y', '@playwright/mcp@latest']),
                server('codex', 'linear', ['-y', 'linear-mcp']),
            ] },
            'machine-2': { ok: false, errorCode: 'internal_error', error: 'Scan failed' },
        };
        const { saveFoundWarmCacheEntry } = await import('@/sync/domains/state/warmCachePersistence');
        saveFoundWarmCacheEntry(scope.serverId, scope.accountId, { kind: 'mcp_server', machineId: 'machine-away', observedAt: 1,
            result: { ok: true, servers: [server('claude', 'notes', ['-y', 'notes-mcp'])] } });
        const detects = () => rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT)).map(item => item.method.split(':')[0]).sort();

        const screen = await renderSettingsView(React.createElement(McpDetectedServersScreen));
        await flushHookEffects();

        // Opening reads each reachable machine once; the offline one is not asked.
        await vi.waitFor(() => expect(detects()).toEqual(['machine-1', 'machine-2']));
        await vi.waitFor(() => expect(screen.findByTestId('mcp.found.row.machine-1.codex.github')).not.toBeNull());
        const rowIds = () => screen.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string'
            && node.props.testID.startsWith('mcp.found.row.machine-1.')).map(node => node.props.testID);
        expect([...new Set(rowIds())]).toEqual(['mcp.found.row.machine-1.codex.github', 'mcp.found.row.machine-1.codex.linear',
            'mcp.found.row.machine-1.claude.playwright']);
        expect(screen.findByTestId('mcp.found.action.machine-1.claude.playwright')?.props.onPress).toBeUndefined();
        // One machine's failed read stays in its own section.
        await vi.waitFor(() => expect(screen.findByTestId('mcp.found.failed.machine-2')).not.toBeNull());
        expect(screen.findByTestId('mcp.found.failed.machine-1')).toBeNull();
        // The offline machine keeps its last known servers, dated, with Add off.
        expect(screen.findByTestId('mcp.found.row.machine-away.claude.notes')).not.toBeNull();
        expect(screen.findByTestId('mcp.found.offline.machine-away')).not.toBeNull();
        expect(screen.find(node => node.props.testID === 'mcp.found.action.machine-away.claude.notes'
            && typeof node.props.disabled === 'boolean').props.disabled).toBe(true);

        // Check again is the user asking: it reaches every machine, the offline one included.
        rpcRequests.length = 0;
        await vi.waitFor(() => expect(screen.find(node => node.props.testID === 'mcp.found.checkAgain'
            && typeof node.props.disabled === 'boolean').props.disabled).toBe(false));
        await act(async () => { await screen.pressByTestIdAsync('mcp.found.checkAgain'); });
        await vi.waitFor(() => expect(detects()).toEqual(['machine-1', 'machine-2', 'machine-away']));
    });
});
