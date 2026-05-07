import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { clearTempData, peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let platformOs: 'ios' | 'android' | 'web' = 'ios';
let mockPathname = '';
let isTabletDevice = false;
let pinnedSessionKeysV1: string[] = [];
const setPinnedSessionKeysV1 = vi.fn();
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());

let sessionTagsV1: Record<string, string[]> = {};
const setSessionTagsV1 = vi.fn();
let workspaceLabelsV1: Record<string, string> = {};
const setWorkspaceLabelsV1 = vi.fn();
let collapsedGroupKeysV1: Record<string, boolean> = {};
const setCollapsedGroupKeysV1 = vi.fn();
let rememberLastProjectSessionSelections: boolean | null = null;
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

const sessionC = {
    ...sessionA,
    id: 'sess_c',
    metadata: {
        machineId: 'machine-target',
        path: '/Users/test/third-repo',
        homeDir: '/Users/test',
        host: 'target.local',
    },
} as any;

vi.mock('react-native-gesture-handler', () => ({
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
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

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () => ({
    ...((await import('@/dev/testkit/mocks/flashList')) as typeof import('@/dev/testkit/mocks/flashList')).createCapturingFlashListMock({
        componentName: 'FlashListCompat',
        renderItems: true,
    }).module,
}));

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
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        props,
        typeof props.trigger === 'function'
            ? props.trigger({
                open: Boolean(props.open),
                toggle: vi.fn(),
                openMenu: vi.fn(),
                closeMenu: vi.fn(),
                selectedItem: null,
            })
            : null,
    ),
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
    useIsTablet: () => isTabletDevice,
    getDeviceType: () => 'phone',
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOs;
                },
                select: (value: any) => value[platformOs] ?? value.default,
            },
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
            pathname: () => mockPathname,
            router: {
                push: routerPushSpy,
            },
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
                    if (key === 'rememberLastProjectSessionSelections') return rememberLastProjectSessionSelections;
                    return null;
                },
                useHasUnreadMessages: () => false,
                useAllMachines: () => allMachines,
                useSettingMutable: (key: string) => {
                    if (key === 'pinnedSessionKeysV1') return [pinnedSessionKeysV1, setPinnedSessionKeysV1];
                    if (key === 'sessionTagsV1') return [sessionTagsV1, setSessionTagsV1];
                    if (key === 'workspaceLabelsV1') return [workspaceLabelsV1, setWorkspaceLabelsV1];
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

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => mockVisibleSessionListViewData,
}));

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: vi.fn(),
}));

const useSessionInlineDragSpy = vi.hoisted(() => vi.fn((params: any) => ({
    gesture: undefined,
    animatedStyle: params ? {} : {},
})));

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

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (!style || typeof style !== 'object') {
        return {};
    }
    return style as Record<string, unknown>;
}

function findChevronOpacityForHeaderPressable(headerPressable: any): unknown {
    const chevronIcon = headerPressable.findAll((node: any) =>
        String(node.type) === 'Ionicons'
        && (node.props?.name === 'chevron-down' || node.props?.name === 'chevron-forward')
    )[0];
    return flattenStyle(chevronIcon?.parent?.props?.style).opacity;
}

function findPressableByAccessibilityLabel(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
    label: string,
) {
    return screen.root.findAll((node) =>
        String(node.type) === 'Pressable' && node.props?.accessibilityLabel === label
    )[0] ?? null;
}

