import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
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

const navigateToSessionSpy = vi.fn();
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

const modalPromptSpy = vi.fn(async () => null as string | null);
const sessionRenameSpy = vi.fn(async () => ({ success: true }));

function hasRenameMenuItem(items: unknown): boolean {
    if (!Array.isArray(items)) return false;
    return items.some((item: unknown) => {
        if (!item || typeof item !== 'object') return false;
        return (item as { id?: unknown }).id === 'rename';
    });
}

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionRename: sessionRenameSpy,
        },
    });
});

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

describe('SessionItem context menu press suppression', () => {
    afterEach(() => {
        standardCleanup();
        navigateToSessionSpy.mockClear();
        modalPromptSpy.mockReset();
        modalPromptSpy.mockResolvedValue(null);
        sessionRenameSpy.mockReset();
        sessionRenameSpy.mockResolvedValue({ success: true });
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

    it('keeps row long-press actions enabled when reorder is handle-scoped on native', async () => {
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
        expect(typeof itemPressable.props.onLongPress).toBe('function');

        await act(async () => {
            itemPressable.props.onLongPress?.();
        });

        expect(onNativeContextMenuOpenChange).toHaveBeenCalledWith(true);
    });

    it('disables row long-press actions on Android while the hotfix is active', async () => {
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
                nativeInlineDragEnabled={false}
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_3' });
        expect(itemPressable.props.onLongPress).toBeUndefined();
    });

    it('opens the rename prompt after the native context menu close turn', async () => {
        vi.useFakeTimers();
        modalPromptSpy.mockResolvedValueOnce('Renamed Session');

        const { SessionItem } = await import('./SessionItem');

        const session = createSessionFixture({
            id: 'sess_rename',
            active: true,
            metadata: null,
        });

        const onNativeContextMenuOpenChange = vi.fn();

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
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

        const contextMenu = screen.findByType('DropdownMenu' as React.ElementType);
        expect(hasRenameMenuItem(contextMenu.props.items)).toBe(true);

        await act(async () => {
            contextMenu.props.onSelect('rename');
        });

        expect(onNativeContextMenuOpenChange).toHaveBeenCalledWith(false);
        expect(modalPromptSpy).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(0);
            await Promise.resolve();
        });

        expect(modalPromptSpy).toHaveBeenCalledTimes(1);
        expect(sessionRenameSpy).toHaveBeenCalledWith('sess_rename', 'Renamed Session', { serverId: 'server_a' });
    });
});
