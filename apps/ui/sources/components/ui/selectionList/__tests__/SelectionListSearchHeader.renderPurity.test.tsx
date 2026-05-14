import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * R16c — Major 6: the header leading-slot animation previously wrote a Reanimated
 * shared value during render in the reduced-motion branch:
 *
 *   if (reducedMotion && leadingWidth.value !== targetWidth) {
 *       leadingWidth.value = targetWidth;
 *   }
 *
 * Writing a shared value during render is a React anti-pattern: it produces a
 * side effect during commit that React cannot track, can be torn during
 * concurrent rendering, and may double-fire under StrictMode. The fix moves
 * the snap into a `useLayoutEffect` keyed on `reducedMotion + targetWidth` so
 * the write happens AFTER the render commit.
 *
 * These tests pin the render-purity contract:
 *  1. Source-level: the leading-slot module must not contain the render-phase conditional
 *     write to `leadingWidth.value`.
 *  2. Functional: after a `canPop` flip with `reducedMotion=true`, the
 *     rendered animator style reflects the new target width (the layout
 *     effect snap ran).
 */
describe('SelectionListSearchHeader render purity (R16c Major 6)', () => {
    it('does NOT mutate the shared value during render (no render-phase conditional write)', async () => {
        const fs = await import('node:fs/promises');
        const src = await fs.readFile(
            new URL('../SelectionListSearchHeaderLeadingSlot.tsx', import.meta.url),
            'utf-8',
        );

        // The anti-pattern: a top-level (function-body) `if` that conditionally
        // assigns `leadingWidth.value = ...` outside of any useEffect /
        // useLayoutEffect callback. The fix moves the assignment INTO a
        // `useLayoutEffect` body. The forbidden source pattern is therefore an
        // `if` followed (within the next ~80 chars) by `leadingWidth.value =`
        // that is NOT inside an effect closure.
        //
        // Detect the literal anti-pattern that previously shipped:
        //   `if (reducedMotion && leadingWidth.value !== targetWidth) {`
        // and any single-line variant `if (... ) leadingWidth.value = targetWidth;`.
        expect(src).not.toMatch(
            /if\s*\([^)]*reducedMotion[^)]*leadingWidth\.value[^)]*\)\s*\{?\s*leadingWidth\.value\s*=/,
        );
        // Stronger sentinel: the production file must include a useLayoutEffect
        // that owns the reduced-motion snap. (The non-reduced-motion path
        // remains in a regular useEffect because it can run after paint.)
        expect(src).toMatch(/useLayoutEffect\s*\(/);
    });

    it('snaps to the new target width after a canPop flip under reducedMotion (layout effect ran)', async () => {
        const { SelectionListSearchHeader } = await import('../SelectionListSearchHeader');
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
        const beforeWidth = Object.assign(
            {},
            ...(Array.isArray(before!.props.style)
                ? before!.props.style.flat(Infinity)
                : [before!.props.style]
            ).filter(Boolean),
        ).width as number;
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
        const afterWidth = Object.assign(
            {},
            ...(Array.isArray(after!.props.style)
                ? after!.props.style.flat(Infinity)
                : [after!.props.style]
            ).filter(Boolean),
        ).width as number;
        // The reduced-motion snap must have run via useLayoutEffect; the
        // rendered width is wider for the back-chip target.
        expect(afterWidth).not.toBe(beforeWidth);
        expect(afterWidth).toBeGreaterThanOrEqual(60);
    });
});
