import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SESSION_LIST_ROW_HEIGHT_DEFAULT } from './sessionListRowHeights';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let pinnedSessionKeysV1: string[] = [];
const setPinnedSessionKeysV1 = vi.fn();
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());

let sessionTagsV1: Record<string, string[]> = {};
const setSessionTagsV1 = vi.fn();
let sessionListOrderingModeV1: 'custom' | 'created' | 'updated' = 'custom';
const setSessionListOrderingModeV1 = vi.fn();
let workspaceLabelsV1: Record<string, string> = {};
const setWorkspaceLabelsV1 = vi.fn();
let workspaceRefsV1: any[] = [];
const setWorkspaceRefsV1 = vi.fn();
let collapsedGroupKeysV1: Record<string, boolean> = {};
const setCollapsedGroupKeysV1 = vi.fn();
const flashListCompatState = vi.hoisted(() => ({ current: null as null | { props: any | null } }));
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
let storageState: any = {
    sessions: {
        sess_a: {
            active: true,
            updatedAt: 10,
            metadata: {
                machineId: 'machine-stale',
                path: '/Users/test/stale-repo',
                homeDir: '/Users/test',
                host: 'stale.local',
            },
        },
        sess_b: {
            active: true,
            updatedAt: 5,
            metadata: {
                machineId: 'machine-other',
                path: '/Users/test/other-repo',
                homeDir: '/Users/test',
                host: 'other.local',
            },
        },
    },
    machines: {
        'machine-target': {
            id: 'machine-target',
            active: true,
            activeAt: 10,
            metadata: { displayName: 'Rebound workstation', host: 'target.local' },
        },
        'machine-other': {
            id: 'machine-other',
            active: true,
            activeAt: 5,
            metadata: { displayName: 'Other workstation', host: 'other.local' },
        },
    },
    getProjectForSession: (sessionId: string) =>
        sessionId === 'sess_a'
            ? {
                key: {
                    machineId: 'machine-target',
                    path: '/Volumes/target/repo',
                },
            }
            : null,
};

const groupKey = 'server:server_a:day:2026-02-17';

const sessionA = {
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
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 'offline',
} as any;

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

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-reanimated', () => ({
    default: { View: (props: any) => React.createElement('Animated.View', props) },
    useSharedValue: (init: any) => ({ value: init }),
    useAnimatedStyle: (fn: () => any) => fn(),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@shopify/flash-list', async () => ({
    ...((await import('@/dev/testkit/mocks/flashList')) as typeof import('@/dev/testkit/mocks/flashList')).createCapturingFlashListMock({
        componentName: 'FlashList',
        renderItems: true,
    }).module,
}));

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () => {
    const flashListModule = (await import('@/dev/testkit/mocks/flashList')) as typeof import('@/dev/testkit/mocks/flashList');
    const mock = flashListModule.createCapturingFlashListMock({
        componentName: 'FlashListCompat',
        renderItems: true,
    });
    flashListCompatState.current = mock.state;
    return mock.module;
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1280 },
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/sync/domains/session/listing/sessionListOrderingStateV1', () => ({
    SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP: 50,
}));

vi.mock('@/sync/domains/session/listing/deriveSessionListActivity', () => ({
    resolveSessionListSecondaryLineMode: ({ groupKind }: { groupKind?: string | null }) =>
        groupKind === 'date' ? 'path' : 'status',
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    formatPathRelativeToHome: (path: string) => path,
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
    getDeviceType: () => 'phone',
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (value: any) => value.ios ?? value.default },
            TurboModuleRegistry: { get: () => ({}) },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: '#f7f7f7', sectionTitle: '#333' },
                    textSecondary: '#666',
                    divider: '#ddd',
                    accent: { blue: '#07f' },
                    surface: '#fff',
                    modal: { border: '#ddd' },
                    shadow: { color: '#000' },
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '',
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'compactSessionView') return false;
                    if (key === 'compactSessionViewMinimal') return false;
                    if (key === 'sessionTagsEnabled') return true;
                    if (key === 'sessionListOrderingModeV1') return sessionListOrderingModeV1;
                    return null;
                },
                useHasUnreadMessages: () => false,
                useAllMachines: () => allMachines,
                useSettingMutable: (key: string) => {
                    if (key === 'pinnedSessionKeysV1') return [pinnedSessionKeysV1, setPinnedSessionKeysV1];
                    if (key === 'sessionTagsV1') return [sessionTagsV1, setSessionTagsV1];
                    if (key === 'sessionListOrderingModeV1') return [sessionListOrderingModeV1, setSessionListOrderingModeV1];
                    if (key === 'workspaceLabelsV1') return [workspaceLabelsV1, setWorkspaceLabelsV1];
                    if (key === 'workspaceRefsV1') return [workspaceRefsV1, setWorkspaceRefsV1];
                    if (key === 'collapsedGroupKeysV1') return [collapsedGroupKeysV1, setCollapsedGroupKeysV1];
                    if (key === 'sessionListGroupOrderV1') return [{}, vi.fn()];
                    return [null, vi.fn()];
                },
                storage: createStorageStoreMock(storageState),
            },
        });
    },
});

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
        },
    });
});

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionMock(sessionId),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

