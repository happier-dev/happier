import React from 'react';
import { View } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const desktopWindowBridgeState = vi.hoisted(() => ({
    startDesktopWindowDragging: vi.fn(),
}));

const itemRowActionsState = vi.hoisted(() => ({
    lastActionIds: [] as string[],
    lastActionControlSizePx: null as number | null,
    overflowOpen: false,
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

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            dark: false,
            colors: {
                header: { tint: '#111' },
                groupped: { background: '#fff' },
                divider: '#ddd',
                surface: '#fff',
                text: '#111',
                textSecondary: '#777',
                button: { primary: { tint: '#fff' } },
                status: { error: '#f00' },
            },
        },
    });
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/ui/media/SafeExpoImage', () => ({
    SafeExpoImage: 'SafeExpoImage',
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: 'ConnectionStatusControl',
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: {
        actions: Array<{ id: string }>;
        actionControlSizePx?: number;
        renderOverflowTrigger?: (params: {
            open: boolean;
            toggle: () => void;
            testID: string;
            accessibilityLabel: string;
            accessibilityHint: string;
        }) => React.ReactNode;
    }) => {
        itemRowActionsState.lastActionIds = props.actions.map((action) => action.id);
        itemRowActionsState.lastActionControlSizePx = props.actionControlSizePx ?? null;
        return React.createElement(
            View,
            { testID: 'desktop-sidebar-item-actions' },
            props.renderOverflowTrigger?.({
                open: itemRowActionsState.overflowOpen,
                toggle: vi.fn(),
                testID: 'sidebar-header-actions-overflow',
                accessibilityLabel: 'More actions',
                accessibilityHint: 'Open more actions',
            }),
        );
    },
}));

vi.mock('@/utils/platform/desktopWindowBridge', () => ({
    startDesktopWindowDragging: () => desktopWindowBridgeState.startDesktopWindowDragging(),
}));

function requireTestInstance(node: ReactTestInstance | null, label: string): ReactTestInstance {
    expect(node, `${label} should be present`).toBeTruthy();
    return node!;
}

function mergeStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function styleListHasExplicitFallbackDimensions(style: unknown, dimensions: Readonly<{ width: number; height: number }>): boolean {
    if (!Array.isArray(style)) return false;
    return style.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const record = item as Record<string, unknown>;
        return record.width === dimensions.width && record.height === dimensions.height;
    });
}

function directChildTestIDs(instance: ReactTestInstance): string[] {
    return instance.children
        .filter((child): child is ReactTestInstance => typeof child === 'object' && child != null && 'props' in child)
        .map((child) => child.props.testID)
        .filter((testID): testID is string => typeof testID === 'string');
}

