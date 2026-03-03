import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
    };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
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

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
    sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useHasUnreadMessages: () => false,
    useProfile: () => ({ id: 'u1' }),
    useSession: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

describe('SessionItem reorder handle', () => {
    it('renders a reorder handle that calls onRequestReorder when pressed', async () => {
        const onRequestReorder = vi.fn();
        const stopPropagation = vi.fn();
        const { SessionItem } = await import('./SessionItem');

        const session = {
            id: 'sess_1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={session}
                    serverId="server_a"
                    serverName="Server A"
                    showServerBadge={true}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                    onRequestReorder={onRequestReorder}
                />,
            );
        });

        const handles = (tree as any).root
            .findAllByType('Pressable')
            .filter((n: any) => n?.props?.testID === 'session-item-reorder-handle');
        expect(handles).toHaveLength(1);

        await act(async () => {
            handles[0].props.onPressIn({ stopPropagation });
            handles[0].props.onPress({ stopPropagation });
        });
        expect(stopPropagation).toHaveBeenCalledTimes(2);
        expect(onRequestReorder).toHaveBeenCalledTimes(1);
    });
});
