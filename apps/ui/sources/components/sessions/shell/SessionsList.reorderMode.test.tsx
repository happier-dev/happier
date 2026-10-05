import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createPartialStorageModuleMock,
    createStorageStoreMock,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import {
    buildSessionListIndexFromViewData,
    type SessionListIndexItem,
} from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import type { SessionListReachabilityRenderable } from '@/sync/domains/state/storage';
import { buildSessionOrganizationProjectionFromLegacyTestSettings } from './sessionOrganizationProjectionTestFixture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionStoreFixture = vi.hoisted(() => {
    const sessionA = {
        id: 'sess_a',
        createdAt: 1,
        active: true,
        presence: 'online',
        metadata: { host: 'h', path: '/p', homeDir: '/h' },
    } as any;
    const sessionB = {
        id: 'sess_b',
        createdAt: 2,
        active: false,
        presence: 'offline',
        metadata: { host: 'h', path: '/p', homeDir: '/h' },
    } as any;
    return {
        sessionA,
        sessionB,
        state: {
            ordinarySessionListMembershipByServerId: {
                server_a: ['sess_a', 'sess_b'],
            },
            sessionListRowsByServerId: {
                server_a: { sess_a: sessionA, sess_b: sessionB },
            },
            profileScope: {
                serverId: 'server_a',
                accountId: 'u1',
            },
        },
    };
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

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

