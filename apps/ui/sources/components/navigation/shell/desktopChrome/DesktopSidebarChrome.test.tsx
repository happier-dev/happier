import React from 'react';
import { View } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { DeferredAnchoredTooltip } from '@/components/ui/overlays/DeferredAnchoredTooltip';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The header now contains account usage; keep the auth/network boundary signed out.
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => ({ credentials: null }) }));

const native = vi.hoisted(() => ({ invoke: vi.fn() }));

const itemRowActionsState = vi.hoisted(() => ({
    lastActionIds: [] as string[],
}));

installNavigationShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            View: 'View',
            Text: 'Text',
        });
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/updates/UpdatesPopoverButton', () => ({
    UpdatesEntry: (props: Record<string, unknown>) => React.createElement('UpdatesEntry', props),
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: 'ConnectionStatusControl',
}));

// Placement only: these entries own their own gating and behavior (covered by their own tests).
vi.mock('@/components/sessions/directSessions/browse/DirectSessionsBrowseButton', () => ({
    DirectSessionsBrowseButton: (props: Record<string, unknown>) => React.createElement('DirectSessionsBrowseButton', props),
}));

vi.mock('@/components/inbox/InboxPopoverButton', () => ({
    InboxPopoverButton: (props: Record<string, unknown>) => React.createElement('InboxPopoverButton', props),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: {
        actions: Array<{ id: string }>;
        leadingPinnedContent?: React.ReactNode;
        renderOverflowTrigger?: (params: {
            open: boolean;
            toggle: () => void;
            testID: string;
            accessibilityLabel: string;
            accessibilityHint: string;
        }) => React.ReactNode;
    }) => {
        itemRowActionsState.lastActionIds = props.actions.map((action) => action.id);
        return React.createElement(
            View,
            { testID: 'desktop-sidebar-item-actions' },
            props.leadingPinnedContent,
            props.renderOverflowTrigger?.({
                open: false,
                toggle: vi.fn(),
                testID: 'sidebar-header-actions-overflow',
                accessibilityLabel: 'More actions',
                accessibilityHint: 'Open more actions',
            }),
        );
    },
}));

// Keep app drag eligibility and bridge behavior real; replace only native IPC.
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
    invokeTauri: (command: string) => native.invoke(command),
    listenTauriEvent: async () => () => {},
}));

function requireTestInstance(node: ReactTestInstance | null, label: string): ReactTestInstance {
    expect(node, `${label} should be present`).toBeTruthy();
    return node!;
}

function directChildTestIDs(instance: ReactTestInstance): string[] {
    return instance.children
        .filter((child): child is ReactTestInstance => typeof child === 'object' && child != null && 'props' in child)
        .map((child) => child.props.testID)
        .filter((testID): testID is string => typeof testID === 'string');
}

