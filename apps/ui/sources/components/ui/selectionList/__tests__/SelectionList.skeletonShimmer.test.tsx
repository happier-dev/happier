import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type {
    SelectionListDynamicSection,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function makeStep(section: SelectionListDynamicSection): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [{ kind: 'dynamic', ...section }],
    };
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

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
    vi.useRealTimers();
});

/**
 * R6 — Premium UI design polish (Fix 5): the dynamic-section loading skeleton
 * rows should pulse via a shimmer animation (opacity 0.4 ↔ 0.8) instead of
 * rendering as flat disabled bars. Implementation uses reanimated's
 * `useAnimatedStyle` + `withRepeat(withTiming(...))`. The reanimated mock in
 * `vitestSetup.ts` resolves `useAnimatedStyle` synchronously, so the test
 * sees the resolved opacity in the rendered style.
 *
 * Reduced-motion: the pulse is skipped (static low opacity).
 */
describe('SelectionList skeleton shimmer (R6 Fix 5)', () => {
    it('renders skeleton rows with an animated opacity style entry', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            loadingSkeletonRows: 3,
            // RUX-11.2: opt into eager skeletons; default is hidden first-load.
            showSkeletonsOnFirstLoad: true,
            resolve: () => new Promise(() => {}),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        // R13 (Fix 5): outer wrapper reserves row geometry; inner ":bar" node
        // carries the animated shimmer style (opacity + width).
        const row0 = screen.findByTestId('sl:section:dyn:loading:row-0:bar');
        expect(row0).not.toBeNull();
        const styles = Array.isArray(row0!.props.style)
            ? row0!.props.style.flat(Infinity)
            : [row0!.props.style];
        const merged = Object.assign({}, ...styles.filter(Boolean));
        // Opacity is set by the shimmer hook; the mock resolves the factory
        // synchronously, so a numeric opacity is present.
        expect(typeof merged.opacity).toBe('number');
        expect(merged.opacity).toBeGreaterThanOrEqual(0.3);
        expect(merged.opacity).toBeLessThanOrEqual(0.9);
    });

    it('uses varied widths across consecutive skeleton rows (natural feel)', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            loadingSkeletonRows: 3,
            // RUX-11.2: opt into eager skeletons; default is hidden first-load.
            showSkeletonsOnFirstLoad: true,
            resolve: () => new Promise(() => {}),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        const widths: Array<string | number | undefined> = [];
        for (let i = 0; i < 3; i++) {
            const row = screen.findByTestId(`sl:section:dyn:loading:row-${i}:bar`);
            const styles = Array.isArray(row!.props.style)
                ? row!.props.style.flat(Infinity)
                : [row!.props.style];
            const merged = Object.assign({}, ...styles.filter(Boolean));
            widths.push(merged.width);
        }
        // At least two distinct widths so the rows don't look uniform.
        const distinct = new Set(widths.map((w) => String(w)));
        expect(distinct.size).toBeGreaterThanOrEqual(2);
    });
});
