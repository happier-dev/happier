import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { Settings } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import {
    buildSessionListIndexFromViewData,
} from '@/sync/domains/sessionList/sessionListIndex';
import { applySessionOrganizationLegacyTestSettings } from './sessionOrganizationProjectionTestFixture';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionFolderGroupKey } from '@/sync/domains/session/folders';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionStoreFixture = vi.hoisted(() => {
    const sessionA = {
        id: 'sess_a',
        createdAt: 1,
        active: true,
        presence: 'online',
        metadata: { host: 'h', path: '/p', homeDir: '/h' },
    } satisfies Partial<Session>;
    const sessionB = {
        id: 'sess_b',
        createdAt: 2,
        active: false,
        presence: 0,
        metadata: { host: 'h', path: '/p', homeDir: '/h' },
    } satisfies Partial<Session>;
    return {
        sessionA,
        sessionB,
    };
});

vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('react-native-safe-area-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native-safe-area-context')>();
    return {
        ...actual,
        SafeAreaInsetsContext: actual.SafeAreaInsetsContext ?? React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    };
});

const routerPushSpy = vi.fn();
const openUniversalSearchSpy = vi.hoisted(() => vi.fn());
const recoveryBannerMountSpy = vi.fn();
const recoveryBannerUnmountSpy = vi.fn();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
let homeA: string;
let storage: typeof import('@/sync/domains/state/storageStore').storage;
let previousStorageState: ReturnType<typeof import('@/sync/domains/state/storageStore').storage.getState>;
let restoredCredentials: import('@/auth/storage/tokenStorage').AuthCredentials;
const folderAssignmentPath = '/v2/session-organization/folder-assignments/sess_a';

const searchRuntime = { open: openUniversalSearchSpy, buildCommands: () => [] };

let pinnedSessionKeysV1: string[] = [];
let sessionListGroupOrderV1: Record<string, string[]> = {};
let sessionListOrderingModeV1: Settings['sessionListOrderingModeV1'] = 'custom';
let sessionListFolderSortModeV1: Settings['sessionListFolderSortModeV1'] = 'foldersFirst';
let sessionListSectionModeV1: 'activity' | 'single' = 'activity';
let sessionListActiveGroupingV1: 'project' | 'date' = 'project';
let sessionListInactiveGroupingV1: 'project' | 'date' = 'date';
let hideInactiveSessions = false;
let sessionTagsV1: Record<string, string[]> = {};
const workspaceA = {
    t: 'workspaceScope' as const,
    serverId: 'srv_server_a',
    machineId: 'machine_a',
    rootPath: '/p',
};
let sessionFoldersV1 = {
    v: 1 as const,
    folders: [] as Array<{
        id: string;
        workspace: typeof workspaceA;
        parentId: string | null;
        name: string;
        createdAt: number;
        updatedAt: number;
    }>,
};
type DropdownMenuTriggerParams = {
    open: boolean;
    toggle: ReturnType<typeof vi.fn>;
    openMenu: ReturnType<typeof vi.fn>;
    closeMenu: ReturnType<typeof vi.fn>;
    selectedItem: unknown;
};

type DropdownMenuCapturedItem = {
    id?: string;
    category?: string;
    subtitle?: string;
    rightElement?: unknown;
    disabled?: boolean;
    submenu?: { items?: DropdownMenuCapturedItem[] };
};

type DropdownMenuCapture = {
    items?: DropdownMenuCapturedItem[];
    selectedId?: string;
    showCategoryTitles?: boolean;
    onSelect?: (id: string) => void;
    trigger?: (params: DropdownMenuTriggerParams) => unknown;
    triggerParams?: DropdownMenuTriggerParams;
};

const dropdownMenuCaptures: DropdownMenuCapture[] = [];

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) },
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
            Platform: {
                OS: 'web',
            },
            FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ...rest }: any) =>
                React.createElement(
                    'FlatList',
                    { ...rest },
                    React.isValidElement(ListHeaderComponent)
                        ? ListHeaderComponent
                        : ListHeaderComponent ? React.createElement(ListHeaderComponent) : null,
                    (data ?? []).map((item: any, index: number) => {
                        const key = keyExtractor ? keyExtractor(item, index) : String(index);
                        return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
                    }),
                ),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPushSpy, replace: vi.fn(), back: vi.fn() },
            pathname: '',
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        const triggerParams: DropdownMenuTriggerParams = {
            open: Boolean(props.open),
            toggle: vi.fn(),
            openMenu: vi.fn(),
            closeMenu: vi.fn(),
            selectedItem: null,
        };
        dropdownMenuCaptures.push({ ...props, triggerParams });
        const triggerResult = typeof props.trigger === 'function'
            ? props.trigger(triggerParams)
            : null;
        return React.createElement('DropdownMenu', props, triggerResult);
    },
}));



vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: () => {
        React.useEffect(() => {
            recoveryBannerMountSpy();
            return () => {
                recoveryBannerUnmountSpy();
            };
        }, []);
        return React.createElement('RecoveryKeyReminderBanner');
    },
}));


vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

const groupKey = 'active:srv_server_a';
const inactiveGroupKey = 'inactive:srv_server_a';
const storedSessionA = createSessionFixture({ ...sessionStoreFixture.sessionA, owner: 'u1' });
const storedSessionB = createSessionFixture({ ...sessionStoreFixture.sessionB, owner: 'u1' });
const sessionA = createSessionListRenderableSessionFixture(storedSessionA);
const sessionB = createSessionListRenderableSessionFixture(storedSessionB);

const mockVisibleSessionListViewData: any[] = [
    { type: 'header', title: 'Active', headerKind: 'active', groupKey, serverId: 'srv_server_a', serverName: 'Server A' },
    { type: 'session', session: sessionA, groupKey, groupKind: 'project', serverId: 'srv_server_a', serverName: 'Server A' },
    { type: 'header', title: 'Inactive', headerKind: 'inactive', groupKey: inactiveGroupKey, serverId: 'srv_server_a', serverName: 'Server A' },
    { type: 'session', session: sessionB, groupKey: inactiveGroupKey, groupKind: 'date', serverId: 'srv_server_a', serverName: 'Server A' },
];
const defaultVisibleSessionListIndex = buildSessionListIndexFromViewData(mockVisibleSessionListViewData) ?? [];
if (defaultVisibleSessionListIndex?.[1]?.type === 'session') {
    (defaultVisibleSessionListIndex[1] as any).workspace = workspaceA;
}
let mockVisibleSessionListIndex = defaultVisibleSessionListIndex;

const requestReviewSpy = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/requestReview', () => ({
    requestReview: requestReviewSpy,
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', props),
}));

const { SessionsListView } = await import('./SessionsList');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { UniversalSearchRuntimeProvider } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
const paneState = {
    summary: { sessionsReady: true, sessionCount: 2 },
    visibleSessionListIndex: mockVisibleSessionListIndex,
    hasHiddenInactiveSessions: false,
    folderFocus: null,
    folderFeatureEnabledServerIds: ['srv_server_a'],
    showLoading: false,
    showEmptyState: false,
} satisfies import('@/hooks/session/useVisibleSessionListPaneState').VisibleSessionListPaneState;
function SessionsList(props: React.ComponentProps<typeof SessionsListView>) {
    return <InjectedAuthProvider credentials={restoredCredentials}>
        <UniversalSearchRuntimeProvider value={searchRuntime}>
            <SessionsListView {...props} paneState={{ ...paneState, visibleSessionListIndex: mockVisibleSessionListIndex }} />
        </UniversalSearchRuntimeProvider>
    </InjectedAuthProvider>;
}
async function renderSessionsList() {
    storage.getState().applySettingsLocal({
        compactSessionView: false, compactSessionViewMinimal: false, sessionTagsEnabled: true,
        sessionListOrderingModeV1, sessionListFolderSortModeV1, sessionListSectionModeV1,
        sessionListActiveGroupingV1, sessionListInactiveGroupingV1, hideInactiveSessions,
    });
    await applySessionOrganizationLegacyTestSettings({
        serverId: 'srv_server_a', pinnedSessionKeysV1, sessionListGroupOrderV1, sessionFoldersV1, sessionTagsV1,
    });
    return renderScreen(<SessionsList />);
}