let mockAllowedServerIds: string[] = ['server_a'];
vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'server_a',
        allowedServerIds: mockAllowedServerIds,
    }),
}));

let mockVisibleSessionListViewData: any[] = [
    {
        type: 'header',
        title: 'Today',
        headerKind: 'date',
        groupKey,
        serverId: 'server_a',
        serverName: 'Server A',
    },
    {
        type: 'session',
        session: sessionA,
        groupKey,
        groupKind: 'date',
        serverId: 'server_a',
        serverName: 'Server A',
    },
    {
        type: 'session',
        session: sessionB,
        groupKey,
        groupKind: 'date',
        serverId: 'server_a',
        serverName: 'Server A',
    },
];

vi.mock('@/hooks/session/useVisibleSessionListPaneState', () => ({
    useVisibleSessionListPaneState: () => ({
        summary: {
            sessionsReady: true,
            sessionCount: mockVisibleSessionListViewData.filter((item) => item.type === 'session').length,
        },
        visibleSessionListViewData: mockVisibleSessionListViewData,
        showLoading: false,
        showEmptyState: false,
    }),
}));

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: vi.fn(),
}));

const useSessionInlineDragSpy = vi.hoisted(() => vi.fn((params: any) => ({ gesture: undefined, animatedStyle: {} })));

vi.mock('./useSessionInlineDrag', () => ({
    useSessionInlineDrag: (params: any) => useSessionInlineDragSpy(params),
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', {
        ...props,
        testID: `session-list-session:${String(props.session?.id ?? 'unknown')}`,
    }),
}));

function resetVisibleSessionListViewData(): void {
    mockVisibleSessionListViewData = [
        {
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            groupKey,
            serverId: 'server_a',
            serverName: 'Server A',
        },
        {
            type: 'session',
            session: sessionA,
            groupKey,
            groupKind: 'date',
            serverId: 'server_a',
            serverName: 'Server A',
        },
        {
            type: 'session',
            session: sessionB,
            groupKey,
            groupKind: 'date',
            serverId: 'server_a',
            serverName: 'Server A',
        },
    ];
}

async function renderSessionsList() {
    await vi.resetModules();
    const { SessionsList } = await import('./SessionsList');
    return renderScreen(<SessionsList />);
}

function findSessionItem(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
    sessionId: string,
) {
    return screen.findByTestId(`session-list-session:${sessionId}`);
}

function expectPresent<T>(value: T | null | undefined, label: string): T {
    expect(value, label).toBeTruthy();
    if (value == null) {
        throw new Error(label);
    }
    return value;
}

function findFirstDropdownMenuItems(screen: Awaited<ReturnType<typeof renderSessionsList>>): any[] {
    const menus = screen.findAll((node) => String(node.type) === 'DropdownMenu');
    for (const menu of menus) {
        const items = (menu.props as any)?.items;
        if (!Array.isArray(items)) continue;
        if (items.some((i: any) => i?.id === 'rename')) {
            return items;
        }
    }
    return [];
}

