import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
}));

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
const modalConfirmSpy = vi.fn(async () => true);
let hideInactiveSessions = false;

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: stopSpy,
    sessionArchiveWithServerScope: archiveSpy,
}));

const modalAlertSpy = vi.fn();

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            spies: {
                alert: modalAlertSpy,
                confirm: modalConfirmSpy,
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useHasUnreadMessages: () => false,
                useProfile: () => ({
                    id: 'u1',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServicesV2: [],
                }),
                useSession: () => null,
                useSessionListMeaningfulActivityAt: () => null,
                useSetting: (key: string) => {
                    if (key === 'hideInactiveSessions') return hideInactiveSessions;
                    return false;
                },
            },
        });
    },
});

describe('SessionItem server-scoped mutations', () => {
    afterEach(() => {
        standardCleanup();
        hideInactiveSessions = false;
    });

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

        const screen = await renderScreen(
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

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
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
        modalConfirmSpy.mockClear();

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

        const screen = await renderScreen(
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

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const actions = modalAlertSpy.mock.calls[0][2];
        await act(async () => {
            actions[1].onPress();
        });

        expect(archiveSpy).toHaveBeenCalledWith('sess_2', { serverId: 'server_b' });
        expect(stopSpy).not.toHaveBeenCalled();
    });

    it('offers to archive a stopped unpinned session when hidden inactive sessions are enabled', async () => {
        hideInactiveSessions = true;
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const { SessionItem } = await import('./SessionItem');

        const session = {
            id: 'sess_3',
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

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_c"
                serverName="Server C"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const actions = modalAlertSpy.mock.calls[0][2];
        await act(async () => {
            await actions[1].onPress();
        });

        expect(stopSpy).toHaveBeenCalledWith('sess_3', { serverId: 'server_c' });
        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(archiveSpy).toHaveBeenCalledWith('sess_3', { serverId: 'server_c' });
    });

    it('does not prompt to archive a stopped pinned session when hidden inactive sessions are enabled', async () => {
        hideInactiveSessions = true;
        archiveSpy.mockClear();
        stopSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const { SessionItem } = await import('./SessionItem');

        const session = {
            id: 'sess_4',
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

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_d"
                serverName="Server D"
                showServerBadge={true}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                pinned={true}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const actions = modalAlertSpy.mock.calls[0][2];
        await act(async () => {
            await actions[1].onPress();
        });

        expect(stopSpy).toHaveBeenCalledWith('sess_4', { serverId: 'server_d' });
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(archiveSpy).not.toHaveBeenCalled();
    });
});
