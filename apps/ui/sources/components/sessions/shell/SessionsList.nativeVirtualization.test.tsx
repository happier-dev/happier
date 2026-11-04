import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This list-shell test does not exercise Markdown. The patched package subpath
// is a genuine third-party boundary and may be absent before UI postinstall.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { replaceCollapsedGroupKeys } from '@/sync/domains/state/disclosureUiState';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { findGestureByKind } from '@/dev/testkit/mocks/gestureHandler';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { HAPPIER_COLLECTION_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';

const SESSION_LIST_ROW_HEIGHT_DEFAULT = HAPPIER_COLLECTION_ROW_METRICS.height.detailed;
import { applySessionOrganizationLegacyTestSettings, buildSessionOrganizationSnapshotFromLegacyTestSettings } from './sessionOrganizationProjectionTestFixture';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import { buildSessionListCollapseContextKey, buildSessionListCollapseKey } from '@/sync/domains/session/listing/sessionListCollapseState';
import { CollectionSpacesV1Schema, type CollectionSpacesV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { writeCollectionSpaceSelectionV1 } from '@/sync/domains/session/listing/sessionListSpaces';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let pinnedSessionKeysV1: string[] = [];
const routerNavigateSpy = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
// Observe the real owners; HTTP below controls pending work, not Sync methods.
const fetchMoreSessionsMock = vi.spyOn(sync, 'fetchMoreSessions');
const refreshSessionsMock = vi.spyOn(sync, 'refreshSessions');
const hydrateSessionListRowsMock = vi.spyOn(sync, 'hydrateSessionListRows');
const { createEmptyAccountBootstrapHttpResponse } = await import('@/dev/testkit/fixtures/accountBootstrapHttpBoundary');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let pendingSessionPage: Promise<void> | null = null;
const request: typeof home.request = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/v2/sessions') await pendingSessionPage;
    if (parsed.pathname === '/v2/session-organization') return Response.json({
        snapshot: buildSessionOrganizationSnapshotFromLegacyTestSettings({ serverId: 'srv_server_a', pinnedSessionKeysV1, sessionTagsV1 }),
    });
    return createEmptyAccountBootstrapHttpResponse(`${parsed.pathname}${parsed.search}`, init) ?? home.request(url, init);
};
// The index's folder barrel reaches production storage/transport owners. Install
// the genuine HTTP boundary before evaluating that graph.
const { buildSessionListIndexFromViewData, buildSessionListIndexNodeId } = await import('@/sync/domains/sessionList/sessionListIndex');
const { sessionMruState, readSessionMruOrder } = await import('@/sync/domains/session/navigation/recentSessions');
// Load the real fixture owners during collection, after installing the HTTP
// boundary, so the first behavior hook does not also pay for their cold graph.
const [
    { clearSessionListViewFilterRetentionForTests, buildSessionListViewCredentialScopeKey },
    { resetSessionListPaneRetentionForTests },
    { storage: realStorage },
    { resolveWarmCacheAccountScope, setWarmCacheAccountScope },
    { listServerProfiles, resolveServerProfileScopeId },
    { resetServerFeaturesClientForTests, primeServerFeaturesSnapshot },
] = await Promise.all([
    import('./search/useSessionListViewFilters'),
    import('./sessionListPaneRetention'),
    import('@/sync/domains/state/storageStore'),
    import('@/sync/domains/state/warmCachePersistence'),
    import('@/sync/domains/server/serverProfiles'),
    import('@/sync/api/capabilities/serverFeaturesClient'),
]);
let homeA: string;
const pinPath = '/v2/session-organization/pins/sess_a';
const tagsPath = '/v2/session-organization/tag-assignments/sess_a';
let keyboardRegistration: ReturnType<typeof import('@/keyboard/KeyboardShortcutProvider').useKeyboardShortcutContextSnapshot>['registration'] = null;
const nativeBoundary = vi.hoisted(() => ({ pathname: '', platformOs: 'ios' as 'ios' | 'android' }));
let filteredListingEnabled = false;
let previousRealStorageState: ReturnType<typeof import('@/sync/domains/state/storageStore').storage.getState> | undefined;
let previousWarmCacheAccountScope: string | null;

let sessionTagsV1: Record<string, string[]> = {};
let sessionListIdentityDisplay: 'avatar' | 'agentLogo' | 'none' | 'project' = 'avatar';
let sessionListStatusWords = false;
let sessionListRowContextV1 = true;
let collectionSpacesV1: CollectionSpacesV1 = { v: 1, spaces: [] };
const virtualizedListState = vi.hoisted(() => ({
    current: null as null | {
        props: any | null;
        refHandle: unknown;
        reset(): void;
    },
}));
let allMachines = [
    {
        id: 'machine-target',
        seq: 1,
        createdAt: 1,
        updatedAt: 10,
        active: true,
        activeAt: 10,
        metadata: {
            displayName: 'Rebound workstation',
            host: 'target.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/Users/test/.happier',
            homeDir: '/Users/test',
        },
        metadataVersion: 1,
        accessTokenEncrypted: null,
        accessTokenNonce: null,
        daemonState: null,
        daemonStateVersion: 1,
    },
    {
        id: 'machine-other',
        seq: 1,
        createdAt: 1,
        updatedAt: 5,
        active: true,
        activeAt: 5,
        metadata: {
            displayName: 'Other workstation',
            host: 'other.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/Users/test/.happier',
            homeDir: '/Users/test',
        },
        metadataVersion: 1,
        accessTokenEncrypted: null,
        accessTokenNonce: null,
        daemonState: null,
        daemonStateVersion: 1,
    },
];
let storageState: Pick<ReturnType<typeof realStorage.getState>, 'sessionListRowsByServerId'> = { sessionListRowsByServerId: {} };

const groupKey = 'server:srv_server_a:day:2026-02-17';
const defaultProjectGroupKey = 'server:srv_server_a:project:default';

const sessionA = createSessionListRenderableSessionFixture({
    id: 'sess_a',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: false,
    activeAt: 0,
    metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/stale-repo',
        homeDir: '/Users/test',
        host: 'stale.local',
    },
    metadataVersion: 1,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 0,
    owner: 'account-a',
});

const sessionB = {
    ...sessionA,
    id: 'sess_b',
    metadata: {
        machineId: 'machine-other',
        path: '/Users/test/other-repo',
        homeDir: '/Users/test',
        host: 'other.local',
    },
} as any;

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-safe-area-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native-safe-area-context')>();
    const React = await import('react');
    return {
        ...actual,
        SafeAreaInsetsContext: actual.SafeAreaInsetsContext ?? React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    };
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('@legendapp/list/react-native', async () => {
    const legendListModule = (await import('@/dev/testkit/mocks/legendList')) as typeof import('@/dev/testkit/mocks/legendList');
    return legendListModule.createLegendListModuleMock({
        renderItems: true,
    }, (state) => { virtualizedListState.current = state; });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

// Native transport factories must be registered before Home/TokenStorage imports.
// A late common-helper option leaves those imports bound to its default web Platform.
vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return nativeBoundary.platformOs;
                },
                select: (value: any) => value[nativeBoundary.platformOs] ?? value.default,
            },
            Dimensions: { get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
                addEventListener: () => ({ remove() {} }) },
            TurboModuleRegistry: { get: () => ({}) },
        });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: () => nativeBoundary.pathname,
            router: {
                push: routerPushSpy,
                navigate: routerNavigateSpy,
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
});

let mockAllowedServerIds: string[] = ['srv_server_a'];

let mockVisibleSessionListViewData: any[] = [
    {
        type: 'header',
        title: 'Project',
        headerKind: 'project',
        groupKey: defaultProjectGroupKey,
        serverId: 'srv_server_a',
        serverName: 'Server A',
    },
    {
        type: 'session',
        session: sessionA,
        groupKey: defaultProjectGroupKey,
        groupKind: 'project',
        serverId: 'srv_server_a',
        serverName: 'Server A',
    },
    {
        type: 'session',
        session: sessionB,
        groupKey: defaultProjectGroupKey,
        groupKind: 'project',
        serverId: 'srv_server_a',
        serverName: 'Server A',
    },
];

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: vi.fn(),
}));

function resetVisibleSessionListViewData(): void {
    mockVisibleSessionListViewData = [
        {
            type: 'header',
            title: 'Project',
            headerKind: 'project',
            groupKey: defaultProjectGroupKey,
            serverId: 'srv_server_a',
            serverName: 'Server A',
        },
        {
            type: 'session',
            session: sessionA,
            groupKey: defaultProjectGroupKey,
            groupKind: 'project',
            serverId: 'srv_server_a',
            serverName: 'Server A',
        },
        {
            type: 'session',
            session: sessionB,
            groupKey: defaultProjectGroupKey,
            groupKind: 'project',
            serverId: 'srv_server_a',
            serverName: 'Server A',
        },
    ];
}

let NativeSessionsListView: typeof import('./SessionsList').SessionsListView;
let useFixtureFolderSupport: typeof import('@/sync/domains/session/listing/useSessionListQuerySourceState').useSessionListFeatureHomeSupportByServerId;

function SessionsList(props: React.ComponentProps<typeof import('./SessionsList').SessionsList> = {}) {
    const folderSupport = useFixtureFolderSupport('sessions.folders', mockAllowedServerIds, true);
    const paneState = React.useMemo(() => ({
        summary: { sessionsReady: true, sessionCount: mockVisibleSessionListViewData.filter((item) => item.type === 'session').length },
        visibleSessionListIndex: buildSessionListIndexFromViewData(mockVisibleSessionListViewData),
        hasHiddenInactiveSessions: false,
        folderFeatureEnabledServerIds: mockAllowedServerIds.filter((serverId) => folderSupport[serverId] === true),
        showLoading: false,
        showEmptyState: false,
    } satisfies import('@/hooks/session/useVisibleSessionListPaneState').VisibleSessionListPaneState), [mockVisibleSessionListViewData, mockAllowedServerIds, folderSupport]);
    return <NativeSessionsListView {...props} paneState={paneState} />;
}

async function publishOrganizationFixture() {
    for (const serverId of mockAllowedServerIds) {
        await applySessionOrganizationLegacyTestSettings({ serverId, pinnedSessionKeysV1, sessionTagsV1 });
    }
}

