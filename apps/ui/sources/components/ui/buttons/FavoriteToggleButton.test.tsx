import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The glyph seam, not the glyph renderer: these tests care which name and weight the toggle asks
// for, which is the whole of its on/off distinction. Rendering real Phosphor SVGs would hide that
// behind a tree of paths.
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: 'Icon' }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const { createPassThroughComponent } = await import('@/dev/testkit/mocks/components');
    return createReactNativeWebMock({
        View: createPassThroughComponent('View'),
        Pressable: createPassThroughComponent('Pressable'),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                state: { warning: { foreground: '#f59e0b' } },
                text: { tertiary: '#999' },
            },
        },
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return style !== null && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

describe('FavoriteToggleButton', () => {
    it('forwards onToggle with the row identity and stops event propagation so the row onSelect is not triggered', async () => {
        const { FavoriteToggleButton } = await import('./FavoriteToggleButton');
        const onToggle = vi.fn();

        const screen = await renderScreen(
            <FavoriteToggleButton
                id="/Users/leeroy/code"
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

    it('fills the star and uses the remove label when the item is already a favorite', async () => {
        const { FavoriteToggleButton } = await import('./FavoriteToggleButton');

        const screen = await renderScreen(
            <FavoriteToggleButton
                id="/x"
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

    it('outlines the star and uses the add label when the item is not a favorite', async () => {
        const { FavoriteToggleButton } = await import('./FavoriteToggleButton');

        const screen = await renderScreen(
            <FavoriteToggleButton
                id="/x"
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

    it('lifts an inactive star to full opacity on web hover and dips it while pressed', async () => {
        const { FavoriteToggleButton } = await import('./FavoriteToggleButton');
        const { motionTokens } = await import('@/components/ui/motion/motionTokens');

        const screen = await renderScreen(
            <FavoriteToggleButton
                id="/x"
                isFavorite={false}
                addLabel="Add"
                removeLabel="Remove"
                onToggle={() => {}}
                testID="favorite-toggle-style"
            />,
        );

        const pressable = screen.findByTestId('favorite-toggle-style');
        const styleProp = pressable!.props.style;

        // RN-Web passes `hovered` alongside `pressed` to the style callback.
        expect(typeof styleProp).toBe('function');
        expect(flattenStyle(styleProp({ pressed: false, hovered: false })).opacity).toBe(0.5);
        expect(flattenStyle(styleProp({ pressed: false, hovered: true })).opacity).toBe(1);
        expect(flattenStyle(styleProp({ pressed: true, hovered: false })).opacity).toBe(motionTokens.press.opacity);
    });

    it('keeps the drawn star as its target inside its row, reaching into none of it', async () => {
        const { FavoriteToggleButton } = await import('./FavoriteToggleButton');

        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <FavoriteToggleButton
                    id="/x"
                    isFavorite={false}
                    addLabel="Add"
                    removeLabel="Remove"
                    onToggle={() => {}}
                    testID="favorite-toggle-hit"
                />
            </HappierUiPlatformProvider>,
        );

        const area = await layoutHitArea(() => screen.findByTestId('favorite-toggle-hit'), { width: 24, height: 24 });
        expect(area.drawn).toEqual({ width: 24, height: 24 });
        expect(area.insets).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    });
});