const routerPushSpy = vi.fn();
const openUniversalSearchSpy = vi.hoisted(() => vi.fn());
const setSessionListGroupOrderV1 = vi.fn();
const setSessionListOrderingModeV1 = vi.fn();
const setSessionListFolderSortModeV1 = vi.fn();
const setSessionListSectionModeV1 = vi.fn();
const setSessionListActiveGroupingV1 = vi.fn();
const setSessionListInactiveGroupingV1 = vi.fn();
const setHideInactiveSessions = vi.fn();
const setSessionFoldersV1 = vi.fn();
const recoveryBannerMountSpy = vi.fn();
const recoveryBannerUnmountSpy = vi.fn();
const applySettings = vi.hoisted(() => vi.fn());
const fetchMoreSessionsSpy = vi.hoisted(() => vi.fn(async () => undefined));
const refreshSessionsSpy = vi.hoisted(() => vi.fn(async () => undefined));
const markSessionListScrollActivitySpy = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlSpy = vi.hoisted(() => vi.fn(async () => ({ token: 'folder-token', secret: 'folder-secret' })));
const resolveSessionOrganizationMutationScopeSpy = vi.hoisted(() => vi.fn(async (serverId: string) => ({
    ok: true as const,
    scope: {
        credentials: { token: 'folder-token', secret: 'folder-secret' },
        serverId,
        serverIdAliases: [] as string[],
        serverUrl: 'https://server-a.example.test',
    },
})));
const setSessionFolderAssignmentSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/components/appShell/search/UniversalSearchRuntimeContext', () => ({
    useUniversalSearchRuntime: () => ({
        open: openUniversalSearchSpy,
        buildCommands: vi.fn(),
    }),
}));

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
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => [],
        useProfile: () => ({ id: 'u1' } as any),
        useSessionListRowsByServerId: () => ({
            server_a: {
                sess_a: sessionA,
                sess_b: sessionB,
            },
        }) as any,
        useSessionListRenderableWithServerScope: (_serverId: any, sessionId: string) =>
            findSessionListRenderable(sessionId),
        useSessionListReachabilityRenderablesForItems: (
            items: readonly SessionListIndexItem[] | null | undefined,
        ): ReadonlyMap<string, SessionListReachabilityRenderable> => {
            const renderables = new Map<string, SessionListReachabilityRenderable>();
            for (const item of items ?? []) {
                if (item?.type !== 'session') continue;
                const serverId = String(item.serverId ?? '').trim();
                const sessionId = String(item.sessionId ?? '').trim();
                if (!serverId || !sessionId) continue;
                const session = findSessionListRenderable(sessionId);
                if (!session) continue;
                const key = buildSessionListServerScopedRowKey(serverId, sessionId);
                if (!key) continue;
                renderables.set(key, {
                    id: sessionId,
                    metadata: session.metadata ?? null,
                });
            }
            return renderables;
        },
        useSessionListRowRenderablesForItems: (
            items: readonly SessionListIndexItem[] | null | undefined,
        ): ReadonlyMap<string, SessionListRenderableSession> => {
            const renderables = new Map<string, SessionListRenderableSession>();
            for (const item of items ?? []) {
                if (item?.type !== 'session') continue;
                const serverId = String(item.serverId ?? '').trim();
                const sessionId = String(item.sessionId ?? '').trim();
                if (!serverId || !sessionId) continue;
                const session = findSessionListRenderable(sessionId);
                if (!session) continue;
                const key = buildSessionListServerScopedRowKey(serverId, sessionId);
                if (!key) continue;
                renderables.set(key, session);
            }
            return renderables;
        },
        useSessionOrganizationProjection: () => buildSessionOrganizationProjectionFromLegacyTestSettings({
            serverId: 'server_a',
            pinnedSessionKeysV1,
            sessionListGroupOrderV1,
            sessionFoldersV1,
            sessionTagsV1,
        }),
        useSessionOrganizationProjections: (serverIds: readonly string[]) => React.useMemo(
            () => Object.fromEntries(serverIds.map((serverId) => [
                serverId,
                buildSessionOrganizationProjectionFromLegacyTestSettings({
                    serverId,
                    pinnedSessionKeysV1,
                    sessionListGroupOrderV1,
                    sessionFoldersV1,
                    sessionTagsV1,
                }),
            ])),
            [serverIds.join('\u0000'), pinnedSessionKeysV1, sessionListGroupOrderV1, sessionFoldersV1, sessionTagsV1],
        ),
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
            if (key === 'sessionListOrderingModeV1') return [sessionListOrderingModeV1, setSessionListOrderingModeV1];
            if (key === 'sessionListFolderSortModeV1') return [sessionListFolderSortModeV1, setSessionListFolderSortModeV1];
            if (key === 'sessionListSectionModeV1') return [sessionListSectionModeV1, setSessionListSectionModeV1];
            if (key === 'sessionListActiveGroupingV1') return [sessionListActiveGroupingV1, setSessionListActiveGroupingV1];
            if (key === 'sessionListInactiveGroupingV1') return [sessionListInactiveGroupingV1, setSessionListInactiveGroupingV1];
            if (key === 'hideInactiveSessions') return [hideInactiveSessions, setHideInactiveSessions];
            if (key === 'sessionFoldersV1') return [sessionFoldersV1, setSessionFoldersV1];
            return [null, vi.fn()];
        },
        storage: createStorageStoreMock(sessionStoreFixture.state),
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

vi.mock('@/sync/store/settingsWriters', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/settingsWriters')>();
    return {
        ...actual,
        useApplySettings: () => applySettings,
    };
});

vi.mock('@/sync/sync', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/sync')>();
    return {
        ...actual,
        sync: {
            ...actual.sync,
            fetchMoreSessions: fetchMoreSessionsSpy,
            refreshSessions: refreshSessionsSpy,
            markSessionListScrollActivity: markSessionListScrollActivitySpy,
        },
    };
});

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return await createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: getCredentialsForServerUrlSpy,
        },
    });
});

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    const serverProfile = { id: 'server_a', name: 'Server A', serverUrl: 'https://server-a.example.test' };
    return {
        ...actual,
        getActiveServerSnapshot: () => ({
            activeServerId: 'server_a',
            profiles: [serverProfile],
        }),
        listServerProfiles: () => [serverProfile],
        getServerProfileById: (serverId: string) => (serverId === serverProfile.id ? serverProfile : null),
    };
});