async function renderSessionsList(props: React.ComponentProps<typeof import('./SessionsList').SessionsList> = {}) {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const rowsByServerId = { ...storageState.sessionListRowsByServerId };
    for (const item of mockVisibleSessionListViewData) {
        if (item.type !== 'session') continue;
        rowsByServerId[item.serverId] = { ...rowsByServerId[item.serverId], [item.session.id]: item.session };
    }
    await publishOrganizationFixture();
    storage.setState({
        sessionListRowsByServerId: rowsByServerId,
        ordinarySessionListMembershipByServerId: Object.fromEntries(
            Object.entries(rowsByServerId).map(([serverId, rows]) => [serverId, Object.keys(rows ?? {})]),
        ),
        sessionListIndexByServerId: Object.fromEntries(mockAllowedServerIds.map((serverId) => [
            serverId,
            buildSessionListIndexFromViewData(mockVisibleSessionListViewData.filter((item) => item.serverId === serverId)),
        ])),
    });
    NativeSessionsListView = (await import('./SessionsList')).SessionsListView;
    useFixtureFolderSupport = (await import('@/sync/domains/session/listing/useSessionListQuerySourceState')).useSessionListFeatureHomeSupportByServerId;
    publishPresentationFixture();
    if (filteredListingEnabled) {
        const { getCachedServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        for (const serverId of mockAllowedServerIds) {
            const snapshot = getCachedServerFeaturesSnapshot({ serverId });
            const features = structuredClone(snapshot?.status === 'ready' ? snapshot.features : createRootLayoutFeaturesResponse());
            expect(tryWriteServerEnabledBitInPlace(features, 'search', true)).toBe(true);
            expect(tryWriteServerEnabledBitInPlace(features, 'sessions.filteredListing', true)).toBe(true);
            primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        }
    }
    await publishHomeSelectionFixture();
    const screen = await renderScreen(<SessionsList {...props} />, { wrapper: NativeListProviders });
    // Resolve the fixture's async secure-storage reads before identity baselines are captured.
    await flushHookEffects();
    return screen;
}

async function renderSessionsListWithSurfaceOwnership(surfaceOwnership: Readonly<{
    interactive?: boolean;
    dataActive?: boolean;
    visible?: boolean;
}>) {
    return renderSessionsList({ surfaceOwnership });
}

function findSessionItem(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
    sessionId: string,
) {
    return screen.findAllByType(SessionItem).find(item => item.props.session?.id === sessionId) ?? null;
}

/** Read the real menu's trigger contract without opening an unrelated platform popover. */
function readSpaceTitle(screen: Awaited<ReturnType<typeof renderSessionsList>>) {
    const menu = expectPresent(
        screen.findAllByType(DropdownMenu).find(node => node.props.popoverAccessibilityLabel === t('sessionsList.spacesTitle')),
        'expected the space menu',
    );
    const title = menu.props.trigger({ open: false, toggle: () => {}, openMenu: () => {}, closeMenu: () => {}, selectedItem: null });
    expect(title.props.testID).toBe('session-list-space-title');
    return title;
}

function expectPresent<T>(value: T | null | undefined, label: string): T {
    expect(value, label).toBeTruthy();
    if (value == null) {
        throw new Error(label);
    }
    return value;
}

function findProjectHeaderMenuItems(screen: Awaited<ReturnType<typeof renderSessionsList>>): ReadonlyArray<{ id: string }> {
    const header = screen.findAllByType(ProjectGroupHeader)[0];
    return screen.findAllByType(DropdownMenu).find(node => { for (let parent = node.parent; parent; parent = parent.parent) if (parent === header) return true; return false; })?.props.items ?? [];
}

async function selectHeaderTagFilter(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
    label: string,
) {
    const control = screen.root.find((node) => typeof node.props.editor?.updateFilters === 'function');
    const { editor } = control.props as import('./search/SessionListFilterEditorControl').SessionListFilterEditorControlProps;
    const tag = expectPresent(editor.tags.find((option) => option.label === label), 'expected qualified tag filter option');
    // The phone modal is a presentation boundary; exercise its canonical editor callback and
    // retained filter owner instead of restoring the retired standalone tag dropdown.
    await act(async () => editor.updateFilters({
        ...editor.filters,
        tagIds: [{ serverId: tag.serverId, tagId: tag.tagId }],
    }));
}

function findRecordedGestureDetectors(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
) {
    // The Space title's intentional swipe gesture is not a Session-row drag gesture (K1).
    const rows = screen.findAllByType(SessionListRow);
    expect(rows.length).toBeGreaterThan(0);
    return rows.flatMap(row => row.findAll(node =>
        String(node.type) === 'GestureDetector' && Boolean(findGestureByKind(node.props.gesture, 'pan'))));
}

// Load real owners after installing boundaries, outside the first behavior timeout.
await import('./SessionsList');
const { SessionListRow } = await import('./sessionListRow');
const { ProjectGroupHeader, CollapsibleSectionHeader } = await import('./sessionListChrome');
const { SessionItem } = await import('./SessionItem');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { useKeyboardShortcutContextSnapshot } = await import('@/keyboard/KeyboardShortcutProvider');
const { CommandPaletteProvider } = await import('@/components/appShell/commandPalette/CommandPaletteProvider');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { t } = await import('@/text');
const markdownRuntime = await import('@/components/markdown/enriched/preloadEnrichedMarkdownRuntime');
const preloadEnrichedMarkdownRuntimeSpy = vi.spyOn(markdownRuntime, 'preloadEnrichedMarkdownRuntime');
const machineTargets = await import('@/sync/ops/sessionMachineTarget');
const readDisplayMachineTargetSpy = vi.spyOn(machineTargets, 'readDisplayMachineTargetForSession');
const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');

function KeyboardRegistrationObserver() {
    keyboardRegistration = useKeyboardShortcutContextSnapshot().registration;
    return null;
}

function NativeListProviders({ children }: React.PropsWithChildren) {
    return <AuthProvider initialCredentials={connection?.credentials ?? null}>
        <AppPaneProvider><CommandPaletteProvider>
            <KeyboardRegistrationObserver />
            {children}
        </CommandPaletteProvider></AppPaneProvider>
    </AuthProvider>;
}

function publishPresentationFixture() {
    realStorage.getState().applySettingsLocal({ collectionSpacesV1: CollectionSpacesV1Schema.parse(collectionSpacesV1),
        sessionListIdentityDisplay, sessionListStatusWords,
        sessionListRowContextV1, sessionTagsEnabled: true,
    });
}

async function publishHomeSelectionFixture() {
    await updateEffectiveHomeViewState(state => ({ ...state,
        activeTargetKind: mockAllowedServerIds.length > 1 ? 'group' : 'server',
        activeTargetId: mockAllowedServerIds.length > 1 ? 'native-list-fixture' : mockAllowedServerIds[0],
        groups: [{ id: 'native-list-fixture', name: 'Native list', serverIds: mockAllowedServerIds, presentation: 'grouped' }],
    }), { scope: 'device' });
}

await import('@/sync/domains/session/listing/useSessionListQuerySourceState');

describe('SessionsList (native virtualization)', () => {
    beforeEach(async () => {
        virtualizedListState.current?.reset();
        sessionListIdentityDisplay = 'avatar';
        sessionListStatusWords = false;
        sessionListRowContextV1 = true;
        nativeBoundary.pathname = '';
        pinnedSessionKeysV1 = [];
        sessionMruState.set('order', []);
        sessionTagsV1 = {};
        replaceCollapsedGroupKeys({});
        collectionSpacesV1 = { v: 1, spaces: [] };
        await writeCollectionSpaceSelectionV1({ scope: { serverId: 'srv_server_a', accountId: 'account-a' },
            entityKind: 'sessionWork', spaceId: 'my-work', isCurrent: () => true,
            readSettings: () => ({ collectionSpacesV1 }) });
        routerNavigateSpy.mockClear();
        routerPushSpy.mockClear();
        fetchMoreSessionsMock.mockClear();
        hydrateSessionListRowsMock.mockClear();
        refreshSessionsMock.mockClear();
        pendingSessionPage = null;
        preloadEnrichedMarkdownRuntimeSpy.mockClear();
        keyboardRegistration = null;
        clearSessionListViewFilterRetentionForTests();
        resetSessionListPaneRetentionForTests();
        mockAllowedServerIds = ['srv_server_a'];
        nativeBoundary.platformOs = 'ios';
        filteredListingEnabled = false;
        readDisplayMachineTargetSpy.mockClear();
        resetVisibleSessionListViewData();
        storageState.sessionListRowsByServerId = {
            srv_server_a: {
                sess_a: sessionA,
                sess_b: sessionB,
            },
        };
        previousRealStorageState = realStorage.getState();
        previousWarmCacheAccountScope = resolveWarmCacheAccountScope(null);
        await home.reset();
        homeA = await home.addHome({ name: 'Server A', serverUrl: 'https://server-a.example.test', serverIdentityId: 'srv_server_a', accountId: 'account-a' });
        await home.addHome({ name: 'Server B', serverUrl: 'https://server-b.example.test', serverIdentityId: 'srv_server_b', accountId: 'account-b', active: false });
        expect(listServerProfiles().map(resolveServerProfileScopeId)).toEqual(expect.arrayContaining(['srv_server_a', 'srv_server_b']));
        // These host rows represent the focused Account's restored native cache.
        // Credential observers must be able to prove its Account before retaining them.
        setWarmCacheAccountScope('account-a');
        home.answer(homeA, pinPath, { body: { pin: { sessionId: 'sess_a', sortKey: null, pinnedAt: 1, listPinned: true, railPinned: false } } });
        home.answer(homeA, tagsPath, { body: { sessionId: 'sess_a', tagIds: ['fixture-tag-2'] } });
        const ordinaryFeatures = createRootLayoutFeaturesResponse({
            // This fixture is the ordinary, unfiltered pane producer.
            features: { search: { enabled: true }, sessions: { folders: { enabled: false }, filteredListing: { enabled: false } } },
        });
        for (const profile of listServerProfiles().filter((profile) => ['srv_server_a', 'srv_server_b'].includes(resolveServerProfileScopeId(profile)))) {
            home.answer(profile.id, '/v1/features', { body: ordinaryFeatures });
            home.answer(profile.id, '/v1/features/authenticated', { body: ordinaryFeatures });
        }
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://server-a.example.test', serverIdentityId: 'srv_server_a', accountId: 'account-a', request,
        });
        await waitForHomeGovernance(() => {
            const state = realStorage.getState();
            expect(state.settingsScope).toEqual({ serverId: 'srv_server_a', accountId: 'account-a' });
            expect(state.profileScope).toEqual({ serverId: 'srv_server_a', accountId: 'account-a' });
            expect(state.profile.id).toBe('account-a');
            expect(state.isDataReady).toBe(true);
        });
        fetchMoreSessionsMock.mockClear();
        hydrateSessionListRowsMock.mockClear();
        refreshSessionsMock.mockClear();
        home.requests.length = 0;
        realStorage.setState({ sessionListRowsByServerId: storageState.sessionListRowsByServerId,
            machines: Object.fromEntries(allMachines.map(machine => [machine.id, machine])),
            machineListByServerId: { srv_server_a: allMachines },
            machineDisplayById: Object.fromEntries(allMachines.map(machine =>
                [machine.id, buildMachineDisplayRenderableFromMachine(machine)])),
        });
        realStorage.getState().clearProjectAccountRowsScope();
        resetServerFeaturesClientForTests();
        for (const serverId of ['srv_server_a', 'srv_server_b']) {
            primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: ordinaryFeatures } });
        }
    });

    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        connection = null;
        await home.reset();
        if (previousRealStorageState) realStorage.setState(previousRealStorageState, true);
        setWarmCacheAccountScope(previousWarmCacheAccountScope);
        resetServerFeaturesClientForTests();
    });

    it('preloads the transcript markdown runtime before a session is opened from the list', async () => {
        await renderSessionsList();
        expect(preloadEnrichedMarkdownRuntimeSpy).toHaveBeenCalledOnce();
    });

    it('defers bulk action targets until selection opens and rebuilds current targets when reopened', async () => {
        const screen = await renderSessionsList();
        const { buildServerScopedSessionKey } = await import('@/sync/domains/session/navigation/sessionNavigationOrder');
        const selectedKey = buildServerScopedSessionKey('sess_a', 'srv_server_a');
        const { SessionListSelectionStoreProvider } = await import('./selection/SessionListSelectionContext');
        const { SessionListSelectionActionBarHost } = await import('./selection/SessionListSelectionActionBar');
        const store = screen.root.findByType(SessionListSelectionStoreProvider).props.store;
        const readTargets = () => expectPresent(
            screen.root.findByType(SessionListSelectionActionBarHost).props.targetsByKey,
            'expected bulk action targets to be published',
        );

        // This is the unused bulk model, not the virtualized row projection.
        expect(readTargets().size).toBe(0);
        await act(async () => { store.enter(selectedKey); });
        expect(readTargets().size).toBe(1);
        expect(expectPresent(readTargets().get(selectedKey), 'expected selected bulk target').tags).toEqual([]);
        await act(async () => { store.selectAllVisible(); });
        expect(store.getSnapshot().count).toBe(2);
        expect(readTargets().size).toBe(2);
        await act(async () => { store.exit(); });
        expect(readTargets().size).toBe(0);

        sessionTagsV1 = { 'srv_server_a:sess_a': ['updated-while-closed'] };
        await publishOrganizationFixture();
        await screen.update(<SessionsList />);
        expect(readTargets().size).toBe(0);
        await act(async () => { store.enter(selectedKey); });
        expect(expectPresent(readTargets().get(selectedKey), 'expected reopened bulk target').tags).toEqual(['updated-while-closed']);
    });

    it('keeps unchanged rows unrendered when real-store arrivals shift their list positions', async () => {
        const rowModels = await import('./sessionListRowViewModels');
        const inlineDrag = await import('./useSessionInlineDrag');
        // Call-through observation of real row derivation, not an internal mock.
        const derive = vi.spyOn(rowModels, 'buildSessionListRowViewModel');
        // The real drag hook runs during each SessionListRow render, beneath its memo boundary.
        const rowRenders = vi.spyOn(inlineDrag, 'useSessionInlineDrag');
        const originalRows = Array.from({ length: 24 }, (_, index) => createSessionListRenderableSessionFixture({
            ...sessionB, id: `unchanged-position-row-${index}`,
        }));
        mockVisibleSessionListViewData = [mockVisibleSessionListViewData[0], ...originalRows.map(session => ({
            type: 'session', session, groupKey: defaultProjectGroupKey, groupKind: 'project', serverId: 'srv_server_a',
        }))];
        const screen = await renderSessionsList();
        const index = buildSessionListIndexFromViewData(mockVisibleSessionListViewData) ?? [];
        const paneState = {
            summary: { sessionsReady: true, sessionCount: originalRows.length },
            visibleSessionListIndex: index,
            hasHiddenInactiveSessions: false,
            folderFeatureEnabledServerIds: [], showLoading: false, showEmptyState: false,
        } satisfies import('@/hooks/session/useVisibleSessionListPaneState').VisibleSessionListPaneState;
        await screen.update(<NativeSessionsListView paneState={paneState} />);
        await flushHookEffects();
        const originalModels = new Map(originalRows.map(row => [row.id,
            expectPresent(findSessionItem(screen, row.id), 'expected unchanged row').props.rowViewModel]));
        const originalKeys = new Set(originalRows.map(row => buildSessionOrganizationSessionKey('srv_server_a', row.id)));
        derive.mockClear();
        rowRenders.mockClear();
        try {
            let items = index;
            let insertedItems: typeof index = [];
            for (let arrival = 0; arrival < 5; arrival++) {
                const added = createSessionListRenderableSessionFixture({ ...sessionB, id: `another-group-session-${arrival}` });
                const addedGroupKey = `another-group-${arrival}`;
                const addedItems = buildSessionListIndexFromViewData([
                    { type: 'header', title: 'Another group', headerKind: 'date', groupKey: addedGroupKey, serverId: 'srv_server_a' },
                    { type: 'session', session: added, groupKey: addedGroupKey, groupKind: 'date', serverId: 'srv_server_a' },
                ]) ?? [];
                await act(async () => { realStorage.getState().applyServerScopedSessionListRows('srv_server_a', [added],
                    { source: 'ordinary', mode: 'append' }); });
                insertedItems = [...addedItems, ...insertedItems];
                items = [...insertedItems, ...index];
                await screen.update(<NativeSessionsListView paneState={{ ...paneState,
                    summary: { sessionsReady: true, sessionCount: originalRows.length + 1 + arrival }, visibleSessionListIndex: items,
                }} />);
                await flushHookEffects();
                expect(findSessionItem(screen, added.id)).toBeTruthy();
            }
            // Moving the intact group changes absolute indices but no row's own content or adjacency.
            await screen.update(<NativeSessionsListView paneState={{ ...paneState,
                summary: { sessionsReady: true, sessionCount: originalRows.length + 5 },
                visibleSessionListIndex: [...index, ...insertedItems],
            }} />);
            await flushHookEffects();
            for (const row of originalRows) expect(findSessionItem(screen, row.id)?.props.rowViewModel).toBe(originalModels.get(row.id));
            expect(derive.mock.calls.filter(([input]) => originalModels.has(input.item.sessionId))).toHaveLength(0);
            expect(rowRenders.mock.calls.filter(([input]) => input.sessionKey !== null && originalKeys.has(input.sessionKey))).toHaveLength(0);
        } finally { derive.mockRestore(); rowRenders.mockRestore(); await screen.unmount(); }
    });

    it('invalidates mounted cells when a Section gains a member, so its header count follows the row', async () => {
        await renderSessionsList();
        const { storage } = await import('@/sync/domains/state/storageStore');
        await act(async () => {
            await applySessionOrganizationLegacyTestSettings({
                serverId: 'srv_server_a',
                sessionFoldersV1: { folders: [{ id: 'section-a', workspace: { t: 'managedSessions' }, parentId: null, name: 'Payments', createdAt: 1, updatedAt: 1 }] },
            });
        });
        await flushHookEffects();
        const before = virtualizedListState.current?.props.extraData;
        expect(before).toBeTruthy();
        await act(async () => {
            storage.getState().setSessionOrganizationFolderAssignmentOptimistic('srv_server_a', sessionB.id, 'section-a');
        });
        await flushHookEffects();
        expect(virtualizedListState.current?.props.extraData === before, 'the membership change reached extraData').toBe(false);
    });

    it('does not rederive settled rows for five unrelated shared-clock wakes', async () => {
        const rowModels = await import('./sessionListRowViewModels');
        const { sessionListRuntimeClock } = await import('@/hooks/session/sessionListRuntimeClock');
        const derive = vi.spyOn(rowModels, 'buildSessionListRowViewModel');
        const screen = await renderSessionsList();
        const token = {};
        try {
            vi.useFakeTimers();
            derive.mockClear();
            for (let wake = 1; wake <= 5; wake++) {
                sessionListRuntimeClock.requestWake(token, Date.now() + 1_000);
                await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
            }
            expect(derive.mock.calls.filter(([input]) => ['sess_a', 'sess_b'].includes(input.item.sessionId))).toHaveLength(0);
            await act(async () => { realStorage.getState().applyServerScopedSessionListRows('srv_server_a', [{
                ...sessionA, createdAt: Date.now() - 59_000,
            }], { source: 'ordinary', mode: 'append' }); });
            derive.mockClear();
            await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
            expect(derive.mock.calls.map(([input]) => input.item.sessionId)).toEqual(['sess_a']);
            expect(derive.mock.results[0]?.value.activityTimeLabel).toBe('1m');
        } finally {
            sessionListRuntimeClock.clearWake(token);
            derive.mockRestore();
            await screen.unmount();
            vi.useRealTimers();
        }
    });

    it('keeps an explicitly expanded empty search input mounted across incidental blur', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        expect(screen.findAllByTestId('session-list-search-input')).toHaveLength(0);

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected collapsed search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        const input = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected expanded search input',
        );
        expect(input.props.autoFocus).toBe(true);

        await act(async () => {
            input.props.onBlur?.();
        });

        expect(screen.findByTestId('session-list-search-input')).toBeTruthy();
    });

    it.each([
        { headerKind: 'attention' as const, groupKind: 'attention' as const, title: 'Needs Attention' },
        { headerKind: 'working' as const, groupKind: 'working' as const, title: 'Working' },
    ])('renders exactly one stable search chrome above the list for the $headerKind group', async ({ headerKind, groupKind, title }) => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title,
                headerKind,
                groupKey: headerKind,
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: headerKind,
                groupKind,
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();

        expect(screen.findAllByTestId('session-list-search-chrome')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('session-list-search-trigger')).toHaveLength(1);
        expect(screen.findAllByType(DropdownMenu).filter((node) =>
            Array.isArray(node.props.items)
            && (node.props as any).items.some((item: any) => item?.id === 'layout:projects')
        )).toHaveLength(1);
    });

    it('renders the canonical filter editor trigger when structural listing is available', async () => {
        filteredListingEnabled = true;
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'sessions.filteredListing', true)).toBe(true);
        primeServerFeaturesSnapshot({ serverId: 'srv_server_a', snapshot: { status: 'ready', features } });

        const screen = await renderSessionsList();

        // The title names the list's space and opens its spaces and filters menu (lab `clfilter`).
        expect(readSpaceTitle(screen).props.label).toBe(t('sessionsList.filtersMyWork'));
    });

    it('labels the filter trigger with the legacy corpus when its Home lacks structural listing support', async () => {
        filteredListingEnabled = true;

        const screen = await renderSessionsList();
        expect(readSpaceTitle(screen).props.label).toBe(t('sessionsList.filtersLegacyOwnerDirect'));
    });

    it('keeps the header search input open with text and filters visible sessions', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected collapsed search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        const input = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected expanded search input',
        );
        await act(async () => {
            input.props.onChangeText?.('sess_b');
            input.props.onBlur?.();
        });

        expect(screen.findAllByTestId('session-list-search-input').length).toBeGreaterThan(0);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(0);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(1);
    });

    it('retains active header search filters across a route-level remount', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected collapsed search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected expanded search input',
            ).props.onChangeText?.('sess_b');
        });

        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(0);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(1);

        standardCleanup();
        const remounted = await renderScreen(<SessionsList />, { wrapper: NativeListProviders });

        const retainedInput = expectPresent(
            remounted.findByTestId('session-list-search-input'),
            'expected retained search input after remount',
        );
        expect(retainedInput.props.value).toBe('sess_b');
        expect(remounted.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(0);
        expect(remounted.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(1);
    });

    it('keeps one stable search field across multiple primary sections while typing', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Pinned',
                headerKind: 'pinned',
                groupKey: 'pinned',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'pinned',
                groupKind: 'pinned',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        // The chrome is a sibling of the one virtualized list, not per-section header data.
        expect(screen.findAllHostsByTestId('session-list-search-trigger')).toHaveLength(1);

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected collapsed search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        const inputOnOpen = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected expanded search input',
        );

        // First character: the list rebuilds around the field; the field itself must not.
        await act(async () => {
            inputOnOpen.props.onChangeText?.('s');
        });
        const inputAfterFirstChar = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected retained search input after typing',
        );
        expect(inputAfterFirstChar).toBe(inputOnOpen);
        expect(inputAfterFirstChar.props.value).toBe('s');

        // Subsequent characters, including a query that empties the list.
        await act(async () => {
            inputAfterFirstChar.props.onChangeText?.('sess_b');
        });
        expect(screen.findByTestId('session-list-search-input')).toBe(inputOnOpen);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(0);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(1);

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected search input before no-results query',
            ).props.onChangeText?.('zzz-no-results');
        });
        expect(screen.findByTestId('session-list-search-input')).toBe(inputOnOpen);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(0);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-filtered-no-results').length).toBeGreaterThan(0);

        // Clearing keeps the same field mounted and restores the prior list state.
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected search input before clearing',
            ).props.onChangeText?.('');
        });
        expect(screen.findByTestId('session-list-search-input')).toBe(inputOnOpen);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(1);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(1);

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected search input before the final query',
            ).props.onChangeText?.('sess_a');
        });
        expect(screen.findByTestId('session-list-search-input')).toBe(inputOnOpen);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(1);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(0);
    });

    it('escalates the contextual query through the canonical Search opener with the query preserved', async () => {
        const screen = await renderSessionsList();
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected collapsed search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected search input before contextual escalation',
            ).props.onChangeText?.('vector');
        });

        const escalation = expectPresent(
            screen.findByTestId('session-list-search-everything'),
            'expected Search everything escalation row',
        );
        expect(escalation.props.accessibilityRole).toBe('button');

        await act(async () => {
            escalation.props.onPress?.({ stopPropagation: vi.fn() });
        });

        expect(routerPushSpy).toHaveBeenCalledWith({ pathname: '/search', params: { q: 'vector', accountId: 'account-a', serverId: 'srv_server_a' } });
    });

    it('seeds Search everything from the mounted Team Home instead of the globally active Home', async () => {
        filteredListingEnabled = true;
        const screen = await renderSessionsList({
            viewContext: {
                kind: 'team',
                team: { serverId: 'srv_server_b', teamId: 'team_b' },
                teamDisplayName: 'Team B',
            },
        });
        await act(async () => {
            await Promise.resolve();
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected Team-context search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected Team-context search input',
            ).props.onChangeText?.('vector');
        });

        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('session-list-search-everything')).toBeTruthy();
        });
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-everything'),
                'expected Team-context Search everything action after its exact Account binding resolves',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        expect(routerPushSpy).toHaveBeenCalledWith({ pathname: '/search', params: { q: 'vector', accountId: 'account-b', serverId: 'srv_server_b' } });
        expect(routerPushSpy).not.toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ accountId: 'account-a', serverId: 'srv_server_a' }) }));
    });

    it('keeps focused search open when clearing the last character after no results', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Pinned',
                headerKind: 'pinned',
                groupKey: 'pinned',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'pinned',
                groupKind: 'pinned',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const searchTriggers = screen.findAllHostsByTestId('session-list-search-trigger');
        expect(searchTriggers).toHaveLength(1);

        await act(async () => {
            expectPresent(
                searchTriggers[0],
                'expected stable search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected expanded search input',
            ).props.onChangeText?.('z');
        });

        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(0);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(0);

        await act(async () => {
            const inputBeforeClear = expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected search input to remain available before clearing',
            );
            inputBeforeClear.props.onChangeText?.('');
            inputBeforeClear.props.onBlur?.();
        });

        const inputAfterClear = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected focused search input to stay mounted after clearing',
        );
        expect(inputAfterClear.props.value).toBe('');
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(1);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(1);
    });

    it('shows the header tag filter when known tags exist and filters by any selected tag', async () => {
        sessionTagsV1 = { 'srv_server_a:sess_a': ['important'], 'srv_server_a:sess_b': ['later'] };
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        await selectHeaderTagFilter(screen, 'important');

        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(1);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(0);
    });

    it('retains a selected tag through a temporary missing organization projection', async () => {
        sessionTagsV1 = { 'srv_server_a:sess_a': ['important'], 'srv_server_a:sess_b': ['later'] };
        const screen = await renderSessionsList();
        await selectHeaderTagFilter(screen, 'important');
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(0);

        // A loading/offline projection may temporarily have no known tags. That
        // absence is not authoritative deletion evidence and must not erase the
        // canonical qualified filter selection.
        sessionTagsV1 = {};
        const { storage } = await import('@/sync/domains/state/storageStore');
        await act(async () => { storage.getState().clearSessionOrganizationForServer('srv_server_a'); });
        await screen.update(<SessionsList />);
        sessionTagsV1 = { 'srv_server_a:sess_a': ['important'], 'srv_server_a:sess_b': ['later'] };
        await publishOrganizationFixture();
        await screen.update(<SessionsList />);

        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(1);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(0);
    });

    it('keeps iOS rows free of any drag gesture outside Organize mode, so scroll, swipe and long-press keep their meaning (K1)', async () => {
        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.dragEnabled).toBe(true);
        expect(first.props.organizeMode).toBe(false);
        expect(first.props.dragGripGesture).toBeUndefined();
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
    });

    it('uses a plain row bounds wrapper on Android where full-row inline drag is disabled', async () => {
        nativeBoundary.platformOs = 'android';

        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        let rowWrapper: typeof first.parent | null = first.parent;
        while (rowWrapper && rowWrapper.props?.collapsable !== false) {
            rowWrapper = rowWrapper.parent;
        }
        rowWrapper = expectPresent(rowWrapper, 'expected session row bounds wrapper');

        expect(first.props.dragGripGesture).toBeUndefined();
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
        expect(String(rowWrapper.type)).toBe('View');
        expect(rowWrapper.props.collapsable).toBe(false);
    });

    it.each(['ios', 'android'] as const)('opens the %s native context menu when the row reports its long press', async (platform) => {
        nativeBoundary.platformOs = platform;
        const screen = await renderSessionsList();
        const initialListProps = virtualizedListState.current?.props;
        expect(initialListProps).toBeTruthy();
        const initialRenderItem = initialListProps?.renderItem;
        const initialExtraData = initialListProps?.extraData;
        const row = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');

        await act(async () => {
            row.props.onNativeContextMenuOpenChange(true);
        });

        const open = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(open.props.nativeContextMenuOpen).toBe(true);
        const openListProps = virtualizedListState.current?.props;
        expect(openListProps?.renderItem).toBe(initialRenderItem);
        expect(openListProps?.extraData).not.toBe(initialExtraData);

        await act(async () => {
            open.props.onNativeContextMenuOpenChange(false);
        });

        const closed = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after close');
        expect(closed.props.nativeContextMenuOpen).toBe(false);
    });

    it.each(['ios', 'android'] as const)('suppresses %s native context menu activation while the native list is being scrolled', async (platform) => {
        nativeBoundary.platformOs = platform;
        const screen = await renderSessionsList();
        const listProps = virtualizedListState.current?.props;
        const row = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');

        expect(typeof listProps?.onScrollBeginDrag).toBe('function');
        expect(typeof listProps?.onScrollEndDrag).toBe('function');

        await act(async () => {
            listProps?.onScrollBeginDrag?.();
            row.props.onNativeContextMenuOpenChange(true);
        });

        const suppressed = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row after suppressed long press',
        );
        expect(suppressed.props.nativeContextMenuOpen).toBe(false);

        await act(async () => {
            listProps?.onScrollEndDrag?.();
            row.props.onNativeContextMenuOpenChange(true);
        });

        const opened = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row after fresh long press',
        );
        expect(opened.props.nativeContextMenuOpen).toBe(true);
    });

    it.each(['ios', 'android'] as const)('closes an open %s native context menu when native list scrolling starts', async (platform) => {
        nativeBoundary.platformOs = platform;
        const screen = await renderSessionsList();
        const listProps = virtualizedListState.current?.props;
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');

        await act(async () => {
            first.props.onNativeContextMenuOpenChange(true);
        });

        const opened = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after open');
        expect(opened.props.nativeContextMenuOpen).toBe(true);

        await act(async () => {
            listProps?.onScrollBeginDrag?.();
        });

        const closed = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after scroll start');
        expect(closed.props.nativeContextMenuOpen).toBe(false);
    });

    it.each(['ios', 'android'] as const)('ignores stale %s native context menu close requests from another row', async (platform) => {
        nativeBoundary.platformOs = platform;
        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');

        await act(async () => {
            first.props.onNativeContextMenuOpenChange(true);
        });

        const opened = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after open');
        expect(opened.props.nativeContextMenuOpen).toBe(true);

        const second = expectPresent(findSessionItem(screen, 'sess_b'), 'expected sess_b session row');
        await act(async () => {
            second.props.onNativeContextMenuOpenChange(false);
        });

        const stillOpen = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after stale close');
        expect(stillOpen.props.nativeContextMenuOpen).toBe(true);
    });

    it('keeps the native date-ordered carry source free of gestures outside Organize mode', async () => {
        realStorage.getState().applySettingsLocal({ sessionListLayoutV1: 'recent_activity' });
        mockVisibleSessionListViewData = mockVisibleSessionListViewData.map(item => item.type === 'header'
            ? { ...item, headerKind: 'date', groupKey }
            : { ...item, groupKind: 'date', groupKey });

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.dragEnabled).toBe(true);
        expect(first.props.dragGripGesture).toBeUndefined();
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
    });

    it('shares Android context-menu state without drag gestures outside Organize mode', async () => {
        nativeBoundary.platformOs = 'android';

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.dragGripGesture).toBeUndefined();
        expect(first.props.nativeContextMenuOpen).toBe(false);
        expect(first.props.onNativeContextMenuOpenChange).toEqual(expect.any(Function));
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
    });

    it('passes canonical virtualization hints without deprecated size estimates', async () => {
        await renderSessionsList();

        expect(virtualizedListState.current?.props?.estimatedItemSize).toBeUndefined();
        expect(typeof virtualizedListState.current?.props?.getItemType).toBe('function');
    });

    it('disables native maintain-visible-content-position for the session list surface', async () => {
        await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });

        expect(virtualizedListState.current?.props?.maintainVisibleContentPosition).toBe(false);
        expect(virtualizedListState.current?.props?.recycleItems).toBe(false);
    });

    it('passes scroll and viewport events to session-list drag autoscroll on native lists', async () => {
        await renderSessionsList();

        const props = virtualizedListState.current?.props;
        expect(typeof props?.onScroll).toBe('function');
        expect(typeof props?.onLayout).toBe('function');
        expect(typeof props?.onContentSizeChange).toBe('function');
        expect(props?.scrollEventThrottle).toBe(16);
    });

    it('restores the retained list offset when the native list becomes visible after a zero-height hide', async () => {
        await renderSessionsList();

        const props = virtualizedListState.current?.props;
        const scrollToOffset = vi.fn();
        (virtualizedListState.current?.refHandle as { scrollToOffset?: unknown } | undefined)!.scrollToOffset = scrollToOffset;

        await act(async () => {
            props?.onLayout?.({ nativeEvent: { layout: { height: 416 } } });
            props?.onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 280 },
                    layoutMeasurement: { height: 416 },
                },
            });
            props?.onLayout?.({ nativeEvent: { layout: { height: 0 } } });
            props?.onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 0 },
                    layoutMeasurement: { height: 0 },
                },
            });
            props?.onLayout?.({ nativeEvent: { layout: { height: 416 } } });
        });

        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 280, animated: false });
    });

    it('keeps native virtualized list prop identities stable across unrelated rerenders', async () => {
        const screen = await renderSessionsList();
        const initialProps = virtualizedListState.current?.props;
        expect(initialProps).toBeTruthy();
        const initialKeyExtractor = initialProps?.keyExtractor;
        const initialRenderItem = initialProps?.renderItem;
        const initialContentContainerStyle = initialProps?.contentContainerStyle;
        const initialFooterComponent = initialProps?.ListFooterComponent;

        await screen.update(<SessionsList />);

        const updatedProps = virtualizedListState.current?.props;
        expect(updatedProps?.keyExtractor).toBe(initialKeyExtractor);
        expect(updatedProps?.renderItem).toBe(initialRenderItem);
        expect(updatedProps?.contentContainerStyle).toBe(initialContentContainerStyle);
        expect(updatedProps?.ListFooterComponent).toBe(initialFooterComponent);
    });

    it('keeps native row extra data stable when an equivalent session-list refresh only replaces data objects', async () => {
        nativeBoundary.platformOs = 'android';

        const screen = await renderSessionsList();
        const initialProps = virtualizedListState.current?.props;
        expect(initialProps).toBeTruthy();
        const initialExtraData = initialProps?.extraData;

        mockVisibleSessionListViewData = mockVisibleSessionListViewData.map((item) => (
            item.type === 'session'
                ? { ...item, session: { ...item.session } }
                : { ...item }
        ));
        await screen.update(<SessionsList />);

        const nextExtraData = virtualizedListState.current?.props?.extraData;
        const changedKeys = Object.keys(initialExtraData ?? {}).filter((key) =>
            !Object.is(initialExtraData[key], nextExtraData?.[key]));
        expect(nextExtraData, `Changed row inputs: ${changedKeys.join(', ')}`).toBe(initialExtraData);
    });

    it('invalidates mounted native rows when a row presentation setting changes', async () => {
        const screen = await renderSessionsList();
        const initialExtraData = virtualizedListState.current?.props?.extraData;

        await act(async () => { sessionListIdentityDisplay = 'none'; publishPresentationFixture(); });
        nativeBoundary.pathname = '/sessions';
        await screen.update(<SessionsList />);

        expect(virtualizedListState.current?.props?.extraData).not.toBe(initialExtraData);
        expect(virtualizedListState.current?.props?.extraData?.sessionListIdentityDisplay).toBe('none');
    });

    it('invalidates mounted native rows when a row-context choice changes (status words, context, identity mode)', async () => {
        // The recycler redraws a mounted cell only when its data or extraData changes, so every
        // input the row context reads must reach extraData or a toggle shows only after reload.
        const screen = await renderSessionsList();
        nativeBoundary.pathname = '/sessions';
        await screen.update(<SessionsList />);
        const changes: ReadonlyArray<readonly [string, () => void]> = [
            ['status words', () => { sessionListStatusWords = true; }],
            ['row context', () => { sessionListRowContextV1 = false; }],
            ['identity mode', () => { sessionListIdentityDisplay = 'project'; }],
        ];
        for (const [name, change] of changes) {
            const before = virtualizedListState.current?.props?.extraData;
            await act(async () => { change(); publishPresentationFixture(); });
            await screen.update(<SessionsList />);
            expect(virtualizedListState.current?.props?.extraData, name).not.toBe(before);
        }
    });

    it('emits one bounded semantic status-demand batch and projects native viewability to row subscription inputs', async () => {
        nativeBoundary.platformOs = 'ios';
        const header = expectPresent(
            mockVisibleSessionListViewData.find((item) => item.type === 'header'),
            'expected header item',
        );
        const profiledSessions = Array.from({ length: 145 }, (_, index) => ({
            ...sessionA,
            id: `sess_profiled_${index}`,
            updatedAt: sessionA.updatedAt + index,
            metadata: {
                ...expectPresent(sessionA.metadata, 'expected initialized Session metadata'),
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-target',
                    remoteSessionId: `remote-${index}`,
                    source: {
                        kind: 'codexHome',
                        home: '/tmp/codex',
                    },
                    linkedAtMs: index + 1,
                },
            },
        } satisfies SessionListRenderableSession));
        mockVisibleSessionListViewData = [
            header,
            ...profiledSessions.map((session) => ({
                type: 'session',
                session,
                groupKey,
                groupKind: 'date',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            })),
        ];
        const serverRows = Object.fromEntries(
            profiledSessions.map((session) => [session.id, session]),
        );
        storageState.sessionListRowsByServerId = {
            srv_server_a: serverRows,
        };

        const {
            registerExternalSessionStatusDemandTransport,
            resetExternalSessionStatusDemandCoordinatorForTests,
        } = await import('@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator');
        resetExternalSessionStatusDemandCoordinatorForTests();
        const emitStatusDemand = vi.fn();
        const statusDemandTransport = registerExternalSessionStatusDemandTransport(
            'srv_server_a',
            emitStatusDemand,
        );
        const screen = await renderSessionsList();
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
        syncPerformanceTelemetry.reset();
        try {
            // A transport registers with an empty replacement to clear previous
            // demand; mounting a list must not add loaded-row entries to it.
            expect(emitStatusDemand.mock.calls.every(([, payload]) => payload.entries.length === 0)).toBe(true);
            const initialProps = virtualizedListState.current?.props;
            expect(initialProps).toBeTruthy();
            expect(typeof initialProps?.onViewableItemsChanged).toBe('function');
            const initialExtraData = initialProps?.extraData;
            const initialData = initialProps?.data;
            const initialSessionNodes = Array.isArray(initialData)
                ? initialData.filter((node) => String(node.id).includes('sess_profiled_'))
                : [];

            syncPerformanceTelemetry.reset();
            await act(async () => {
                initialProps?.onViewableItemsChanged({
                    changed: [],
                    viewableItems: initialSessionNodes.slice(75, 88).map((item, index) => ({
                        index: 76 + index,
                        isViewable: true,
                        item,
                        key: item.id,
                    })),
                });
                await Promise.resolve();
            });

            const nonemptyDemands = emitStatusDemand.mock.calls
                .map(([, payload]) => payload)
                .filter(payload => payload.entries.length > 0);
            expect(nonemptyDemands).toHaveLength(1);
            const visibleDemand = nonemptyDemands[0] as {
                entries: Array<{ demand: string }>;
            };
            expect(visibleDemand.entries).toHaveLength(13);
            expect(visibleDemand.entries.every((entry) => entry.demand === 'visible')).toBe(true);
            const nextExtraData = virtualizedListState.current?.props?.extraData;
            // Viewability is row-local: scrolling publishes through the stable viewport
            // owner without invalidating every mounted cell through global extraData.
            expect(nextExtraData).toBe(initialExtraData);
            const viewport = expectPresent(
                screen.root.findAll(node => node.props.item?.type === 'session' && node.props.rowViewport)[0]?.props.rowViewport,
                'expected the mounted row viewport owner',
            );
            expect(profiledSessions.filter(session => viewport.isViewable(
                buildSessionListServerScopedRowKey('srv_server_a', session.id),
            )).map(session => session.id)).toEqual(profiledSessions.slice(75, 88).map(session => session.id));
            expect(virtualizedListState.current?.props?.data).toBe(initialData);
            const events = syncPerformanceTelemetry.snapshot().events;
            expect(events.find((event) => event.name === 'ui.sessionsList.viewableRows.changed')?.fields).toEqual(expect.objectContaining({
                changed: 1,
                nextVisibleRows: 13,
                previousKnown: 0,
                previousVisibleRows: 0,
            }));
            expect(events.find((event) => event.name === 'ui.sessionsList.rowStoreSubscriptions')?.fields).toEqual(expect.objectContaining({
                allRenderedRowsSubscribed: 1,
                dataActive: 1,
                priorityRows: 0,
                subscribedRows: 145,
                totalRows: 145,
                visibleRows: 13,
            }));
        } finally {
            statusDemandTransport.dispose();
            resetExternalSessionStatusDemandCoordinatorForTests();
            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        }
    });

    it('demands hydration only for actual visible rows and retires demand on blur and unmount', async () => {
        const { getVisibleSessionListSurfaces, getVisibleSessionSurfaces } = await import('@/sync/domains/session/sessionSurfaceVisibility');
        const screen = await renderSessionsList();
        expect(hydrateSessionListRowsMock).not.toHaveBeenCalled();
        expect(getVisibleSessionListSurfaces()).toEqual([]);
        const listProps = expectPresent(virtualizedListState.current?.props, 'expected list props');
        const node = expectPresent(listProps.data.find((item: { id: string }) => item.id === buildSessionListIndexNodeId({
            type: 'session', serverId: 'srv_server_a', sessionId: 'sess_a',
        })), 'expected Session node');
        const secondNode = expectPresent(listProps.data.find((item: { id: string }) => item.id === buildSessionListIndexNodeId({
            type: 'session', serverId: 'srv_server_a', sessionId: 'sess_b',
        })), 'expected second Session node');
        const publish = async (nodes = [node]) => {
            await act(async () => listProps.onViewableItemsChanged({
                changed: [], viewableItems: nodes.map((item, index) => ({ item, key: item.id, index, isViewable: true })),
            }));
        };
        await publish();
        const addresses = [{ serverId: 'srv_server_a', sessionId: 'sess_a' }];
        expect(getVisibleSessionListSurfaces()).toEqual(addresses);
        expect(getVisibleSessionSurfaces()).toEqual([]);
        expect(hydrateSessionListRowsMock.mock.calls).toEqual([[addresses]]);
        await publish();
        expect(hydrateSessionListRowsMock.mock.calls).toEqual([[addresses]]);
        const secondAddress = { serverId: 'srv_server_a', sessionId: 'sess_b' };
        await publish([node, secondNode]);
        expect(getVisibleSessionListSurfaces()).toEqual([...addresses, secondAddress]);
        expect(hydrateSessionListRowsMock.mock.calls).toEqual([[addresses], [[secondAddress]]]);
        await publish([secondNode]);
        expect(getVisibleSessionListSurfaces()).toEqual([secondAddress]);
        expect(hydrateSessionListRowsMock.mock.calls).toEqual([[addresses], [[secondAddress]]]);
        await screen.update(<SessionsList surfaceOwnership={{ visible: true, interactive: false, dataActive: false }} />);
        expect(getVisibleSessionListSurfaces()).toEqual([]);
        await publish();
        expect(getVisibleSessionListSurfaces()).toEqual([]);
        expect(hydrateSessionListRowsMock.mock.calls).toEqual([[addresses], [[secondAddress]]]);
        await screen.update(<SessionsList surfaceOwnership={{ visible: true, interactive: true, dataActive: true }} />);
        expect(getVisibleSessionListSurfaces()).toEqual([secondAddress]);
        expect(hydrateSessionListRowsMock.mock.calls).toEqual([[addresses], [[secondAddress]], [[secondAddress]]]);
        await screen.unmount();
        expect(getVisibleSessionListSurfaces()).toEqual([]);
    });

    it('keeps native virtualized node data stable when an equivalent session-list refresh only replaces data objects', async () => {
        nativeBoundary.platformOs = 'android';

        const screen = await renderSessionsList();
        const initialProps = virtualizedListState.current?.props;
        expect(initialProps).toBeTruthy();
        const initialData = initialProps?.data;
        const initialFirstNode = Array.isArray(initialData) ? initialData[0] : null;

        mockVisibleSessionListViewData = mockVisibleSessionListViewData.map((item) => (
            item.type === 'session'
                ? { ...item, session: { ...item.session } }
                : { ...item }
        ));
        await screen.update(<SessionsList />);

        const updatedData = virtualizedListState.current?.props?.data;
        expect(updatedData).toBe(initialData);
        expect(Array.isArray(updatedData) ? updatedData[0] : null).toBe(initialFirstNode);
    });

    it('keeps native virtualized node data stable when one row renderable updates', async () => {
        nativeBoundary.platformOs = 'ios';

        const screen = await renderSessionsList();
        const initialProps = virtualizedListState.current?.props;
        expect(initialProps).toBeTruthy();
        const initialData = initialProps?.data;
        const initialExtraData = initialProps?.extraData;

        storageState.sessionListRowsByServerId = {
            ...storageState.sessionListRowsByServerId,
            srv_server_a: {
                ...storageState.sessionListRowsByServerId.srv_server_a,
                sess_a: {
                    ...sessionA,
                    active: true,
                    activeAt: 100,
                    thinking: true,
                    thinkingAt: 100,
                    presence: 'online',
                },
            },
        };
        const { storage: realStorage } = await import('@/sync/domains/state/storageStore');
        await act(async () => {
            realStorage.setState({ sessionListRowsByServerId: storageState.sessionListRowsByServerId });
        });
        await screen.update(<SessionsList />);

        expect(virtualizedListState.current?.props?.data).toBe(initialData);
        const updatedExtraData = virtualizedListState.current?.props?.extraData;
        const changedInputs = Object.keys(initialExtraData ?? {}).filter((key) =>
            !Object.is(initialExtraData[key], updatedExtraData?.[key]));
        const changedAudienceInputs = Object.keys(initialExtraData?.audience ?? {}).filter((key) =>
            !Object.is(initialExtraData.audience[key], updatedExtraData?.audience?.[key]));
        expect(updatedExtraData, `changed row inputs: ${changedInputs.join(', ')}; audience: ${changedAudienceInputs.join(', ')}`).toBe(initialExtraData);
    });

    it('keeps row move action props stable when an equivalent session-list refresh only replaces data objects', async () => {
        nativeBoundary.platformOs = 'android';
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({
            serverId: 'srv_server_a',
            snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
                features: { sessions: { enabled: true, folders: { enabled: true } } },
            }) },
        });
        mockVisibleSessionListViewData = mockVisibleSessionListViewData.map((item) => (
            item.type === 'session'
                ? {
                    ...item,
                    workspace: {
                        t: 'workspaceScope',
                        serverId: 'srv_server_a',
                        machineId: 'machine-target',
                        rootPath: '/Volumes/target/repo',
                    },
                }
                : item
        ));

        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(typeof first.props.onMoveToFolder).toBe('function');
        expect(typeof first.props.onMoveToWorkspaceRoot).toBe('function');
        expect(typeof first.props.onMoveUp).toBe('function');
        expect(typeof first.props.onMoveDown).toBe('function');
        const initialMoveToFolder = first.props.onMoveToFolder;
        const initialMoveToWorkspaceRoot = first.props.onMoveToWorkspaceRoot;
        const initialMoveUp = first.props.onMoveUp;
        const initialMoveDown = first.props.onMoveDown;

        mockVisibleSessionListViewData = mockVisibleSessionListViewData.map((item) => (
            item.type === 'session'
                ? { ...item, session: { ...item.session } }
                : { ...item }
        ));
        await screen.update(<SessionsList />);

        const updated = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after refresh');
        expect(updated.props.onMoveToFolder).toBe(initialMoveToFolder);
        expect(updated.props.onMoveToWorkspaceRoot).toBe(initialMoveToWorkspaceRoot);
        expect(updated.props.onMoveUp).toBe(initialMoveUp);
        expect(updated.props.onMoveDown).toBe(initialMoveDown);
    });

    it('classifies native virtualized-list items by row kind', async () => {
        realStorage.getState().applySettingsLocal({ sessionListDensity: 'detailed' });
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'server:srv_server_a:active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:srv_server_a:active:project:abc',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'server:srv_server_a:active:project:abc',
                groupKind: 'project',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        await renderSessionsList();

        const getItemType = virtualizedListState.current?.props?.getItemType;
        const data = virtualizedListState.current?.props?.data as any[] | null | undefined;
        expect(getItemType?.(data?.[0], 0)).toBe('supporting_sections');
        expect(getItemType?.(data?.[1], 1)).toBe('header:active');
        expect(getItemType?.(data?.[2], 2)).toBe('header:project');
        expect(getItemType?.(data?.[3], 3)).toBe('session:default:body');
    });

    it('passes path secondary-line mode for date-grouped rows', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey,
                groupKind: 'date',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey,
                groupKind: 'date',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        expect(findSessionItem(screen, 'sess_a')?.props.secondaryLineMode).toBe('path');
        expect(findSessionItem(screen, 'sess_b')?.props.secondaryLineMode).toBe('path');
    });

    it('passes status secondary-line mode for project-grouped rows', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:srv_server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'server:srv_server_a:active:project:abc',
                groupKind: 'project',
                variant: 'no-path',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(1);
        expect(findSessionItem(screen, 'sess_a')?.props.secondaryLineMode).toBe('status');
    });

    it('shows an Open project action for project headers with a resolvable WorkspaceRef', async () => {
        realStorage.setState({ profileScope: { serverId: 'srv_server_a', accountId: 'account-a' } });
        const ref = {
                id: 'wr_1',
                serverId: 'srv_server_a',
                machineId: 'machine_1',
                rootPath: '/repo',
                label: 'Repo',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            };
        applyProjectAccountRowsFixture(realStorage, { workspaceRefs: [ref] });
        const project = projectWorkspaceRefV1(ref);
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Repo',
                headerKind: 'project',
                groupKey: projectGroupIdentityKey(project),
                projectKey: project,
                workspaceScopeHint: { serverId: 'srv_server_a', machineId: 'machine_1', rootPath: '/repo' },
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const items = findProjectHeaderMenuItems(screen);
        expect(items.some((item) => item?.id === 'openProject')).toBe(true);
        await act(async () => {
            applyProjectAccountRowsFixture(realStorage, { workspaceRefs: [], revisionsByPhysicalKey: {
                [buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: 'srv_server_a', id: 'wr_1' })]: 1,
            } });
        });
        expect(findProjectHeaderMenuItems(screen).some((item) => item.id === 'openProject')).toBe(false);
    });

    it('does not expose project rename actions without a workspace scope hint', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:srv_server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        expect(findProjectHeaderMenuItems(screen).some(item => item.id === 'rename')).toBe(false);
    });

    it('wires pin toggling through session organization', async () => {
        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected first session item');
        expect(typeof first.props.onTogglePinned).toBe('function');

        await act(async () => {
            first.props.onTogglePinned();
        });
        await flushHookEffects();
        await waitForHomeGovernance(() => expect(home.requestsFor(pinPath)).toHaveLength(1));

        expect(home.requestsFor(pinPath)).toEqual([expect.objectContaining({
            serverId: homeA, serverUrl: 'https://server-a.example.test', input: { pinned: true }, token: home.findByServerUrl('https://server-a.example.test')?.token,
        })]);
        const { storage } = await import('@/sync/domains/state/storageStore');
        await waitForHomeGovernance(() => {
            expect(storage.getState().sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey('srv_server_a', 'sess_a')]).toEqual({
                sessionId: 'sess_a', sortKey: null, pinnedAt: 1, listPinned: true, railPinned: false,
            });
        });
    });

    it('does not rewrite focused-session MRU from the active list projection', async () => {
        nativeBoundary.pathname = '/session/sess_b';
        sessionMruState.set('order', ['srv_server_a:stale', 'srv_server_a:sess_a']);

        await renderSessionsList();

        expect(readSessionMruOrder()).toEqual(['srv_server_a:stale', 'srv_server_a:sess_a']);
    });

    it('does not record active session changes into the MRU order when the surface is not data-active', async () => {
        nativeBoundary.pathname = '/session/sess_b';
        sessionMruState.set('order', ['srv_server_a:stale', 'srv_server_a:sess_a']);

        await renderSessionsListWithSurfaceOwnership({
            visible: false,
            interactive: false,
            dataActive: false,
        });

        expect(readSessionMruOrder()).toEqual(['srv_server_a:stale', 'srv_server_a:sess_a']);
    });

    it('registers visible session shortcut handlers through the keyboard provider', async () => {
        nativeBoundary.pathname = '/session/sess_a';

        await renderSessionsList();

        expect(keyboardRegistration).not.toBeNull();

        act(() => {
            expect(keyboardRegistration?.executeCommand('session.visible.next')).toBe(true);
        });

        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_b?serverId=srv_server_a', expect.any(Object));
    });

    it('traverses mirrored occurrences and ranges from the chosen copy without duplicating bulk targets', async () => {
        nativeBoundary.pathname = '/session/sess_a';
        const [header, rowA, rowB] = mockVisibleSessionListViewData;
        const rowC = { ...rowB, session: createSessionListRenderableSessionFixture({ ...sessionB, id: 'sess_c' }) };
        mockVisibleSessionListViewData = [header, { ...rowA, occurrenceRole: 'needsYou' }, rowB, rowA, rowC];
        const screen = await renderSessionsList();
        act(() => {
            expect(keyboardRegistration?.executeCommand('session.visible.next')).toBe(true);
            expect(keyboardRegistration?.executeCommand('session.visible.next')).toBe(true);
            expect(keyboardRegistration?.executeCommand('session.visible.next')).toBe(true);
        });
        expect(routerNavigateSpy.mock.calls.map(([href]) => href)).toEqual(['sess_b', 'sess_a', 'sess_c'].map(id => `/session/${id}?serverId=srv_server_a`));

        const { SessionListSelectionStoreProvider } = await import('./selection/SessionListSelectionContext');
        const { SessionListSelectionActionBarHost } = await import('./selection/SessionListSelectionActionBar');
        const store = screen.root.findByType(SessionListSelectionStoreProvider).props.store;
        const baseA = buildSessionListIndexNodeId({ type: 'session', sessionId: 'sess_a', serverId: 'srv_server_a' });
        const baseB = buildSessionListIndexNodeId({ type: 'session', sessionId: 'sess_b', serverId: 'srv_server_a' });
        const baseC = buildSessionListIndexNodeId({ type: 'session', sessionId: 'sess_c', serverId: 'srv_server_a' });
        await act(async () => { store.setFocusedKey(baseB); });
        act(() => { expect(keyboardRegistration?.executeCommand('session.visible.next')).toBe(true); });
        expect(routerNavigateSpy).toHaveBeenLastCalledWith('/session/sess_a?serverId=srv_server_a', expect.any(Object));
        await act(async () => { store.replaceWith(baseA); store.selectRange(baseC); });
        const { buildServerScopedSessionKey } = await import('@/sync/domains/session/navigation/sessionNavigationOrder');
        expect([...store.getSnapshot().selectedKeys]).toEqual([
            buildServerScopedSessionKey('sess_a', 'srv_server_a'),
            buildServerScopedSessionKey('sess_c', 'srv_server_a'),
        ]);
        await act(async () => { store.selectAllVisible(); });
        expect(store.getSnapshot().count).toBe(3);
        expect(screen.root.findByType(SessionListSelectionActionBarHost).props.targetsByKey?.size).toBe(3);
    });

    it('registers MRU session shortcut handlers through the keyboard provider', async () => {
        nativeBoundary.pathname = '/session/sess_a';
        sessionMruState.set('order', ['srv_server_a:sess_a', 'srv_server_a:sess_b']);

        await renderSessionsList();

        expect(keyboardRegistration).not.toBeNull();

        act(() => {
            expect(keyboardRegistration?.executeCommand('session.mru.next')).toBe(true);
        });

        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/sess_b?serverId=srv_server_a', expect.any(Object));
    });

    it('does not register session-list shortcut handlers when the surface is non-interactive', async () => {
        nativeBoundary.pathname = '/session/sess_a';
        sessionMruState.set('order', ['srv_server_a:sess_a', 'srv_server_a:sess_b']);

        await renderSessionsListWithSurfaceOwnership({ interactive: false, dataActive: true });

        expect(keyboardRegistration?.executeCommand('session.visible.next')).toBe(false);
        expect(keyboardRegistration?.executeCommand('session.mru.next')).toBe(false);
    });

    it('keeps the last active render data while the surface is visible but inactive', async () => {
        // Seed the same real rows/index as the native host tests, then mount the
        // production pane producer: injected paneState bypasses pane retention.
        const fixtureScreen = await renderSessionsList();
        await fixtureScreen.unmount();
        const { SessionsList: ResolvedSessionsList } = await import('./SessionsList');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const screen = await renderScreen(<ResolvedSessionsList surfaceOwnership={{
            visible: true,
            interactive: true,
            dataActive: true,
        }} />, { wrapper: NativeListProviders });
        const activeData = expectPresent(
            virtualizedListState.current?.props?.data,
            'expected active virtualized-list data',
        );
        const activeExtraData = virtualizedListState.current?.props?.extraData;
        await screen.update(
            <ResolvedSessionsList
                surfaceOwnership={{
                    visible: true,
                    interactive: false,
                    dataActive: false,
                }}
            />,
        );
        const refreshedSession = createSessionListRenderableSessionFixture({
            id: 'sess_hidden_refresh', active: true, updatedAt: 20, owner: 'account-a',
        });
        await act(async () => {
            storage.setState((state) => ({
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    srv_server_a: { ...state.sessionListRowsByServerId.srv_server_a, [refreshedSession.id]: refreshedSession },
                },
                ordinarySessionListMembershipByServerId: {
                    ...state.ordinarySessionListMembershipByServerId,
                    srv_server_a: ['sess_a', 'sess_b', refreshedSession.id],
                },
                sessionListIndexByServerId: {
                    ...state.sessionListIndexByServerId,
                    srv_server_a: [
                        ...(state.sessionListIndexByServerId.srv_server_a ?? []),
                        { type: 'session', sessionId: refreshedSession.id, serverId: 'srv_server_a' },
                    ],
                },
            }));
        });
        const inactiveData = expectPresent(
            virtualizedListState.current?.props?.data,
            'expected inactive visible virtualized-list data',
        );
        expect(inactiveData).toBe(activeData);
        expect(virtualizedListState.current?.props?.extraData).not.toBe(activeExtraData);
        expect(virtualizedListState.current?.props?.extraData?.sessionListSurfaceDataActive).toBe(false);
        const inactiveExtraData = virtualizedListState.current?.props?.extraData;

        await screen.update(
            <ResolvedSessionsList
                surfaceOwnership={{
                    visible: true,
                    interactive: true,
                    dataActive: true,
                }}
            />,
        );
        const reactivatedData = expectPresent(
            virtualizedListState.current?.props?.data,
            'expected reactivated virtualized-list data',
        );
        expect(reactivatedData).not.toBe(activeData);
        expect(virtualizedListState.current?.props?.extraData).not.toBe(inactiveExtraData);
        expect(virtualizedListState.current?.props?.extraData?.sessionListSurfaceDataActive).toBe(true);
        const hiddenRefreshNodeId = buildSessionListIndexNodeId({
            type: 'session',
            serverId: 'srv_server_a',
            sessionId: 'sess_hidden_refresh',
        });
        expect(reactivatedData.some((item: any) => item.id === hiddenRefreshNodeId)).toBe(true);
    });

    it('unmounts native virtualization while the surface is hidden', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });
        expect(screen.root.findAllByType('LegendList' as any)).toHaveLength(1);

        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    visible: false,
                    interactive: false,
                    dataActive: false,
                }}
            />,
        );

        expect(screen.root.findAllByType('LegendList' as any)).toHaveLength(0);
    });

    it('does not expose load-more work while the surface is not data-active', async () => {
        await renderSessionsListWithSurfaceOwnership({
            visible: false,
            interactive: false,
            dataActive: false,
        });

        expect(virtualizedListState.current?.props?.onEndReached).toBeUndefined();
    });

    it('refreshes sessions from native pull-to-refresh and keeps the indicator active while pending', async () => {
        let resolveRefresh: (() => void) | null = null;
        const refreshPromise = new Promise<undefined>((resolve) => {
            resolveRefresh = () => resolve(undefined);
        });
        pendingSessionPage = refreshPromise;
        await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });

        const refreshControl = expectPresent(
            virtualizedListState.current?.props?.refreshControl,
            'expected native refresh control',
        );
        const onRefresh = expectPresent(
            refreshControl.props.onRefresh,
            'expected native refresh handler',
        );

        expect(String(refreshControl.type)).toBe('RefreshControl');
        expect(refreshControl.props.refreshing).toBe(false);

        let refresh: Promise<void> | undefined;
        await act(async () => {
            refresh = onRefresh();
            await Promise.resolve();
        });

        expect(refreshSessionsMock).toHaveBeenCalledTimes(1);
        expect(virtualizedListState.current?.props?.refreshControl?.props?.refreshing).toBe(true);

        await act(async () => {
            resolveRefresh?.();
            await refresh;
        });

        expect(virtualizedListState.current?.props?.refreshControl?.props?.refreshing).toBe(false);
    });

    it('keeps native pull-to-refresh mounted but disabled while the surface is inactive', async () => {
        await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: false,
            dataActive: false,
        });

        expect(virtualizedListState.current?.props?.refreshControl?.props).toMatchObject({
            enabled: false,
            refreshing: false,
        });
        expect(virtualizedListState.current?.props?.refreshControl?.props?.onRefresh).toBeUndefined();
    });

    it('deduplicates native pull-to-refresh while a session refresh is already pending', async () => {
        let resolveRefresh: (() => void) | null = null;
        const refreshPromise = new Promise<undefined>((resolve) => {
            resolveRefresh = () => resolve(undefined);
        });
        pendingSessionPage = refreshPromise;
        await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const onRefresh = expectPresent(
            virtualizedListState.current?.props?.refreshControl?.props?.onRefresh,
            'expected active native refresh handler',
        );

        let refresh: Promise<void> | undefined;
        await act(async () => {
            refresh = onRefresh();
            void onRefresh();
            await Promise.resolve();
        });

        expect(refreshSessionsMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveRefresh?.();
            await refresh;
        });
    });

    it('ignores stale native pull-to-refresh callbacks after the surface becomes inactive', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const staleOnRefresh = expectPresent(
            virtualizedListState.current?.props?.refreshControl?.props?.onRefresh,
            'expected active native refresh handler',
        );

        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    visible: false,
                    interactive: false,
                    dataActive: false,
                }}
            />,
        );
        await act(async () => {
            await staleOnRefresh();
        });

        expect(refreshSessionsMock).not.toHaveBeenCalled();
    });

    it('loads another page only for advancing viewport demand, not mount or repeated end callbacks', async () => {
        await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });

        await act(async () => {
            virtualizedListState.current?.props?.onEndReached?.();
            virtualizedListState.current?.props?.onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 0 },
                    contentSize: { height: 120 },
                    layoutMeasurement: { height: 240 },
                },
            });
        });
        expect(fetchMoreSessionsMock).not.toHaveBeenCalled();

        await act(async () => {
            virtualizedListState.current?.props?.onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 720 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 240 },
                },
            });
        });

        expect(fetchMoreSessionsMock).not.toHaveBeenCalled();
        await act(async () => {
            virtualizedListState.current?.props?.onScrollBeginDrag?.();
            virtualizedListState.current?.props?.onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 720 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 240 },
                },
            });
        });
        expect(fetchMoreSessionsMock).toHaveBeenCalledTimes(1);
        await act(async () => {
            virtualizedListState.current?.props?.onEndReached?.();
            virtualizedListState.current?.props?.onEndReached?.();
        });
        expect(fetchMoreSessionsMock).toHaveBeenCalledTimes(1);
    });

    it('ignores stale load-more callbacks after the surface becomes inactive', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const staleOnEndReached = expectPresent(
            virtualizedListState.current?.props?.onEndReached,
            'expected active load-more handler',
        );

        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    visible: false,
                    interactive: false,
                    dataActive: false,
                }}
            />,
        );
        await act(async () => {
            await staleOnEndReached();
        });

        expect(fetchMoreSessionsMock).not.toHaveBeenCalled();
    });

    it('writes session tags through session organization assignments', async () => {
        sessionTagsV1 = { 'srv_server_a:sess_a': ['important'], 'srv_server_a:sess_b': ['urgent'] };

        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected first session item');
        expect(typeof first.props.onSetTags).toBe('function');
        await act(async () => {
            first.props.onSetTags(['urgent']);
        });
        await flushHookEffects();
        await waitForHomeGovernance(() => expect(home.requestsFor(tagsPath)).toHaveLength(1));

        expect(home.requestsFor(tagsPath)).toEqual([expect.objectContaining({
            serverId: homeA, serverUrl: 'https://server-a.example.test', input: { addTagIds: ['fixture-tag-2'], removeTagIds: ['fixture-tag-1'] }, token: home.findByServerUrl('https://server-a.example.test')?.token,
        })]);
        const { storage } = await import('@/sync/domains/state/storageStore');
        expect(storage.getState().sessionOrganizationTagAssignmentsBySessionKey[buildSessionOrganizationSessionKey('srv_server_a', 'sess_a')]).toEqual({
            sessionId: 'sess_a', tagIds: ['fixture-tag-2'],
        });
    });

    it('shows pinned server badges only when multiple servers are selected', async () => {
        pinnedSessionKeysV1 = ['srv_server_a:sess_a'];
        sessionTagsV1 = {};
        const screen = await renderSessionsList();
        expect(findSessionItem(screen, 'sess_a')?.props.pinned).toBe(true);
        expect(findSessionItem(screen, 'sess_a')?.props.showServerBadge).toBe(false);

        await screen.unmount();
        mockAllowedServerIds = ['srv_server_a', 'srv_server_b'];
        const updatedScreen = await renderSessionsList();
        expect(findSessionItem(updatedScreen, 'sess_a')?.props.showServerBadge).toBe(true);
    });

    it('uses the reachable machine label and canonical workspace name when row metadata is stale after handoff', async () => {
        // The hydrated owner and project producer have seen the handoff while
        // the compact row still carries its previous Machine and workspace.
        const currentSession = createSessionFixture({ id: sessionA.id, serverId: 'srv_server_a',
            metadataLayoutVersion: 1, metadata: { path: '', host: '' },
            ownerMetadataView: { machineId: 'machine-target', path: '/Volumes/target/repo', host: 'target.local' },
        });
        realStorage.setState({ sessions: { ...realStorage.getState().sessions, [currentSession.id]: currentSession } });
        const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
        projectManager.addSession(currentSession, { serverId: 'srv_server_a' });
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey,
                groupKind: 'date',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey,
                groupKind: 'date',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        try {
            const screen = await renderSessionsList();
            const item = expectPresent(
                findSessionItem(screen, 'sess_a'),
                'expected first session item',
            );
            // The context owner presents the workspace separately from Machine identity.
            // Both facts must still come from the handoff target, never stale Session metadata.
            expect(item.props.subtitleOverride).toBe('repo');
            const row = screen.root.findAll(node => node.props.item?.sessionId === 'sess_a' && node.props.rowViewport)[0];
            expect(row?.props.reachableSessionDisplay).toMatchObject({ machineId: 'machine-target', machineLabel: 'Rebound workstation' });
        } finally {
            projectManager.removeSession(currentSession.id);
        }
    });

    it('isolates a mounted group fold when the canonical saved Space selection changes', async () => {
        const { createSessionListViewFilterDefaults } = await import('./search/sessionListViewFilters');
        // The restored Account catalog must be admitted before a saved Space can be selected.
        realStorage.setState({ settingsVersion: 1 });
        const { searchQuery: _searchQuery, ...filter } = createSessionListViewFilterDefaults({ homeServerIds: ['srv_server_a'] });
        collectionSpacesV1 = { v: 1, spaces: ['space-a', 'space-b'].map(id => ({
            id, name: id, entityKind: 'sessionWork', icon: { kind: 'icon', name: 'list' }, filter, includeNeedsYouEverywhere: false,
        } satisfies CollectionSpacesV1['spaces'][number])) };
        const selectSpace = (spaceId: string) => writeCollectionSpaceSelectionV1({
            scope: { serverId: 'srv_server_a', accountId: 'account-a' }, entityKind: 'sessionWork', spaceId,
            isCurrent: () => true, readSettings: () => ({ collectionSpacesV1 }),
        });
        await selectSpace('space-a');
        const fixtureScreen = await renderSessionsList();
        await fixtureScreen.unmount();
        const { SessionsList: ResolvedSessionsList } = await import('./SessionsList');
        const screen = await renderScreen(<ResolvedSessionsList />, { wrapper: NativeListProviders });
        expect(findSessionItem(screen, 'sess_a')).not.toBeNull();
        // Fold through the mounted owner after credential admission rather than
        // guessing its not-yet-bound retention context before mount.
        const rowGroupKey = expectPresent(screen.root.findAll(node => node.props.item?.type === 'session'
            && node.props.item.sessionId === 'sess_a' && node.props.rowViewport)[0]?.props.item.groupKey,
            'expected the mounted Session group');
        const projectHeader = screen.findAllByType(ProjectGroupHeader).find(node => node.props.item.groupKey === rowGroupKey);
        const sectionHeader = screen.findAllByType(CollapsibleSectionHeader).find(node =>
            node.props.testID === `session-list-header:${rowGroupKey}`);
        const onToggle = projectHeader?.props.onToggleCollapse ?? sectionHeader?.props.onPress;
        expect(typeof onToggle).toBe('function');
        await act(async () => { onToggle(); });
        expect(findSessionItem(screen, 'sess_a')).toBeNull();
        await act(async () => { await selectSpace('space-b'); });
        await flushHookEffects();
        expect(findSessionItem(screen, 'sess_a')).not.toBeNull();
        await act(async () => { await selectSpace('space-a'); });
        await flushHookEffects();
        expect(findSessionItem(screen, 'sess_a')).toBeNull();
    });

    it('does not derive reachability details for rows hidden by a collapsed group', async () => {
        const contextKey = buildSessionListCollapseContextKey({
            retentionScopeKey: buildSessionListViewCredentialScopeKey('global', new Map([
                ['srv_server_a', { kind: 'bound' as const, scope: { serverId: 'srv_server_a', accountId: 'account-a' } }],
            ]), ['srv_server_a']),
            corpusStorage: 'active',
            selectedSpaceId: 'my-work',
        }, 'projects');
        replaceCollapsedGroupKeys({ [buildSessionListCollapseKey(contextKey, groupKey)]: true });
        readDisplayMachineTargetSpy.mockClear();
        const collapsedPaneItems: typeof mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey,
                groupKind: 'date',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: 'Tomorrow',
                headerKind: 'date',
                groupKey: 'server:srv_server_a:day:2026-02-18',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'server:srv_server_a:day:2026-02-18',
                groupKind: 'date',
                serverId: 'srv_server_a',
                serverName: 'Server A',
            },
        ];

        // This fixture supplies the pane directly. Admit its real credential-bound
        // context before publishing rows, as the canonical pane producer does.
        mockVisibleSessionListViewData = [];
        const screen = await renderSessionsList();
        mockVisibleSessionListViewData = collapsedPaneItems;
        await screen.update(<SessionsList />);
        await flushHookEffects();

        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_a')).toHaveLength(0);
        expect(screen.findAllByType(SessionItem).filter(item => item.props.session?.id === 'sess_b')).toHaveLength(1);
        const queriedSessionIds = readDisplayMachineTargetSpy.mock.calls.map(([input]) => input.sessionId);
        expect(queriedSessionIds).not.toContain('sess_a');
        expect(queriedSessionIds).toContain('sess_b');
    });

    it('seats the stable chrome and the sole virtualized list inside the non-scroll keyboard-aware frame', async () => {
        const screen = await renderSessionsList();

        const frame = screen.findHostByTestId('sessions-list-keyboard-frame');
        expect(frame).not.toBeNull();

        const hasAncestorWithFrame = (node: { parent: any }): boolean => {
            let current = node.parent;
            while (current !== null && current !== undefined) {
                if (current.props?.testID === 'sessions-list-keyboard-frame') return true;
                current = current.parent;
            }
            return false;
        };

        // The stable search chrome and the virtualized rows both live inside
        // ONE non-scroll keyboard-aware frame, so the keyboard resizes the
        // viewport around them instead of scrolling a nested container.
        const chrome = screen.root.findByProps({ testID: 'session-list-search-chrome' });
        expect(hasAncestorWithFrame(chrome)).toBe(true);
        const row = expectPresent(findSessionItem(screen, 'sess_a'), 'expected rendered first row');
        expect(hasAncestorWithFrame(row)).toBe(true);
    });
});
