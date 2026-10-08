import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from './navigationTestHelpers';
import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
    storage: async (importOriginal) => await importOriginal(),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, children),
        });
    },
});

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

function mergedStyle(style: unknown): Record<string, unknown> {
    const styles = Array.isArray(style) ? style.flat(Infinity) : [style];
    return Object.assign(
        {},
        ...styles.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object'),
    );
}

type TestNode = Readonly<{ props: Record<string, any>; parent: TestNode | null; findAllByType: (type: never) => unknown[] }>;

/** The row the accessory sits in: its nearest ancestor laid out as a row. */
function findAccessoryRow(root: { findByType: (type: never) => TestNode }): TestNode {
    let node: TestNode | null = root.findByType('TrailingAccessory' as never).parent;
    while (node && mergedStyle(node.props.style).flexDirection !== 'row') node = node.parent;
    return node!;
}

describe('FloatingTabBarSurface', () => {
    it('constrains the bar inside the positioner when no accessory is provided', async () => {
        const { FloatingTabBarSurface } = await import('./FloatingTabBarSurface');

        const screen = await renderScreen(
            <FloatingTabBarSurface bottomInset={0} testID="tab-bar-surface">
                {React.createElement('TabRow')}
            </FloatingTabBarSurface>,
        );

        // The bar can shrink-wrap, but a wide tab row must remain inside the positioner's
        // available width. Query the public surface identity rather than GlassPanel's internals.
        const bar = screen.findHostByTestId('tab-bar-surface');
        expect(bar).not.toBeNull();
        let bounds = bar?.parent ?? null;
        while (bounds && (typeof bounds.type !== 'string' || mergedStyle(bounds.props.style).maxWidth !== '100%')) {
            bounds = bounds.parent;
        }
        expect(bounds).not.toBeNull();
        const positioner = screen.root.findAll((node) => typeof node.type === 'string' && node.props.pointerEvents === 'box-none')[0];
        let parentHost = bounds?.parent ?? null;
        while (parentHost && typeof parentHost.type !== 'string') parentHost = parentHost.parent;
        expect(parentHost).toBe(positioner);
        expect(bounds?.findAll((node) => typeof node.type === 'string' && node.props.testID === 'tab-bar-surface')).toEqual([bar]);
        expect(mergedStyle(bounds?.props.style).maxWidth).toBe('100%');
    });

    it('renders a trailing accessory as a sibling capsule beside the bar', async () => {
        const { FloatingTabBarSurface } = await import('./FloatingTabBarSurface');

        const screen = await renderScreen(
            <FloatingTabBarSurface
                bottomInset={0}
                testID="tab-bar-surface"
                trailingAccessory={React.createElement('TrailingAccessory')}
            >
                {React.createElement('TabRow')}
            </FloatingTabBarSurface>,
        );

        // A sibling, never a tab: creating a session is not a navigation destination and must never
        // take the active-tab highlight.
        expect(screen.tree.root.findAllByType('TrailingAccessory' as never)).toHaveLength(1);
        expect(findAccessoryRow(screen.tree.root).findAllByType('TabRow' as never)).toHaveLength(1);
    });

    it('stretches the accessory row so the accessory cannot change the measured bar height', async () => {
        const { FloatingTabBarSurface } = await import('./FloatingTabBarSurface');

        const screen = await renderScreen(
            <FloatingTabBarSurface
                bottomInset={0}
                testID="tab-bar-surface"
                trailingAccessory={React.createElement('TrailingAccessory')}
            >
                {React.createElement('TabRow')}
            </FloatingTabBarSurface>,
        );

        // The accessory is sized BY the row rather than sizing it: the chrome host publishes this
        // height into `SessionCockpitChromeRegistry`, and list padding, the composer reservation
        // and the selection action bar all read it back.
        const row = findAccessoryRow(screen.tree.root);
        const rowStyle = mergedStyle(row.props.style);
        expect(rowStyle.flexDirection).toBe('row');
        expect(rowStyle.alignItems).toBe('stretch');
        expect(rowStyle.paddingVertical ?? 0).toBe(0);
    });

    // The accessory and its leading mirror are squares as tall as the bar. `aspectRatio` alone
    // cannot size them on web: a row item's stretched height is not definite there, so Chromium
    // drew the mirror 0px wide and the "+" at its content width (a 26x26 circle in a 26x44 shadow).
    it('sizes the accessory and its leading mirror as squares of the bar height', async () => {
        const { FloatingTabBarSurface } = await import('./FloatingTabBarSurface');
        const { act } = await import('react-test-renderer');

        const screen = await renderScreen(
            <FloatingTabBarSurface
                bottomInset={0}
                testID="tab-bar-surface"
                trailingAccessory={React.createElement('TrailingAccessory')}
            >
                {React.createElement('TabRow')}
            </FloatingTabBarSurface>,
        );
        // The bar's cell reports its laid-out height.
        const measured = screen.tree.root.findAll((node) => typeof node.props.onLayout === 'function'
            && node.findAll((child) => child.props.testID === 'tab-bar-surface').length > 0);
        expect(measured.length).toBeGreaterThan(0);
        await act(async () => {
            measured[measured.length - 1]!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 44 } } });
        });

        const row = findAccessoryRow(screen.tree.root);
        const cells = (row as unknown as { children: TestNode[] }).children;
        const leading = mergedStyle(cells[0]!.props.style);
        const trailing = mergedStyle(cells[cells.length - 1]!.props.style);
        expect(leading.width).toBe(44);
        expect(trailing.width).toBe(44);
        expect(cells[cells.length - 1]!.findAllByType('TrailingAccessory' as never)).toHaveLength(1);
    });
});