describe('SessionsList (native virtualization)', () => {
    beforeEach(() => {
        platformOs = 'ios';
        mockPathname = '';
        isTabletDevice = false;
        pinnedSessionKeysV1 = [];
        sessionTagsV1 = {};
        workspaceLabelsV1 = {};
        collapsedGroupKeysV1 = {};
        rememberLastProjectSessionSelections = null;
        setPinnedSessionKeysV1.mockClear();
        setSessionTagsV1.mockClear();
        setWorkspaceLabelsV1.mockClear();
        setCollapsedGroupKeysV1.mockClear();
        useSessionInlineDragSpy.mockClear();
        routerPushSpy.mockClear();
        mockAllowedServerIds = ['server_a'];
        readMachineTargetForSessionMock.mockReset();
        readMachineTargetForSessionMock.mockImplementation(() => null);
        delete storageState.sessions.seed_sess;
        clearTempData();
        resetVisibleSessionListViewData();
    });

    afterEach(() => {
        clearTempData();
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

    it('passes stable recycling hints to native FlashList without deprecated size estimates', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );

        expect(list.props.estimatedItemSize).toBeUndefined();
        expect(list.props.getItemType?.(mockVisibleSessionListViewData[0])).toBe('header:date');
        expect(list.props.getItemType?.(mockVisibleSessionListViewData[1])).toBe('session');
    });

    it('keeps native list render props stable across unrelated rerenders', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();
        const initialList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const initialKeyExtractor = initialList.props.keyExtractor;
        const initialRenderItem = initialList.props.renderItem;
        const initialContentContainerStyle = initialList.props.contentContainerStyle;
        const { SessionsList } = await import('./SessionsList');

        await screen.update(<SessionsList />);

        const updatedList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected updated native FlashListCompat',
        );
        expect(updatedList.props.keyExtractor).toBe(initialKeyExtractor);
        expect(updatedList.props.renderItem).toBe(initialRenderItem);
        expect(updatedList.props.contentContainerStyle).toBe(initialContentContainerStyle);
    });

    it('reuses row item references that are not affected by route selection changes', async () => {
        platformOs = 'android';
        isTabletDevice = true;
        mockPathname = '/session/sess_a';
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
            {
                type: 'session',
                session: sessionC,
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const initialList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const initialData = initialList.props.data as Array<SessionListViewItem & { selected?: boolean }>;
        const initialRenderItem = initialList.props.renderItem;
        expect(initialData[1]?.selected).toBe(true);
        expect(initialData[2]?.selected).toBe(false);
        expect(initialData[3]?.selected).toBe(false);

        mockPathname = '/session/sess_b';
        const { SessionsList } = await import('./SessionsList');
        await screen.update(<SessionsList />);

        const updatedList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected updated native FlashListCompat',
        );
        const updatedData = updatedList.props.data as Array<SessionListViewItem & { selected?: boolean }>;
        expect(updatedList.props.renderItem).toBe(initialRenderItem);
        expect(updatedData[0]).toBe(initialData[0]);
        expect(updatedData[1]).not.toBe(initialData[1]);
        expect(updatedData[2]).not.toBe(initialData[2]);
        expect(updatedData[3]).toBe(initialData[3]);
        expect(updatedData[1]?.selected).toBe(false);
        expect(updatedData[2]?.selected).toBe(true);
        expect(updatedData[3]?.selected).toBe(false);
    });

    it('records numeric aggregate telemetry for session-list render derivation chunks', async () => {
        platformOs = 'android';
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            const screen = await renderSessionsList();

            expect(findSessionItem(screen, 'sess_a')).toBeTruthy();
            const events = syncPerformanceTelemetry.snapshot().events;
            expect(events.find((event) => event.name === 'ui.sessionsList.render.selectedMapping')?.fields)
                .toMatchObject({ items: 3, selectable: 0 });
            expect(events.find((event) => event.name === 'ui.sessionsList.render.reachabilityDisplayMap')?.fields)
                .toMatchObject({ items: 3, sessions: 2 });
            expect(events.find((event) => event.name === 'ui.sessionsList.render.collapsedFiltering')?.fields)
                .toMatchObject({ items: 3, collapsedGroups: 0 });

            await screen.unmount();
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        }
    });

    it('passes drag gestures into iOS rows without wrapping the full row in a GestureDetector', async () => {
        useSessionInlineDragSpy.mockReturnValueOnce({ gesture: { type: 'pan' }, animatedStyle: {} } as any);
        useSessionInlineDragSpy.mockReturnValueOnce({ gesture: { type: 'pan' }, animatedStyle: {} } as any);

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.reorderHandleGesture).toEqual({ type: 'pan' });
        expect(first.props.nativeInlineDragEnabled).toBe(true);

        const nativeRowGestureDetectors = screen.root.findAll((node) => String(node.type) === 'GestureDetector');
        expect(nativeRowGestureDetectors).toHaveLength(0);
    });

    it('disables Android reorder gestures during the hotfix', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.reorderHandleGesture).toBeUndefined();
        expect(first.props.nativeInlineDragEnabled).toBe(false);
        expect(useSessionInlineDragSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
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

    it('routes the project add action into a prefilled new-session flow', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                workspaceScopeHint: {
                    serverId: 'server_a',
                    machineId: 'machine-target',
                    rootPath: '/repo',
                },
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const addButton = expectPresent(
            findPressableByAccessibilityLabel(screen, 'machine.launchNewSessionInDirectory'),
            'expected always-visible project add action',
        );

        await act(async () => {
            addButton.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-target',
                directory: '/repo',
                spawnServerId: 'server_a',
            },
        });
    });

    it('uses the latest project session configuration when the remember setting is enabled', async () => {
        rememberLastProjectSessionSelections = true;
        storageState.sessions.seed_sess = {
            id: 'seed_sess',
            active: true,
            createdAt: 20,
            updatedAt: 30,
            seq: 3,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'machine-source',
                path: '/repo/source',
                homeDir: '/repo',
                host: 'source.local',
                flavor: 'codex',
                profileId: 'profile-1',
                transcriptStorage: 'direct',
                codexBackendMode: 'appServer',
                sessionModeOverrideV1: {
                    v: 1,
                    updatedAt: 100,
                    modeId: 'plan',
                },
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 101,
                    overrides: {
                        effort: { updatedAt: 101, value: 'high' },
                    },
                },
            },
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 102,
            modelMode: 'gpt-5',
            modelModeUpdatedAt: 103,
        };
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                seedSessionId: 'seed_sess',
                workspaceScopeHint: {
                    serverId: 'server_a',
                    machineId: 'machine-target',
                    rootPath: '/repo',
                },
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const addButton = expectPresent(
            findPressableByAccessibilityLabel(screen, 'machine.launchNewSessionInDirectory'),
            'expected project add action',
        );

        await act(async () => {
            addButton.props.onPress();
        });

        const pushArg = routerPushSpy.mock.calls[0]?.[0] as any;
        expect(pushArg).toEqual({
            pathname: '/new',
            params: {
                dataId: expect.any(String),
                machineId: 'machine-target',
                directory: '/repo',
                spawnServerId: 'server_a',
            },
        });
        const tempData = peekTempData<NewSessionData>(pushArg.params.dataId);
        expect(tempData).toEqual(expect.objectContaining({
            prompt: '',
            replacePersistedDraftSelections: true,
            machineId: 'machine-target',
            directory: '/repo',
            agentType: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-5',
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 101,
                overrides: {
                    effort: { updatedAt: 101, value: 'high' },
                },
            },
        }));
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

    it('shows project chevrons only on hover unless the group is collapsed, while keeping the add action visible', async () => {
        platformOs = 'web';
        const { ProjectGroupHeader } = await import('./SessionsList');

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'server:server_a:active:project:abc',
                    workspaceKey: 'wl_abc',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine-target',
                        rootPath: '/repo',
                    },
                    serverId: 'server_a',
                    serverName: 'Server A',
                } as any}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header"
            />,
        );

        const header = screen.root.findAllByType('Pressable')[0];
        expect(findPressableByAccessibilityLabel(screen as any, 'machine.launchNewSessionInDirectory')).toBeTruthy();
        expect(findChevronOpacityForHeaderPressable(header)).toBe(0);
        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(0);

        await act(async () => {
            header.props.onHoverIn?.();
        });

        expect(findChevronOpacityForHeaderPressable(screen.root.findAllByType('Pressable')[0])).toBe(1);
        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(1);
        const menuTrigger = expectPresent(
            findPressableByAccessibilityLabel(screen as any, 'common.moreActions'),
            'expected project menu trigger while hovered',
        );

        await act(async () => {
            menuTrigger.props.onHoverIn?.();
            screen.root.findAllByType('Pressable')[0].props.onHoverOut?.();
        });

        expect(findPressableByAccessibilityLabel(screen as any, 'common.moreActions')).toBeTruthy();
        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(1);

        await act(async () => {
            menuTrigger.props.onHoverOut?.();
            screen.root.findAllByType('Pressable')[0].props.onHoverOut?.();
        });

        expect(findChevronOpacityForHeaderPressable(screen.root.findAllByType('Pressable')[0])).toBe(0);

        const collapsedScreen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'server:server_a:active:project:abc',
                    workspaceKey: 'wl_abc',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine-target',
                        rootPath: '/repo',
                    },
                    serverId: 'server_a',
                    serverName: 'Server A',
                } as any}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                collapsed={true}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header-collapsed"
            />,
        );
        const collapsedHeader = collapsedScreen.root.findAllByType('Pressable')[0];
        expect(findChevronOpacityForHeaderPressable(collapsedHeader)).toBe(1);
    });

    it('hides expanded section chevrons until hover on web and keeps date headers on the subheader typography tier', async () => {
        platformOs = 'web';
        const { CollapsibleSectionHeader, ProjectGroupHeader } = await import('./SessionsList');

        const activeScreen = await renderScreen(
            <CollapsibleSectionHeader
                title="Active"
                headerKind="active"
                collapsed={false}
                onPress={vi.fn()}
                headerTestId="active-header"
            />,
        );
        const projectScreen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'server:server_a:active:project:abc',
                    workspaceKey: 'wl_abc',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine-target',
                        rootPath: '/repo',
                    },
                } as any}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header"
            />,
        );
        const yesterdayScreen = await renderScreen(
            <CollapsibleSectionHeader
                title="Yesterday"
                headerKind="date"
                collapsed={false}
                onPress={vi.fn()}
                headerTestId="yesterday-header"
            />,
        );

        const activeHeader = activeScreen.root.findAllByType('Pressable')[0];
        const projectHeader = projectScreen.root.findAllByType('Pressable')[0];
        const yesterdayHeader = yesterdayScreen.root.findAllByType('Pressable')[0];
        expect(findChevronOpacityForHeaderPressable(activeHeader)).toBe(0);
        expect(findChevronOpacityForHeaderPressable(yesterdayHeader)).toBe(0);

        await act(async () => {
            yesterdayHeader.props.onHoverIn?.();
        });

        expect(findChevronOpacityForHeaderPressable(yesterdayScreen.root.findAllByType('Pressable')[0])).toBe(1);

        const activeTextStyle = flattenStyle(activeHeader.findAllByType('Text')[0]?.props?.style);
        const yesterdayTextStyle = flattenStyle(yesterdayHeader.findAllByType('Text')[0]?.props?.style);
        const projectTextStyle = flattenStyle(projectHeader.findAllByType('Text')[0]?.props?.style);

        expect(yesterdayTextStyle.fontSize).toBe(projectTextStyle.fontSize);
        expect(Number(activeTextStyle.fontSize)).toBeGreaterThan(Number(yesterdayTextStyle.fontSize));
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

    it('uses start-side overflow ellipsis for workspace path headers on web without reordering the path', async () => {
        platformOs = 'web';
        const { ProjectGroupHeader } = await import('./SessionsList');
        const workspacePath = '~/Documents/Development/happier/remote-dev';
        const projectHeaderItem = {
            type: 'header',
            title: workspacePath,
            headerKind: 'project',
            groupKey: 'server:server_a:active:project:abc',
            workspaceKey: 'wl_abc',
            workspaceScopeHint: {
                serverId: 'server_a',
                machineId: 'machine-target',
                rootPath: '/Users/test/Documents/Development/happier/remote-dev',
            },
            serverId: 'server_a',
            serverName: 'Server A',
        } satisfies Extract<SessionListViewItem, { type: 'header' }>;

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={projectHeaderItem}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header"
            />,
        );

        const outerTitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.numberOfLines === 1,
        )[0];
        const innerTitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === workspacePath,
        )[0];

        expect(outerTitle).toBeTruthy();
        expect(innerTitle).toBeTruthy();
        expect(flattenStyle(outerTitle?.props.style)).toMatchObject({
            writingDirection: 'rtl',
            textAlign: 'left',
        });
        expect(flattenStyle(innerTitle?.props.style)).toMatchObject({
            writingDirection: 'ltr',
            unicodeBidi: 'isolate',
        });
    });

    it('uses native head ellipsis for workspace path headers outside web', async () => {
        platformOs = 'ios';
        const { ProjectGroupHeader } = await import('./SessionsList');
        const workspacePath = '~/Documents/Development/happier/remote-dev';
        const projectHeaderItem = {
            type: 'header',
            title: workspacePath,
            headerKind: 'project',
            groupKey: 'server:server_a:active:project:abc',
            workspaceKey: 'wl_abc',
            workspaceScopeHint: {
                serverId: 'server_a',
                machineId: 'machine-target',
                rootPath: '/Users/test/Documents/Development/happier/remote-dev',
            },
            serverId: 'server_a',
            serverName: 'Server A',
        } satisfies Extract<SessionListViewItem, { type: 'header' }>;

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={projectHeaderItem}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header"
            />,
        );

        const title = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === workspacePath
            && node.props.numberOfLines === 1,
        )[0];

        expect(title?.props.ellipsizeMode).toBe('head');
    });
});
