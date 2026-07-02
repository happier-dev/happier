import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createModelBackedSessionItemTestComponent } from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { SessionListSelectionProvider } from './selection/SessionListSelectionContext';
import { SESSION_ACTION_RENAME_ID } from '@/components/sessions/actions/sessionActionIds';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionRenameSpy = vi.fn(async () => ({ success: true }));
const modalPromptSpy = vi.fn(async () => 'Renamed Session');

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
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

let platformOs: 'ios' | 'android' | 'web' = 'ios';

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

async function importSessionItem() {
    const { SessionItem } = await import('./SessionItem');
    return createModelBackedSessionItemTestComponent(SessionItem);
}

function hasSelectMenuItem(items: unknown): boolean {
    if (!Array.isArray(items)) return false;
    return items.some((item: unknown) => {
        if (!item || typeof item !== 'object') return false;
        return (item as { id?: unknown }).id === 'selection.select';
    });
}

describe('SessionItem context menu press suppression', () => {
    afterEach(() => {
        standardCleanup();
        navigateToSessionSpy.mockClear();
        modalPromptSpy.mockClear();
        sessionRenameSpy.mockClear();
        platformOs = 'ios';
        vi.useRealTimers();
    });

    it('keeps native context menus closed until they are opened', async () => {
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_lazy_menu',
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
                nativeContextMenuOpen={false}
                onNativeContextMenuOpenChange={onNativeContextMenuOpenChange}
            />,
        );

        const closedMenus = screen.tree.root.findAllByType('ContextMenu' as React.ElementType);
        expect(closedMenus).toHaveLength(1);
        expect(closedMenus[0].props.open).toBe(false);

        await act(async () => {
            screen.tree.update(
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
        });

        const menus = screen.tree.root.findAllByType('ContextMenu' as React.ElementType);
        expect(menus).toHaveLength(1);
        expect(menus[0].props.open).toBe(true);
        expect(menus[0].props.items.some((item: { id?: string }) => item.id === SESSION_ACTION_RENAME_ID)).toBe(true);
    });

    it('suppresses the release press after a native context menu is opened externally', async () => {
        vi.useFakeTimers();

        const SessionItem = await importSessionItem();

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

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_1' });
        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });

        expect(onNativeContextMenuOpenChange).not.toHaveBeenCalledWith(false);
        expect(navigateToSessionSpy).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(750);
        });

        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });

        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_1', undefined);
    });

    it('delegates iOS native inline drag context-menu opening to the outer row gesture', async () => {
        vi.useFakeTimers();

        const SessionItem = await importSessionItem();

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
        expect(itemPressable.props.onPressIn).toBeUndefined();
        expect(itemPressable.props.onPressOut).toBeUndefined();
        expect(itemPressable.props.onLongPress).toBeUndefined();
        expect(onNativeContextMenuOpenChange).not.toHaveBeenCalled();
    });

    it('suppresses the post-drag row press after a web reorder-handle drag', async () => {
        vi.useFakeTimers();
        platformOs = 'web';
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_reorder_drag',
            active: true,
            metadata: null,
        });

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
                reorderHandleGesture={{ type: 'pan' } as any}
                isBeingDragged={true}
            />,
        );

        await act(async () => {
            vi.advanceTimersByTime(700);
        });

        await act(async () => {
            screen.tree.update(
                <SessionItem
                    session={session}
                    serverId="server_a"
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                    reorderHandleGesture={{ type: 'pan' } as any}
                    isBeingDragged={false}
                />,
            );
        });

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_reorder_drag' });
        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });

        expect(navigateToSessionSpy).not.toHaveBeenCalled();

        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });

        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_reorder_drag', { serverId: 'server_a' });
    });

    it('opens the iOS native context menu from a press-in timer before release', async () => {
        vi.useFakeTimers();

        const SessionItem = await importSessionItem();

        const session = {
            id: 'sess_press_in',
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

        const itemPressable = screen.findByProps({ testID: 'session-list-item-sess_press_in' });
        expect(itemPressable.props.onPressIn).toEqual(expect.any(Function));

        await act(async () => {
            itemPressable.props.onPressIn();
            vi.advanceTimersByTime(349);
        });
        expect(onNativeContextMenuOpenChange).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(onNativeContextMenuOpenChange).toHaveBeenCalledWith(true);

        await act(async () => {
            await pressTestInstanceAsync(itemPressable, 'session list item');
        });
        expect(navigateToSessionSpy).not.toHaveBeenCalled();
    });

    it('adds Android ripple feedback to the session row pressable', async () => {
        platformOs = 'android';

        const SessionItem = await importSessionItem();

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

        const SessionItem = await importSessionItem();
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
            contextMenu.props.onSelect(SESSION_ACTION_RENAME_ID);
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

    it('keeps the session identity visible on web row hover outside selection mode', async () => {
        platformOs = 'web';
        const SessionItem = await importSessionItem();
        const session = createSessionFixture({
            id: 'sess_hover',
            active: true,
            metadata: null,
        });
        const selectionKey = 'server_a:sess_hover';

        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={[selectionKey]}>
                <SessionItem
                    session={session}
                    serverId="server_a"
                    selectionKey={selectionKey}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />
            </SessionListSelectionProvider>,
        );

        expect(screen.tree.root.findAllByProps({ testID: 'session-list-selection-checkbox-sess_hover' })).toHaveLength(0);

        const hoverTarget = screen.tree.root.findAll((node) => typeof node.props?.onPointerEnter === 'function')[0];
        expect(hoverTarget).toBeDefined();
        await act(async () => {
            hoverTarget.props.onPointerEnter();
        });

        expect(screen.tree.root.findAllByProps({ testID: 'session-list-selection-checkbox-sess_hover' })).toHaveLength(0);
        expect(screen.tree.root.findAllByType('Avatar' as React.ElementType)).toHaveLength(1);
    });

    it('adds a web more-menu Select entry that enters selection mode for the row', async () => {
        platformOs = 'web';
        const SessionItem = await importSessionItem();
        const session = createSessionFixture({
            id: 'sess_web_select',
            active: true,
            metadata: null,
        });
        const selectionKey = 'server_a:sess_web_select';

        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="scope-a" visibleOrderedKeys={[selectionKey]}>
                <SessionItem
                    session={session}
                    serverId="server_a"
                    selectionKey={selectionKey}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />
            </SessionListSelectionProvider>,
        );

        const hoverTarget = screen.tree.root.findAll((node) => typeof node.props?.onPointerEnter === 'function')[0];
        expect(hoverTarget).toBeDefined();
        await act(async () => {
            hoverTarget.props.onPointerEnter();
        });

        const menus = screen.tree.root.findAllByType('DropdownMenu' as React.ElementType);
        const moreMenu = menus.find((menu) => hasSelectMenuItem(menu.props.items));
        expect(moreMenu).toBeDefined();

        await act(async () => {
            moreMenu?.props.onSelect('selection.select');
        });

        const checkbox = screen.findByProps({ testID: 'session-list-selection-checkbox-sess_web_select' });
        expect(checkbox.props.accessibilityState).toEqual({ checked: true });
    });
});
