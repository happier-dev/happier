import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeContainingText, renderScreen, standardCleanup } from '@/dev/testkit';
import { createCapturingFlatListMock } from '@/dev/testkit/mocks/flashList';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedRootFlatListProps: any | null = null;
const routerPushSpy = vi.fn();

let pinnedSessionKeysV1: string[] = [];
const setPinnedSessionKeysV1 = vi.fn();

let sessionListGroupOrderV1: Record<string, string[]> = {};
const setSessionListGroupOrderV1 = vi.fn();

let sessionTagsV1: Record<string, string[]> = {};
const setSessionTagsV1 = vi.fn();
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const mockMachinesState = vi.hoisted(() => ({ current: [] as any[] }));
const flatListMock = createCapturingFlatListMock({ renderItems: true });

const groupKey = 'server:server_a:day:2026-02-17';

const sessionA = {
    id: 'sess_a',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: false,
    activeAt: 0,
    metadata: null,
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
} as any;

const projectGroupKey = 'server:server_a:active:project:proj_a';

vi.mock('react-native-reanimated', () => ({
    default: { View: (props: any) => React.createElement('Animated.View', props) },
    useSharedValue: (init: any) => ({ value: init }),
    useAnimatedStyle: (fn: () => any) => fn(),
}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                Platform: { OS: 'web', select: (value: any) => value.web ?? value.default },
                                TurboModuleRegistry: { get: () => ({}) },
                                FlatList: (props: any) => {
                                    const element = flatListMock.module.FlatList(props);
                                    capturedRootFlatListProps = flatListMock.state.props;
                                    return element;
                                },
                            }
    );
});

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '',
    router: {
        push: routerPushSpy,
        replace: vi.fn(),
        back: vi.fn(),
        setParams: vi.fn(),
    },
}).module);

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
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

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return {
        ...actual,
        useIsTablet: () => false,
        getDeviceType: () => 'phone',
    };
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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: (key: string) => {
                if (key === 'compactSessionView') return false;
                if (key === 'compactSessionViewMinimal') return false;
                if (key === 'sessionTagsEnabled') return true;
                return null;
            },
            useHasUnreadMessages: () => false,
            useSession: () => null,
            useProfile: () => ({
                id: 'profile-1',
                timestamp: 0,
                firstName: null,
                lastName: null,
                username: null,
                avatar: null,
                linkedProviders: [],
                connectedServices: [],
                connectedServicesV2: [],
            }),
            useAllMachines: () => mockMachinesState.current,
            useSettingMutable: (key: string) => {
                if (key === 'pinnedSessionKeysV1') return [pinnedSessionKeysV1, setPinnedSessionKeysV1];
                if (key === 'sessionListGroupOrderV1') return [sessionListGroupOrderV1, setSessionListGroupOrderV1];
                if (key === 'sessionTagsV1') return [sessionTagsV1, setSessionTagsV1];
                return [null, vi.fn()];
            },
        },
    });
});

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: vi.fn(),
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    resolveActiveServerSelectionFromRawSettings: () =>
        ({
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'server_a',
            allowedServerIds: ['server_a'],
        }) as any,
    getEffectiveServerSelectionFromRawSettings: () =>
        ({
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'server_a',
            allowedServerIds: ['server_a'],
        }) as any,
}));