vi.mock('@/sync/ops/sessionOrganization', () => ({
    resolveSessionOrganizationMutationScope: resolveSessionOrganizationMutationScopeSpy,
    requireSessionOrganizationMutationScope: async (serverId: string) => {
        const result = await resolveSessionOrganizationMutationScopeSpy(serverId);
        if (result.ok) return result.scope;
        const { HappyError } = await import('@/utils/errors/errors');
        throw new HappyError(`homeGovernance.unavailableTitle: ${serverId}`, true);
    },
    writeSessionOrganizationFolderAssignment: setSessionFolderAssignmentSpy,
    writeSessionOrganizationFolders: vi.fn(async () => undefined),
    writeSessionOrganizationGroupOrder: vi.fn(async () => undefined),
    writeSessionOrganizationPin: vi.fn(async () => undefined),
    writeSessionOrganizationTagLabels: vi.fn(async () => undefined),
    writeSessionOrganizationWorkspaceLabels: vi.fn(async () => undefined),
    writeSessionOrganizationWorkspaceOrder: vi.fn(async () => undefined),
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


vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    formatPathRelativeToHome: (path: string) => path,
    getSessionAvatarId: () => 'avatar',
    getSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
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
const sessionA = sessionStoreFixture.sessionA;
const sessionB = sessionStoreFixture.sessionB;

function findSessionListRenderable(sessionId: string): SessionListRenderableSession | null {
    if (sessionId === 'sess_a') return sessionA;
    if (sessionId === 'sess_b') return sessionB;
    return null;
}

const mockVisibleSessionListViewData: any[] = [
    { type: 'header', title: 'Active', headerKind: 'active', groupKey, serverId: 'server_a', serverName: 'Server A' },
    { type: 'session', session: sessionA, groupKey, groupKind: 'project', serverId: 'server_a', serverName: 'Server A' },
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
        folderFeatureEnabledServerIds: ['server_a'],
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

const { SessionsList } = await import('./SessionsList');

describe('SessionsList (inline reorder)', () => {
    beforeEach(() => {
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
        applySettings.mockClear();
        fetchMoreSessionsSpy.mockClear();
        refreshSessionsSpy.mockClear();
        markSessionListScrollActivitySpy.mockClear();
        setSessionListActiveGroupingV1.mockClear();
        setSessionListInactiveGroupingV1.mockClear();
        setHideInactiveSessions.mockClear();
        setSessionListGroupOrderV1.mockClear();
        setSessionListOrderingModeV1.mockClear();
        setSessionListFolderSortModeV1.mockClear();
        setSessionListSectionModeV1.mockClear();
        setSessionFoldersV1.mockClear();
        getCredentialsForServerUrlSpy.mockClear();
        resolveSessionOrganizationMutationScopeSpy.mockClear();
        setSessionFolderAssignmentSpy.mockClear();
        recoveryBannerMountSpy.mockClear();
        recoveryBannerUnmountSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('does not trigger store-review prompts automatically when the list renders', async () => {
        requestReviewSpy.mockClear();

        await renderScreen(<SessionsList />);

        expect(requestReviewSpy).not.toHaveBeenCalled();
    });

    it('keeps active and inactive rows available as carry sources across their ordering modes', async () => {
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};

        const screen = await renderScreen(<SessionsList />);

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

        const screen = await renderScreen(<SessionsList />);

        const items = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(items.length).toBe(2);
        expect(items[0].props.dragEnabled).toBe(true);
    });

    it('keeps Recent activity rows available for carry while preserving custom project ordering', async () => {
        sessionListSectionModeV1 = 'single';
        sessionListActiveGroupingV1 = 'date';
        sessionListOrderingModeV1 = 'custom';

        const { SessionsList } = await import('./SessionsList');
        const screen = await renderScreen(<SessionsList />);

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

        const screen = await renderScreen(<SessionsList />);

        const firstRow = screen.findAll((node) => String(node.type) === 'SessionItem')[0];
        expect(firstRow.props.dragEnabled).toBe(true);
        expect(setSessionListGroupOrderV1).toHaveBeenCalledTimes(0);
    });

    it('preserves carry availability when ordering mode returns to custom', async () => {
        sessionListOrderingModeV1 = 'updated';

        const screen = await renderScreen(<SessionsList />);
        const disabledItems = screen.findAll((node) => String(node.type) === 'SessionItem');
        expect(disabledItems[0].props.dragEnabled).toBe(true);

        setSessionListOrderingModeV1.mockClear();
        sessionListOrderingModeV1 = 'custom';
        const updatedScreen = await renderScreen(<SessionsList />);

        const reorderedItems = updatedScreen.findAll((node) => String(node.type) === 'SessionItem');
        expect(reorderedItems.length).toBe(2);
        expect(reorderedItems[0].props.dragEnabled).toBe(true);
    });

    it('exposes View options and writes canonical settings atomically on select', async () => {
        const { SessionsList } = await import('./SessionsList');

        await renderScreen(<SessionsList />);

        const menuProps = dropdownMenuCaptures.find((captured) => {
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

        menuProps?.onSelect?.('ordering:created');
        expect(applySettings).toHaveBeenLastCalledWith({ sessionListOrderingModeV1: 'created' });
        menuProps?.onSelect?.('folderSort:mixed');
        expect(applySettings).toHaveBeenLastCalledWith({ sessionListFolderSortModeV1: 'mixed' });
        menuProps?.onSelect?.('grouping:active:date');
        expect(applySettings).toHaveBeenLastCalledWith({ sessionListActiveGroupingV1: 'date' });
        applySettings.mockClear();
        fetchMoreSessionsSpy.mockClear();
        refreshSessionsSpy.mockClear();
        menuProps?.onSelect?.('layout:projects');
        expect(applySettings).toHaveBeenCalledTimes(1);
        expect(applySettings).toHaveBeenCalledWith({
            sessionListSectionModeV1: 'single',
            sessionListActiveGroupingV1: 'project',
        });
        expect(fetchMoreSessionsSpy).not.toHaveBeenCalled();
        expect(refreshSessionsSpy).not.toHaveBeenCalled();
        menuProps?.onSelect?.('grouping:inactive:project');
        expect(applySettings).toHaveBeenLastCalledWith({ sessionListInactiveGroupingV1: 'project' });
    });

    it('uses folders-first as the effective folder sort mode while preserving mixed as a dormant date-mode preference', async () => {
        sessionListOrderingModeV1 = 'updated';
        sessionListFolderSortModeV1 = 'mixed';

        await renderScreen(<SessionsList />);

        const menuProps = dropdownMenuCaptures.find((captured) => {
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

        menuProps?.onSelect?.('folderSort:mixed');
        expect(applySettings).not.toHaveBeenCalled();
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

        expect(resolveSessionOrganizationMutationScopeSpy).toHaveBeenCalledWith('server_a');
        expect(setSessionFolderAssignmentSpy).toHaveBeenCalledWith({
            scope: {
                credentials: { token: 'folder-token', secret: 'folder-secret' },
                serverId: 'server_a',
                serverIdAliases: [],
                serverUrl: 'https://server-a.example.test',
            },
            sessionId: 'sess_a',
            folderId: 'folder-a',
        });
    });

    it('renders one View options trigger in search chrome and keeps stopPropagation bound', async () => {
        const { SessionsList } = await import('./SessionsList');

        const screen = await renderScreen(<SessionsList />);

        const menuProps = dropdownMenuCaptures.find((captured) => {
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
        const responsive = await import('@/utils/platform/responsive');
        // Wide layouts delegate this reminder to Home; its list placement is the phone contract.
        vi.spyOn(responsive, 'useIsTablet').mockReturnValue(false);
        recoveryBannerMountSpy.mockClear();
        recoveryBannerUnmountSpy.mockClear();

        const screen = await renderScreen(<SessionsList />);

        expect(recoveryBannerMountSpy).toHaveBeenCalledTimes(1);
        expect(recoveryBannerUnmountSpy).not.toHaveBeenCalled();

        await screen.update(<SessionsList />);

        expect(recoveryBannerMountSpy).toHaveBeenCalledTimes(1);
        expect(recoveryBannerUnmountSpy).not.toHaveBeenCalled();
    });
});
