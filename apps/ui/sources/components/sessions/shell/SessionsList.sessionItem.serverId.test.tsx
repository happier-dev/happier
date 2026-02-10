import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const navigateSpy = vi.fn();

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

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
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
    useNavigateToSession: () => navigateSpy,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));

vi.mock('@/sync/ops', () => ({
    sessionDelete: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useHasUnreadMessages: () => false,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

describe('SessionItem navigation', () => {
    it('passes serverId when navigating to a session', async () => {
        navigateSpy.mockClear();

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
                />,
            );
        });

        expect(tree).not.toBeNull();
        const pressable = (tree as any).root.findByType('Pressable');
        await act(async () => {
            pressable.props.onPress();
        });

        expect(navigateSpy).toHaveBeenCalledTimes(1);
        expect(navigateSpy).toHaveBeenCalledWith('sess_1', { serverId: 'server_a' });
    });
});