describe('SessionsList (native virtualization)', () => {
    beforeEach(() => {
        sessionListOrderingModeV1 = 'custom';
        pinnedSessionKeysV1 = [];
        sessionTagsV1 = {};
        workspaceLabelsV1 = {};
        workspaceRefsV1 = [];
        collapsedGroupKeysV1 = {};
        setPinnedSessionKeysV1.mockClear();
        setSessionTagsV1.mockClear();
        setSessionListOrderingModeV1.mockClear();
        setWorkspaceLabelsV1.mockClear();
        setWorkspaceRefsV1.mockClear();
        setCollapsedGroupKeysV1.mockClear();
        useSessionInlineDragSpy.mockClear();
        mockAllowedServerIds = ['server_a'];
        readMachineTargetForSessionMock.mockReset();
        readMachineTargetForSessionMock.mockImplementation(() => null);
        resetVisibleSessionListViewData();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders session items with correct adjacency props on native', async () => {
        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        const second = expectPresent(findSessionItem(screen, 'sess_b'), 'expected sess_b session row');
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);
        expect(first.props.isFirst).toBe(true);
        expect(first.props.isLast).toBe(false);
        expect(second.props.isFirst).toBe(false);
        expect(second.props.isLast).toBe(true);
    });

    it('passes reorder handle gestures directly to native session rows in custom mode', async () => {
        useSessionInlineDragSpy.mockReturnValueOnce({ gesture: { type: 'pan' }, animatedStyle: {} } as any);
        useSessionInlineDragSpy.mockReturnValueOnce({ gesture: { type: 'pan' }, animatedStyle: {} } as any);

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.reorderHandleGesture).toBeDefined();
        expect(first.props.nativeInlineDragEnabled).toBe(true);
    });

    it('disables native inline drag affordances when ordering mode is not custom', async () => {
        sessionListOrderingModeV1 = 'updated';

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.reorderHandleGesture).toBeUndefined();
        expect(first.props.nativeInlineDragEnabled).toBe(false);
        expect(useSessionInlineDragSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });

    it('passes FlashList layout hints for heterogeneous native session rows', async () => {
        await renderSessionsList();

        expect(flashListCompatState.current?.props?.estimatedItemSize).toBe(SESSION_LIST_ROW_HEIGHT_DEFAULT);
        expect(typeof flashListCompatState.current?.props?.getItemType).toBe('function');
    });

    it('classifies native FlashList items by row kind', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'server:server_a:active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'server:server_a:active:project:abc',
                groupKind: 'project',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        await renderSessionsList();

        const getItemType = flashListCompatState.current?.props?.getItemType;
        expect(getItemType?.(mockVisibleSessionListViewData[0], 0)).toBe('header:active');
        expect(getItemType?.(mockVisibleSessionListViewData[1], 1)).toBe('header:project');
        expect(getItemType?.(mockVisibleSessionListViewData[2], 2)).toBe('session');
    });

    it('passes path secondary-line mode for date-grouped rows', async () => {
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
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'server:server_a:active:project:abc',
                groupKind: 'project',
                variant: 'no-path',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
        expect(findSessionItem(screen, 'sess_a')?.props.secondaryLineMode).toBe('status');

        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];
    });

    it('shows an Open project action for project headers with a resolvable WorkspaceRef', async () => {
        workspaceRefsV1 = [
            {
                id: 'wr_1',
                serverId: 'server_a',
                machineId: 'machine_1',
                rootPath: '/repo',
                label: 'Repo',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ];
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Repo',
                headerKind: 'project',
                groupKey: 'project:machine_1:/repo',
                workspaceScopeHint: { serverId: 'server_a', machineId: 'machine_1', rootPath: '/repo' },
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const items = findFirstDropdownMenuItems(screen);
        expect(items.some((item) => item?.id === 'openProject')).toBe(true);
    });

    it('does not expose project rename actions without a workspace scope hint', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        expect(findFirstDropdownMenuItems(screen)).toEqual([]);
    });

    it('wires pin toggling via pinnedSessionKeysV1', async () => {
        setPinnedSessionKeysV1.mockClear();

        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected first session item');
        expect(typeof first.props.onTogglePinned).toBe('function');

        await act(async () => {
            first.props.onTogglePinned();
        });

        expect(setPinnedSessionKeysV1).toHaveBeenCalledTimes(1);
        expect(setPinnedSessionKeysV1).toHaveBeenCalledWith(['server_a:sess_a']);
    });

    it('writes session tags back to settings as a value (not an updater function)', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        setSessionTagsV1.mockClear();

        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected first session item');
        expect(typeof first.props.onSetTags).toBe('function');
        first.props.onSetTags(['urgent']);

        expect(setSessionTagsV1).toHaveBeenCalledTimes(1);
        expect(setSessionTagsV1.mock.calls[0]?.[0]).toEqual({
            'server_a:sess_a': ['urgent'],
        });
    });

    it('shows pinned server badges only when multiple servers are selected', async () => {
        pinnedSessionKeysV1 = ['server_a:sess_a'];
        sessionTagsV1 = {};
        const screen = await renderSessionsList();
        expect(findSessionItem(screen, 'sess_a')?.props.pinned).toBe(true);
        expect(findSessionItem(screen, 'sess_a')?.props.showServerBadge).toBe(false);

        mockAllowedServerIds = ['server_a', 'server_b'];
        const updatedScreen = await renderSessionsList();
        expect(findSessionItem(updatedScreen, 'sess_a')?.props.showServerBadge).toBe(true);
    });

    it('uses the reachable machine label and base path when row metadata is stale after handoff', async () => {
        readMachineTargetForSessionMock.mockImplementation((sessionId: string) =>
            sessionId === 'sess_a'
                ? { machineId: 'machine-target', basePath: '/Volumes/target/repo' }
                : null,
        );
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const item = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected first session item',
        );
        expect(item.props.subtitleOverride).toBe('Rebound workstation · /Volumes/target/repo');
    });

    it('does not derive reachability details for rows hidden by a collapsed group', async () => {
        collapsedGroupKeysV1 = { [groupKey]: true };
        readMachineTargetForSessionMock.mockClear();
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: 'Tomorrow',
                headerKind: 'date',
                groupKey: 'server:server_a:day:2026-02-18',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'server:server_a:day:2026-02-18',
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();

        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);
        expect(readMachineTargetForSessionMock).toHaveBeenCalledTimes(1);
        expect(readMachineTargetForSessionMock).toHaveBeenCalledWith('sess_b');
    });
});
