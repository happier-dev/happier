import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from './navigationTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, children),
            Pressable: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, children),
        });
    },
    storage: async (importOriginal) => await importOriginal(),
});

const expoRouterMock = createExpoRouterMock();

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

describe('TabBarNewSessionButton', () => {
    // Load the module graph once, outside any single test's time budget.
    beforeAll(async () => {
        await import('./TabBarNewSessionButton');
    }, 300_000);

    afterEach(() => {
        standardCleanup();
        expoRouterMock.spies.push.mockReset();
    });

    it('opens an explicit ordinary-entry draft route when pressed', async () => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');

        const screen = await renderScreen(<TabBarNewSessionButton />);
        screen.pressByTestId('tabbar-start-new-session');

        expect(expoRouterMock.spies.push).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                draftOrigin: 'ordinary',
            },
        });
    });

    it.each(['web', 'ios', 'android'] as const)('focuses the same Docked draft on %s and starts another only on an explicit modified press', async (platform) => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');
        const { NewSessionShellHostProvider, useNewSessionShellHost } = await import('@/components/sessions/new/navigation/newSessionEntry');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const storage = getStorage();
        const { Platform } = await import('react-native');
        const previousOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const initialState = storage.getState();
        storage.setState({ settings: { ...initialState.settings, newSessionPresentationModeV1: 'docked' } });
        function ShellState() {
            const shell = useNewSessionShellHost();
            return React.createElement('ShellState', {
                visible: shell?.visible,
                draftId: shell?.host.params.draftId,
                focusRequest: shell?.focusRequest,
            });
        }
        try {
            const screen = await renderScreen(<NewSessionShellHostProvider><TabBarNewSessionButton /><ShellState /></NewSessionShellHostProvider>);
            await screen.pressByTestIdAsync('tabbar-start-new-session');
            const first = screen.tree.root.findByType('ShellState' as never).props;
            expect(first.visible).toBe(true);
            expect(first.draftId).toEqual(expect.any(String));
            expect(expoRouterMock.spies.push).not.toHaveBeenCalled();

            await screen.pressByTestIdAsync('tabbar-start-new-session');
            const repeated = screen.tree.root.findByType('ShellState' as never).props;
            expect(repeated.draftId).toBe(first.draftId);
            expect(repeated.focusRequest).toBeGreaterThan(first.focusRequest);

            const { act } = await import('react-test-renderer');
            await act(async () => {
                screen.findByTestId('tabbar-start-new-session')!.props.onPress({ nativeEvent: { ctrlKey: true, metaKey: true } });
            });
            expect(screen.tree.root.findByType('ShellState' as never).props.draftId).not.toBe(first.draftId);
            expect(expoRouterMock.spies.push).not.toHaveBeenCalled();
        } finally {
            standardCleanup();
            storage.setState(initialState, true);
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previousOS });
        }
    });

    // The sidebar "+" floats over the session list; the QA hit-area probe accepts only a control its owner marks this way.
    it('marks the sidebar placement as a floating overlay and leaves the tab bar placement unmarked', async () => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');
        const marked = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.tree.root.findAll(
            (node) => (node.props as { dataSet?: { happierFloatingOverlay?: string } }).dataSet?.happierFloatingOverlay === 'true',
        );

        const sidebar = await renderScreen(<TabBarNewSessionButton placement="sidebar" />);
        expect(marked(sidebar).some((node) => node.findAll((inner) => inner.props.testID === 'sidebar-start-new-session').length > 0)).toBe(true);
        const tabBar = await renderScreen(<TabBarNewSessionButton />);
        expect(marked(tabBar)).toHaveLength(0);
    });

    it('exposes the new-session action to assistive technology', async () => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');

        const screen = await renderScreen(<TabBarNewSessionButton />);
        const button = screen.findByTestId('tabbar-start-new-session');

        // An icon-only control with no label is unusable with a screen reader, and this one has no
        // adjacent text to borrow meaning from.
        // The shared pressable exposes its role as `role` on web and `accessibilityRole` on native.
        expect(button?.props.role ?? button?.props.accessibilityRole).toBe('button');
        expect(button?.props.accessibilityLabel).toBe('newSession.title');
    });

    // Owner 2026-11-11: the desktop sidebar's "+" is the phone's floating create button, not a restyled second
    // control. Only its frame's size differs (a fixed circle with no bar to measure); the glass, its shadow and
    // the glyph are the bar capsule's, and nothing inside the frame re-derives a size.
    it('draws the desktop sidebar "+" as the bar capsule: same shadow and glyph, sized only on its frame', async () => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');
        const capsule = async (element: React.ReactElement) => {
            const screen = await renderScreen(element);
            // The capsule's GlassPanel: the composite that takes the full-pill radius.
            const panel = screen.tree.root.findAll((node) => typeof node.type !== 'string' && node.props.radius === 999)[0]!;
            const glyph = screen.tree.root.findAll((node) => node.props.name === 'plus' && typeof node.props.size === 'number')[0]!;
            return { panel: panel.props as Record<string, unknown>, glyphSize: glyph.props.size as number };
        };
        const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? Object.assign({}, ...style.map(flatten))
            : (style && typeof style === 'object' ? style as Record<string, unknown> : {});

        const bar = await capsule(<TabBarNewSessionButton />);
        const sidebar = await capsule(<TabBarNewSessionButton placement="sidebar" />);
        expect(sidebar.panel.shadowLevel).toBe(bar.panel.shadowLevel);
        expect(sidebar.panel.style).toBe(bar.panel.style);
        expect(sidebar.glyphSize).toBe(bar.glyphSize);
        expect(flatten(sidebar.panel.frameStyle)).toMatchObject({ width: 44, height: 44 });
    });

    // Owner 2026-11-16: on light, a white rim reads as a ring wherever the glass stands on anything but white (the
    // sidebar's grey list). Light glass carries its edge with the cast shadow and inner shade, never a full ring.
    it('draws no ring around the light glass capsule', async () => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');
        const screen = await renderScreen(<TabBarNewSessionButton placement="sidebar" />);
        const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? Object.assign({}, ...style.map(flatten))
            : (style && typeof style === 'object' ? style as Record<string, unknown> : {});
        const ringed = screen.findAllByType('View' as never).filter((view) => Number(flatten(view.props.style).borderWidth ?? 0) > 0);
        expect(ringed).toHaveLength(0);
    });

    // The tab-bar row gives the capsule a square cell (`FloatingTabBarSurface`). The panel's
    // outermost box, the flex item that also casts the shadow, must fill that cell, and the glass
    // must fill the panel; sizing an inner box instead drew a 26x26 circle inside a 26x44 shadow.
    it('sizes the shadow host and the glass surface as one square in the tab bar row', async () => {
        const { TabBarNewSessionButton } = await import('./TabBarNewSessionButton');

        const screen = await renderScreen(<TabBarNewSessionButton />);
        const views = screen.findAllByType('View' as never);
        const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? Object.assign({}, ...style.map(flatten))
            : (style && typeof style === 'object' ? style as Record<string, unknown> : {});

        const frame = flatten(views[0]!.props.style);
        expect(frame).toMatchObject({ flex: 1 });
        // Everything inside fills that square; nothing re-derives its own size.
        expect(views.slice(1).filter((view) => flatten(view.props.style).aspectRatio !== undefined)).toHaveLength(0);
        const surface = views.find((view) => view !== views[0] && flatten(view.props.style).borderWidth !== undefined);
        expect(flatten(surface?.props.style)).toMatchObject({ flex: 1 });
    });
});

