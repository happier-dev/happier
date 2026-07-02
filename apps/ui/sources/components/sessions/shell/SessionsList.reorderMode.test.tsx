import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, findGestureByKind, renderScreen } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { buildSessionListIndexFromViewData } from '@/sync/domains/sessionList/sessionListIndex';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

const routerPushSpy = vi.fn();
const setPinnedSessionKeysV1 = vi.fn();
const setSessionListGroupOrderV1 = vi.fn();
const setSessionListOrderingModeV1 = vi.fn();
const setSessionListFolderSortModeV1 = vi.fn();
const setSessionListSectionModeV1 = vi.fn();
const setSessionListActiveGroupingV1 = vi.fn();
const setSessionListInactiveGroupingV1 = vi.fn();
const setHideInactiveSessions = vi.fn();
const setSessionTagsV1 = vi.fn();
const setSessionFoldersV1 = vi.fn();
const recoveryBannerMountSpy = vi.fn();
const recoveryBannerUnmountSpy = vi.fn();
const getCredentialsForServerUrlSpy = vi.hoisted(() => vi.fn(async () => ({ token: 'folder-token', secret: 'folder-secret' })));
const setSessionFolderAssignmentSpy = vi.hoisted(() => vi.fn(async () => {}));

let pinnedSessionKeysV1: string[] = [];
let sessionListGroupOrderV1: Record<string, string[]> = {};
let sessionListOrderingModeV1 = 'custom';
let sessionListFolderSortModeV1 = 'foldersFirst';
let sessionListSectionModeV1: 'activity' | 'single' = 'activity';
let sessionListActiveGroupingV1: 'project' | 'date' = 'project';
let sessionListInactiveGroupingV1: 'project' | 'date' = 'date';
let hideInactiveSessions = false;
let sessionTagsV1: Record<string, string[]> = {};
const workspaceA = {
    t: 'workspaceScope' as const,
    serverId: 'server_a',
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

type DropdownMenuCapture = {
    items?: Array<{ id?: string; category?: string; subtitle?: string; rightElement?: unknown; disabled?: boolean }>;
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
            Platform: {
                OS: 'web',
            },
            FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ...rest }: any) =>
                React.createElement(
                    'FlatList',
                    { ...rest },
                    ListHeaderComponent ? React.createElement(ListHeaderComponent) : null,
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
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => [],
        useProfile: () => ({ id: 'u1' } as any),
        useSessionListRowStateByServerId: () => ({
            server_a: {
                sess_a: sessionA,
                sess_b: sessionB,
            },
        }) as any,
        useSessionListRenderableWithServerScope: (_serverId: any, sessionId: string) => {
            if (sessionId === 'sess_a') return sessionA;
            if (sessionId === 'sess_b') return sessionB;
            return null;
        },
        useSetting: (key: string) => {
            if (key === 'compactSessionView') return false;
            if (key === 'compactSessionViewMinimal') return false;
            if (key === 'sessionTagsEnabled') return true;
            if (key === 'sessionListOrderingModeV1') return sessionListOrderingModeV1;
            if (key === 'sessionListFolderSortModeV1') return sessionListFolderSortModeV1;
            if (key === 'sessionListSectionModeV1') return sessionListSectionModeV1;
            if (key === 'sessionListActiveGroupingV1') return sessionListActiveGroupingV1;
            if (key === 'sessionListInactiveGroupingV1') return sessionListInactiveGroupingV1;
            if (key === 'hideInactiveSessions') return hideInactiveSessions;
            if (key === 'sessionFoldersV1') return sessionFoldersV1;
            return null;
        },
        useSettingMutable: (key: string) => {
            if (key === 'pinnedSessionKeysV1') return [pinnedSessionKeysV1, setPinnedSessionKeysV1];
            if (key === 'sessionListGroupOrderV1') return [sessionListGroupOrderV1, setSessionListGroupOrderV1];
            if (key === 'sessionListOrderingModeV1') return [sessionListOrderingModeV1, setSessionListOrderingModeV1];
            if (key === 'sessionListFolderSortModeV1') return [sessionListFolderSortModeV1, setSessionListFolderSortModeV1];
            if (key === 'sessionListSectionModeV1') return [sessionListSectionModeV1, setSessionListSectionModeV1];
            if (key === 'sessionListActiveGroupingV1') return [sessionListActiveGroupingV1, setSessionListActiveGroupingV1];
            if (key === 'sessionListInactiveGroupingV1') return [sessionListInactiveGroupingV1, setSessionListInactiveGroupingV1];
            if (key === 'hideInactiveSessions') return [hideInactiveSessions, setHideInactiveSessions];
            if (key === 'sessionTagsV1') return [sessionTagsV1, setSessionTagsV1];
            if (key === 'sessionFoldersV1') return [sessionFoldersV1, setSessionFoldersV1];
            return [null, vi.fn()];
        },
    }),
});

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

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: getCredentialsForServerUrlSpy,
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({
        activeServerId: 'server_a',
        profiles: [
            { id: 'server_a', name: 'Server A', serverUrl: 'https://server-a.example.test' },
        ],
    }),
    listServerProfiles: () => [
        { id: 'server_a', name: 'Server A', serverUrl: 'https://server-a.example.test' },
    ],
}));