vi.mock('./useSessionInlineDrag', () => ({
    useSessionInlineDrag: () => ({ gesture: undefined, animatedStyle: {} }),
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

describe('SessionsList pinning + per-group ordering', () => {
    beforeEach(() => {
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};
        setPinnedSessionKeysV1.mockClear();
        setSessionListGroupOrderV1.mockClear();
        setSessionTagsV1.mockClear();
        routerPushSpy.mockReset();
        mockAllowedServerIds = ['server_a'];
        capturedRootFlatListProps = null;
        readMachineTargetForSessionMock.mockReset();
        mockMachinesState.current = [];
        resetVisibleSessionListViewData();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the archived sessions footer on web and routes to archived sessions', async () => {
        const screen = await renderSessionsList();

        const footerPressable = expectPresent(
            findTestInstanceByTypeContainingText(screen.root, 'Pressable', 'sessionInfo.archivedSessions'),
            'expected archived sessions footer button',
        );

        await act(async () => {
            footerPressable.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/archived');
    });

    it('stops wheel event propagation on web so session list scrolling is not blocked by document scroll-lock listeners', async () => {
        const screen = await renderSessionsList();

        expect(screen.root).toBeTruthy();
        expect(capturedRootFlatListProps).toBeTruthy();
        expect(typeof capturedRootFlatListProps?.onWheel).toBe('function');

        const stopPropagation = vi.fn();
        capturedRootFlatListProps?.onWheel?.({ stopPropagation });
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('passes session tags from settings into session items when enabled', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        const screen = await renderSessionsList();

        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );
        expect(row.props.tags).toEqual(['important']);
        expect(row.props.allKnownTags).toContain('important');
        expect(row.props.tagsEnabled).toBe(true);
    });

    it('writes updated session tags back to settings as a value (not an updater function)', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        const screen = await renderSessionsList();

        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );

        expect(typeof row.props.onSetTags).toBe('function');
        row.props.onSetTags(['urgent']);

        expect(setSessionTagsV1).toHaveBeenCalledTimes(1);
        expect(setSessionTagsV1.mock.calls[0]?.[0]).toEqual({
            'server_a:sess_a': ['urgent'],
        });
    });

    it('shows pinned server badges only when multiple servers are selected', async () => {
        pinnedSessionKeysV1 = ['server_a:sess_a'];
        sessionTagsV1 = {};
        const screen = await renderSessionsList();

        const pinnedRow = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected pinned sess_a row',
        );
        expect(pinnedRow.props.pinned).toBe(true);
        expect(pinnedRow.props.showServerBadge).toBe(false);

        mockAllowedServerIds = ['server_a', 'server_b'];
        const updatedScreen = await renderSessionsList();

        const pinnedRow2 = expectPresent(
            findSessionItem(updatedScreen, 'sess_a'),
            'expected updated pinned sess_a row',
        );
        expect(pinnedRow2.props.showServerBadge).toBe(true);
    });

    it('wires pin toggling via pinnedSessionKeysV1', async () => {
        setPinnedSessionKeysV1.mockClear();

        const screen = await renderSessionsList();

        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );
        expect(typeof row.props.onTogglePinned).toBe('function');

        await act(async () => {
            row.props.onTogglePinned();
        });

        expect(setPinnedSessionKeysV1).toHaveBeenCalledTimes(1);
        expect(setPinnedSessionKeysV1).toHaveBeenCalledWith(['server_a:sess_a']);
    });

    it('does not render project headers and forces path/machine subtitles into rows', async () => {
        const sess1 = {
            ...sessionA,
            id: 'sess_p1',
            active: true,
            presence: 'online',
            metadata: { machineId: 'm1', host: 'Mac 1', path: '/home/u/repoA', homeDir: '/home/u' },
        } as any;

        const sess2 = {
            ...sessionA,
            id: 'sess_p2',
            active: true,
            presence: 'online',
            metadata: { machineId: 'm2', host: 'Mac 2', path: '/home/u/repoA', homeDir: '/home/u' },
        } as any;

        mockVisibleSessionListViewData = [
            { type: 'header', title: 'Active', headerKind: 'active', serverId: 'server_a', serverName: 'Server A' },
            {
                type: 'header',
                title: '~/repoA',
                headerKind: 'project',
                groupKey: projectGroupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            },
            { type: 'session', session: sess1, groupKey: projectGroupKey, groupKind: 'project', variant: 'no-path', serverId: 'server_a', serverName: 'Server A' },
            { type: 'session', session: sess2, groupKey: projectGroupKey, groupKind: 'project', variant: 'no-path', serverId: 'server_a', serverName: 'Server A' },
        ];

        const screen = await renderSessionsList();

        const textNodes = screen.root.findAllByType('Text');
        const textChildren = textNodes.map((n: any) => n.props.children);
        expect(textChildren).toContain('~/repoA');

        const row1 = expectPresent(
            findSessionItem(screen, 'sess_p1'),
            'expected sess_p1 session row',
        );
        expect(row1.props.variant).toBe('no-path');
        expect(row1.props.subtitleOverride ?? null).toBe(null);
    });

    it('derives row subtitles from reachable machine targets when session metadata is stale after handoff', async () => {
        mockMachinesState.current = [
            { id: 'machine-live-1', metadata: { displayName: 'Rebound workstation' } },
            { id: 'machine-live-2', metadata: { host: 'rebound-2.local' } },
        ];

        const sess1 = {
            ...sessionA,
            id: 'sess_live_1',
            active: true,
            presence: 'online',
            metadata: { machineId: 'machine-stale-1', host: 'Old workstation', path: '/home/u/stale-a', homeDir: '/home/u' },
        } as any;

        const sess2 = {
            ...sessionA,
            id: 'sess_live_2',
            active: true,
            presence: 'online',
            metadata: { machineId: 'machine-stale-2', host: 'Old workstation 2', path: '/home/u/stale-b', homeDir: '/home/u' },
        } as any;

        readMachineTargetForSessionMock.mockImplementation((sessionId: string) => {
            if (sessionId === 'sess_live_1') {
                return { machineId: 'machine-live-1', basePath: '/home/u/live-a' };
            }
            if (sessionId === 'sess_live_2') {
                return { machineId: 'machine-live-2', basePath: '/home/u/live-b' };
            }
            return null;
        });

        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            },
            { type: 'session', session: sess1, groupKey, groupKind: 'date', serverId: 'server_a', serverName: 'Server A' },
            { type: 'session', session: sess2, groupKey, groupKind: 'date', serverId: 'server_a', serverName: 'Server A' },
        ];

        const screen = await renderSessionsList();

        const row1 = expectPresent(
            findSessionItem(screen, 'sess_live_1'),
            'expected sess_live_1 session row',
        );
        const row2 = expectPresent(
            findSessionItem(screen, 'sess_live_2'),
            'expected sess_live_2 session row',
        );

        expect(row1.props.subtitleOverride).toBe('Rebound workstation · /home/u/live-a');
        expect(row2.props.subtitleOverride).toBe('rebound-2.local · /home/u/live-b');
    });
});
