import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema, SessionCurrentProjectionRecordV1Schema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import { MemorySearchQueryV1Schema } from '@happier-dev/protocol/memory/memorySearch';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { SessionViewerProjectionV1Schema } from '@happier-dev/protocol/sessions/personal/viewer';
import { QUIET_SESSION_PERSONAL_ATTENTION_V1 } from '@happier-dev/protocol/sessions/personal/attention';
import { createDeferred, createMachineFixture, createSessionFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen as renderScreenWithTestkit, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createAccountTokenForTests, createHomeGovernanceHarness, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { SelectionListProps } from '@/components/ui/selectionList';
import type { SelectionListSectionFailure } from '@/components/ui/selectionList/selectionListSectionFailure';
import type { SessionOrganizationProjection } from '@/sync/domains/session/organization/types';
import type { UniversalSearchControllerProps } from './UniversalSearchController';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { t } from '@/text';
import type { WorkspaceFileEditorState } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState';

const HOME_A = 'srv_fsp_controller_a';
const HOME_B = 'srv_fsp_controller_b';
let localHomeB = '';
let controllerConnection: Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').restoreServerAccountForTest>> | undefined;
const harness = vi.hoisted(() => ({
    routerNavigate: vi.fn(), routerPush: vi.fn(), modalAlert: vi.fn(),
    pathname: '/', params: {} as Record<string, string>,
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: harness.modalAlert } }).module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => harness.pathname, params: () => harness.params,
        router: { push: harness.routerPush, navigate: harness.routerNavigate } }).module;
});