vi.mock('@/sync/ops/sessionFolders', () => ({
    setSessionFolderAssignment: setSessionFolderAssignmentSpy,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.folders',
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

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    formatPathRelativeToHome: (path: string) => path,
}));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => ({
        serverIds: ['server_a'],
    }),
    useResolvedActiveServerSelection: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'server_a',
        allowedServerIds: ['server_a'],
    }),
}));

const groupKey = 'active:server_a';
const inactiveGroupKey = 'inactive:server_a';
const sessionA = { id: 'sess_a', createdAt: 1, active: true, presence: 'online', metadata: { host: 'h', path: '/p', homeDir: '/h' } } as any;
const sessionB = { id: 'sess_b', createdAt: 2, active: false, presence: 'offline', metadata: { host: 'h', path: '/p', homeDir: '/h' } } as any;
const mockVisibleSessionListViewData: any[] = [
    { type: 'header', title: 'Active', headerKind: 'active', groupKey, serverId: 'server_a', serverName: 'Server A' },
    { type: 'session', session: sessionA, groupKey, groupKind: 'date', serverId: 'server_a', serverName: 'Server A' },
    { type: 'header', title: 'Inactive', headerKind: 'inactive', groupKey: inactiveGroupKey, serverId: 'server_a', serverName: 'Server A' },
    { type: 'session', session: sessionB, groupKey: inactiveGroupKey, groupKind: 'date', serverId: 'server_a', serverName: 'Server A' },
];
const mockVisibleSessionListIndex = buildSessionListIndexFromViewData(mockVisibleSessionListViewData);
if (mockVisibleSessionListIndex?.[1]?.type === 'session') {
    (mockVisibleSessionListIndex[1] as any).workspace = workspaceA;
}

vi.mock('@/hooks/session/useVisibleSessionListPaneState', () => ({
    useVisibleSessionListPaneState: () => ({
        summary: {
            sessionsReady: true,
            sessionCount: mockVisibleSessionListViewData.filter((item) => item.type === 'session').length,
        },
        visibleSessionListIndex: mockVisibleSessionListIndex,
        showLoading: false,
        showEmptyState: false,
    }),
}));

const requestReviewSpy = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/requestReview', () => ({
    requestReview: requestReviewSpy,
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', props),
}));

