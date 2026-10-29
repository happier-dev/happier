import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const collapsedSidebarState = vi.hoisted(() => ({
    setSidebarCollapsed: vi.fn(),
}));

const inboxState = vi.hoisted(() => ({
    model: { hasContent: true },
}));

const native = vi.hoisted(() => ({ invoke: vi.fn() }));

installNavigationShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useLocalSettingMutable: (key: string) => {
                if (key === 'sidebarCollapsed') {
                    return [true, collapsedSidebarState.setSidebarCollapsed] as const;
                }
                return [null, vi.fn()] as const;
            },
        });
    },
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));

vi.mock('@/components/inbox/InboxPopoverButton', () => ({
    InboxPopoverButton: (props: Record<string, unknown>) => React.createElement('InboxPopoverButton', props),
}));

vi.mock('@/components/updates/UpdatesPopoverButton', () => ({
    UpdatesEntry: (props: Record<string, unknown>) => React.createElement('UpdatesEntry', props),
}));

vi.mock('@/components/inbox/actionOperations/ActionOperationActivityButton', () => ({
    ActionOperationActivityButton: (props: Record<string, unknown>) => React.createElement('ActionOperationActivityButton', props),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 56,
}));

// Keep the bridge and shared policy observer real; replace only native IPC.
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
    invokeTauri: (command: string) => native.invoke(command),
    listenTauriEvent: async () => () => {},
}));

describe('CollapsedSidebarView desktop chrome', () => {
    beforeEach(() => {
        collapsedSidebarState.setSidebarCollapsed.mockReset();
        native.invoke.mockReset();
        native.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_get_window_chrome_policy') return { strategy: 'custom-controls' };
            if (command === 'desktop_get_window_state') return { isMaximized: false };
            return true;
        });
    });

    it('renders collapsed desktop chrome hosts and expands the sidebar', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView
                desktopWindowControls={<View testID="injected-collapsed-window-controls" />}
            />,
        );

        expect(screen.findByTestId('desktop-collapsed-shell-chrome')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-host')).toBeTruthy();
        expect(screen.findByTestId('injected-collapsed-window-controls')).toBeTruthy();
        // The logo stays; Updates is its own rail entry (R13 (e)), never a replacement for the logo.
        expect(screen.findAllByTestId('collapsed-sidebar-home-button').length).toBeGreaterThan(0);
        expect(screen.findByTestId('collapsed-sidebar-updates-button')?.props.variant).toBe('icon');

        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('sidebar-expand-button'));
        });

        expect(collapsedSidebarState.setSidebarCollapsed).toHaveBeenCalledWith(false);
    });

    it('exits focus mode through the expand affordance without changing persisted collapse state directly', async () => {
        const onRequestExpand = vi.fn();
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView
                focusModeActive={true}
                onRequestExpand={onRequestExpand}
            />,
        );

        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('sidebar-expand-button'));
        });

        expect(onRequestExpand).toHaveBeenCalledTimes(1);
        expect(collapsedSidebarState.setSidebarCollapsed).not.toHaveBeenCalled();
    });

    it('gives the collapsed expand affordance a translated accessible name', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(<CollapsedSidebarView />);

        expect(screen.findByTestId('sidebar-expand-button')?.props.accessibilityLabel).toBe('common.expand');
    });

    it('renders both Inbox and Activity in the collapsed rail when Inbox is available', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView inboxEnabled inboxSummary={inboxState.model as never} />,
        );

        const inboxButton = screen.findByType('InboxPopoverButton' as never);
        expect(inboxButton.props).toMatchObject({
            summary: inboxState.model,
            testID: 'collapsed-sidebar-inbox-button',
        });
        expect(screen.findByTestId('collapsed-sidebar-action-operations')).toBeTruthy();
    });

    it('keeps action operations as the fallback when Inbox is unavailable', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView inboxEnabled={false} inboxSummary={inboxState.model as never} />,
        );

        expect(screen.findAllByType('InboxPopoverButton' as never)).toHaveLength(0);
        expect(screen.findByTestId('collapsed-sidebar-action-operations')).toBeTruthy();
    });

    // The rail is the sidebar's CLOSED state, so its button opens rather than closes. It used to
    // render the collapse glyph anyway — the same drawing the expanded chrome shows — so the control
    // looked identical whichever state you were in.
    it('shows the expand glyph on the rail, not the collapse one', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(<CollapsedSidebarView />);

        const expandButton = screen.findByTestId('sidebar-expand-button');
        expect(expandButton?.findByType('Icon' as never).props.name).toBe('sidebar-left-open');
    });
});