const network = await installSessionOpsNetworkBoundary();
const selectedHomes = createHomeGovernanceHarness();
let concurrentFixtureStarted = false;
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { setServerProfileIdentityForUrl, upsertServerProfile, removeServerProfile, listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { parseToken } = await import('@/utils/auth/parseToken');
const { AppShellPluginUiProjectionValueProvider, useAppShellPluginUiProjection } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
const { readCurrentAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { useDetailsTabUnsavedKeys } = await import('@/components/appShell/panes/details/workspace/detailsTabChrome');
const { buildProjectPaneScopeId } = await import('@/components/projects/detail/projectPaneScope');
const { useWorkspaceFileEditorState } = await import('@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState');
const { readWorkspaceFileEditorDraft } = await import('@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraft');
const { ChatFindSeedHost } = await import('@/components/appShell/panes/fileFindSeedHost');
const { createTranscriptFindModel } = await import('@/components/sessions/transcript/find/useTranscriptFind');
const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { serializeWorkspaceLayout, workspaceLayoutScopeKey } = await import('@/components/appShell/workspace/workspacePersistence');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { useRegisterSessionPaneDriver } = await import('@/components/sessions/panes/useRegisterSessionPaneDriver');
const { installBrowserRuntimeForTests } = await import('@/dev/testkit/harness/browserRuntimeHarness');
let browserRuntime: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;

const fixture = {
    homeSearch: vi.fn<(request: Record<string, unknown>) => Promise<unknown>>(),
    daemonRpc: vi.fn(async (_request: { method: string; payload: unknown; serverId: string; accountId: string | null; machineId: string }) => DEFAULT_MEMORY_SETTINGS as unknown),
    featureEnabled: { search: true, 'memory.search': false } as Record<string, boolean>,
    memoryMachine: null as null | { serverId: string; machine: { id: string; active?: boolean; activeAt?: number } },
    workspaceRefs: [] as WorkspaceRefV1[],
    sessionListRows: [] as Array<{ serverId: string | null; serverName: string | null; session: { id: string; updatedAt: number; archivedAt?: number | null; metadata: { name: string; path?: string } } }>,
    sessionOrganizationProjection: null as SessionOrganizationProjection | null,
    portableIdentity: false, singleHome: false,
    scopedPluginProjections: new Map<string, ReturnType<typeof PluginProjectionV2Schema.parse>>(),
    observedAmbientProjection: null as PluginUiProjectionModel | null,
    inventoryFailure: false,
    inventoryHold: null as Promise<void> | null,
    inventorySignals: [] as AbortSignal[],
};
let mountedSearch: Awaited<ReturnType<typeof renderScreenWithTestkit>> | undefined;
let SelectionList: typeof import('@/components/ui/selectionList')['SelectionList'];
// ReactTestInstance erases the props type; this node is the actual typed SelectionList.
const selectionListProps = (): SelectionListProps | null => (mountedSearch?.findByType(SelectionList).props as SelectionListProps | undefined) ?? null;
const inventoryRequests = () => network.httpRequests.filter(request => new URL(request.url).pathname === '/v2/sessions');
const homeUrl = (id: string) => id === HOME_A ? 'https://home-a.example.test' : 'https://home-b.example.test';
function wireSession(id: string, metadata: Readonly<{ name: string; path?: string }> = { name: 'Scoped Session', path: '/repo/b' }, archivedAt: number | null = null, updatedAt = 1) {
    const admittedMetadata = MetadataSchema.parse(metadata);
    const session = createSessionFixture({ id, metadata: admittedMetadata, seq: 100, updatedAt, active: archivedAt === null, archivedAt, activeAt: Date.now() });
    return SessionCurrentProjectionRecordV1Schema.parse({ ...session,
        metadata: JSON.stringify(admittedMetadata), metadataLayoutVersion: 0, agentState: null, dataEncryptionKey: null,
        share: null, effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
        responsibleAccountId: null, responsibleAccount: null, pendingCount: 0, pendingVersion: 0,
        viewer: SessionViewerProjectionV1Schema.parse({
            latestFailureSeq: null,
            readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
            follow: { follows: false, notificationLevel: null }, notification: { level: 'important', source: 'owner' },
            attention: QUIET_SESSION_PERSONAL_ATTENTION_V1,
        }),
    });
}
async function mutateHomeBCredentials() {
    await network.setAccount(homeUrl(HOME_B), 'account-1');
    expect(await TokenStorage.setCredentialsForServerUrl(homeUrl(HOME_B), { serverId: HOME_B }, { token: createAccountTokenForTests('account-1') })).toBe(true);
}
async function prepareControllerFixture() {
    const { clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
    clearMachineRequestReachabilityForTest();
    for (const profile of listServerProfiles()) {
        if (profile.serverUrl === homeUrl(HOME_A) || profile.serverUrl === homeUrl(HOME_B)) await removeServerProfile(profile.id);
    }
    const profiles = [];
    for (const [serverId, accountId, name] of [[HOME_A, 'account-a', 'Home A'], [HOME_B, 'account-1', 'Home B']] as const) {
        await upsertServerProfile({ serverUrl: homeUrl(serverId), name });
        const home = await network.addHome(homeUrl(serverId), accountId);
        await upsertServerProfile({ serverUrl: home.serverUrl, name });
        if (serverId === HOME_B) localHomeB = home.id;
        await setServerProfileIdentityForUrl(home.serverUrl, serverId);
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId }, { token: home.token })).toBe(true);
        profiles.push(home);
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: serverId }, homeSearch: { enabled: true } } });
        tryWriteServerEnabledBitInPlace(features, 'search', fixture.featureEnabled.search);
        if (fixture.scopedPluginProjections.size) {
            tryWriteServerEnabledBitInPlace(features, 'plugins', true);
            tryWriteServerEnabledBitInPlace(features, 'plugins.ui', true);
        }
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features } });
    }
    await upsertAndActivateServer({ serverUrl: homeUrl(fixture.singleHome ? HOME_B : HOME_A), name: fixture.singleHome ? 'Home B' : 'Home A' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    if (fixture.singleHome) await removeServerProfile(profiles[0]!.id);
    const machine = fixture.memoryMachine || fixture.scopedPluginProjections.size
        ? createMachineFixture({ ...fixture.memoryMachine?.machine, id: fixture.memoryMachine?.machine.id ?? 'machine-b',
            activeAt: fixture.memoryMachine?.machine.activeAt ?? Date.now() }) : null;
    const httpResponse: Parameters<typeof network.setHttpResponder>[0] = async (input, init) => {
        const url = new URL(String(input));
        const serverId = url.origin === homeUrl(HOME_A) ? HOME_A : HOME_B;
        if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') {
            const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: serverId }, homeSearch: { enabled: true } } });
            tryWriteServerEnabledBitInPlace(features, 'search', fixture.featureEnabled.search);
            tryWriteServerEnabledBitInPlace(features, 'plugins', fixture.scopedPluginProjections.size > 0);
            tryWriteServerEnabledBitInPlace(features, 'plugins.ui', fixture.scopedPluginProjections.size > 0);
            return Response.json(features);
        }
        if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
            experiments: true, featureToggles: { 'memory.search': fixture.featureEnabled['memory.search'] },
        } }, version: 1 });
        if (url.pathname === '/v1/home/search') {
            const authorization = new Headers(init?.headers).get('Authorization');
            const accountId = authorization?.startsWith('Bearer ') ? parseToken(authorization.slice('Bearer '.length)) : null;
            return Response.json(await fixture.homeSearch({ ...JSON.parse(String(init?.body)), serverId, accountId }));
        }
        if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
        if (url.pathname === '/v1/machines') return Response.json(machine ? [{ ...createPlainMachineRowFixture({
            id: fixture.scopedPluginProjections.size && serverId === HOME_A ? 'machine-a' : machine.id,
            accountId: serverId === HOME_A ? 'account-a' : 'account-1',
        }),
            active: machine.active, activeAt: machine.activeAt,
        }] : []);
        if (url.pathname.startsWith('/v1/machines/')) return createPlainMachineReadHttpResponseFixture(url.pathname, init, serverId === HOME_A ? 'account-a' : 'account-1');
        if (url.pathname.startsWith('/v2/sessions/')) {
            if (url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], hasNext: false, nextCursor: null });
            if (url.pathname === '/v2/sessions/archived') return Response.json({ sessions: fixture.sessionListRows.filter(row => row.serverId === serverId && row.session.archivedAt).map(row => wireSession(row.session.id, row.session.metadata, row.session.archivedAt, row.session.updatedAt)), hasNext: false, nextCursor: null });
            return Response.json({ session: wireSession(decodeURIComponent(url.pathname.slice('/v2/sessions/'.length))) });
        }
        if (url.pathname === '/v2/sessions') {
            if (init?.signal) fixture.inventorySignals.push(init.signal);
            if (fixture.inventoryHold) await fixture.inventoryHold;
            if (fixture.inventoryFailure) return Response.json({ error: 'unavailable' }, { status: 503 });
            return Response.json({ sessions: fixture.sessionListRows.filter(row => row.serverId === serverId && !row.session.archivedAt).map(row => wireSession(row.session.id, row.session.metadata, null, row.session.updatedAt)), hasNext: false, nextCursor: null });
        }
        return null;
    };
    const sessionReadResponse = createSessionReadBatchFetchBoundary(httpResponse);
    network.setHttpResponder(sessionReadResponse);
    network.setRpcAckResponder(async call => {
        const serverId = call.serverUrl === homeUrl(HOME_A) ? HOME_A : HOME_B;
        try {
            const result = call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                ? { protocolVersion: 1, projection: fixture.scopedPluginProjections.get(`${serverId}:${call.targetId}`) ?? PluginProjectionV2Schema.parse({ v: 2, generation: 0 }) }
                : await fixture.daemonRpc({ method: call.method, payload: call.payload, serverId,
                    accountId: call.token ? parseToken(call.token) : null, machineId: call.targetId });
            return { ok: true, result };
        } catch (error) {
            if (error instanceof Error && 'rpcErrorCode' in error && typeof error.rpcErrorCode === 'string') {
                return { ok: false, error: error.message, errorCode: error.rpcErrorCode };
            }
            throw error;
        }
    });
    if (fixture.scopedPluginProjections.size) {
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        controllerConnection = await restoreServerAccountForTest({ serverUrl: homeUrl(fixture.singleHome ? HOME_B : HOME_A),
            serverIdentityId: fixture.singleHome ? HOME_B : HOME_A, accountId: fixture.singleHome ? 'account-1' : 'account-a',
            additionalRequestOrigins: [homeUrl(HOME_B)], request: sessionReadResponse });
        await waitForHomeGovernance(() => {
            if (!storage.getState().isDataReady) throw new Error('Controller fixture Sync bootstrap is not ready');
        });
        // The foreign inventory belongs to the actual multi-Home Account runtime,
        // so a new Search credential binding can validate rather than retire it.
        await selectedHomes.selectHomes([HOME_A, HOME_B]);
        const { startConcurrentSessionCacheSync, isConcurrentSessionListQueryHomeOnline } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        startConcurrentSessionCacheSync();
        concurrentFixtureStarted = true;
        await waitForHomeGovernance(() => {
            if (!isConcurrentSessionListQueryHomeOnline(HOME_B)) throw new Error('Home B Account runtime is not established');
            expect(storage.getState().machineListByServerId[HOME_B]?.some(machine => machine.id === 'machine-b')).toBe(true);
        });
    }
    storage.setState({
        isDataReady: true,
        profileScope: { serverId: fixture.singleHome ? HOME_B : HOME_A, accountId: fixture.singleHome ? 'account-1' : 'account-a' }, endpointStatus: 'online',
        settingsScope: { serverId: fixture.singleHome ? HOME_B : HOME_A, accountId: fixture.singleHome ? 'account-1' : 'account-a' }, settingsVersion: 1,
        settings: { ...storage.getState().settings, experiments: true, featureToggles: { 'memory.search': fixture.featureEnabled['memory.search'] },
            machineAdministrationTargetsLocalV1: machine ? { 'memory.settings': { serverIdentityId: HOME_B, machineId: machine.id } } : {} },
        machines: fixture.scopedPluginProjections.size ? storage.getState().machines : {},
        machineListByServerId: fixture.scopedPluginProjections.size ? storage.getState().machineListByServerId : machine ? { [HOME_B]: [machine] } : {},
        machineListStatusByServerId: { [HOME_A]: 'idle', [HOME_B]: 'idle' },
        sessionListRowsByServerId: {},
    });
    applyProjectAccountRowsFixture(storage, { workspaceRefs: fixture.workspaceRefs });
    if (fixture.sessionOrganizationProjection) {
        for (const tag of Object.values(fixture.sessionOrganizationProjection.tagsById)) {
            storage.getState().upsertSessionOrganizationTagOptimistic(HOME_B, tag);
        }
        for (const [sessionId, tagIds] of Object.entries(fixture.sessionOrganizationProjection.tagAssignmentsBySessionId)) {
            storage.getState().setSessionTagAssignmentsOptimistic(HOME_B, sessionId, tagIds);
        }
    }
}
function AmbientPluginProjectionProbe() {
    fixture.observedAmbientProjection = useAppShellPluginUiProjection().pluginUiProjection;
    return null;
}
function DismissibleSearch(props: Readonly<{ element: React.ReactElement<UniversalSearchControllerProps> }>) {
    const [open, setOpen] = React.useState(true);
    return open ? React.cloneElement(props.element, { onRequestClose: () => {
        setOpen(false);
        props.element.props.onRequestClose();
    } }) : null;
}
function DirtyReplaceEditor(props: Readonly<{ observe(editor: WorkspaceFileEditorState, unsaved: boolean): void }>) {
    const pane = useAppPaneScope(buildProjectPaneScopeId('ws-replace', HOME_B, 'dirty-editor-instance'));
    const tab = React.useMemo(() => createWorkspaceFileDetailsTab('/repo/src/dirty.ts'), []);
    React.useEffect(() => { pane.openDetailsTab(tab, { intent: 'pinned' }); }, [pane.openDetailsTab, tab]);
    const { chromeFor, unsavedKeys } = useDetailsTabUnsavedKeys(pane.pinDetailsTab);
    const chrome = chromeFor(tab.key);
    const persistDraft = React.useCallback((draft: Parameters<typeof useWorkspaceFileEditorState>[0]['persistedDraft']) => {
        pane.patchDetailsTabState(tab.key, draft ?? { accountId: null, isEditingFile: false,
            editorOriginalHash: undefined, editorText: undefined });
    }, [pane.patchDetailsTabState, tab.key]);
    const editor = useWorkspaceFileEditorState({
        scope: { serverId: HOME_B, machineId: 'machine-b', rootPath: '/repo' }, accountId: 'account-1',
        filePath: 'src/dirty.ts', displayMode: 'file', fileText: 'routeKey()', fileHash: 'a'.repeat(64),
        fileWriteSupported: true, setFileWriteSupported: () => {}, fileEditorFeatureEnabled: true,
        filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
        filesEditorAutoSave: false, filesEditorChangeDebounceMs: 0, mountedRef: { current: true }, refreshAll: async () => {},
        persistedDraft: readWorkspaceFileEditorDraft(pane.scopeState?.details.tabState[tab.key], 'account-1'), persistDraft,
    });
    React.useEffect(() => chrome.setUnsaved(editor.editorDirty), [chrome, editor.editorDirty]);
    props.observe(editor, unsavedKeys.has(tab.key));
    return null;
}
async function renderScreen(element: React.ReactElement<UniversalSearchControllerProps>, destination?: React.ReactNode,
    wrap?: (content: React.ReactNode) => React.ReactNode | Promise<React.ReactNode>) {
    await prepareControllerFixture();
    // A local profile seed is resolved only after its real Home profile exists.
    if (fixture.portableIdentity) {
        if (!element.props.initialScope) throw new Error('Portable profile fixture requires an explicit scope');
        element = React.cloneElement(element, { initialScope: { ...element.props.initialScope, serverId: localHomeB } });
    }
    const ambientWire = fixture.scopedPluginProjections.get(`${HOME_A}:machine-a`);
    let content: React.ReactNode = wrap ? <DismissibleSearch element={element} /> : element;
    if (ambientWire) {
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime?.isCurrent()) throw new Error('Ambient plugin fixture requires the real active Account lifetime');
        content = <AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: normalizePluginUiProjection(ambientWire), pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: 'machine-a', serverId: HOME_A,
            platform: 'web', accountLifetime, clientExecutableActivation: { status: 'ready' },
            reloadConnectedAccountProjection: vi.fn(), reloadClientExecutables: vi.fn(),
        }}><AmbientPluginProjectionProbe />{element}</AppShellPluginUiProjectionValueProvider>;
    }
    if (destination) content = <AppPaneProvider>{wrap ? await wrap(<>{content}{destination}</>) : <>{content}{destination}</>}</AppPaneProvider>;
    mountedSearch = await renderScreenWithTestkit(<InjectedAuthProvider credentials={{ token: createAccountTokenForTests('account-a') }}>{content}</InjectedAuthProvider>);
    await flushHookEffects({ cycles: 4, turns: 2 });
    return mountedSearch;
}
beforeEach(() => {
    network.resetRequests();
    retireActiveServerAccountScopeLifetime();
    clearDaemonMergedProjectionCacheForTests();
    storage.setState(storage.getInitialState(), true);
    fixture.homeSearch.mockReset().mockResolvedValue({ v: 1, ok: true, hits: [] });
    fixture.daemonRpc.mockReset().mockResolvedValue(DEFAULT_MEMORY_SETTINGS);
    fixture.featureEnabled = { search: true, 'memory.search': false };
    fixture.memoryMachine = null; fixture.workspaceRefs = []; fixture.sessionListRows = [];
    fixture.sessionOrganizationProjection = null; fixture.portableIdentity = false; fixture.singleHome = false;
    fixture.scopedPluginProjections.clear(); fixture.inventoryFailure = false; fixture.inventoryHold = null; fixture.inventorySignals = [];
    fixture.observedAmbientProjection = null;
    harness.pathname = '/'; harness.params = {};
    vi.clearAllMocks();
});
afterEach(async () => {
    standardCleanup(); mountedSearch = undefined;
    if (concurrentFixtureStarted) (await import('@/sync/runtime/orchestration/concurrentSessionCache')).stopConcurrentSessionCacheSync();
    concurrentFixtureStarted = false;
    if (controllerConnection) await controllerConnection.dispose();
    else await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
    controllerConnection = undefined;
    retireActiveServerAccountScopeLifetime();
    browserRuntime?.restore(); browserRuntime = undefined;
});
afterAll(() => network.dispose());
beforeAll(async () => {
    ({ SelectionList } = await import('@/components/ui/selectionList'));
    await import('./UniversalSearchController');
}, 300_000);