describe('DesktopSidebarChrome', () => {
    beforeEach(() => {
        desktopWindowBridgeState.startDesktopWindowDragging.mockReset();
        itemRowActionsState.lastActionIds = [];
        itemRowActionsState.lastActionControlSizePx = null;
        itemRowActionsState.overflowOpen = false;
    });

    // The header cluster owns the sidebar's density, not the inline-row default: at that default
    // every control became a 44px box and four of them spread across the whole sidebar width.
    it('draws the header action cluster at the sidebar chrome control size', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const { DESKTOP_SIDEBAR_CHROME_ACTION_CONTROL_SIZE_PX } = await import('./desktopChromeMetrics');
        await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[
                    { id: 'projects', title: 'Projects', icon: 'folder', onPress: vi.fn() },
                    { id: 'settings', title: 'Settings', icon: 'gear', onPress: vi.fn() },
                    { id: 'newSession', title: 'New session', icon: 'plus', onPress: vi.fn() },
                ]}
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
            />,
        );

        expect(itemRowActionsState.lastActionControlSizePx).toBe(DESKTOP_SIDEBAR_CHROME_ACTION_CONTROL_SIZE_PX);
    }, 120_000);

    it('places the branded sidebar row below the desktop window controls row', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const sidebarProps = {
            sidebarWidthPx: 600,
            headerHeightPx: 56,
            onPressHome: vi.fn(),
            onPressCollapse: vi.fn(),
            onPressBack: vi.fn(),
            onPressForward: vi.fn(),
            environmentBadge: null,
            headerActions: [],
            topUtilityActions: [{
                id: 'settings',
                title: 'settings.title',
                inlineTestID: 'nav-settings',
                icon: 'gear',
                onPress: vi.fn(),
            }],
            renderHeaderOverflowVisual: () => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' }),
            popoverBoundaryRef: { current: null },
            desktopWindowControls: <View testID="injected-desktop-window-controls" />,
            desktopUpdateIndicator: <View testID="injected-desktop-update-indicator" />,
        } as React.ComponentProps<typeof DesktopSidebarChrome> & {
            onPressCollapse: () => void;
            onPressBack: () => void;
            onPressForward: () => void;
        };
        const screen = await renderScreen(
            <DesktopSidebarChrome {...sidebarProps} />,
        );

        const chrome = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome'), 'desktop chrome');
        const controlsRow = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-controls-row'),
            'desktop controls row',
        );
        const contentRow = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-content-row'),
            'desktop content row',
        );
        const brandGroup = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-brand-group'),
            'desktop brand group',
        );
        const actionsRow = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-actions-row'),
            'desktop actions row',
        );

        expect(chrome.children[0]).toBe(controlsRow);
        expect(chrome.children[1]).toBe(contentRow);
        expect(controlsRow.children).not.toContain(actionsRow);
        expect(contentRow.children).toEqual([brandGroup, actionsRow]);
        expect(brandGroup.findByProps({ accessibilityLabel: 'common.home' })).toBeTruthy();
        expect(brandGroup.findByType('ConnectionStatusControl' as any)).toBeTruthy();
        expect(screen.findByTestId('sidebar-collapse-button')).toBeTruthy();
        expect(screen.findByTestId('sidebar-back-button')).toBeTruthy();
        expect(screen.findByTestId('sidebar-forward-button')).toBeTruthy();
        expect(screen.findByTestId('nav-settings')).toBeTruthy();
        expect(actionsRow.findAll((child) => child.props?.testID === 'desktop-update-indicator-host')).toHaveLength(0);
        expect(screen.findByTestId('desktop-sidebar-title-container')!.findByProps({ testID: 'injected-desktop-update-indicator' })).toBeTruthy();
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
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const controlsRow = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-controls-row'),
            'desktop controls row',
        );
        const preventDefault = vi.fn();
        controlsRow.props.onMouseDown?.({
            buttons: 1,
            preventDefault,
            target: { closest: vi.fn(() => null) },
        });

        expect(controlsRow.props['data-tauri-drag-region']).toBe(true);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(desktopWindowBridgeState.startDesktopWindowDragging).toHaveBeenCalledTimes(1);
    });

    it('does not start window dragging from interactive top strip controls', async () => {
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
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const controlsRow = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-controls-row'),
            'desktop controls row',
        );
        controlsRow.props.onMouseDown?.({
            buttons: 1,
            preventDefault: vi.fn(),
            target: { closest: vi.fn(() => ({ role: 'button' })) },
        });

        expect(desktopWindowBridgeState.startDesktopWindowDragging).toHaveBeenCalledTimes(0);
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
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
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

    it('keeps the brand identity visible in the compact content row', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const sidebarProps = {
            sidebarWidthPx: 600,
            headerHeightPx: 56,
            onPressHome: vi.fn(),
            onPressCollapse: vi.fn(),
            environmentBadge: null,
            headerActions: [],
            renderHeaderOverflowVisual: () => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' }),
            popoverBoundaryRef: { current: null },
            desktopWindowControls: <View testID="injected-desktop-window-controls" />,
        } as React.ComponentProps<typeof DesktopSidebarChrome> & {
            onPressCollapse: () => void;
        };

        const screen = await renderScreen(<DesktopSidebarChrome {...sidebarProps} />);

        const contentRow = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-content-row'),
            'desktop content row',
        );
        const mergedStyle = Array.isArray(contentRow.props.style)
            ? Object.assign({}, ...contentRow.props.style.filter(Boolean))
            : contentRow.props.style;

        expect(mergedStyle.minHeight).toBeLessThan(56);
        const logo = requireTestInstance(screen.findByTestId('desktop-sidebar-logo'), 'desktop sidebar logo');
        expect(logo.type).toBe('SafeExpoImage');
        expect(styleListHasExplicitFallbackDimensions(logo.props.style, { width: 24, height: 24 })).toBe(true);
        const title = requireTestInstance(screen.findByTestId('desktop-sidebar-title-text'), 'desktop sidebar title');
        expect(title.children).toContain('sidebar.sessionsTitle');
        const brandButton = requireTestInstance(screen.findByTestId('desktop-sidebar-brand-button'), 'desktop sidebar brand button');
        expect(mergeStyle(brandButton.props.style).flexShrink).toBe(0);
        const titleContainer = requireTestInstance(
            screen.findByTestId('desktop-sidebar-title-container'),
            'desktop sidebar title container',
        );
        const brandGroup = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-brand-group'),
            'desktop brand group',
        );
        expect(directChildTestIDs(brandGroup).slice(0, 2)).toEqual([
            brandButton.props.testID,
            titleContainer.props.testID,
        ]);
    });

    it('uses the update indicator in the title slot when one is available', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
                desktopUpdateIndicator={<View testID="injected-desktop-update-indicator" />}
            />,
        );

        const titleContainer = requireTestInstance(
            screen.findByTestId('desktop-sidebar-title-container'),
            'desktop sidebar title container',
        );

        expect(titleContainer.findByProps({ testID: 'injected-desktop-update-indicator' })).toBeTruthy();
        expect(screen.findAllByTestId('desktop-update-indicator-host')).toHaveLength(0);
    });

    it('keeps top utility controls compact, right-aligned, and optically tiered', async () => {
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
                headerActions={[
                    { id: 'projects', title: 'Projects', icon: 'folder', onPress: vi.fn() },
                    { id: 'settings', title: 'Settings', icon: 'gear', onPress: vi.fn() },
                    { id: 'newSession', title: 'New session', icon: 'plus', onPress: vi.fn() },
                ]}
                topUtilityActions={[
                    {
                        id: 'inbox',
                        title: 'Inbox',
                        inlineTestID: 'sidebar-inbox-button',
                        icon: React.createElement('InboxIcon'),
                        onPress: vi.fn(),
                    },
                    {
                        id: 'settings',
                        title: 'Settings',
                        inlineTestID: 'nav-settings',
                        icon: 'gear',
                        onPress: vi.fn(),
                    },
                ]}
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const chrome = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome'), 'desktop chrome');
        const collapseButton = requireTestInstance(screen.findByTestId('sidebar-collapse-button'), 'collapse top utility button');
        const backButton = requireTestInstance(screen.findByTestId('sidebar-back-button'), 'back top utility button');
        const forwardButton = requireTestInstance(screen.findByTestId('sidebar-forward-button'), 'forward top utility button');
        const inboxButton = requireTestInstance(screen.findByTestId('sidebar-inbox-button'), 'inbox top utility button');
        const settingsButton = requireTestInstance(screen.findByTestId('nav-settings'), 'settings top utility button');
        const controlsHost = requireTestInstance(
            screen.findByTestId('desktop-window-controls-host'),
            'desktop window controls host',
        );
        const utilityRow = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-utility-row'),
            'desktop utility row',
        );
        const chromeStyle = mergeStyle(chrome.props.style);
        const collapseButtonStyle = mergeStyle(collapseButton.props.style);
        const backButtonStyle = mergeStyle(backButton.props.style);
        const forwardButtonStyle = mergeStyle(forwardButton.props.style);
        const settingsButtonStyle = mergeStyle(settingsButton.props.style);

        expect(mergeStyle(controlsHost.props.style).minWidth).toBeLessThanOrEqual(68);
        expect(chromeStyle.paddingTop).toBeLessThanOrEqual(2);
        expect(mergeStyle(utilityRow.props.style).marginLeft).toBe('auto');
        expect(collapseButtonStyle.width as number).toBeLessThan(settingsButtonStyle.width as number);
        expect(backButtonStyle.width).toBe(collapseButtonStyle.width);
        expect(forwardButtonStyle.width).toBe(collapseButtonStyle.width);
        expect(settingsButtonStyle.width).toBe(24);
        expect(settingsButtonStyle.height).toBe(24);
        expect(collapseButtonStyle.opacity as number).toBeLessThan(1);
        expect(settingsButtonStyle.opacity as number).toBeLessThan(1);
        expect(itemRowActionsState.lastActionIds).toEqual(['projects', 'newSession']);

        const orderedTopControlIds = requireTestInstance(
            screen.findByTestId('desktop-sidebar-chrome-utility-row'),
            'desktop utility row',
        ).children
            .filter((child): child is ReactTestInstance => typeof child === 'object' && child !== null && 'props' in (child as any))
            .map((child) => child.props?.testID)
            .filter(Boolean);
        expect(orderedTopControlIds).toEqual([
            'sidebar-back-button',
            'sidebar-forward-button',
            'sidebar-inbox-button',
            'nav-settings',
            'sidebar-collapse-button',
        ]);
        expect(collapseButtonStyle.width).toBe(backButtonStyle.width);
        expect(inboxButton.props.style).toBeTruthy();
    });

    it('does not keep an empty top row when no desktop window controls are active', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
                desktopUpdateIndicator={<View testID="injected-desktop-update-indicator" />}
            />,
        );

        expect(screen.findAllByTestId('desktop-sidebar-chrome-controls-row')).toHaveLength(0);
        expect(screen.findByTestId('desktop-sidebar-chrome-content-row')).toBeTruthy();
    });

    it('hides the overflow trigger from interaction and accessibility while the menu is open', async () => {
        itemRowActionsState.overflowOpen = true;
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[{ id: 'settings', title: 'Settings', icon: 'gear', onPress: vi.fn() }]}
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
            />,
        );

        const overflowTrigger = requireTestInstance(
            screen.findByTestId('sidebar-header-actions-overflow'),
            'overflow trigger',
        );

        expect(overflowTrigger.props.onPress).toBeUndefined();
        expect(overflowTrigger.props.accessibilityElementsHidden).toBe(true);
        expect(overflowTrigger.props.importantForAccessibility).toBe('no-hide-descendants');
        expect(overflowTrigger.props.accessibilityState).toEqual({ expanded: true, disabled: true });
    }, 120_000);

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
                    title: 'Settings',
                    inlineTestID: 'nav-settings',
                    icon: 'sliders-horizontal',
                    onPress: vi.fn(),
                }]}
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const utilityRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-utility-row'), 'utility row');
        const sizes = utilityRow.findAll((node) => node.type === ('Icon' as never)).map((icon) => icon.props.size);

        expect(sizes.length).toBeGreaterThanOrEqual(4);
        expect(new Set(sizes).size, 'the strip should read as one size').toBe(1);
        expect(sizes[0]).toBeLessThan(DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX);
    }, 120_000);

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
                renderHeaderOverflowVisual={() => React.createElement(View, { testID: 'desktop-sidebar-overflow-visual' })}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const collapseButton = requireTestInstance(screen.findByTestId('sidebar-collapse-button'), 'collapse button');
        expect(collapseButton.findByType('Icon' as never).props.name).toBe('sidebar-left-close');

        const flipped = collapseButton.findAll((node) => {
            const transform = (mergeStyle(node.props?.style) as { transform?: Array<Record<string, number>> }).transform;
            return Array.isArray(transform) && transform.some((step) => step.scaleX === -1);
        });
        expect(flipped, 'nothing should mirror the glyph the seam already chose').toHaveLength(0);
    }, 120_000);
});
