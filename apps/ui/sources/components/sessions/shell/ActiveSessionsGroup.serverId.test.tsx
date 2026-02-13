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

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionAvatarId: () => 'avatar',
    formatPathRelativeToHome: (value: string) => value,
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
        state: 'waiting',
    }),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    CompactSourceControlStatus: 'CompactSourceControlStatus',
    ProjectSourceControlStatus: 'ProjectSourceControlStatus',
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

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: vi.fn(async () => ({ success: true, sessionId: 'sess_new' })),
    sessionArchive: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => [{
        id: 'machine_1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            displayName: 'Machine',
            host: 'machine.local',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    }],
    useHasUnreadMessages: () => false,
    useSetting: () => false,
    storage: {
        getState: () => ({
            sessionsMap: {},
        }),
    },
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('ActiveSessionsGroup navigation', () => {
    it('passes serverId when navigating from a scoped active session row', async () => {
        navigateSpy.mockClear();
        const { ActiveSessionsGroup } = await import('./ActiveSessionsGroup');

        const session = {
            id: 'sess_1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: {
                path: '/tmp/project',
                machineId: 'machine_1',
                homeDir: '/tmp',
            },
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
                React.createElement(ActiveSessionsGroup as any, {
                    sessions: [session],
                    serverId: 'server_a',
                }),
            );
        });

        expect(tree).not.toBeNull();
        const pressables = (tree as any).root.findAllByType('Pressable');
        const sessionPressable = pressables.find((node: any) => typeof node.props?.onPress === 'function');
        expect(sessionPressable).toBeDefined();

        await act(async () => {
            sessionPressable.props.onPress();
        });

        expect(navigateSpy).toHaveBeenCalledTimes(1);
        expect(navigateSpy).toHaveBeenCalledWith('sess_1', { serverId: 'server_a' });
    });
});
