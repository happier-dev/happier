import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from './navigationTestHelpers';
import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
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

describe('FloatingTabBarSurface', () => {
    it('keeps the bar as the positioner\'s direct child when no accessory is provided', async () => {
        const { FloatingTabBarSurface } = await import('./FloatingTabBarSurface');

        const screen = await renderScreen(
            <FloatingTabBarSurface bottomInset={0} testID="tab-bar-surface">
                {React.createElement('TabRow')}
            </FloatingTabBarSurface>,
        );

        // Every other bottom bar renders through this component, and the chrome host publishes the
        // measured height of whatever it renders. An extra layout layer here would move several
        // downstream consumers, so the default tree stays exactly as flat as it is today.
        const positioner = screen.tree.toJSON() as { children: Array<Record<string, any>> };
        expect(positioner.children).toHaveLength(1);
        expect(positioner.children[0].children[0].props.testID).toBe('tab-bar-surface');
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
        expect(screen.tree.root.findByType('TrailingAccessory' as never).parent!
            .findAllByType('TabRow' as never)).toHaveLength(1);
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
        const row = screen.tree.root.findByType('TrailingAccessory' as never).parent!;
        const rowStyle = mergedStyle(row.props.style);
        expect(rowStyle.flexDirection).toBe('row');
        expect(rowStyle.alignItems).toBe('stretch');
        expect(rowStyle.paddingVertical ?? 0).toBe(0);
    });
});
