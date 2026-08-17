/**
 * Lane G2 — `resolveArrowTarget`, the seam a multi-column layout uses to turn
 * "one index later" into "one visual row down".
 *
 * The suite is deliberately split between the ABSENCE case (which must
 * reproduce the single-column contract exactly, key for key) and the PRESENT
 * case (which must respect the layout's answer, including its refusals).
 */

import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

import {
    useSelectionListKeyboardNav as useSelectionListKeyboardDispatch,
    useSelectionListRovingFocus,
    type SelectionListKeyboardNavParams,
    type SelectionListKeyboardNavApi,
} from '../useSelectionListKeyboardNav';

/**
 * The production composition: the surface owns roving focus (so it can read the
 * focused row BEFORE autocomplete) and hands it to the key dispatcher. These
 * suites exercise the same pair, not a test-only arrangement of it.
 */
function useSelectionListKeyboardNav(
    params: Omit<SelectionListKeyboardNavParams, 'focus'>,
): SelectionListKeyboardNavApi {
    const focus = useSelectionListRovingFocus(params);
    return useSelectionListKeyboardDispatch({ ...params, focus });
}

type Params = Parameters<typeof useSelectionListKeyboardNav>[0];

function makeKeyEvent(key: string) {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    return {
        event: { key, preventDefault, stopPropagation },
        preventDefault,
        stopPropagation,
    };
}

function makeParams(overrides: Partial<Params> = {}): Params {
    return {
        flatVisibleOptionIds: ['a', 'b', 'c', 'd', 'e', 'f'],
        onActivate: vi.fn(),
        canPopStep: false,
        onPopStep: vi.fn(),
        inputValue: '',
        onClearInput: vi.fn(),
        ...overrides,
    };
}

async function press(
    harness: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSelectionListKeyboardNav>>>>,
    key: string,
): Promise<boolean> {
    let consumed = false;
    await act(async () => {
        consumed = harness.getCurrent().handleKey(makeKeyEvent(key).event);
    });
    return consumed;
}

describe('useSelectionListKeyboardNav — resolveArrowTarget absent (single-column contract)', () => {
    it('walks ArrowDown one index at a time and wraps at the end', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams()));
        expect(harness.getCurrent().focusedIndex).toBe(0);
        for (const expected of [1, 2, 3, 4, 5, 0]) {
            expect(await press(harness, 'ArrowDown')).toBe(true);
            expect(harness.getCurrent().focusedIndex).toBe(expected);
        }
    });

    it('walks ArrowUp one index at a time and wraps at the start', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams()));
        for (const expected of [5, 4, 3]) {
            expect(await press(harness, 'ArrowUp')).toBe(true);
            expect(harness.getCurrent().focusedIndex).toBe(expected);
        }
    });

    it('leaves ArrowLeft and ArrowRight entirely to the text caret', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams()));
        await press(harness, 'ArrowDown');
        const focusedAfterExplicitFocus = harness.getCurrent().focusedIndex;
        expect(await press(harness, 'ArrowRight')).toBe(false);
        expect(await press(harness, 'ArrowLeft')).toBe(false);
        expect(harness.getCurrent().focusedIndex).toBe(focusedAfterExplicitFocus);
    });
});

