import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let pinnedSessionKeysV1: string[] = [];
const setPinnedSessionKeysV1 = vi.fn();

let sessionListGroupOrderV1: Record<string, string[]> = {};
const setSessionListGroupOrderV1 = vi.fn();

let sessionTagsV1: Record<string, string[]> = {};
const setSessionTagsV1 = vi.fn();

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

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
        TurboModuleRegistry: { ...stub.TurboModuleRegistry, get: () => ({}) },
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent }: any) => {
            return React.createElement(
                'FlatList',
                null,
                ListHeaderComponent ? React.createElement(ListHeaderComponent) : null,
                (data ?? []).map((item: any, index: number) => {
                    const key = keyExtractor ? keyExtractor(item, index) : String(index);
                    return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
                }),
            );
        },
    };
});

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
    useSettingMutable: (key: string) => {
        if (key === 'pinnedSessionKeysV1') return [pinnedSessionKeysV1, setPinnedSessionKeysV1];
        if (key === 'sessionListGroupOrderV1') return [sessionListGroupOrderV1, setSessionListGroupOrderV1];
        if (key === 'sessionTagsV1') return [sessionTagsV1, setSessionTagsV1];
        return [null, vi.fn()];
    },
}));

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: vi.fn(),
}));

// Some other suites may auto-mock this module; ensure the full export surface exists for this suite.
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

vi.mock('./SessionGroupDragList', () => ({
    SessionGroupDragList: (props: any) => React.createElement('SessionGroupDragList', props),
}));

describe('SessionsList pinning + per-group ordering', () => {
    it('passes session tags from settings into group row models when enabled', async () => {
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        setPinnedSessionKeysV1.mockClear();
        setSessionListGroupOrderV1.mockClear();
        setSessionTagsV1.mockClear();

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const group = (tree as any).root.findByType('SessionGroupDragList');
        const row = group.props.rows.find((r: any) => r.key === 'server_a:sess_a');
        expect(row.tags).toEqual(['important']);
        expect(row.allKnownTags).toContain('important');
        expect(row.tagsEnabled).toBe(true);
    });

    it('writes updated session tags back to settings as a value (not an updater function)', async () => {
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        setPinnedSessionKeysV1.mockClear();
        setSessionListGroupOrderV1.mockClear();
        setSessionTagsV1.mockClear();

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const group = (tree as any).root.findByType('SessionGroupDragList');
        const row = group.props.rows.find((r: any) => r.key === 'server_a:sess_a');

        expect(typeof row.onSetTags).toBe('function');
        row.onSetTags(['urgent']);

        expect(setSessionTagsV1).toHaveBeenCalledTimes(1);
        expect(setSessionTagsV1.mock.calls[0]?.[0]).toEqual({
            'server_a:sess_a': ['urgent'],
        });
    });

    it('shows pinned server badges only when multiple servers are selected', async () => {
        pinnedSessionKeysV1 = ['server_a:sess_a'];
        sessionTagsV1 = {};
        setPinnedSessionKeysV1.mockClear();
        mockAllowedServerIds = ['server_a'];

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const group = (tree as any).root.findByType('SessionGroupDragList');
        const pinnedRow = group.props.rows.find((r: any) => r.key === 'server_a:sess_a');
        expect(pinnedRow.pinned).toBe(true);
        expect(pinnedRow.showServerBadge).toBe(false);

        mockAllowedServerIds = ['server_a', 'server_b'];
        await act(async () => {
            tree?.update(<SessionsList />);
        });

        const group2 = (tree as any).root.findByType('SessionGroupDragList');
        const pinnedRow2 = group2.props.rows.find((r: any) => r.key === 'server_a:sess_a');
        expect(pinnedRow2.showServerBadge).toBe(true);
    });

    it('wires pin toggling via pinnedSessionKeysV1', async () => {
        pinnedSessionKeysV1 = [];
        setPinnedSessionKeysV1.mockClear();

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const group = (tree as any).root.findByType('SessionGroupDragList');
        const row = group.props.rows.find((r: any) => r.key === 'server_a:sess_a');
        expect(typeof row.onTogglePinned).toBe('function');

        await act(async () => {
            row.onTogglePinned();
        });

        expect(setPinnedSessionKeysV1).toHaveBeenCalledTimes(1);
        expect(setPinnedSessionKeysV1).toHaveBeenCalledWith(['server_a:sess_a']);
    });

    it('wires drag reorder via sessionListGroupOrderV1', async () => {
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        setSessionListGroupOrderV1.mockClear();

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        await act(async () => {
            const group = (tree as any).root.findByType('SessionGroupDragList');
            group.props.onReorderKeys(['server_a:sess_b', 'server_a:sess_a']);
        });

        expect(setSessionListGroupOrderV1).toHaveBeenCalledTimes(1);
        expect(setSessionListGroupOrderV1).toHaveBeenCalledWith({
            [groupKey]: ['server_a:sess_b', 'server_a:sess_a'],
        });
    });

    it('does not render project headers and forces path/machine subtitles into rows', async () => {
        pinnedSessionKeysV1 = [];
        setPinnedSessionKeysV1.mockClear();
        mockAllowedServerIds = ['server_a'];

        const projectHeader = {
            type: 'header',
            title: '~/repoA',
            headerKind: 'project',
            groupKey: projectGroupKey,
            serverId: 'server_a',
            serverName: 'Server A',
        };

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
            projectHeader,
            { type: 'session', session: sess1, groupKey: projectGroupKey, groupKind: 'project', variant: 'no-path', serverId: 'server_a', serverName: 'Server A' },
            { type: 'session', session: sess2, groupKey: projectGroupKey, groupKind: 'project', variant: 'no-path', serverId: 'server_a', serverName: 'Server A' },
        ];

        const { SessionsList } = await import('./SessionsList');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionsList />);
        });

        const textNodes = (tree as any).root.findAllByType('Text');
        const textChildren = textNodes.map((n: any) => n.props.children);
        expect(textChildren).toContain('~/repoA');

        const group = (tree as any).root.findByType('SessionGroupDragList');
        const row1 = group.props.rows.find((r: any) => r.key === 'server_a:sess_p1');
        expect(row1.variant).toBe('no-path');
        expect(row1.subtitle ?? null).toBe(null);
    });
});
