import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type {
    SelectionListOption,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * RUX-5: scrolling-edge indicators on the SelectionListBody scroll container.
 *
 * The non-virtualized body wraps its ScrollView with a parent View that hosts
 * two absolutely-positioned gradient overlays (top + bottom). The overlays:
 *   - appear ONLY when the scroll container can scroll AND the user is past
 *     the corresponding edge (top fade after `scrollTop > threshold`; bottom
 *     fade when distance from the bottom > threshold).
 *   - have `pointer-events: none` (testID is on a wrapper View that uses
 *     `pointerEvents="none"`).
 *   - render via `LinearGradient` from `expo-linear-gradient`.
 */

function makeOptions(count: number, prefix = 'opt'): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        label: `Option ${i}`,
    }));
}

function defaultProps(rootStep: SelectionListStep, overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

describe('SelectionListBody scrolling-edge indicators (RUX-5)', () => {
    it('mounts a fade-overlay host alongside the bodyScroll ScrollView', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'long',
                    title: 'LONG',
                    options: makeOptions(30, 'l'),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, { maxHeight: 200 })} />,
        );
        // Wrapper that hosts ScrollView + edge fade overlays.
        const fadeHost = screen.findByTestId('sl:bodyScroll:fadeHost');
        expect(fadeHost).not.toBeNull();
        // The actual ScrollView is still reachable by its existing testID.
        expect(screen.findByTestId('sl:bodyScroll')).not.toBeNull();
    });

    it('renders top and bottom fade overlay wrappers with pointer-events disabled', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'long',
                    title: 'LONG',
                    options: makeOptions(30, 'l'),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, { maxHeight: 200 })} />,
        );
        const topFade = screen.findByTestId('sl:bodyScroll:fadeTop') as any;
        const bottomFade = screen.findByTestId('sl:bodyScroll:fadeBottom') as any;
        expect(topFade).not.toBeNull();
        expect(bottomFade).not.toBeNull();
        // Both must opt out of pointer events so they never block row taps.
        expect(topFade.props.pointerEvents).toBe('none');
        expect(bottomFade.props.pointerEvents).toBe('none');
    });

    it('drives bottom-fade visibility from the useScrollEdgeFades hook (initial state: bottom visible when content overflows)', async () => {
        // The body seeds the hook with `initialVisibility: { bottom: true }` so
        // that the trailing fade renders optimistically before the first
        // measurement. We assert the fade is rendered (its style includes a
        // non-zero opacity) on initial mount with a tall list.
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'long',
                    title: 'LONG',
                    options: makeOptions(30, 'l'),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, { maxHeight: 200 })} />,
        );
        const bottomFade = screen.findByTestId('sl:bodyScroll:fadeBottom') as any;
        expect(bottomFade).not.toBeNull();
        // Initial visibility for bottom should be truthy (optimistic).
        const styleProp = bottomFade.props.style;
        const flatStyle: Record<string, unknown> = Array.isArray(styleProp)
            ? Object.assign({}, ...styleProp.filter(Boolean))
            : (styleProp ?? {});
        // The hidden state collapses opacity to 0; the visible state keeps it > 0.
        const opacity = flatStyle.opacity;
        expect(typeof opacity === 'number' ? opacity : 1).toBeGreaterThan(0);
    });

    it('top-fade is hidden initially (no scroll-position yet) — opacity 0', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'long',
                    title: 'LONG',
                    options: makeOptions(30, 'l'),
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root, { maxHeight: 200 })} />,
        );
        const topFade = screen.findByTestId('sl:bodyScroll:fadeTop') as any;
        expect(topFade).not.toBeNull();
        const styleProp = topFade.props.style;
        const flatStyle: Record<string, unknown> = Array.isArray(styleProp)
            ? Object.assign({}, ...styleProp.filter(Boolean))
            : (styleProp ?? {});
        // Initial: top edge fade is hidden.
        expect(flatStyle.opacity).toBe(0);
    });

    it('does not mount fade overlays when only a virtualized section is present (FlashList owns scroll)', async () => {
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                {
                    kind: 'static',
                    id: 'big',
                    title: 'BIG',
                    options: makeOptions(60, 'b'),
                    virtualization: 'force',
                },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} />);
        // No bodyScroll ScrollView ⇒ no fade host either (FlashList path).
        expect(screen.findByTestId('sl:bodyScroll')).toBeNull();
        expect(screen.findByTestId('sl:bodyScroll:fadeHost')).toBeNull();
        expect(screen.findByTestId('sl:bodyScroll:fadeTop')).toBeNull();
        expect(screen.findByTestId('sl:bodyScroll:fadeBottom')).toBeNull();
    });
});