describe('useSelectionListKeyboardNav — resolveArrowTarget present', () => {
    it('moves ArrowDown to the index the layout names instead of the next one', async () => {
        // A 2-column grid: down from 0 is 2, not 1.
        const resolveArrowTarget = vi.fn((index: number, key: string) => (
            key === 'ArrowDown' ? index + 2 : null
        ));
        const harness = await renderHook(() =>
            useSelectionListKeyboardNav(makeParams({ resolveArrowTarget })));
        expect(await press(harness, 'ArrowDown')).toBe(true);
        expect(harness.getCurrent().focusedIndex).toBe(2);
        expect(resolveArrowTarget).toHaveBeenCalledWith(0, 'ArrowDown');
    });

    it('falls back to the modulo walk when the layout declines a vertical move', async () => {
        const resolveArrowTarget = vi.fn(() => null);
        const harness = await renderHook(() =>
            useSelectionListKeyboardNav(makeParams({ resolveArrowTarget })));
        expect(await press(harness, 'ArrowDown')).toBe(true);
        expect(harness.getCurrent().focusedIndex).toBe(1);
        expect(await press(harness, 'ArrowUp')).toBe(true);
        expect(harness.getCurrent().focusedIndex).toBe(0);
    });

    it('ignores an out-of-range answer rather than focusing a row that is not there', async () => {
        const resolveArrowTarget = vi.fn(() => 99);
        const harness = await renderHook(() =>
            useSelectionListKeyboardNav(makeParams({ resolveArrowTarget })));
        expect(await press(harness, 'ArrowDown')).toBe(true);
        expect(harness.getCurrent().focusedIndex).toBe(1);
    });

    it('moves horizontally only after the user explicitly focused a row', async () => {
        const resolveArrowTarget = vi.fn((index: number, key: string) => (
            key === 'ArrowRight' ? index + 1 : key === 'ArrowLeft' ? index - 1 : null
        ));
        const harness = await renderHook(() =>
            useSelectionListKeyboardNav(makeParams({ resolveArrowTarget })));

        // Index 0 is highlighted implicitly on mount — that is context, not a
        // target, so the caret keeps the key and the layout is never consulted.
        expect(await press(harness, 'ArrowRight')).toBe(false);
        expect(harness.getCurrent().focusedIndex).toBe(0);
        expect(resolveArrowTarget).not.toHaveBeenCalledWith(0, 'ArrowRight');

        // ↓ makes the focus explicit; now ←/→ belong to the grid.
        await press(harness, 'ArrowDown');
        expect(await press(harness, 'ArrowRight')).toBe(true);
        expect(harness.getCurrent().focusedIndex).toBe(2);
        expect(await press(harness, 'ArrowLeft')).toBe(true);
        expect(harness.getCurrent().focusedIndex).toBe(1);
    });

    it('releases ArrowLeft back to the caret when the layout clamps at the row edge', async () => {
        const resolveArrowTarget = vi.fn(() => null);
        const harness = await renderHook(() =>
            useSelectionListKeyboardNav(makeParams({ resolveArrowTarget })));
        await press(harness, 'ArrowDown');
        const focused = harness.getCurrent().focusedIndex;
        expect(await press(harness, 'ArrowLeft')).toBe(false);
        expect(await press(harness, 'ArrowRight')).toBe(false);
        expect(harness.getCurrent().focusedIndex).toBe(focused);
    });

    it('keeps ghost-autocomplete acceptance ahead of horizontal row movement', async () => {
        const onAcceptAutocomplete = vi.fn();
        const resolveArrowTarget = vi.fn(() => 3);
        const harness = await renderHook(() =>
            useSelectionListKeyboardNav(makeParams({
                resolveArrowTarget,
                onAcceptAutocomplete,
                inputCaretAtEnd: true,
                ghostSuffixPresent: true,
            })));
        await press(harness, 'ArrowDown');
        expect(await press(harness, 'ArrowRight')).toBe(true);
        expect(onAcceptAutocomplete).toHaveBeenCalledTimes(1);
        expect(resolveArrowTarget).not.toHaveBeenCalledWith(expect.anything(), 'ArrowRight');
    });

    it('does not steal the arrows from an IME mid-composition', async () => {
        const resolveArrowTarget = vi.fn(() => 3);
        const harness = await renderHook(() =>
            useSelectionListKeyboardNav(makeParams({ resolveArrowTarget, isComposing: true })));
        expect(await press(harness, 'ArrowLeft')).toBe(false);
        expect(await press(harness, 'ArrowRight')).toBe(false);
        expect(resolveArrowTarget).not.toHaveBeenCalled();
    });
});
