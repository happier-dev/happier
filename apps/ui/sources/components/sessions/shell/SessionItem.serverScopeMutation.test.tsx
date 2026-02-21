import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
}));

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'ios' },
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
    useHappyAction: (fn: any) => [false, fn],
}));

const stopSpy = vi.fn(async () => ({ success: true }));
const archiveSpy = vi.fn(async () => ({ success: true, archivedAt: 1 }));

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: stopSpy,
    sessionArchiveWithServerScope: archiveSpy,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useHasUnreadMessages: () => false,
    useProfile: () => ({ id: 'u1' }),
}));

const modalAlertSpy = vi.fn();
vi.mock('@/modal', () => ({
    Modal: { alert: modalAlertSpy },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('SessionItem server-scoped mutations', () => {
    it('stops active sessions using server scope when serverId is provided', async () => {
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();

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

        const swipeable = (tree as any).root.findByType('Swipeable');
        await act(async () => {
            swipeable.props.renderRightActions().props.onPress();
        });

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const actions = modalAlertSpy.mock.calls[0][2];
        await act(async () => {
            actions[1].onPress();
        });

        expect(stopSpy).toHaveBeenCalledWith('sess_1', { serverId: 'server_a' });
        expect(archiveSpy).not.toHaveBeenCalled();
    });

    it('archives inactive sessions using server scope when serverId is provided', async () => {
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();

        const { SessionItem } = await import('./SessionItem');

        const session = {
            id: 'sess_2',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={session}
                    serverId="server_b"
                    serverName="Server B"
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

        const swipeable = (tree as any).root.findByType('Swipeable');
        await act(async () => {
            swipeable.props.renderRightActions().props.onPress();
        });

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const actions = modalAlertSpy.mock.calls[0][2];
        await act(async () => {
            actions[1].onPress();
        });

        expect(archiveSpy).toHaveBeenCalledWith('sess_2', { serverId: 'server_b' });
        expect(stopSpy).not.toHaveBeenCalled();
    });
});
