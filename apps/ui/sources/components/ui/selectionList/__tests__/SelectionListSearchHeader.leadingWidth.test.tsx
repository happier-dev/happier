import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * R6 — Premium UI design polish (Fix 3): the header leading slot must animate
 * its WIDTH (not only opacity) when swapping between the search icon and the
 * back chip so the input doesn't jump horizontally during step transitions.
 *
 * The width animation is driven by a reanimated `useAnimatedStyle` so the test
 * asserts on the resolved style of the leading-slot wrapper exposed under a
 * stable testID. The reanimated mock in `vitestSetup.ts` returns the factory
 * value synchronously, so the test sees the resolved style for the current
 * `canPop` state.
 */
describe('SelectionListSearchHeader leading slot width animation (R6 Fix 3)', () => {
    it('exposes a leading-slot animator wrapper with an animated `width` style entry', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value=""
                onChangeText={() => {}}
                placeholder="Search"
                canPop={false}
                testID="hdr"
            />,
        );
        const animator = screen.findByTestId('hdr:leading:animator');
        expect(animator).not.toBeNull();
        const styles = Array.isArray(animator!.props.style)
            ? animator!.props.style.flat(Infinity)
            : [animator!.props.style];
        const merged = Object.assign({}, ...styles.filter(Boolean));
        expect(typeof merged.width).toBe('number');
        // Search-icon resting width should be modest (icon + small chrome).
        expect(merged.width).toBeGreaterThan(0);
        expect(merged.width).toBeLessThan(60);
    });

    it('reports a wider animated width when the back chip is shown', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value=""
                onChangeText={() => {}}
                placeholder="Search"
                canPop
                backLabel="Worktrees"
                onPopStep={() => {}}
                testID="hdr"
            />,
        );
        const animator = screen.findByTestId('hdr:leading:animator');
        expect(animator).not.toBeNull();
        const styles = Array.isArray(animator!.props.style)
            ? animator!.props.style.flat(Infinity)
            : [animator!.props.style];
        const merged = Object.assign({}, ...styles.filter(Boolean));
        // Back chip is meaningfully wider than the search icon.
        expect(typeof merged.width).toBe('number');
        expect(merged.width).toBeGreaterThanOrEqual(60);
    });

    it('snaps to the target width without animation when reduced motion is active', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
        // Render once with canPop false then update to canPop true under
        // reducedMotion=true and verify the width has changed (snap rather
        // than mid-tween value).
        const screen = await renderScreen(
            <SelectionListSearchHeader
                value=""
                onChangeText={() => {}}
                placeholder="Search"
                canPop={false}
                reducedMotion
                testID="hdr"
            />,
        );
        const before = screen.findByTestId('hdr:leading:animator');
        const beforeMerged = Object.assign(
            {},
            ...(Array.isArray(before!.props.style) ? before!.props.style.flat(Infinity) : [before!.props.style]).filter(Boolean),
        );
        const beforeWidth = beforeMerged.width as number;
        await screen.update(
            <SelectionListSearchHeader
                value=""
                onChangeText={() => {}}
                placeholder="Search"
                canPop
                backLabel="Worktrees"
                onPopStep={() => {}}
                reducedMotion
                testID="hdr"
            />,
        );
        const after = screen.findByTestId('hdr:leading:animator');
        const afterMerged = Object.assign(
            {},
            ...(Array.isArray(after!.props.style) ? after!.props.style.flat(Infinity) : [after!.props.style]).filter(Boolean),
        );
        const afterWidth = afterMerged.width as number;
        expect(afterWidth).not.toBe(beforeWidth);
        expect(afterWidth).toBeGreaterThanOrEqual(60);
    });
});