describe('SessionsList (inline reorder)', () => {
    beforeEach(async () => {
        storage = (await import('@/sync/domains/state/storageStore')).storage;
        previousStorageState = storage.getState();
        await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
        await home.reset();
        homeA = await home.addHome({ name: 'Server A', serverUrl: 'https://server-a.example.test', serverIdentityId: 'srv_server_a', accountId: 'u1' });
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        await (await import('@/sync/runtime/orchestration/connectionManager')).restoreConnectionToActiveServer({ token: createAccountTokenForTests('u1') });
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://server-a.example.test');
        if (!credentials) throw new Error('expected restored Home credentials');
        restoredCredentials = credentials;
        await home.selectHomes(['srv_server_a']);
        home.answer(homeA, folderAssignmentPath, { body: { sessionId: 'sess_a', folderId: 'folder-a' } });
        const machine = createMachineFixture({ id: 'machine_a' });
        if (!machine.metadata) throw new Error('Expected canonical Machine fixture metadata');
        storage.setState({
            sessions: { sess_a: storedSessionA, sess_b: storedSessionB },
            machines: { machine_a: { ...machine, metadata: { ...machine.metadata, host: 'h', homeDir: '/h' } } },
            ordinarySessionListMembershipByServerId: { srv_server_a: ['sess_a', 'sess_b'] },
            sessionListRowsByServerId: { srv_server_a: { sess_a: sessionA, sess_b: sessionB } },
        });
        const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ serverId: 'srv_server_a', snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            features: { sessions: { enabled: true, folders: { enabled: true } } },
        }) } });
        mockVisibleSessionListIndex = defaultVisibleSessionListIndex;
        sessionListOrderingModeV1 = 'custom';
        sessionListFolderSortModeV1 = 'foldersFirst';
        sessionListSectionModeV1 = 'activity';
        sessionListActiveGroupingV1 = 'project';
        sessionListInactiveGroupingV1 = 'date';
        hideInactiveSessions = false;
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};
        sessionFoldersV1 = { v: 1, folders: [] };
        dropdownMenuCaptures.length = 0;
        requestReviewSpy.mockClear();
        recoveryBannerMountSpy.mockClear();
        recoveryBannerUnmountSpy.mockClear();
    });

    afterEach(async () => {
        standardCleanup();
        await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
        await home.reset();
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.setState(previousStorageState, true);
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
    });

    it('does not trigger store-review prompts automatically when the list renders', async () => {
        requestReviewSpy.mockClear();

        await renderSessionsList();

        expect(requestReviewSpy).not.toHaveBeenCalled();
    });

    it('keeps active and inactive rows available as carry sources across their ordering modes', async () => {
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};

        const screen = await renderSessionsList();

        const items = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(items.length).toBe(2);
        // The whole desktop row is the carry source (E1); SessionListRow tells the row whether it can move.
        expect(items[0].props.dragEnabled).toBe(true);
        expect(items[1].props.dragEnabled).toBe(true);
        // isBeingDragged is passed from SessionListRow
        expect(items[0].props.isBeingDragged).toBe(false);
    });

    it('keeps the carry source available when sibling ordering is date-based', async () => {
        sessionListOrderingModeV1 = 'created';

        const screen = await renderSessionsList();

        const items = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(items.length).toBe(2);
        expect(items[0].props.dragEnabled).toBe(true);
    });

    it('keeps Recent activity rows available for carry while preserving custom project ordering', async () => {
        sessionListSectionModeV1 = 'single';
        sessionListActiveGroupingV1 = 'date';
        sessionListOrderingModeV1 = 'custom';

        const screen = await renderSessionsList();

        const rowBoundaries = screen.findAll((node) => (
            typeof node.props?.dragEnabled === 'boolean'
            && node.props?.item?.type === 'session'
            && Array.isArray(node.props?.items)
        ));
        expect(rowBoundaries).toHaveLength(2);
        expect(rowBoundaries[0].props.dragEnabled).toBe(true);
        expect(sessionListOrderingModeV1).toBe('custom');
    });

    it('keeps drag-end persistence disabled when ordering mode is not custom', async () => {
        sessionListOrderingModeV1 = 'updated';
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};

        const screen = await renderSessionsList();

        const firstRow = screen.findAll((node) => String(node.type) === 'SessionItem')[0];
        expect(firstRow.props.dragEnabled).toBe(true);
        expect(storage.getState().sessionOrganizationOrderEntriesByScopeKey).toEqual({});
    });

    it('preserves carry availability when ordering mode returns to custom', async () => {
        sessionListOrderingModeV1 = 'updated';

        const screen = await renderSessionsList();
        const disabledItems = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(disabledItems[0].props.dragEnabled).toBe(true);

        sessionListOrderingModeV1 = 'custom';
        const updatedScreen = await renderSessionsList();

        const reorderedItems = updatedScreen.findAll((node) => String(node.type) === 'SessionItem');
        expect(reorderedItems.length).toBe(2);
        expect(reorderedItems[0].props.dragEnabled).toBe(true);
    });

    it('exposes View options and writes canonical settings atomically on select', async () => {

        await renderSessionsList();

        const menuProps = [...dropdownMenuCaptures].reverse().find((captured) => {
            const items = captured.items ?? [];
            return items.some((item) => item?.id === 'layout:projects')
                && items.some((item) => item?.id === 'layout:recent_activity')
                && items.some((item) => item?.id === 'layout:active_inactive');
        });
        expect(menuProps).toBeTruthy();
        expect(menuProps?.showCategoryTitles).toBe(true);
        expect(menuProps?.items?.map((item) => item.id)).toEqual([
            'layout:projects',
            'layout:recent_activity',
            'layout:active_inactive',
            'activeGrouping',
            'inactiveGrouping',
            'attentionPlacement',
            'workingPlacement',
            'ordering:custom',
            'ordering:updated',
            'ordering:created',
            'folderDisplay',
            'folderSort',
        ]);
        expect(menuProps?.items?.some((item) => item.id === 'hideInactiveSessions')).toBe(false);
        expect(menuProps?.items?.find((item) => item.id === 'activeGrouping')?.submenu?.items?.map((item) => item.id)).toEqual([
            'grouping:active:project',
            'grouping:active:date',
        ]);
        expect(menuProps?.items?.find((item) => item.id === 'attentionPlacement')?.submenu?.items?.map((item) => item.id)).toEqual([
            'attention:off',
            'attention:global',
            'attention:withinGroups',
        ]);

        await act(async () => menuProps?.onSelect?.('ordering:created'));
        expect(storage.getState().settings.sessionListOrderingModeV1).toBe('created');
        await act(async () => menuProps?.onSelect?.('folderSort:mixed'));
        expect(storage.getState().settings.sessionListFolderSortModeV1).toBe('mixed');
        await act(async () => menuProps?.onSelect?.('grouping:active:date'));
        expect(storage.getState().settings.sessionListActiveGroupingV1).toBe('date');
        const layoutTransitions: unknown[] = [];
        const unsubscribe = storage.subscribe((state, previous) => {
            if (state.settings.sessionListSectionModeV1 !== previous.settings.sessionListSectionModeV1
                || state.settings.sessionListActiveGroupingV1 !== previous.settings.sessionListActiveGroupingV1) {
                layoutTransitions.push([state.settings.sessionListSectionModeV1, state.settings.sessionListActiveGroupingV1]);
            }
        });
        const sessionReadsBefore = home.requests.filter(request => /^\/v[12]\/sessions(?:\?|$)/.test(request.path)).length;
        await act(async () => menuProps?.onSelect?.('layout:projects'));
        unsubscribe();
        expect(layoutTransitions).toEqual([['single', 'project']]);
        expect(home.requests.filter(request => /^\/v[12]\/sessions(?:\?|$)/.test(request.path))).toHaveLength(sessionReadsBefore);
        await act(async () => menuProps?.onSelect?.('grouping:inactive:project'));
        expect(storage.getState().settings.sessionListInactiveGroupingV1).toBe('project');
    });

    it('uses folders-first as the effective folder sort mode while preserving mixed as a dormant date-mode preference', async () => {
        sessionListOrderingModeV1 = 'updated';
        sessionListFolderSortModeV1 = 'mixed';

        await renderSessionsList();

        const menuProps = [...dropdownMenuCaptures].reverse().find((captured) => {
            const items = captured.items ?? [];
            return items.some((item) => item?.id === 'layout:projects');
        });
        const folderSortItems = menuProps?.items?.find((item) => item?.id === 'folderSort')?.submenu?.items;
        const foldersFirstItem = folderSortItems?.find((item) => item?.id === 'folderSort:foldersFirst');
        const mixedFolderSortItem = folderSortItems?.find((item) => item?.id === 'folderSort:mixed');

        expect((foldersFirstItem as { rightElement?: unknown } | undefined)?.rightElement).toBeTruthy();
        expect((mixedFolderSortItem as { rightElement?: unknown } | undefined)?.rightElement).toBeFalsy();
        expect(mixedFolderSortItem?.disabled).toBe(true);
        expect(mixedFolderSortItem?.subtitle).toBe('settingsSession.sessionList.folderSortModeMixedDisabledInDateModeSubtitle');

        const settingsBeforeSelection = storage.getState().settings;
        await act(async () => menuProps?.onSelect?.('folderSort:mixed'));
        expect(storage.getState().settings).toBe(settingsBeforeSelection);
    });

    it('moves a session to a folder through the row menu with server-scoped credentials', async () => {
        sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder-a',
                workspace: workspaceA,
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }, {
                id: 'folder-a-child',
                workspace: workspaceA,
                parentId: 'folder-a',
                name: 'Review',
                createdAt: 2,
                updatedAt: 2,
            }],
        };

        // The pane projection mounts empty folder destinations as well as the source row.
        mockVisibleSessionListIndex = [
            { type: 'header', title: 'Project', headerKind: 'project', groupKey,
                workspace: workspaceA, workspaceKey: groupKey, serverId: 'srv_server_a' },
            ...sessionFoldersV1.folders.map((folder): SessionListIndexItem => ({
                type: 'header', title: folder.name, headerKind: 'folder', folderId: folder.id,
                folderDepth: folder.parentId ? 1 : 0, workspace: workspaceA, serverId: 'srv_server_a',
                groupKey: buildSessionFolderGroupKey({ serverId: 'srv_server_a', workspace: workspaceA, folderId: folder.id }),
            })),
            ...defaultVisibleSessionListIndex.filter((item) => item.type === 'session'),
        ];

        const screen = await renderSessionsList();
        const items = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(items[0].props.folderMoveTargets).toEqual(expect.arrayContaining([
            expect.objectContaining({ folderId: null, title: 'sessionsList.workspaceRoot' }),
            expect.objectContaining({ folderId: 'folder-a', title: 'Planning' }),
            expect.objectContaining({ folderId: 'folder-a-child', title: 'Review', depth: 1 }),
        ]));

        await act(async () => {
            await items[0].props.onMoveToSessionFolder('folder-a');
        });

        expect(home.requestsFor(folderAssignmentPath)).toEqual([expect.objectContaining({
            serverId: homeA, serverUrl: 'https://server-a.example.test', input: { folderId: 'folder-a' }, token: home.findByServerUrl('https://server-a.example.test')?.token,
        })]);
        const { storage } = await import('@/sync/domains/state/storageStore');
        expect(storage.getState().sessionOrganizationFolderAssignmentsBySessionKey[buildSessionOrganizationSessionKey('srv_server_a', 'sess_a')]).toEqual({
            sessionId: 'sess_a', folderId: 'folder-a',
        });
        await screen.unmount();
    });

    it('renders one View options trigger in search chrome and keeps stopPropagation bound', async () => {

        const screen = await renderSessionsList();

        const menuProps = [...dropdownMenuCaptures].reverse().find((captured) => {
            const items = captured.items ?? [];
            return items.some((item) => item?.id === 'layout:projects');
        });
        expect(menuProps).toBeTruthy();

        expect(screen.findAllByProps({ testID: 'session-list-ordering-menu-trigger' })).toHaveLength(0);
        const triggers = screen.findAllHostsByTestId('session-list-view-options-trigger');
        expect(triggers).toHaveLength(1);

        const event = {
            nativeEvent: {},
            stopPropagation(this: { nativeEvent?: unknown }) {
                if (!this?.nativeEvent) {
                    throw new Error('stopPropagation lost event binding');
                }
            },
        };
        await act(async () => {
            triggers[0].props.onPress(event);
        });
        expect(menuProps?.triggerParams?.toggle).toHaveBeenCalledTimes(1);
    });

    it('keeps the phone recovery banner mounted across SessionsList rerenders', async () => {
        recoveryBannerMountSpy.mockClear();
        recoveryBannerUnmountSpy.mockClear();

        const screen = await renderSessionsList();

        expect(recoveryBannerMountSpy).toHaveBeenCalledTimes(1);
        expect(recoveryBannerUnmountSpy).not.toHaveBeenCalled();

        await screen.update(<SessionsList />);

        expect(recoveryBannerMountSpy).toHaveBeenCalledTimes(1);
        expect(recoveryBannerUnmountSpy).not.toHaveBeenCalled();
    });
});
