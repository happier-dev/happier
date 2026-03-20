import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (input: any) =>
            typeof input === 'function'
                ? input({
                    colors: {
                        surface: '#fff',
                        surfaceSelected: '#eee',
                        divider: '#ddd',
                        text: '#111',
                        textSecondary: '#666',
                        textLink: '#07f',
                        input: { background: '#f0f0f0' },
                        groupped: { background: '#f7f7f7' },
                        status: { error: '#f00' },
                        button: { primary: { tint: '#fff' } },
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
        Platform: { ...stub.Platform, OS: 'web' },
    };
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/sessions/pendingBadge', () => ({
    formatPendingCountBadge: () => null,
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));

vi.mock('@/utils/errors/errors', () => ({
    HappyError: class HappyError extends Error {},
}));

vi.mock('@/utils/time/formatShortRelativeTime', () => ({
    formatShortRelativeTime: () => '1m',
}));

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
    sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
    sessionRename: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), prompt: vi.fn() },
}));

vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => mockSessionStatus,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useHasUnreadMessages: () => mockHasUnreadMessages,
    useProfile: () => ({ id: 'u1' }),
    useSession: () => null,
    useSessionListMeaningfulActivityAt: () => 60_000,
}));

let mockHasUnreadMessages = false;
let mockSessionStatus = {
    state: 'thinking',
    isConnected: true,
    statusText: 'Working on it',
    shouldShowStatus: true,
    statusColor: '#07f',
    statusDotColor: '#0f0',
    isPulsing: false,
};

function createSession(id: string) {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    } as any;
}

function findRowPressable(tree: renderer.ReactTestRenderer) {
    const pressables = tree.root.findAllByType('Pressable');
    const row = pressables.find((candidate) => !candidate.props.accessibilityLabel);
    if (!row) throw new Error('Row Pressable not found');
    return row;
}

function triggerHoverEnter(node: renderer.ReactTestInstance) {
    node.props.onMouseEnter?.();
    node.props.onHoverIn?.();
    node.props.onPointerEnter?.();
}

describe('SessionItem activity time', () => {
    it('renders the meaningful activity timestamp instead of the raw session updatedAt', async () => {
        const { SessionItem } = await import('./SessionItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={createSession('sess_1')}
                    serverId="server_a"
                    pinned={false}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />,
            );
        });

        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === '1m')).toBe(true);
    });

    it('renders a tiny status line in very compact mode when the session has a meaningful active state', async () => {
        mockSessionStatus = {
            state: 'thinking',
            isConnected: true,
            statusText: 'Working on it',
            shouldShowStatus: true,
            statusColor: '#07f',
            statusDotColor: '#0f0',
            isPulsing: true,
        };

        const { SessionItem } = await import('./SessionItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={createSession('sess_compact_active')}
                    serverId="server_a"
                    pinned={false}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={true}
                    compactMinimal={true}
                />,
            );
        });

        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'Working on it')).toBe(true);
    });

    it('does not render a subtitle in very compact mode for quiet online sessions', async () => {
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };

        const { SessionItem } = await import('./SessionItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={createSession('sess_compact_quiet')}
                    serverId="server_a"
                    pinned={false}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={true}
                    compactMinimal={true}
                />,
            );
        });

        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((node) => node.props.children === 'online')).toBe(false);
    });

    it('keeps the selected row background when a session is selected', async () => {
        mockHasUnreadMessages = false;
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };

        const { SessionItem } = await import('./SessionItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={createSession('sess_selected')}
                    serverId="server_a"
                    pinned={false}
                    selected={true}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />,
            );
        });

        const rowPressable = tree!.root.findAllByType('Pressable')[0]!;
        const flattenedStyle = (rowPressable.props.style as any[]).filter(Boolean);
        expect(flattenedStyle.some((entry) => entry?.backgroundColor === '#eee')).toBe(true);
    });

    it('keeps the unread marker and the status dot in very compact rows', async () => {
        mockHasUnreadMessages = true;
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };

        const { SessionItem } = await import('./SessionItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={createSession('sess_unread_minimal')}
                    serverId="server_a"
                    pinned={false}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={true}
                    compactMinimal={true}
                />,
            );
        });

        const unreadDots = tree!.root.findAll(
            (node) => String(node.type) === 'View' && node.props.style?.backgroundColor === '#07f',
        );
        const statusDots = tree!.root.findAllByType('StatusDot');

        expect(unreadDots.length).toBeGreaterThan(0);
        expect(statusDots.length).toBeGreaterThan(0);
    });

    it('does not expose the mutation menu for viewers without session mutation access', async () => {
        mockHasUnreadMessages = false;
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };

        const { SessionItem } = await import('./SessionItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={{ ...createSession('sess_viewer'), owner: 'someone-else', accessLevel: 'viewer', active: false, presence: 'offline' }}
                    serverId="server_a"
                    pinned={false}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />,
            );
        });

        await act(async () => {
            triggerHoverEnter(findRowPressable(tree!));
        });

        const dropdowns = tree!.root.findAllByType('DropdownMenu');
        expect(dropdowns).toHaveLength(0);
    });

    it('keeps rename available in the mutation menu for owned sessions', async () => {
        mockHasUnreadMessages = false;
        mockSessionStatus = {
            state: 'waiting',
            isConnected: true,
            statusText: 'online',
            shouldShowStatus: false,
            statusColor: '#34C759',
            statusDotColor: '#34C759',
            isPulsing: false,
        };

        const { SessionItem } = await import('./SessionItem');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={{ ...createSession('sess_owned'), owner: 'u1', accessLevel: 'viewer', active: false, presence: 'offline' }}
                    serverId="server_a"
                    pinned={false}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />,
            );
        });

        await act(async () => {
            triggerHoverEnter(findRowPressable(tree!));
        });

        const dropdowns = tree!.root.findAllByType('DropdownMenu');
        expect(dropdowns).toHaveLength(1);
        expect(dropdowns[0].props.items.some((item: { id: string }) => item.id === 'rename')).toBe(true);
    });
});
