import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionRenameSpy = vi.fn(async () => ({ success: true }));
const modalPromptSpy = vi.fn(async () => 'Renamed Session');

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: any) => React.createElement('ContextMenu', props),
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    getSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
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

const navigateToSessionSpy = vi.fn();
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

let platformOs: 'ios' | 'android' = 'ios';

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOs;
                },
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
            spies: {
                prompt: modalPromptSpy,
            },
        }).module;
    },
    storage: async (_importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
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
            useSessionListRenderable: () => null,
            useSessionListMeaningfulActivityAt: () => null,
        });
    },
});

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionRename: sessionRenameSpy,
        },
    });
});

describe('SessionItem context menu press suppression', () => {
    afterEach(() => {
        standardCleanup();
        navigateToSessionSpy.mockClear();
        modalPromptSpy.mockClear();
        sessionRenameSpy.mockClear();
        platformOs = 'ios';
        vi.useRealTimers();
    });

    it('does not indefinitely suppress navigation when a native context menu is opened externally', async () => {
        vi.useFakeTimers();

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

        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        await act(async () => {
            screen.tree.update(
                <SessionItem
                    session={session}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                    nativeContextMenuOpen={true}
                    onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
                />,
            );
        });

        await act(async () => {
            vi.advanceTimersByTime(750);
        });

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_1' });
        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });

        expect(onNativeContextMenuOpenChange).toHaveBeenCalledWith(false);
        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_1', undefined);
    });

    it('disables row fallback long-press actions when native inline drag owns long-press', async () => {
        vi.useFakeTimers();

        const { SessionItem } = await import('./SessionItem');

        const session = {
            id: 'sess_2',
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

        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeInlineDragEnabled={true}
                reorderHandleGesture={{ type: 'pan' } as any}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_2' });
        expect(itemPressable.props.onLongPress).toBeUndefined();
    });

    it('adds Android ripple feedback to the session row pressable', async () => {
        platformOs = 'android';

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
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
            />,
        );

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_3' });
        expect(itemPressable.props.android_ripple).toMatchObject({
            borderless: false,
            foreground: true,
        });
    });

    it('opens the rename prompt after the native context menu close turn', async () => {
        vi.useFakeTimers();

        const { SessionItem } = await import('./SessionItem');
        const session = createSessionFixture({
            id: 'sess_rename',
            metadata: {
                name: 'Old Session',
                serverId: 'server_a',
                path: '/repo',
                host: 'devbox',
            },
        });
        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                selected={false}
                isFirst={true}
                isLast={true}
                isSingle={true}
                variant="default"
                compact={false}
                nativeContextMenuOpen={true}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
                serverId="server_a"
            />,
        );

        const contextMenu = screen.findByType('ContextMenu' as any);
        await act(async () => {
            contextMenu.props.onSelect('rename');
        });

        expect(onNativeContextMenuOpenChange).toHaveBeenCalledWith(false);
        expect(modalPromptSpy).not.toHaveBeenCalled();
        expect(sessionRenameSpy).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(0);
        });

        expect(modalPromptSpy).toHaveBeenCalled();
        expect(sessionRenameSpy).toHaveBeenCalledWith('sess_rename', 'Renamed Session', { serverId: 'server_a' });
    });
});
