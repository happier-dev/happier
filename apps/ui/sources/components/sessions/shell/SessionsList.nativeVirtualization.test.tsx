import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let pinnedSessionKeysV1: string[] = [];
const setPinnedSessionKeysV1 = vi.fn();

let sessionTagsV1: Record<string, string[]> = {};
const setSessionTagsV1 = vi.fn();
let workspaceLabelsV1: Record<string, string> = {};
const setWorkspaceLabelsV1 = vi.fn();
let collapsedGroupKeysV1: Record<string, boolean> = {};
const setCollapsedGroupKeysV1 = vi.fn();
let allMachines = [
    {
        id: 'machine-target',
        active: true,
        activeAt: 10,
        metadata: { displayName: 'Rebound workstation', host: 'target.local' },
    },
    {
        id: 'machine-other',
        active: true,
        activeAt: 5,
        metadata: { displayName: 'Other workstation', host: 'other.local' },
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

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
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
    }),
    StyleSheet: {
        create: (input: any) =>
            typeof input === 'function'
                ? input({
                    colors: {
                        groupped: { background: '#f7f7f7', sectionTitle: '#333' },
                        textSecondary: '#666',
                        divider: '#ddd',
                        accent: { blue: '#07f' },
                        surface: '#fff',
                        modal: { border: '#ddd' },
                        shadow: { color: '#000' },
                    },
                })
                : input,
    },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('react-native', async () => {
    const stub = await import('../../../dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'ios' },
        TurboModuleRegistry: { ...stub.TurboModuleRegistry, get: () => ({}) },
    };
});

vi.mock('@shopify/flash-list', () => ({
    FlashList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ...rest }: any) => {
        return React.createElement(
            'FlashList',
            { ...rest },
            ListHeaderComponent ? React.createElement(ListHeaderComponent) : null,
            (data ?? []).map((item: any, index: number) => {
                const key = keyExtractor ? keyExtractor(item, index) : String(index);
                return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
            }),
        );
    },
}));

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ...rest }: any) => {
        return React.createElement(
            'FlashListCompat',
            { ...rest },
            ListHeaderComponent ? React.createElement(ListHeaderComponent) : null,
            (data ?? []).map((item: any, index: number) => {
                const key = keyExtractor ? keyExtractor(item, index) : String(index);
                return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
            }),
        );
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('expo-router', () => ({
    usePathname: () => '',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
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

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
    getDeviceType: () => 'phone',
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
    sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'compactSessionView') return false;
        if (key === 'compactSessionViewMinimal') return false;
        if (key === 'sessionTagsEnabled') return true;
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
    storage: {
        getState: () => storageState,
    },
}));

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: vi.fn(),
}));

vi.mock('./useSessionInlineDrag', () => ({
    useSessionInlineDrag: () => ({ gesture: undefined, animatedStyle: {} }),
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', props),
}));

describe('SessionsList (native virtualization)', () => {
    it('renders session items with correct adjacency props on native', async () => {
        pinnedSessionKeysV1 = [];
        sessionTagsV1 = {};
        workspaceLabelsV1 = {};
        collapsedGroupKeysV1 = {};
        setPinnedSessionKeysV1.mockClear();
        setSessionTagsV1.mockClear();

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const items = (tree as any).root.findAllByType('SessionItem');
        expect(items).toHaveLength(2);
        expect(items[0]?.props.isFirst).toBe(true);
        expect(items[0]?.props.isLast).toBe(false);
        expect(items[1]?.props.isFirst).toBe(false);
        expect(items[1]?.props.isLast).toBe(true);
    });

    it('passes path secondary-line mode for date-grouped rows', async () => {
        pinnedSessionKeysV1 = [];
        sessionTagsV1 = {};
        workspaceLabelsV1 = {};
        collapsedGroupKeysV1 = {};

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const items = (tree as any).root.findAllByType('SessionItem');
        expect(items[0]?.props.secondaryLineMode).toBe('path');
        expect(items[1]?.props.secondaryLineMode).toBe('path');
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

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const items = (tree as any).root.findAllByType('SessionItem');
        expect(items).toHaveLength(1);
        expect(items[0]?.props.secondaryLineMode).toBe('status');

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

    it('wires pin toggling via pinnedSessionKeysV1', async () => {
        pinnedSessionKeysV1 = [];
        workspaceLabelsV1 = {};
        collapsedGroupKeysV1 = {};
        setPinnedSessionKeysV1.mockClear();

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const items = (tree as any).root.findAllByType('SessionItem');
        const first = items[0];
        expect(typeof first.props.onTogglePinned).toBe('function');

        await act(async () => {
            first.props.onTogglePinned();
        });

        expect(setPinnedSessionKeysV1).toHaveBeenCalledTimes(1);
        expect(setPinnedSessionKeysV1).toHaveBeenCalledWith(['server_a:sess_a']);
    });

    it('writes session tags back to settings as a value (not an updater function)', async () => {
        pinnedSessionKeysV1 = [];
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        workspaceLabelsV1 = {};
        collapsedGroupKeysV1 = {};
        setSessionTagsV1.mockClear();

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const items = (tree as any).root.findAllByType('SessionItem');
        const first = items[0];
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
        workspaceLabelsV1 = {};
        collapsedGroupKeysV1 = {};
        mockAllowedServerIds = ['server_a'];

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const items = (tree as any).root.findAllByType('SessionItem');
        expect(items[0]?.props.pinned).toBe(true);
        expect(items[0]?.props.showServerBadge).toBe(false);

        mockAllowedServerIds = ['server_a', 'server_b'];
        await act(async () => {
            tree?.update(<SessionsList />);
        });

        const items2 = (tree as any).root.findAllByType('SessionItem');
        expect(items2[0]?.props.showServerBadge).toBe(true);
    });

    it('uses the reachable machine label and base path when row metadata is stale after handoff', async () => {
        pinnedSessionKeysV1 = [];
        sessionTagsV1 = {};
        workspaceLabelsV1 = {};
        collapsedGroupKeysV1 = {};
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

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const item = (tree as any).root.findAllByType('SessionItem')[0];
        expect(item.props.subtitleOverride).toBe('Rebound workstation · /Volumes/target/repo');
    });
});