function pluginSearchProjection(input: Readonly<{ pluginId: string; title: string; generation: number }>) {
    const providerId = `searchProvider:${input.pluginId}:entries`;
    return PluginProjectionV2Schema.parse({
        v: 2, generation: input.generation,
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
            [providerId]: { id: providerId, pluginId: input.pluginId, occurrenceId: `occurrence-${input.pluginId}`, contributionKind: 'searchProvider', descriptorId: 'entries',
                identity: { pluginId: input.pluginId, localId: 'entries' }, action: { pluginId: input.pluginId, localId: 'search' } },
        } } },
        actionsById: { [`${input.pluginId}/search`]: { id: 'search', pluginId: input.pluginId, occurrenceId: `occurrence-${input.pluginId}`, title: input.title, icon: 'action',
            scopes: ['global'], surfaces: ['ui'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true } },
    });
}

describe('UniversalSearchController exact Home scope', () => {
    it('renders a known indexed reply before document admission finishes, then adds admitted documents', async () => {
        fixture.featureEnabled = { search: false, 'memory.search': true };
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-b' } };
        const documents = createDeferred<void>();
        let documentsReleased = false;
        fixture.daemonRpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return {
                v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false, deepIndexReady: true,
                activeIndexReady: true, activeIndexSearchable: true, embeddingsEnabled: false,
                embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
                embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
                tier1DbPath: null, deepDbPath: '/memory/deep.sqlite', tier1DbBytes: null, deepDbBytes: 1,
                documentSearchSupported: true,
            };
            const query = MemorySearchQueryV1Schema.parse(call.payload);
            if (query.corpora?.includes('documents')) {
                await documents.promise;
                return { v: 1, ok: true, documents: { state: 'ready' }, hits: [{ type: 'artifact',
                    ref: { kind: 'doc', serverId: HOME_B, artifactId: 'orchard-memory' },
                    revision: { headerVersion: 1, bodyVersion: 1 }, location: 'facts',
                    summary: 'amber orchard document', score: 0.5 }] };
            }
            return { v: 1, ok: true, hits: [{ sessionId: 'session-b', seqFrom: 7, seqTo: 7,
                createdAtFromMs: 1, createdAtToMs: 1, summary: 'amber orchard, silver meadow', score: 0.5 }] };
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        try {
            const screen = await renderScreen(<UniversalSearchController commands={[]} initialQuery="amber orchard"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                presentation="modal" onRequestClose={vi.fn()} />);
            await act(async () => {
                await vi.waitFor(() => expect(JSON.stringify(screen.tree.toJSON())).toContain('silver meadow'));
            });
            expect(documentsReleased).toBe(false);
            expect(JSON.stringify(screen.tree.toJSON())).not.toContain('amber orchard document');
            documentsReleased = true;
            await act(async () => { documents.resolve(); await flushHookEffects({ cycles: 4, turns: 2 }); });
            await vi.waitFor(() => expect(JSON.stringify(screen.tree.toJSON())).toContain('amber orchard document'));
            expect(JSON.stringify(screen.tree.toJSON())).toContain('silver meadow');
        } finally { documents.resolve(); }
    });
    it('keeps old-daemon Session hits usable with explicit unavailable document coverage', async () => {
        fixture.featureEnabled = { search: false, 'memory.search': true };
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-b' } };
        fixture.daemonRpc.mockImplementation(async (call) => {
            if (call.method === 'daemon.memory.settings.get') return DEFAULT_MEMORY_SETTINGS;
            if (call.method === 'daemon.memory.status') throw Object.assign(new Error('Older daemon'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            });
            return { v: 1, ok: true, hits: [{ sessionId: 'session-b', seqFrom: 9, seqTo: 9,
                createdAtFromMs: 1, createdAtToMs: 1, summary: 'Old transcript match', score: 0.5 }] };
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(<UniversalSearchController commands={[]} initialQuery="recovery"
            initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
            presentation="modal" onRequestClose={vi.fn()} />);
        const section = selectionListProps()?.rootStep.sections.find((item) => item.id === 'transcript');
        if (!section || section.kind !== 'dynamic') throw new Error('Memory search section missing');
        const resolved = await section.resolve('recovery', new AbortController().signal);
        expect(resolved.options).toHaveLength(1);
        expect(resolved.resultHint).toContain('Memory document search is unavailable here.');
        const query = fixture.daemonRpc.mock.calls.find(([call]) => call.method === 'daemon.memory.search')?.[0];
        expect(query?.payload).not.toHaveProperty('corpora');
        const option = resolved.options[0]!;
        await act(async () => {
            option.onSelect?.();
            selectionListProps()?.onSelect?.(option.id, option);
            await vi.waitFor(() => expect(harness.routerNavigate).toHaveBeenCalledWith('/session/session-b?serverId=srv_fsp_controller_b&jumpSeq=9', expect.objectContaining({ dangerouslySingular: expect.any(Function) })));
        });
    });

    it('keeps mixed memory hits and opens their named topic through the qualified document route', async () => {
        fixture.featureEnabled['memory.search'] = true;
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-b' } };
        fixture.homeSearch.mockResolvedValue({ v: 1, ok: true, hits: [{ sessionId: 'session-b',
            seqFrom: 7, seqTo: 7, createdAtFromMs: 1, createdAtToMs: 1,
            summary: 'Past release discussion', score: 0.5 }] });
        const statusFixture = {
            v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false,
            deepIndexReady: true, activeIndexReady: true, activeIndexSearchable: true, embeddingsEnabled: false,
            embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
            embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
            tier1DbPath: null, deepDbPath: '/memory/deep.sqlite', tier1DbBytes: null, deepDbBytes: 1,
            documentSearchSupported: true,
        };
        const resultFixture = {
            v: 1, ok: true, documents: { state: 'ready' }, hits: [
                { type: 'artifact', ref: { kind: 'doc', serverId: HOME_B, artifactId: 'memory/b' },
                    revision: { headerVersion: 1, bodyVersion: 2 },
                    location: { type: 'topic', title: 'Release & recovery' }, factId: 'fact/b',
                    summary: 'Keep release recovery steps', score: 0.8 },
                { type: 'artifact', ref: { kind: 'doc', serverId: HOME_B, artifactId: 'memory/b' },
                    revision: { headerVersion: 1, bodyVersion: 2 },
                    location: { type: 'topic', title: 'facts' }, factId: 'same-fact',
                    summary: 'Named facts topic', score: 0.7 },
                { type: 'artifact', ref: { kind: 'doc', serverId: HOME_B, artifactId: 'memory/b' },
                    revision: { headerVersion: 1, bodyVersion: 2 }, location: 'facts', factId: 'same-fact',
                    summary: 'Key facts section', score: 0.6 },
                { sessionId: 'session-b', seqFrom: 7, seqTo: 7,
                    createdAtFromMs: 1, createdAtToMs: 1, summary: 'Past release discussion', score: 0.5 },
            ],
        };
        fixture.daemonRpc.mockImplementation(async call => call.method === 'daemon.memory.settings.get' ? DEFAULT_MEMORY_SETTINGS
            : call.method === 'daemon.memory.status' ? statusFixture : resultFixture);
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(<UniversalSearchController commands={[]} initialQuery="recovery"
            initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
            presentation="modal" onRequestClose={vi.fn()} />);
        const section = selectionListProps()?.rootStep.sections.find((item) => item.id === 'transcript');
        if (!section || section.kind !== 'dynamic') throw new Error('Memory search section missing');
        const resolved = await section.resolve('recovery', new AbortController().signal);
        expect(resolved.options.map((option) => option.label))
            .toContain('Keep release recovery steps');
        expect(fixture.homeSearch).toHaveBeenCalledWith(expect.objectContaining({ serverId: HOME_B, accountId: 'account-1' }));
        const query = fixture.daemonRpc.mock.calls.find(([call]) => call.method === 'daemon.memory.search')?.[0];
        expect(query).toMatchObject({ serverId: HOME_B, accountId: 'account-1', machineId: 'machine-b',
            payload: { corpora: ['documents'] } });
        expect(resolved.options).toHaveLength(4);
        expect(new Set(resolved.options.map((option) => option.id)).size).toBe(4);
        const memoryOption = resolved.options.find((option) => option.label === 'Keep release recovery steps');
        if (!memoryOption) throw new Error('Remembered fact missing');
        await act(async () => {
            memoryOption.onSelect?.();
            selectionListProps()?.onSelect?.(memoryOption.id, memoryOption);
            await vi.waitFor(() => expect(harness.routerPush).toHaveBeenCalledWith(
                '/settings/prompts/memory/memory%2Fb?serverId=srv_fsp_controller_b&topic=Release%20%26%20recovery&fact=fact%2Fb',
            ));
        });
        const sessionOption = resolved.options.find((option) => option.subtitle === 'Past release discussion');
        if (!sessionOption) throw new Error('Past Session missing');
        await act(async () => {
            sessionOption.onSelect?.();
            selectionListProps()?.onSelect?.(sessionOption.id, sessionOption);
            await vi.waitFor(() => expect(harness.routerNavigate).toHaveBeenCalledWith('/session/session-b?serverId=srv_fsp_controller_b&jumpSeq=7', expect.objectContaining({ dangerouslySingular: expect.any(Function) })));
        });
    });

    it('keeps a typed Messages section with a truthful hint when transcript search is disabled', async () => {
        fixture.featureEnabled = { search: false, 'memory.search': false };
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const rootStep = selectionListProps()?.rootStep;
        const transcript = rootStep?.sections.find((section) => section.id === 'transcript');
        expect(transcript?.kind).toBe('dynamic');
        if (!transcript || transcript.kind !== 'dynamic') throw new Error('Messages availability section missing');
        const resolved = await transcript.resolve('needle', new AbortController().signal);
        expect(resolved.options).toEqual([]);
        expect(resolved.emptyHint).toBe('Enable memory search in Features to configure local indexing.');
        expect(rootStep?.emptyStateLabel).toBe('No matches');

        await act(async () => {
            selectionListProps()?.onSelect?.('missing-result', { id: 'missing-result', label: 'Missing' });
        });
        await vi.waitFor(() => expect(harness.modalAlert).toHaveBeenCalledWith(
            'Error',
            'Search failed. Please try again.',
        ));
    });

    it('keeps an explicit empty scope closed instead of widening to ambient or cross-Home entities', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: null, serverId: null, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId="ambient-session-a"
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const ids = selectionListProps()?.rootStep.sections.map((section) => section.id) ?? [];
        expect(ids).not.toContain('transcript');
        expect(ids).not.toContain('sessions');
        expect(fixture.homeSearch).not.toHaveBeenCalled();
    });

    it('uses the canonical Session organization projection when matching Session tags', async () => {
        fixture.sessionListRows = [{
            serverId: HOME_B,
            serverName: 'Home B',
            session: {
                id: 'session-b',
                updatedAt: 1,
                metadata: { name: 'Home B session', path: '/repo/b' },
            },
        }];
        fixture.sessionOrganizationProjection = {
            schemaVersion: 1,
            version: 1,
            orderedPinSessionIds: [],
            pinnedSessionIds: [],
            railPinnedSessionIds: [],
            pinsBySessionId: {},
            foldersById: {},
            folderAssignmentsBySessionId: {},
            tagsById: {
                urgent: {
                    tagId: 'urgent',
                    tagKey: 'tag/urgent',
                    sortKey: 'a',
                    display: { t: 'plain', v: { label: 'Urgent' } },
                    displayState: { status: 'available', value: { label: 'Urgent' } },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            tagAssignmentsBySessionId: { 'session-b': ['urgent'] },
            attentionStandingsBySessionId: {},
            orderEntriesByScopeKey: {},
            labelsByLabelKey: {},
        };
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="Urgent"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        await vi.waitFor(() => {
            const sessionSection = selectionListProps()?.rootStep.sections.find((section) => section.id === 'sessions');
            if (!sessionSection || sessionSection.kind !== 'static') throw new Error('Sessions section missing');
            expect(sessionSection.options[0]?.searchText).toContain('Urgent');
        });
    });

    it('ensures complete inventory once for the scope lifetime without exposing or restarting a result section', async () => {
                fixture.sessionListRows = [
            {
                serverId: HOME_A,
                serverName: 'Home A',
                session: {
                    id: 'unloaded-active',
                    updatedAt: 3,
                    archivedAt: null,
                    metadata: { name: 'Unloaded active needle', path: '/repo/active' },
                },
            },
            {
                serverId: HOME_A,
                serverName: 'Home A',
                session: {
                    id: 'unloaded-archived',
                    updatedAt: 2,
                    archivedAt: 1,
                    metadata: { name: 'Archived needle', path: '/repo/archived' },
                },
            },
        ];
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-a', serverId: HOME_A, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        await vi.waitFor(() => expect(inventoryRequests()).toHaveLength(1));
        expect(selectionListProps()?.rootStep.sections.some((section) => section.id === 'session-inventory')).toBe(false);
        await act(async () => {
            selectionListProps()?.onChangeInputValue?.('needle again');
        });
        await act(async () => undefined);
        expect(inventoryRequests()).toHaveLength(1);
        expect(inventoryRequests()[0]).toMatchObject({ url: expect.stringContaining(homeUrl(HOME_A)) });
        await vi.waitFor(() => {
            const sessions = selectionListProps()?.rootStep?.sections.find((section) => section.id === 'sessions');
            expect(sessions?.kind).toBe('static');
            if (!sessions || sessions.kind !== 'static') throw new Error('Sessions section not ready');
            expect(sessions.options.map((option) => option.label)).toEqual([
                'Unloaded active needle',
                'Archived needle',
            ]);
        });
    });

    it('surfaces Session inventory failures section-locally while silencing cancellation', async () => {
        fixture.inventoryFailure = true;
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        await vi.waitFor(() => expect(inventoryRequests()).toHaveLength(1));
        expect(selectionListProps()?.rootStep.sections.some((section) => section.id === 'session-inventory')).toBe(false);
        await vi.waitFor(() => {
            const sessions = selectionListProps()?.rootStep.sections.find((section) => section.id === 'sessions');
            expect(sessions?.kind).toBe('static');
            expect(sessions && 'resultHint' in sessions ? sessions.resultHint : undefined).toEqual(expect.any(String));
        });
    });

    it('pages Session metadata for an explicitly selected inactive Home without borrowing the active Sync scope', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="archived needle"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        await vi.waitFor(() => expect(inventoryRequests()).toHaveLength(1));
        expect(inventoryRequests()[0]).toMatchObject({ url: expect.stringContaining(homeUrl(HOME_B)), token: expect.stringContaining(createAccountTokenForTests('account-1')) });
        expect(inventoryRequests().every(request => new URL(request.url).origin === homeUrl(HOME_B))).toBe(true);
    });

    it('aborts inactive-Home Session metadata paging when that exact credential lifetime retires', async () => {
        const held = createDeferred<void>();
        fixture.inventoryHold = held.promise;
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );
        await vi.waitFor(() => expect(inventoryRequests()).toHaveLength(1));
        const firstSignal = fixture.inventorySignals[0]!;
        expect(firstSignal.aborted).toBe(false);

        await act(async () => {
            await mutateHomeBCredentials();
        });

        await vi.waitFor(() => expect(firstSignal.aborted).toBe(true));
        held.resolve();
        await flushHookEffects();
        expect(storage.getState().sessionListRowsByServerId[HOME_B]?.['session-b']).toBeUndefined();
    });

    it('keeps Search open when a previously rendered command has left the current catalog', async () => {
        const dismiss = vi.fn();
        const action = vi.fn(async () => {});
        const command = {
            id: 'retired-command',
            title: 'Retired command',
            action,
            // This test exercises pre-dismiss currentness, not the separately
            // covered empty-query suggestion projection.
            emptyQuerySuggested: true,
        };
        const { UniversalSearchController } = await import('./UniversalSearchController');
        const renderController = (commands: typeof command[]) => (
            <UniversalSearchController
                commands={commands}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={dismiss}
            />
        );
        const screen = await renderScreen(renderController([command]));
        const staleOption = selectionListProps()?.rootStep.sections
            .flatMap((section) => section.kind === 'static' ? section.options : [])
            .find((option) => option.id === 'command:retired-command');
        expect(staleOption).toBeDefined();

        await act(async () => { screen.tree.update(<InjectedAuthProvider credentials={{ token: createAccountTokenForTests('account-a') }}>{renderController([])}</InjectedAuthProvider>); });
        await act(async () => {
            selectionListProps()?.onSelect?.(staleOption!.id, staleOption!);
        });

        expect(dismiss).not.toHaveBeenCalled();
        expect(action).not.toHaveBeenCalled();
    });

    it('canonicalizes a local profile id to portable Home identity for credentials, filtering, query, and result activation', async () => {
        fixture.portableIdentity = true;
        fixture.homeSearch.mockResolvedValue({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'session-b',
                seqFrom: 5,
                seqTo: 5,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Portable identity result',
                score: 1,
            }],
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: localHomeB, sessionId: 'session-b', machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const transcript = selectionListProps()?.rootStep?.sections.find((section) => section.id === 'transcript');
        expect(transcript?.kind).toBe('dynamic');
        if (!transcript || transcript.kind !== 'dynamic') throw new Error('Transcript section not ready');
        expect(localHomeB).not.toBe(HOME_B);
        const resolved = await transcript.resolve('needle', new AbortController().signal);
        const option = resolved.options[0];
        expect(fixture.homeSearch).toHaveBeenCalledWith(expect.objectContaining({
            serverId: HOME_B,
            accountId: 'account-1',
        }));
        await act(async () => {
            option?.onSelect?.();
            selectionListProps()?.onSelect?.(option!.id, option!);
            await vi.waitFor(() => expect(harness.routerNavigate).toHaveBeenCalledWith('/session/session-b?serverId=srv_fsp_controller_b&jumpSeq=5', expect.objectContaining({ dangerouslySingular: expect.any(Function) })));
        });
    });

    it.each([false, true])('keeps a contextual Home B seed through query, result identity, and canonical scoped activation (workspace: %s)', async (hosted) => {
        fixture.singleHome = hosted;
        if (hosted) {
            browserRuntime = await installBrowserRuntimeForTests({ url: `https://home-b.example.test/session/session-b?serverId=${HOME_B}&bottom=terminal` });
            browserRuntime.window.sessionStorage.setItem('happier.workspace.windowIdV1', 'main');
        }
        let navigation: import('@/components/appShell/workspace/WorkspaceNavigationContext').WorkspaceNavigationContextValue | undefined;
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages: [{ kind: 'user-text', id: 'matched-message', localId: null,
                seq: 7, createdAt: 1, text: 'Needle in Home B' }],
                history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null,
            jumpToTarget: async target => ({ status: 'scrolled', target }),
            reveal: async () => {},
        });
        function Destination() {
            // A reused Session keeps the browser profile qualifier, whereas
            // Search addresses the same Home by its portable identity.
            return <ChatFindSeedHost sessionId="session-b" serverId={localHomeB} active>{input =>
                <ApplySeed {...input} />}</ChatFindSeedHost>;
        }
        function ApplySeed(input: import('@/components/appShell/panes/fileFindSeedHost').ChatFindSeedHostInput) {
            React.useEffect(() => {
                if (input.findSeed) void model.applySeed(input.findSeed).then(input.consumeFindSeed);
            }, [input.findSeed, input.consumeFindSeed]);
            return null;
        }
        function Driver(props: React.PropsWithChildren) {
            const scopeId = useRegisterSessionPaneDriver('session-b', localHomeB);
            return <>{props.children}<ScopeProbe scopeId={scopeId} /></>;
        }
        function ScopeProbe(_props: Readonly<{ scopeId: string }>) { return null; }
        const wrap = hosted ? async (content: React.ReactNode) => {
            harness.pathname = '/session/session-b';
            harness.params = { serverId: localHomeB, bottom: 'terminal' };
            browserRuntime!.reconfigureUrl(`https://home-b.example.test/session/session-b?serverId=${localHomeB}&bottom=terminal`);
            const initial = createWorkspaceState({ id: 'retained-session', target: { kind: 'session',
                params: { id: 'session-b', serverId: localHomeB, bottom: 'terminal' } }, pinned: false, preview: false });
            const key = workspaceLayoutScopeKey({ serverId: HOME_B, accountId: 'account-1', windowId: 'main' });
            const settings = storage.getState().localSettings;
            storage.setState({ localSettings: { ...settings, workspaceLayoutV1: {
                ...settings.workspaceLayoutV1, [key]: serializeWorkspaceLayout(initial),
            } } });
            const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: false, friends: false }, pages: [] });
            return <WorkspaceProvider enabled catalog={catalog}>{current => {
                navigation = current;
                const tab = current.state.tabs['retained-session'];
                if (!tab) throw new Error('Retained Session missing');
                return <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname="/session/session-b" focused visible
                    navigation={current.navigationForTab(tab.id)}><Driver>{content}</Driver></DestinationInstanceHost>;
            }}</WorkspaceProvider>;
        } : undefined;
        fixture.homeSearch.mockResolvedValue({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'session-b',
                seqFrom: 7,
                seqTo: 7,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Needle in Home B',
                score: 1,
            }],
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: 'session-b', machineId: null, rootPath: null }}
                activeSessionId="ambient-session-a"
                presentation="modal"
                onRequestClose={vi.fn()}
            />, <Destination />, wrap,
        );

        const rootStep = selectionListProps()?.rootStep;
        const transcript = rootStep?.sections.find((section) => section.id === 'transcript');
        expect(transcript?.kind).toBe('dynamic');
        if (!transcript || transcript.kind !== 'dynamic') throw new Error('Transcript section not ready');
        const resolved = await transcript.resolve('needle', new AbortController().signal);
        const option = resolved.options[0];
        expect(fixture.homeSearch).toHaveBeenCalledWith(expect.objectContaining({
            serverId: HOME_B,
            accountId: 'account-1',
            query: 'needle',
        }));
        expect(option?.id).toContain(HOME_B);
        // Search reads are scoped before activation starts the real connection's cleanup/hydration.
        expect(inventoryRequests().every(request => new URL(request.url).origin === homeUrl(HOME_B))).toBe(true);

        await act(async () => {
            option?.onSelect?.();
            selectionListProps()?.onSelect?.(option!.id, option!);
            await vi.waitFor(() => {
                if (hosted) expect(navigation?.state.tabs['retained-session'].target.params.jumpSeq).toBe('7');
                else expect(harness.routerNavigate).toHaveBeenCalledWith('/session/session-b?serverId=srv_fsp_controller_b&jumpSeq=7', expect.objectContaining({ dangerouslySingular: expect.any(Function) }));
            });
        });
        await flushHookEffects();
        await model.settled();
        expect(model.getSnapshot()).toMatchObject({ open: true, query: 'needle',
            status: { kind: 'results', current: 1, total: 1 } });
        if (hosted) {
            expect(Object.keys(navigation!.state.tabs)).toEqual(['retained-session']);
        }
        model.dispose();
    });

    it('uses Home B plugin providers from the selected scope while Home A is focused', async () => {
        fixture.scopedPluginProjections.set(`${HOME_A}:machine-a`, pluginSearchProjection({ pluginId: 'acme.home-a', title: 'Home A entities', generation: 11 }));
        fixture.scopedPluginProjections.set(
            `${HOME_B}:machine-b`,
            pluginSearchProjection({
                pluginId: 'acme.home-b',
                title: 'Home B entities',
                generation: 22,
            }),
        );
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{
                    accountId: 'account-1',
                    serverId: HOME_B,
                    sessionId: null,
                    machineId: 'machine-b',
                    rootPath: null,
                }}
                activeSessionId="ambient-session-a"
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        await vi.waitFor(() => expect(network.requests).toContainEqual(expect.objectContaining({ targetId: 'machine-b', serverUrl: homeUrl(HOME_B) })));
        expect(fixture.observedAmbientProjection?.searchProvidersById)
            .toHaveProperty(['searchProvider:acme.home-a:entries']);
        expect(readCurrentAppShellPluginUiProjection()).toBe(fixture.observedAmbientProjection);
        const sectionIds = selectionListProps()?.rootStep.sections.map((section) => section.id) ?? [];
        expect(sectionIds).toContain('plugin-search:acme.home-b:entries');
        expect(sectionIds).not.toContain('plugin-search:acme.home-a:entries');
    });

    it('uses the freshly hydrated exact Session title instead of duplicating the transcript excerpt', async () => {
        fixture.homeSearch.mockResolvedValue({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'newly-hydrated',
                seqFrom: 1,
                seqTo: 1,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Matching transcript excerpt',
                score: 1,
            }],
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const transcript = selectionListProps()?.rootStep.sections.find((section) => section.id === 'transcript');
        if (!transcript || transcript.kind !== 'dynamic') throw new Error('Transcript section missing');
        const result = await transcript.resolve('needle', new AbortController().signal);

        expect(result.options[0]?.label).toBe('Scoped Session');
        expect(result.options[0]?.subtitle).toBe('Matching transcript excerpt');
    });

    it('lists settings results as one group, pages first, each row with the path the settings rail shows', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="theme"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const sections = selectionListProps()?.rootStep.sections ?? [];
        const settingsSections = sections.filter((section) => section.id === 'settings');
        expect(settingsSections).toHaveLength(1);
        const settings = settingsSections[0];
        if (!settings || settings.kind !== 'dynamic') throw new Error('Settings section missing');
        const resolved = await settings.resolve('theme', new AbortController().signal);
        const pageIndex = resolved.options.findIndex(option => option.label === 'Appearance');
        const fieldIndex = resolved.options.findIndex(option => option.label === 'Theme');
        expect(pageIndex).toBeGreaterThanOrEqual(0);
        expect(fieldIndex).toBeGreaterThan(pageIndex);
        expect(resolved.options[fieldIndex]?.subtitle).toBe('Appearance');
        // The shipped catalog has a nested Account → Security page; retain
        // the nested-page path contract formerly exercised with a fake Terminal page.
        await act(async () => { selectionListProps()?.onChangeInputValue?.('security'); });
        const nested = selectionListProps()?.rootStep.sections.find(section => section.id === 'settings');
        if (!nested || nested.kind !== 'dynamic') throw new Error('Nested Settings search missing');
        const nestedResults = await nested.resolve('security', new AbortController().signal);
        expect(nestedResults.options.find(option => option.label === 'Sign-in & security')?.subtitle)
            .toBe('Profile & account › Account');
    });

    it('offers the all-machines choice even when there is only one Home', async () => {
        fixture.singleHome = true;
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        expect(selectionListProps()).not.toBeNull();
        expect(selectionListProps()?.filters ?? []).toHaveLength(1);
        expect(selectionListProps()?.filters?.[0].options).toHaveLength(2);
    });

    it('names the scope chip by the Home display name when there are several Homes', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const scopeFilter = selectionListProps()?.filters?.find((filter) => filter.id === 'scope');
        if (!scopeFilter) throw new Error('Scope filter missing from Search');
        expect(scopeFilter.valueLabel).toBe('Home B');
    });

    // Find lab G1s: "Text in files" is a removable scope token (× returns to everything), not a
    // two-option dropdown; without it Search shows no source chip at all (G1).
    it('shows Text in files as a removable token only while that scope is on', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');
        const workspaceScope = { accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-b', rootPath: '/home/leeroy/code/happier' };

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="routeKey"
                initialSource="fileContent"
                initialScope={workspaceScope}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const token = selectionListProps()?.filters?.find((filter) => filter.id === 'source');
        if (!token) throw new Error('Text in files token missing');
        expect(token.options).toBeUndefined();
        // The token says where the scope searches (lab G1s: "Text in happier · MacBook Pro"), not just what.
        expect(token.valueLabel).toContain('happier');
        expect(token.valueLabel).toContain('machine-b');
        // The phone's chip row names the folder alone (lab G1sp "Text in happier").
        expect(token.rowValueLabel).toContain('happier');
        expect(token.rowValueLabel).not.toContain('machine-b');
        expect(token.onClear).toBeTypeOf('function');
        await act(async () => { token.onClear?.(); });

        expect(selectionListProps()?.filters?.some((filter) => filter.id === 'source')).toBe(false);
        expect(selectionListProps()?.inputValue).toBe('routeKey');
    });

    it('previews deletion only after the user arms Replace, allowing an empty replacement', async () => {
        fixture.singleHome = true;
        fixture.workspaceRefs = [{ id: 'ws-replace', serverId: HOME_B, machineId: 'machine-b', rootPath: '/repo', label: 'Replace project', createdAtMs: 1 }];
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-b', active: true } };
        fixture.daemonRpc.mockImplementation(async call => call.method === RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW
            ? { ok: true, files: [], skipped: { notText: 0 }, hasMore: false, coverage: 'complete' }
            : { ok: true, files: [], hasMore: false, coverage: 'complete' });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        const screen = await renderScreen(<UniversalSearchController commands={[]} initialQuery="routeKey" initialSource="fileContent"
            initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-b', rootPath: '/repo' }}
            presentation="modal" onRequestClose={vi.fn()} />);
        await act(async () => { storage.setState({ machines: {
            'machine-b': createMachineFixture({ id: 'machine-b', active: true, activeAt: Date.now() }),
        } }); });
        const previews = () => fixture.daemonRpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW);
        expect(previews()).toHaveLength(0);
        await screen.pressByTestIdAsync('universal-search:replace-toggle');
        await vi.waitFor(() => expect(previews().map(([call]) => call.payload), screen.getTextContent()).toEqual([
            expect.objectContaining({ query: 'routeKey', replacement: '' }),
        ]));
        await screen.pressByTestIdAsync('universal-search:replace-hide');
        await act(async () => { selectionListProps()?.onChangeInputValue?.('other'); });
        expect(previews()).toHaveLength(1);
    });

    it('keeps an unchanged replace preview through a presence refresh without reissuing its read', async () => {
        fixture.singleHome = true;
        fixture.workspaceRefs = [{ id: 'ws-replace', serverId: HOME_B, machineId: 'machine-b', rootPath: '/repo', label: 'Replace project', createdAtMs: 1 }];
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-b', active: true } };
        fixture.daemonRpc.mockResolvedValue({ ok: true, files: [], skipped: { notText: 0 }, hasMore: false, coverage: 'complete' });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(<UniversalSearchController commands={[]} initialQuery="routeKey" initialSource="fileContent" initialReplace
            initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-b', rootPath: '/repo' }}
            presentation="modal" onRequestClose={vi.fn()} />);
        const presence = async (active: boolean) => act(async () => { storage.setState({ machines: {
            'machine-b': createMachineFixture({ id: 'machine-b', active, activeAt: Date.now() }),
        } }); });
        await presence(true);
        const previews = () => fixture.daemonRpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW);
        await vi.waitFor(() => expect(previews()).toHaveLength(1));
        const firstPreview = previews()[0];
        const { recordMachineRequestFailed, recordMachineRequestSucceeded, isMachineReachable } = await import('@/sync/domains/machines/reachability/machineReachability');
        const target = { serverId: HOME_B, accountId: 'account-1', machineId: 'machine-b' };
        await act(async () => { recordMachineRequestFailed(target); });
        expect(isMachineReachable(target, storage.getState().machines['machine-b']!)).toBe(false);
        await act(async () => { recordMachineRequestSucceeded(target); });
        expect(isMachineReachable(target, storage.getState().machines['machine-b']!)).toBe(true);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(previews()).toEqual([firstPreview]);
    });

    it.each(['before', 'after'] as const)('excludes an actual dirty editor %s its Replace preview, including retained destination instances', async when => {
        fixture.singleHome = true;
        fixture.workspaceRefs = [{ id: 'ws-replace', serverId: HOME_B, machineId: 'machine-b', rootPath: '/repo', label: 'Replace project', createdAtMs: 1 }];
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-b', active: true } };
        fixture.daemonRpc.mockResolvedValue({ ok: true, files: ['src/dirty.ts', 'src/clean.ts'].map(path => ({ path,
            hash: 'a'.repeat(64), matchCount: 1, matches: [{ line: 1, column16: 1, length16: 8,
                text: 'routeKey()', replacedText: 'nextKey()', before: [], after: [] }] })),
            skipped: { notText: 0 }, hasMore: false, coverage: 'complete' });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        let editor: WorkspaceFileEditorState | undefined;
        let unsaved = false;
        const screen = await renderScreen(<UniversalSearchController commands={[]} initialQuery="routeKey" initialSource="fileContent"
            initialReplace={when === 'after'}
            initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-b', rootPath: '/repo' }}
            presentation="modal" onRequestClose={vi.fn()} />,
        <DirtyReplaceEditor observe={(current, dirty) => { editor = current; unsaved = dirty; }} />);
        await act(async () => { storage.setState({ machines: {
            'machine-b': createMachineFixture({ id: 'machine-b', active: true, activeAt: Date.now() }),
        } }); });
        if (when === 'after') await vi.waitFor(() => expect(screen.findByTestId('replace-apply')?.props.disabled).toBe(false));
        await act(async () => { editor!.startEditingFile(); editor!.onEditorChange('routeKey()\nunsaved draft'); });
        await vi.waitFor(() => expect(unsaved).toBe(true));
        if (when === 'before') await screen.pressByTestIdAsync('universal-search:replace-toggle');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('universalSearch.replace.unsavedSection')));
        const sections = selectionListProps()?.rootStep.sections ?? [];
        expect(sections.find(section => section.id === 'replace:unsaved')).toMatchObject({ options: [
            expect.objectContaining({ id: 'replace:unsaved:src/dirty.ts', label: 'src/dirty.ts' }),
        ] });
        expect(sections.find(section => section.id === 'replace:review')).toMatchObject({ options: expect.arrayContaining([
            expect.objectContaining({ label: 'src/clean.ts' }),
        ]) });
    });

    it('keeps the reviewed matcher while an invalid regex loads, then shows its error', async () => {
        fixture.singleHome = true;
        fixture.workspaceRefs = [{ id: 'ws-replace', serverId: HOME_B, machineId: 'machine-b', rootPath: '/repo', label: 'Replace project', createdAtMs: 1 }];
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-b', active: true } };
        const invalid = createDeferred<unknown>();
        fixture.daemonRpc.mockImplementation(async call => {
            if (call.method !== RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW)
                return { ok: true, files: [], hasMore: false, coverage: 'complete' };
            const payload = call.payload as { query: string };
            if (payload.query === '(') return invalid.promise;
            return { ok: true, files: [{ path: 'src/a.ts', hash: 'a'.repeat(64), matchCount: 1,
                matches: [{ line: 1, column16: 1, length16: 8, text: 'routeKey()', replacedText: 'nextKey()', before: [], after: [] }] }],
                skipped: { notText: 0 }, hasMore: false, coverage: 'complete' };
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        const screen = await renderScreen(<UniversalSearchController commands={[]} initialQuery="routeKey" initialSource="fileContent" initialReplace
            initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-b', rootPath: '/repo' }}
            presentation="modal" onRequestClose={vi.fn()} />);
        await act(async () => { storage.setState({ machines: {
            'machine-b': createMachineFixture({ id: 'machine-b', active: true, activeAt: Date.now() }),
        } }); });
        await act(async () => { screen.changeTextByTestId('universal-search:replace-input', 'nextKey'); });
        await screen.pressByTestIdAsync('universal-search:regex');
        await vi.waitFor(() => expect(screen.findByTestId('replace-apply')?.props.disabled, screen.getTextContent()).toBe(false));
        try {
            await act(async () => { selectionListProps()?.onChangeInputValue?.('('); });
            expect(screen.findByTestId('replace-apply')?.props.disabled).toBe(true);
            expect(screen.getTextContent()).toContain('nextKey');
            await act(async () => { invalid.resolve({ ok: false, code: 'invalid_pattern' }); await flushHookEffects(); });
            expect(screen.getTextContent()).toContain(t('universalSearch.replace.invalidPattern'));
        } finally { invalid.resolve({ ok: false, code: 'invalid_pattern' }); }
    });

    it('opens the Files scope and reserves @ for Symbols, with Backspace returning through Files to everything', async () => {
        fixture.singleHome = true;
        fixture.workspaceRefs = [{ id: 'ws-files', serverId: HOME_B, machineId: 'machine-b', rootPath: '/repo/happier', label: 'happier', createdAtMs: 1 }];
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(<UniversalSearchController commands={[]} initialSource="files"
            initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-b', rootPath: '/repo/happier' }}
            presentation="modal" onRequestClose={vi.fn()} />);
        expect(selectionListProps()?.filters?.find(filter => filter.id === 'source')?.valueLabel).toContain('happier');
        await act(async () => { selectionListProps()?.onChangeInputValue?.('hello'); });
        expect(selectionListProps()?.rootStep.sections.map(section => section.id)).toEqual(['files']);
        await act(async () => { selectionListProps()?.onChangeInputValue?.('@hello'); });
        expect(selectionListProps()?.inputValue).toBe('hello');
        expect(selectionListProps()?.rootStep.sections.map(section => section.id)).toEqual(['symbols']);
        await act(async () => { selectionListProps()?.onChangeInputValue?.(''); });
        await act(async () => { selectionListProps()?.inputBehavior?.onBackspaceAtEnd?.(''); });
        expect(selectionListProps()?.filters?.find(filter => filter.id === 'source')?.valueLabel).toContain('happier');
        await act(async () => { selectionListProps()?.inputBehavior?.onBackspaceAtEnd?.(''); });
        expect(selectionListProps()?.filters?.some(filter => filter.id === 'source')).toBe(false);
    });

    it.each(['current', 'workspace', 'account', 'retired', 'retired-after-query'] as const)('consumes a supplied unsaved symbol holder only for its current scope and Account (%s)', async (state) => {
        fixture.singleHome = true;
        const scope = { accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-offline', rootPath: '/symbol-holder' };
        fixture.workspaceRefs = [{ id: 'ws-symbol-holder', ...scope, label: 'Symbols project', createdAtMs: 1 }];
        let text = 'class SavedSymbol {}';
        let reads = 0;
        let accountCurrent = state !== 'retired';
        const accountId = state === 'account' ? 'old-account' : scope.accountId;
        const symbols = {
            target: { kind: 'workspaceFile' as const, scope: { ...scope, rootPath: state === 'workspace' ? '/another-project' : scope.rootPath },
                path: 'src/a.ts', accountId, serverId: scope.serverId, workspaceRefId: 'ws-symbol-holder', sessionId: null },
            resolverKey: 'active-symbol-holder', language: 'typescript', isDark: false, unavailableHint: t('common.unavailable'),
            accountLifetime: { scope: { serverId: scope.serverId, accountId }, isCurrent: () => accountCurrent, onRetire: () => ({ dispose() {} }) },
            isCurrent: () => true,
            getText: () => { reads += 1; return text; },
            flushPendingChange: () => { text = '// unsaved\nclass LiveSymbol {}'; },
        };
        const { UniversalSearchModal } = await import('./UniversalSearchModal');
        const openWorkspaceFile = vi.fn(async () => true);
        await renderScreen(<UniversalSearchModal commands={[]} symbols={symbols} initialSource="files" initialQuery="@LiveSymbol"
            initialScope={scope} openWorkspaceFile={openWorkspaceFile} onClose={vi.fn()} />);
        const section = selectionListProps()?.rootStep.sections.find(item => item.id === 'symbols');
        if (!section || section.kind !== 'dynamic') throw new Error('Missing Symbols section');
        let page!: Awaited<ReturnType<typeof section.resolve>>;
        await act(async () => { page = await section.resolve('LiveSymbol', new AbortController().signal); });
        if (state !== 'current' && state !== 'retired-after-query') {
            expect(page.options).toEqual([]);
            expect(reads).toBe(0);
            return;
        }
        expect(page.options.map(option => option.label)).toEqual(['LiveSymbol']);
        expect(selectionListProps()?.filters?.find(filter => filter.id === 'source')?.valueLabel).toContain('a.ts');
        const option = page.options[0]!;
        if (state === 'retired-after-query') accountCurrent = false;
        await act(async () => {
            option.onSelect?.();
            selectionListProps()?.onCommandSelect?.(option.id, option);
        });
        if (state === 'retired-after-query') {
            await vi.waitFor(() => expect(harness.modalAlert).toHaveBeenCalled());
            expect(openWorkspaceFile).not.toHaveBeenCalled();
            return;
        }
        await vi.waitFor(() => expect(openWorkspaceFile).toHaveBeenCalledWith({ kind: 'project', workspaceRefId: 'ws-symbol-holder',
            serverId: scope.serverId, machineId: scope.machineId, rootPath: scope.rootPath, path: 'src/a.ts' },
            { intent: 'beside', anchor: { kind: 'fileLine', startLine: 2 } }));
    });

    it.each(['preview', 'beside'] as const)('keeps offline Recent and Changed searchable and opens a remembered file with %s intent without requesting files', async (intent) => {
        fixture.singleHome = true;
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-offline', active: false, activeAt: 0 } };
        const scope = { accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-offline', rootPath: '/offline-quick-open' };
        fixture.workspaceRefs = [{ id: 'ws-offline-quick-open', ...scope, label: 'Offline project', createdAtMs: 1 }];
        const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        const { UniversalSearchController } = await import('./UniversalSearchController');
        const openWorkspaceFile = vi.fn(async () => true);
        await renderScreen(<UniversalSearchController commands={[]} initialSource="files" initialScope={scope}
            openWorkspaceFile={openWorkspaceFile} activeSessionId={null} presentation="modal" onRequestClose={vi.fn()} />);
        await act(async () => {
            storage.getState().applyLocalSettings({ recentWorkspaceFilesV1: {
                [buildWorkspaceCacheKey(scope)]: ['src/settingsRecent.ts', 'settings/unrelated.ts'],
            } });
            storage.getState().updateWorkspaceScmSnapshot(scope, {
                projectKey: buildWorkspaceCacheKey(scope), fetchedAt: 1,
                repo: { isRepo: true, rootPath: scope.rootPath },
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                hasConflicts: false,
                entries: [{ path: 'src/settingsChanged.ts', previousPath: null, kind: 'modified',
                    includeStatus: '', pendingStatus: 'M', hasIncludedDelta: false, hasPendingDelta: true,
                    stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false } }],
                totals: { includedFiles: 0, pendingFiles: 1, untrackedFiles: 0,
                    includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0 },
            });
        });
        const sections = selectionListProps()?.rootStep.sections ?? [];
        expect(sections.map(section => section.id)).toEqual(['files:recent', 'files:changed']);
        const recent = sections[0];
        if (!recent || recent.kind !== 'static') throw new Error('Missing offline Recent source');
        expect(recent.resultHint).toBeDefined();
        await act(async () => { selectionListProps()?.onChangeInputValue?.('settings'); });
        const files = selectionListProps()?.rootStep.sections.find(section => section.id === 'files');
        if (!files || files.kind !== 'dynamic') throw new Error('Missing offline Files source');
        const reply = await files.resolve('settings', new AbortController().signal);
        expect(reply.options.map(option => option.label)).toEqual(['settingsRecent.ts', 'settingsChanged.ts', 'unrelated.ts']);
        expect(reply.resultHint).toBeDefined();
        expect(fixture.daemonRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST)).toBe(false);
        const option = reply.options[0]!;
        await act(async () => {
            option.onSelect?.();
            const select = intent === 'beside' ? selectionListProps()?.onCommandSelect : selectionListProps()?.onSelect;
            if (!select) throw new Error('Missing Files activation callback');
            select(option.id, option);
        });
        await vi.waitFor(() => expect(openWorkspaceFile).toHaveBeenCalledWith({ kind: 'project',
            workspaceRefId: 'ws-offline-quick-open', serverId: HOME_B, machineId: scope.machineId,
            rootPath: scope.rootPath, path: 'src/settingsRecent.ts' }, { intent }));
    });

    it('keeps positioned file matches selectable and prefers a literal colon filename in the Files scope', async () => {
        fixture.singleHome = true;
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-offline', active: false, activeAt: 0 } };
        const scope = { accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-offline', rootPath: '/quick-open-grammar' };
        fixture.workspaceRefs = [{ id: 'ws-quick-open-grammar', ...scope, label: 'Grammar project', createdAtMs: 1 }];
        const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        const { UniversalSearchController } = await import('./UniversalSearchController');
        const openWorkspaceFile = vi.fn(async () => true);
        await renderScreen(<UniversalSearchController commands={[]} initialSource="files" initialScope={scope}
            openWorkspaceFile={openWorkspaceFile} activeSessionId={null} presentation="modal" onRequestClose={vi.fn()} />);
        await act(async () => {
            storage.getState().applyLocalSettings({ recentWorkspaceFilesV1: {
                [buildWorkspaceCacheKey(scope)]: ['src/settings.ts', 'src/settings.ts:23', 'src/SettingsModal.tsx'],
            } });
            selectionListProps()?.onChangeInputValue?.('src/settings.ts:23');
        });
        const files = selectionListProps()?.rootStep.sections.find(section => section.id === 'files');
        if (!files || files.kind !== 'dynamic') throw new Error('Missing Files source');
        const literal = await files.resolve('src/settings.ts:23', new AbortController().signal);
        expect(literal.options[0]?.label).toBe('settings.ts:23');
        await act(async () => { selectionListProps()?.onChangeInputValue?.('settingsmodal:23'); });
        const positionedFiles = selectionListProps()?.rootStep.sections.find(section => section.id === 'files');
        if (!positionedFiles || positionedFiles.kind !== 'dynamic') throw new Error('Missing positioned Files source');
        const positioned = await positionedFiles.resolve('settingsmodal:23', new AbortController().signal);
        const option = positioned.options[0];
        if (!option) throw new Error('Positioned filename match is not selectable');
        await act(async () => {
            option.onSelect?.();
            selectionListProps()?.onSelect?.(option.id, option);
        });
        await vi.waitFor(() => expect(openWorkspaceFile).toHaveBeenCalledWith({ kind: 'project',
            workspaceRefId: 'ws-quick-open-grammar', serverId: scope.serverId, machineId: scope.machineId,
            rootPath: scope.rootPath, path: 'src/SettingsModal.tsx' }, { intent: 'preview', anchor: { kind: 'fileLine', startLine: 23 } }));
    });

    it('preserves a missing folder outcome in both file search sections', async () => {
        fixture.singleHome = true;
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-b' } };
        fixture.workspaceRefs = [{ id: 'ws-missing', serverId: HOME_B, machineId: 'machine-b', rootPath: '/missing', label: 'Missing', createdAtMs: 1 }];
        fixture.daemonRpc.mockImplementation(async ({ method }) => method === RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST
            ? { ok: false, errorCode: 'root_not_found' } : { ok: false, code: 'root_not_found' });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(<UniversalSearchController commands={[]} initialQuery="needle"
            initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-b', rootPath: '/missing' }}
            activeSessionId={null} presentation="modal" onRequestClose={vi.fn()} />);
        await act(async () => { storage.setState({ machines: {
            'machine-b': createMachineFixture({ id: 'machine-b', active: true, activeAt: Date.now() }),
        } }); });
        const causes = new Set<string | undefined>();
        for (const id of ['files', 'fileContent']) {
            const section = selectionListProps()?.rootStep.sections.find(item => item.id === id);
            if (!section || section.kind !== 'dynamic') throw new Error(`Missing section ${id}`);
            const failure = await section.resolve('needle', new AbortController().signal).then(() => null, (error: unknown) => error as SelectionListSectionFailure);
            if (!failure) throw new Error(`Section ${id} did not name the missing folder`);
            expect(failure).toMatchObject({ name: 'SelectionListSectionFailure' });
            expect(failure.hint).toContain('folder');
            expect(failure.hint).not.toContain('connection');
            expect(failure.retryable).toBe(false);
            causes.add(failure.causeKey);
        }
        // Both groups name one cause, so the palette says it once.
        expect(causes.size).toBe(1);
        expect(causes.has(undefined)).toBe(false);
    });

    it('says an empty bounded Files reply searched only part of the folder, never that more results exist', async () => {
        fixture.singleHome = true;
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-b' } };
        fixture.workspaceRefs = [{ id: 'ws-big', serverId: HOME_B, machineId: 'machine-b', rootPath: '/big', label: 'Big', createdAtMs: 1 }];
        fixture.daemonRpc.mockImplementation(async ({ method }) => method === RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST
            ? { ok: true, paths: ['src/unrelated.ts'], truncated: true } : { ok: false, code: 'root_not_found' });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(<UniversalSearchController commands={[]} initialQuery="needle"
            initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-b', rootPath: '/big' }}
            activeSessionId={null} presentation="modal" onRequestClose={vi.fn()} />);
        await act(async () => { storage.setState({ machines: {
            'machine-b': createMachineFixture({ id: 'machine-b', active: true, activeAt: Date.now() }),
        } }); });
        const section = selectionListProps()?.rootStep.sections.find(item => item.id === 'files');
        if (!section || section.kind !== 'dynamic') throw new Error('Missing Files section');
        const reply = await section.resolve('needle', new AbortController().signal);
        expect(reply.options).toHaveLength(0);
        expect(reply.emptyHint).toBe(t('universalSearch.noMatchesInSearchedResults'));
        expect(reply.resultHint).toBeUndefined();
    });

    // Find lab ST "Machine offline": one line, under Text in files, not the same sentence in every group.
    it('says once that the folder\'s machine is offline', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');
        const workspaceScope = { accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: 'machine-offline', rootPath: '/home/leeroy/code/happier' };
        fixture.workspaceRefs = [{ id: 'ws-happier', serverId: HOME_B, machineId: 'machine-offline', rootPath: '/home/leeroy/code/happier', label: 'happier', createdAtMs: 1 }];

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="routeKey"
                initialScope={workspaceScope}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const ids = selectionListProps()?.rootStep.sections.map((section) => section.id) ?? [];
        expect(ids).toContain('fileContent');
        expect(ids).not.toContain('files');
        expect(ids).not.toContain('commits');
    });

    // Same-named projects on same-named Machines read apart, with the suffix the session list header uses.
    it('tells same-named projects apart by the Machine name that the session list header uses', async () => {
        fixture.singleHome = true;
        fixture.memoryMachine = { serverId: HOME_B, machine: { id: 'machine-b' } };
        fixture.workspaceRefs = [
            { id: 'ws-one', serverId: HOME_B, machineId: 'machine-aaaa1111', rootPath: '/srv/happier', label: 'happier', createdAtMs: 1 },
            { id: 'ws-two', serverId: HOME_B, machineId: 'machine-bbbb2222', rootPath: '/srv/happier', label: 'happier', createdAtMs: 1 },
        ];
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(<UniversalSearchController commands={[]}
            initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
            activeSessionId={null} presentation="modal" onRequestClose={vi.fn()} />);
        const named = (id: string) => createMachineFixture({ id, active: true, activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, displayName: 'Build box', host: 'build-box' } });
        await act(async () => { storage.setState({
            machines: { 'machine-aaaa1111': named('machine-aaaa1111'), 'machine-bbbb2222': named('machine-bbbb2222') },
            machineListByServerId: { [HOME_B]: [named('machine-aaaa1111'), named('machine-bbbb2222')] },
        }); });
        await vi.waitFor(() => {
            const section = selectionListProps()?.rootStep.sections.find((item) => item.id === 'projects');
            if (!section || section.kind !== 'static') throw new Error('Projects section missing');
            const subtitles = section.options.map((option) => String(option.subtitle ?? ''));
            expect(subtitles).toHaveLength(2);
            expect(subtitles.every((subtitle) => subtitle.includes('Build box · '))).toBe(true);
            expect(new Set(subtitles).size).toBe(2);
        });
        // A Machine still hydrating is left out of the line; the placeholder never reads as its name.
        const hydrating = createMachineFixture({ id: 'machine-aaaa1111', metadata: null, availability: undefined });
        await act(async () => { storage.setState({
            machines: { 'machine-aaaa1111': hydrating, 'machine-bbbb2222': named('machine-bbbb2222') },
            machineListByServerId: { [HOME_B]: [hydrating, named('machine-bbbb2222')] },
        }); });
        await vi.waitFor(() => {
            const section = selectionListProps()?.rootStep.sections.find((item) => item.id === 'projects');
            if (!section || section.kind !== 'static') throw new Error('Projects section missing');
            expect(section.options.map((option) => String(option.subtitle ?? '')).some((subtitle) => subtitle.includes(t('common.loading')))).toBe(false);
        });
    });

    it('keeps the result query when the scope filter changes the Home', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        expect(selectionListProps()?.rootStep.sections.some((section) => section.id === 'scope')).toBe(false);
        // The scope is a filter chip: choosing another Home changes the scope, not the query.
        const scopeFilter = selectionListProps()?.filters?.find((filter) => filter.id === 'scope');
        if (!scopeFilter) throw new Error('Scope filter missing from Search');
        expect(scopeFilter.testID).toBe('universal-search:scope');
        const nextScope = scopeFilter.options?.find((option) => option.id.includes(HOME_A));
        expect(nextScope).toBeDefined();
        await act(async () => {
            scopeFilter.onChange?.(nextScope!.id);
        });

        expect(selectionListProps()?.inputValue).toBe('needle');
        expect(selectionListProps()?.filters?.find((filter) => filter.id === 'scope')?.selectedId)
            .toBe(nextScope!.id);
    });

    it('invalidates the Home transcript resolver identity when that Home credential mutates', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: HOME_B, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const before = selectionListProps()?.rootStep?.sections.find((section) => section.id === 'transcript');
        if (!before || before.kind !== 'dynamic') throw new Error('Transcript section not ready');
        const retiredCache = selectionListProps()?.dynamicSectionCache;
        if (!retiredCache) throw new Error('Credential-scoped cache not installed');
        retiredCache.set('transcript::old-credential::needle', [{ id: 'sensitive-old-row', label: 'Sensitive old row' }]);

        await act(async () => {
            await mutateHomeBCredentials();
        });

        const after = selectionListProps()?.rootStep?.sections.find((section) => section.id === 'transcript');
        if (!after || after.kind !== 'dynamic') throw new Error('Transcript section not ready after credential mutation');
        const activeCache = selectionListProps()?.dynamicSectionCache;
        if (!activeCache) throw new Error('Replacement credential-scoped cache not installed');
        expect(after.resolverKey).not.toBe(before.resolverKey);
        expect(activeCache).not.toBe(retiredCache);
        expect(retiredCache.size()).toBe(0);

        // Completion from work admitted under the old credential can only touch its retired
        // cache instance; it cannot publish into the replacement credential lifetime.
        retiredCache.set('transcript::old-credential::needle', [{ id: 'late-old-row', label: 'Late old row' }]);
        expect(activeCache.get('transcript::old-credential::needle')).toBeUndefined();
    });

    it('normalizes a provider hit session id once for authorization, identity, and activation', async () => {
        fixture.homeSearch.mockResolvedValue({
            v: 1,
            ok: true,
            hits: [{
                sessionId: '  session-b  ',
                seqFrom: 9,
                seqTo: 9,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Whitespace-bearing provider hit',
                score: 1,
            }],
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{
                    accountId: 'account-1',
                    serverId: HOME_B,
                    sessionId: 'session-b',
                    machineId: null,
                    rootPath: null,
                }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const transcript = selectionListProps()?.rootStep?.sections.find((section) => section.id === 'transcript');
        if (!transcript || transcript.kind !== 'dynamic') throw new Error('Transcript section not ready');
        const resolved = await transcript.resolve('needle', new AbortController().signal);
        const option = resolved.options[0];

        expect(option).toBeTruthy();
        await act(async () => {
            option?.onSelect?.();
            selectionListProps()?.onSelect?.(option!.id, option!);
            await vi.waitFor(() => {
                expect(harness.routerNavigate).toHaveBeenCalledWith('/session/session-b?serverId=srv_fsp_controller_b&jumpSeq=9', expect.objectContaining({ dangerouslySingular: expect.any(Function) }));
            });
        });
    });
});