describe('SessionsList (inline reorder)', () => {
    beforeEach(() => {
        sessionListOrderingModeV1 = 'custom';
        sessionListFolderSortModeV1 = 'foldersFirst';
        sessionListSectionModeV1 = 'activity';
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};
        sessionFoldersV1 = { v: 1, folders: [] };
        dropdownMenuCaptures.length = 0;
        requestReviewSpy.mockClear();
        setSessionListActiveGroupingV1.mockClear();
        setSessionListInactiveGroupingV1.mockClear();
        setHideInactiveSessions.mockClear();
        setPinnedSessionKeysV1.mockClear();
        setSessionListGroupOrderV1.mockClear();
        setSessionListOrderingModeV1.mockClear();
        setSessionListFolderSortModeV1.mockClear();
        setSessionListSectionModeV1.mockClear();
        setSessionTagsV1.mockClear();
        setSessionFoldersV1.mockClear();
        getCredentialsForServerUrlSpy.mockClear();
        setSessionFolderAssignmentSpy.mockClear();
        recoveryBannerMountSpy.mockClear();
        recoveryBannerUnmountSpy.mockClear();
    });

    it('does not trigger store-review prompts automatically when the list renders', async () => {
        requestReviewSpy.mockClear();
        const { SessionsList } = await import('./SessionsList');

        await renderScreen(<SessionsList />);

        expect(requestReviewSpy).not.toHaveBeenCalled();
    });

    it('renders SessionItem rows with reorder drag props', async () => {
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};
        const { SessionsList } = await import('./SessionsList');

        const screen = await renderScreen(<SessionsList />);

        const items = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(items.length).toBe(2);
        // reorderHandleGesture is passed from SessionListRow.
        // reorderDragStyle is no longer passed (Animated.View is in SessionListRow).
        expect(items[0].props).toHaveProperty('reorderHandleGesture');
        expect(findGestureByKind(items[0].props.reorderHandleGesture, 'pan')).toBeTruthy();
        // isBeingDragged is passed from SessionListRow
        expect(items[0].props.isBeingDragged).toBe(false);
    });

    it('hides reorder drag props when ordering mode is created or updated', async () => {
        sessionListOrderingModeV1 = 'created';

        const { SessionsList } = await import('./SessionsList');
        const screen = await renderScreen(<SessionsList />);

        const items = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(items.length).toBe(2);
        expect(items[0].props.reorderHandleGesture).toBeUndefined();
    });

    it('keeps drag-end persistence disabled when ordering mode is not custom', async () => {
        sessionListOrderingModeV1 = 'updated';
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};

        const { SessionsList } = await import('./SessionsList');
        const screen = await renderScreen(<SessionsList />);

        const firstRow = screen.findAll((node) => String(node.type) === 'SessionItem')[0];
        expect(firstRow.props.reorderHandleGesture).toBeUndefined();
        expect(setSessionListGroupOrderV1).toHaveBeenCalledTimes(0);
    });

    it('restores reorder drag props when ordering mode returns to custom', async () => {
        sessionListOrderingModeV1 = 'updated';
        const { SessionsList } = await import('./SessionsList');

        const screen = await renderScreen(<SessionsList />);
        const disabledItems = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(disabledItems[0].props.reorderHandleGesture).toBeUndefined();

        setSessionListOrderingModeV1.mockClear();
        sessionListOrderingModeV1 = 'custom';
        const updatedScreen = await renderScreen(<SessionsList />);

        const reorderedItems = updatedScreen.findAll((node) => String(node.type) === 'SessionItem');
        expect(reorderedItems.length).toBe(2);
        expect(reorderedItems[0].props).toHaveProperty('reorderHandleGesture');
        expect(findGestureByKind(reorderedItems[0].props.reorderHandleGesture, 'pan')).toBeTruthy();
    });

    it('exposes quick-access ordering, grouping, and visibility controls and writes canonical settings on select', async () => {
        const { SessionsList } = await import('./SessionsList');

        const screen = await renderScreen(<SessionsList />);

        const menuProps = dropdownMenuCaptures.find((captured) => {
            const items = captured.items ?? [];
            return items.some((item: any) => item?.id === 'activeGroupingProject')
                && items.some((item: any) => item?.id === 'inactiveGroupingProject')
                && items.some((item: any) => item?.id === 'hideInactiveSessions');
        });
        expect(menuProps).toBeTruthy();
        expect(menuProps?.selectedId).toBe('custom');
        expect(menuProps?.showCategoryTitles).toBe(true);
        const itemIds = (menuProps?.items ?? []).map((item: any) => String(item?.id ?? ''));
        expect(itemIds).toEqual(expect.arrayContaining([
            'custom',
            'created',
            'updated',
            'sectionModeActivity',
            'sectionModeSingle',
            'activeGroupingProject',
            'activeGroupingDate',
            'inactiveGroupingProject',
            'inactiveGroupingDate',
            'sessionFolderViewModeTree',
            'sessionListFolderSortModeFoldersFirst',
            'sessionListFolderSortModeMixed',
            'hideInactiveSessions',
        ]));
        expect(menuProps?.items?.map((item: any) => item?.category)).toEqual([
            'settingsSession.sessionList.menuSections.sortBy',
            'settingsSession.sessionList.menuSections.sortBy',
            'settingsSession.sessionList.menuSections.sortBy',
            'settingsSession.sessionList.sectionModeTitle',
            'settingsSession.sessionList.sectionModeTitle',
            'settingsFeatures.sessionListActiveGrouping',
            'settingsFeatures.sessionListActiveGrouping',
            'settingsFeatures.sessionListInactiveGrouping',
            'settingsFeatures.sessionListInactiveGrouping',
            'settingsSession.sessionList.menuSections.show',
            'settingsSession.sessionList.menuSections.folderSortMode',
            'settingsSession.sessionList.menuSections.folderSortMode',
            'settingsSession.sessionList.menuSections.show',
        ]);
        const activeGroupingProjectItem = menuProps?.items?.find((item: any) => item?.id === 'activeGroupingProject');
        const sectionModeActivityItem = menuProps?.items?.find((item: any) => item?.id === 'sectionModeActivity');
        const inactiveGroupingDateItem = menuProps?.items?.find((item: any) => item?.id === 'inactiveGroupingDate');
        const hideInactiveSessionsItem = menuProps?.items?.find((item: any) => item?.id === 'hideInactiveSessions');
        const foldersFirstItem = menuProps?.items?.find((item: any) => item?.id === 'sessionListFolderSortModeFoldersFirst');
        const mixedFolderSortItem = menuProps?.items?.find((item: any) => item?.id === 'sessionListFolderSortModeMixed');
        expect(activeGroupingProjectItem?.subtitle).toBeUndefined();
        expect(sectionModeActivityItem?.subtitle).toBe('settingsSession.sessionList.sectionModeActivitySubtitle');
        expect(inactiveGroupingDateItem?.subtitle).toBeUndefined();
        expect(hideInactiveSessionsItem?.subtitle).toBeUndefined();
        expect(foldersFirstItem?.subtitle).toBe('settingsSession.sessionList.folderSortModeFoldersFirstSubtitle');
        expect(mixedFolderSortItem?.subtitle).toBe('settingsSession.sessionList.folderSortModeMixedSubtitle');
        expect((activeGroupingProjectItem as { rightElement?: unknown } | undefined)?.rightElement).toBeTruthy();
        expect((sectionModeActivityItem as { rightElement?: unknown } | undefined)?.rightElement).toBeTruthy();
        expect((inactiveGroupingDateItem as { rightElement?: unknown } | undefined)?.rightElement).toBeTruthy();

        const firstMenuItems = menuProps?.items;

        await screen.update(<SessionsList />);

        const rerenderedMenuProps = dropdownMenuCaptures.at(-1);
        expect(rerenderedMenuProps?.items).toBe(firstMenuItems);

        rerenderedMenuProps?.onSelect?.('created');
        expect(setSessionListOrderingModeV1).toHaveBeenCalledWith('created');
        rerenderedMenuProps?.onSelect?.('sessionListFolderSortModeMixed');
        expect(setSessionListFolderSortModeV1).toHaveBeenCalledWith('mixed');
        rerenderedMenuProps?.onSelect?.('activeGroupingDate');
        expect(setSessionListActiveGroupingV1).toHaveBeenCalledWith('date');
        rerenderedMenuProps?.onSelect?.('sectionModeSingle');
        expect(setSessionListSectionModeV1).toHaveBeenCalledWith('single');
        rerenderedMenuProps?.onSelect?.('inactiveGroupingProject');
        expect(setSessionListInactiveGroupingV1).toHaveBeenCalledWith('project');
        rerenderedMenuProps?.onSelect?.('hideInactiveSessions');
        expect(setHideInactiveSessions).toHaveBeenCalledWith(true);
    });

    it('uses folders-first as the effective folder sort mode while preserving mixed as a dormant date-mode preference', async () => {
        sessionListOrderingModeV1 = 'updated';
        sessionListFolderSortModeV1 = 'mixed';

        const { SessionsList } = await import('./SessionsList');
        await renderScreen(<SessionsList />);

        const menuProps = dropdownMenuCaptures.find((captured) => {
            const items = captured.items ?? [];
            return items.some((item) => item?.id === 'sessionListFolderSortModeFoldersFirst')
                && items.some((item) => item?.id === 'sessionListFolderSortModeMixed');
        });
        const foldersFirstItem = menuProps?.items?.find((item) => item?.id === 'sessionListFolderSortModeFoldersFirst');
        const mixedFolderSortItem = menuProps?.items?.find((item) => item?.id === 'sessionListFolderSortModeMixed');

        expect((foldersFirstItem as { rightElement?: unknown } | undefined)?.rightElement).toBeTruthy();
        expect((mixedFolderSortItem as { rightElement?: unknown } | undefined)?.rightElement).toBeFalsy();
        expect(mixedFolderSortItem?.disabled).toBe(true);
        expect(mixedFolderSortItem?.subtitle).toBe('settingsSession.sessionList.folderSortModeMixedDisabledInDateModeSubtitle');

        menuProps?.onSelect?.('sessionListFolderSortModeMixed');
        expect(setSessionListFolderSortModeV1).not.toHaveBeenCalled();
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
        const { SessionsList } = await import('./SessionsList');

        const screen = await renderScreen(<SessionsList />);
        const items = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(items[0].props.folderMoveTargets).toEqual(expect.arrayContaining([
            expect.objectContaining({ folderId: null, title: 'sessionsList.workspaceRoot' }),
            expect.objectContaining({ folderId: 'folder-a', title: 'Planning' }),
            expect.objectContaining({ folderId: 'folder-a-child', title: 'Review', depth: 1 }),
        ]));

        await act(async () => {
            await items[0].props.onMoveToSessionFolder('folder-a');
        });

        expect(getCredentialsForServerUrlSpy).toHaveBeenCalledWith('https://server-a.example.test', { serverId: 'server_a' });
        expect(setSessionFolderAssignmentSpy).toHaveBeenCalledWith({
            credentials: { token: 'folder-token', secret: 'folder-secret' },
            serverId: 'server_a',
            serverUrl: 'https://server-a.example.test',
            sessionId: 'sess_a',
            folderId: 'folder-a',
        });
    });

    it('renders ordering triggers on the active and inactive section headers and keeps stopPropagation bound', async () => {
        const { SessionsList } = await import('./SessionsList');

        const screen = await renderScreen(<SessionsList />);

        const menuProps = dropdownMenuCaptures.find((captured) => {
            const items = captured.items ?? [];
            return items.some((item: any) => item?.id === 'activeGroupingProject')
                && items.some((item: any) => item?.id === 'inactiveGroupingProject')
                && items.some((item: any) => item?.id === 'hideInactiveSessions');
        });
        expect(menuProps).toBeTruthy();

        expect(screen.findAllByProps({ testID: 'session-list-ordering-menu-anchor' })).toHaveLength(0);

        const triggers = screen.findAllByProps({ testID: 'session-list-ordering-menu-trigger' });
        expect(triggers).toHaveLength(2);
        expect(triggers[0].props.style).toEqual(expect.objectContaining({
            width: 18,
            height: 14,
        }));
        expect(triggers[0].props.style.backgroundColor).toBeUndefined();
        expect(triggers[0].props.style.borderWidth).toBeUndefined();
        expect(triggers[0].props.style.borderColor).toBeUndefined();

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

    it('keeps the recovery banner mounted across SessionsList rerenders', async () => {
        recoveryBannerMountSpy.mockClear();
        recoveryBannerUnmountSpy.mockClear();

        const { SessionsList } = await import('./SessionsList');
        const screen = await renderScreen(<SessionsList />);

        expect(recoveryBannerMountSpy).toHaveBeenCalledTimes(1);
        expect(recoveryBannerUnmountSpy).not.toHaveBeenCalled();

        await screen.update(<SessionsList />);

        expect(recoveryBannerMountSpy).toHaveBeenCalledTimes(1);
        expect(recoveryBannerUnmountSpy).not.toHaveBeenCalled();
    });
});
