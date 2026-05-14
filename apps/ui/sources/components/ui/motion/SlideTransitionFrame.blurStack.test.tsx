/**
 * Web blur z-stack invariant.
 *
 * On web, `SlideTransitionBlurLayer` uses CSS `filter: blur(...)` to blur its own
 * descendants — the layer therefore must wrap the slide content (so blurring the
 * layer blurs the content), not be a sibling above an empty container.
 *
 * Structurally: each `SlideTransitionLayer` mounts the children + a blur overlay
 * inside the same Animated.View. We verify here that the blur layer mounts AS a
 * child of the same container that holds the slide content (so on web, `filter:
 * blur(...)` actually blurs the rendered content underneath).
 */

import * as React from 'react';
import { Text } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SlideTransitionFrame — blur z-stack (web)', () => {
    it('mounts the per-slot blur layer alongside the slot content within the same animated layer container', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionFrame } = await import('./SlideTransitionFrame');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0);
            return (
                <SlideTransitionFrame
                    current={<Text testID="content-current">cur</Text>}
                    next={<Text testID="content-next">next</Text>}
                    progress={progress}
                    blur
                    testID="frame"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const layerCurrent = screen.findByTestId('frame-current-layer');
        const blurCurrent = screen.findByTestId('frame-current-blur');
        const layerNext = screen.findByTestId('frame-next-layer');
        const blurNext = screen.findByTestId('frame-next-blur');
        expect(layerCurrent).not.toBeNull();
        expect(blurCurrent).not.toBeNull();
        expect(layerNext).not.toBeNull();
        expect(blurNext).not.toBeNull();

        // Both content and blur overlay must share the same Animated.View parent
        // (the layer container). Otherwise the web `backdrop-filter: blur` overlay
        // has nothing to read underneath.
        const findAncestor = (node: ReactTestInstance | null, predicate: (parent: ReactTestInstance) => boolean) => {
            let cursor: ReactTestInstance | null = node;
            while (cursor) {
                if (predicate(cursor)) return cursor;
                cursor = cursor.parent ?? null;
            }
            return null;
        };

        const contentLayerHost = findAncestor(
            screen.findByTestId('content-current') as unknown as ReactTestInstance | null,
            (parent) => parent.props?.testID === 'frame-current-layer',
        );
        const blurLayerHost = findAncestor(
            blurCurrent as unknown as ReactTestInstance | null,
            (parent) => parent.props?.testID === 'frame-current-layer',
        );

        expect(contentLayerHost).not.toBeNull();
        expect(blurLayerHost).not.toBeNull();
        expect(contentLayerHost).toBe(blurLayerHost);
    });

    it('uses backdrop-filter (not filter) on the web blur overlay so it reads the slide content beneath it', async () => {
        const Reanimated = await import('react-native-reanimated');
        const { SlideTransitionFrame } = await import('./SlideTransitionFrame');

        function Harness(): React.ReactElement {
            const progress = Reanimated.useSharedValue(0.4); // mid-progress so blur is non-zero
            return (
                <SlideTransitionFrame
                    current={<Text testID="content-current">cur</Text>}
                    progress={progress}
                    blur
                    testID="frame"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const blurNode = screen.findByTestId('frame-current-blur');
        expect(blurNode).not.toBeNull();

        const styles = Array.isArray(blurNode!.props.style) ? blurNode!.props.style : [blurNode!.props.style];
        const flattened = Object.assign({}, ...styles.filter((s: unknown) => s != null)) as Record<string, unknown>;

        // The web blur overlay must use `backdropFilter` (not `filter`). `filter:
        // blur` blurs descendants — the overlay has none. `backdrop-filter: blur`
        // reads the painted layers beneath the overlay, which on web is exactly
        // the slide content (rendered as a sibling inside the same layer).
        expect(typeof flattened.backdropFilter === 'string' && flattened.backdropFilter.includes('blur(')).toBe(true);
        expect(flattened.filter).toBeUndefined();
    });
});