describe('DesktopSidebarChrome', () => {
    beforeEach(() => {
        native.invoke.mockReset();
        native.invoke.mockImplementation(async (command: string) => {
            if (command === 'desktop_get_window_chrome_policy') return { strategy: 'custom-controls' };
            if (command === 'desktop_get_window_state') return { isMaximized: false };
            return true;
        });
        itemRowActionsState.lastActionIds = [];
    });

    it('shows each rail and overflow tooltip from its accessible name on hover, including disabled history', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        await withPopoverWebGlobals(async () => {
            const screen = await renderScreen(
                <DesktopSidebarChrome
                    headerHeightPx={56}
                    onPressHome={vi.fn()}
                    onPressBack={vi.fn()}
                    onPressForward={vi.fn()}
                    onPressCollapse={vi.fn()}
                    canNavigateBack={false}
                    environmentBadge={null}
                    headerActions={[]}
                    topUtilityActions={[{ id: 'settings', title: 'Filter sessions', inlineTestID: 'nav-settings', icon: 'sliders-horizontal', onPress: vi.fn() }]}
                    renderHeaderOverflowVisual={() => <View />}
                    popoverBoundaryRef={{ current: null }}
                    desktopWindowControls={<View />}
                />,
            );

            for (const id of ['sidebar-back-button', 'sidebar-forward-button', 'sidebar-collapse-button', 'nav-settings', 'sidebar-header-actions-overflow']) {
                const button = screen.findHostByTestId(id)!;
                await React.act(async () => { button.props.onHoverIn?.(); });
                const tooltips = screen.findAllByType(DeferredAnchoredTooltip);
                expect(tooltips, id).toHaveLength(1);
                expect(tooltips[0]!.props.label).toBe(button.props.accessibilityLabel);
                await React.act(async () => { button.props.onHoverOut?.(); });
                expect(screen.findAllByType(DeferredAnchoredTooltip)).toHaveLength(0);
            }
            await screen.unmount();
        });
    });

    it('places utility controls above the branded sidebar row', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                topUtilityActions={[{
                    id: 'settings',
                    title: 'settings.title',
                    inlineTestID: 'nav-settings',
                    icon: 'gear',
                    onPress: vi.fn(),
                }]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const chrome = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome'), 'desktop chrome');
        const controlsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-controls-row'), 'controls row');
        const contentRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-content-row'), 'content row');
        const brandGroup = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-brand-group'), 'brand group');
        const actionsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-actions-row'), 'actions row');

        expect(chrome.children[0]).toBe(controlsRow);
        expect(chrome.children[1]).toBe(contentRow);
        // The desktop top rail carries window-level utilities: back/forward lead, Updates follows them
        // ahead of the other utilities; inbox and activity live only in the sidebar's own icon row below.
        expect(directChildTestIDs(screen.findByTestId('desktop-sidebar-chrome-utility-row')!)).toEqual([
            'sidebar-back-button',
            'sidebar-forward-button',
            'desktop-sidebar-updates-button',
            'nav-settings',
            'sidebar-collapse-button',
        ]);
        expect(contentRow.children).toEqual([brandGroup, actionsRow]);
        expect(brandGroup.findByProps({ accessibilityLabel: 'common.home' })).toBeTruthy();
        // Activity renders nothing while idle, so match the mounted entry rather than painted hosts.
        const mountedIn = (root: ReactTestInstance, testID: string) =>
            root.findAll((node) => node.props?.testID === testID).length > 0;
        expect(mountedIn(actionsRow, 'desktop-sidebar-action-operations')).toBe(true);
        expect(mountedIn(controlsRow, 'desktop-sidebar-action-operations')).toBe(false);
        expect(mountedIn(actionsRow, 'desktop-sidebar-updates-button')).toBe(false);
        // The title stays whole: no entry trails it any more.
        const titleContainer = screen.findByTestId('desktop-sidebar-title-container')!;
        expect(titleContainer.findByProps({ testID: 'desktop-sidebar-title-text' })).toBeTruthy();
        expect(titleContainer.findAll((node) => node.type === ('UpdatesEntry' as never))).toHaveLength(0);
    });

    it('puts the Updates icon in the sidebar icon row when there is no desktop top rail', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const { DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX } = await import('./desktopChromeMetrics');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
            />,
        );

        const actionsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-actions-row'), 'actions row');
        const paintedIn = (testID: string) =>
            actionsRow.findAll((node) => typeof node.type === 'string' && node.props?.testID === testID);
        const updates = paintedIn('desktop-sidebar-updates-button');
        expect(updates).toHaveLength(1);
        expect(updates[0]!.props).toMatchObject({ variant: 'icon', iconSize: DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX });
        expect(actionsRow.findAll((node) => node.props?.testID === 'desktop-sidebar-action-operations').length).toBeGreaterThan(0);
    });

    it('puts the provider-session browse icon immediately left of the inbox icon', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
                inboxEnabled
                inboxSummary={{ hasContent: false }}
            />,
        );

        const actionsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-actions-row'), 'actions row');
        // Painted entries in on-screen order.
        const order = actionsRow
            .findAll((node) => typeof node.type === 'string' && typeof node.props?.testID === 'string')
            .map((node) => node.props.testID as string);
        const browseIndex = order.indexOf('sidebar-direct-browse-button');
        expect(browseIndex).toBeGreaterThanOrEqual(0);
        expect(order[browseIndex + 1]).toBe('sidebar-inbox-button');
    });

    it('starts window dragging from non-interactive sidebar top strip clicks', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const controlsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-controls-row'), 'controls row');
        const preventDefault = vi.fn();
        await controlsRow.props.onMouseDown?.({
            buttons: 1,
            preventDefault,
            target: { closest: vi.fn(() => null) },
        });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('desktop_start_window_dragging'));
    });

    it('marks unavailable browser history controls disabled without removing them', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                canNavigateBack={false}
                canNavigateForward={true}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const backButton = requireTestInstance(screen.findByTestId('sidebar-back-button'), 'back button');
        const forwardButton = requireTestInstance(screen.findByTestId('sidebar-forward-button'), 'forward button');

        expect(backButton.props.disabled).toBe(true);
        expect(backButton.props.accessibilityState).toEqual({ disabled: true });
        expect(forwardButton.props.disabled).toBe(false);
        expect(forwardButton.props.accessibilityState).toEqual({ disabled: false });
    });

    it('keeps top utility actions out of the content action row when window controls are active', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[
                    { id: 'inbox', title: 'Inbox', inlineTestID: 'sidebar-inbox-button', icon: 'envelope', onPress: vi.fn() },
                    { id: 'settings', title: 'Settings', inlineTestID: 'nav-settings', icon: 'gear', onPress: vi.fn() },
                    { id: 'newSession', title: 'New', inlineTestID: 'nav-new-session', icon: 'plus', onPress: vi.fn() },
                ]}
                topUtilityActions={[
                    { id: 'inbox', title: 'Inbox', inlineTestID: 'sidebar-inbox-button', icon: 'envelope', onPress: vi.fn() },
                    { id: 'settings', title: 'Settings', inlineTestID: 'nav-settings', icon: 'gear', onPress: vi.fn() },
                ]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        expect(itemRowActionsState.lastActionIds).toEqual(['newSession']);
    });

    // This strip sits beside the traffic lights, which are 12px. Every glyph in it moved to the app's
    // default 20 during the icon-family migration — a 33-54% jump on controls that had been measured
    // at 13-18 — and at 20 they exactly filled their 20px buttons, so the row had no air in it at all.
    it('draws the whole top strip at one compact chrome size', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const { DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX } = await import('./desktopChromeMetrics');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                topUtilityActions={[{
                    id: 'settings',
                    title: 'settings.title',
                    inlineTestID: 'nav-settings',
                    icon: 'sliders-horizontal',
                    onPress: vi.fn(),
                }]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const utilityRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-utility-row'), 'utility row');
        const sizes = utilityRow.findAll((node) => node.type === ('Icon' as never)).map((icon) => icon.props.size);

        expect(sizes.length).toBeGreaterThanOrEqual(4);
        expect(new Set(sizes).size, 'the strip should read as one size').toBe(1);
        expect(sizes[0]).toBeLessThan(DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX);
    });

    // The expanded chrome is the sidebar's OPEN state, so its button collapses. It reached that
    // drawing through a `scaleX: -1` on a wrapper View, which flipped the resolved glyph into the
    // opposite edge's — the icon seam said one thing and the screen showed another.
    it('shows the collapse glyph unflipped in the expanded chrome', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const collapseButton = requireTestInstance(screen.findByTestId('sidebar-collapse-button'), 'collapse button');
        expect(collapseButton.findByType('Icon' as never).props.name).toBe('sidebar-left-close');

        const flipped = collapseButton.findAll((node) => {
            const transform = (node.props?.style as { transform?: Array<Record<string, number>> } | undefined)?.transform;
            return Array.isArray(transform) && transform.some((step) => step.scaleX === -1);
        });
        expect(flipped, 'nothing should mirror the glyph the seam already chose').toHaveLength(0);
    });
});
