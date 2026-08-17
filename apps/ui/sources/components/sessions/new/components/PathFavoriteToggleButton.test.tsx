import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createPassThroughComponent } from '@/dev/testkit/mocks/components';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The glyph seam, not the glyph renderer: these tests care which name and weight the toggle asks
// for, which is the whole of its on/off distinction. Rendering real Phosphor SVGs would hide that
// behind a tree of paths.
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: 'Icon' }));

installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: createPassThroughComponent('View'),
            Pressable: createPassThroughComponent('Pressable'),
        });
    },
    unistyles: async () => await createUnistylesMock({
        theme: {
            colors: {
                state: { warning: { foreground: '#f59e0b' } },
                text: { tertiary: '#999' },
            },
        },
    }),
});

describe('PathFavoriteToggleButton', () => {
    it('forwards onToggle with the row path and stops event propagation so the row onSelect is not triggered', async () => {
        const { PathFavoriteToggleButton } = await import('./PathFavoriteToggleButton');
        const onToggle = vi.fn();

        const screen = await renderScreen(
            <PathFavoriteToggleButton
                path="/Users/leeroy/code"
                isFavorite={false}
                addLabel="Add to favorites"
                removeLabel="Remove from favorites"
                onToggle={onToggle}
                testID="favorite-toggle"
            />,
        );

        const pressable = screen.findByTestId('favorite-toggle');
        expect(pressable).toBeTruthy();

        const stopPropagation = vi.fn();
        const stopImmediatePropagation = vi.fn();
        const fakeEvent = {
            stopPropagation,
            nativeEvent: { stopImmediatePropagation },
        };

        pressable!.props.onPress(fakeEvent);

        expect(onToggle).toHaveBeenCalledTimes(1);
        expect(onToggle).toHaveBeenCalledWith('/Users/leeroy/code');
        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
    });

    it('fills the star and uses the remove label when path is already a favorite', async () => {
        const { PathFavoriteToggleButton } = await import('./PathFavoriteToggleButton');

        const screen = await renderScreen(
            <PathFavoriteToggleButton
                path="/x"
                isFavorite={true}
                addLabel="Add to favorites"
                removeLabel="Remove from favorites"
                onToggle={() => {}}
                testID="favorite-toggle-on"
            />,
        );

        const pressable = screen.findByTestId('favorite-toggle-on');
        expect(pressable).toBeTruthy();
        expect(pressable!.props.accessibilityLabel).toBe('Remove from favorites');
        expect(pressable!.props['aria-pressed']).toBe(true);

        const icon = screen.find((node) => String(node.type) === 'Icon');
        expect(icon).toBeTruthy();
        expect(icon!.props.name).toBe('star');
        expect(icon!.props.weight).toBe('fill');
    });

    it('outlines the star and uses the add label when path is not a favorite', async () => {
        const { PathFavoriteToggleButton } = await import('./PathFavoriteToggleButton');

        const screen = await renderScreen(
            <PathFavoriteToggleButton
                path="/x"
                isFavorite={false}
                addLabel="Add to favorites"
                removeLabel="Remove from favorites"
                onToggle={() => {}}
                testID="favorite-toggle-off"
            />,
        );

        const pressable = screen.findByTestId('favorite-toggle-off');
        expect(pressable!.props.accessibilityLabel).toBe('Add to favorites');
        expect(pressable!.props['aria-pressed']).toBe(false);

        const icon = screen.find((node) => String(node.type) === 'Icon');
        // Phosphor draws one `star`; the two states are told apart by weight, and the colour below
        // only repeats that — a favourite must never be distinguishable by colour alone.
        expect(icon!.props.name).toBe('star');
        expect(icon!.props.weight).toBe('regular');
        expect(icon!.props.color).not.toBe('#f59e0b');
    });

    it('survives Pressable invoking the style callback with web-only `hovered` state', async () => {
        const { PathFavoriteToggleButton } = await import('./PathFavoriteToggleButton');

        const screen = await renderScreen(
            <PathFavoriteToggleButton
                path="/x"
                isFavorite={false}
                addLabel="Add"
                removeLabel="Remove"
                onToggle={() => {}}
                testID="favorite-toggle-style"
            />,
        );

        const pressable = screen.findByTestId('favorite-toggle-style');
        const styleProp = pressable!.props.style;

        // Pressable's `style` prop is a function on web; it must accept
        // the (pressed, hovered) callback shape without throwing.
        expect(typeof styleProp === 'function').toBe(true);
        expect(() => styleProp({ pressed: false, hovered: true })).not.toThrow();
        expect(() => styleProp({ pressed: true, hovered: false })).not.toThrow();
        expect(() => styleProp({ pressed: false, hovered: false })).not.toThrow();
    });
});
