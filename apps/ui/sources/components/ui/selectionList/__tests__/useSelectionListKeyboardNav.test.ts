import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

import {
    useSelectionListKeyboardNav as useSelectionListKeyboardDispatch,
    useSelectionListRovingFocus,
    type SelectionListKeyboardNavParams,
    type SelectionListKeyboardNavApi,
} from '../useSelectionListKeyboardNav';
import type { SelectionListVirtualizedOptionSource } from '../_types';

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

function makeKeyEvent(overrides: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    return {
        event: {
            key: overrides.key ?? '',
            metaKey: overrides.metaKey ?? false,
            ctrlKey: overrides.ctrlKey ?? false,
            shiftKey: overrides.shiftKey ?? false,
            preventDefault,
            stopPropagation,
        },
        preventDefault,
        stopPropagation,
    };
}

function makeParams(overrides: Partial<Params> = {}): Params {
    return {
        flatVisibleOptionIds: ['a', 'b', 'c'],
        onActivate: vi.fn(),
        canPopStep: false,
        onPopStep: vi.fn(),
        inputValue: '',
        onClearInput: vi.fn(),
        quickActionShortcuts: [],
        ...overrides,
    };
}

function makeVirtualizedSource(
    ids: ReadonlyArray<string>,
    disabled: ReadonlySet<number> = new Set(),
): SelectionListVirtualizedOptionSource {
    const focusable = (index: number) => index >= 0 && index < ids.length && !disabled.has(index);
    return {
        items: ids.map((id, optionIndex) => ({ kind: 'option' as const, key: id, optionIndex, positionInSet: optionIndex + 1 })),
        optionCount: ids.length,
        stateKey: ids.join('|'),
        getOption: (index) => ({ id: ids[index] ?? '', label: ids[index] ?? '' }),
        getOptionId: (index) => ids[index] ?? '',
        findOptionIndexById: (id) => ids.indexOf(id),
        getFirstFocusableOptionIndex: () => ids.findIndex((_, index) => focusable(index)),
        getNextFocusableOptionIndex: (current, direction) => {
            for (let distance = 1; distance <= ids.length; distance += 1) {
                const index = (current + direction * distance + ids.length) % ids.length;
                if (focusable(index)) return index;
            }
            return -1;
        },
        isFocusableOptionIndex: focusable,
        getHeader: () => ({ id: 'unused' }),
    };
}

describe('useSelectionListKeyboardNav (base)', () => {
    it('initializes focusedIndex to 0 when there is at least one visible option', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams()));
        expect(harness.getCurrent().focusedIndex).toBe(0);
    });

    it('initializes focusedIndex from the preferred option when it is visible', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({
            preferredFocusedOptionId: 'b',
        })));
        expect(harness.getCurrent().focusedIndex).toBe(1);
    });

    it('keeps an opt-out step unhighlighted when its options refresh until the user navigates', async () => {
        let ids = ['a', 'b'];
        const onActivate = vi.fn();
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({
            flatVisibleOptionIds: ids,
            autoFocusFirstOption: false,
            onActivate,
        })));
        expect(harness.getCurrent().focusedOptionId).toBeNull();
        ids = ['a', 'b', 'c'];
        await harness.rerender();
        expect(harness.getCurrent().focusedOptionId).toBeNull();
        await act(async () => {
            harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowDown' }).event);
        });
        expect(harness.getCurrent().focusedOptionId).toBe('a');
        await act(async () => { harness.getCurrent().handleKey(makeKeyEvent({ key: 'Enter' }).event); });
        expect(onActivate).toHaveBeenCalledWith('a');
    });

    it('honors an explicit selected row but does not seed the first virtualized action when opted out', async () => {
        const source = makeVirtualizedSource(['a', 'b', 'c']);
        const unselected = await renderHook(() => useSelectionListKeyboardNav(makeParams({
            flatVisibleOptionIds: [],
            virtualizedOptionSource: source,
            autoFocusFirstOption: false,
        })));
        expect(unselected.getCurrent().focusedOptionId).toBeNull();
        const selected = await renderHook(() => useSelectionListKeyboardNav(makeParams({
            flatVisibleOptionIds: [],
            virtualizedOptionSource: source,
            autoFocusFirstOption: false,
            preferredFocusedOptionId: 'b',
        })));
        expect(selected.getCurrent().focusedOptionId).toBe('b');
    });

    it('keeps explicit keyboard row focus in value mode after seeding from a preferred option', async () => {
        const onActivate = vi.fn();
        const onCommitInputValue = vi.fn();
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({
            inputMode: 'value',
            preferredFocusedOptionId: 'b',
            onActivate,
            onCommitInputValue,
        })));

        await act(async () => {
            harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowDown' }).event);
        });
        await act(async () => {
            harness.getCurrent().handleKey(makeKeyEvent({ key: 'Enter' }).event);
        });

        expect(harness.getCurrent().focusedIndex).toBe(2);
        expect(onActivate).toHaveBeenCalledWith('c');
        expect(onCommitInputValue).not.toHaveBeenCalled();
    });

    it('initializes focusedIndex to -1 when there are no visible options', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({ flatVisibleOptionIds: [] })));
        expect(harness.getCurrent().focusedIndex).toBe(-1);
    });

    it('ArrowDown advances focusedIndex and consumes the event', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams()));
        const { event, preventDefault } = makeKeyEvent({ key: 'ArrowDown' });
        let consumed = false;
        await act(async () => { consumed = harness.getCurrent().handleKey(event); });
        expect(consumed).toBe(true);
        expect(preventDefault).toHaveBeenCalled();
        expect(harness.getCurrent().focusedIndex).toBe(1);
    });

    it('ArrowDown wraps to 0 when at the last option', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams()));
        await act(async () => {
            harness.getCurrent().setFocusedIndex(2);
        });
        await act(async () => { harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowDown' }).event); });
        expect(harness.getCurrent().focusedIndex).toBe(0);
    });

    it('ArrowUp wraps to last when at index 0', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams()));
        await act(async () => { harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowUp' }).event); });
        expect(harness.getCurrent().focusedIndex).toBe(2);
    });

    it.each([
        { key: 'Home', expectedIndex: 0 },
        { key: 'End', expectedIndex: 2 },
    ])('$key moves to the $expectedIndex boundary and consumes the event', async ({ key, expectedIndex }) => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams()));
        await act(async () => { harness.getCurrent().setFocusedIndex(1); });
        const { event, preventDefault } = makeKeyEvent({ key });

        let consumed = false;
        await act(async () => { consumed = harness.getCurrent().handleKey(event); });

        expect(consumed).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(harness.getCurrent().focusedIndex).toBe(expectedIndex);
    });

    it.each(['Home', 'End'])('%s preserves IME composition and native text handling', async (key) => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({ isComposing: true })));
        const { event, preventDefault } = makeKeyEvent({ key });

        let consumed = true;
        await act(async () => { consumed = harness.getCurrent().handleKey(event); });

        expect(consumed).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(harness.getCurrent().focusedIndex).toBe(0);
    });

    it('Home and End use the direct virtualized source boundaries and skip disabled rows', async () => {
        const source = makeVirtualizedSource(
            ['provider:disabled-first', 'provider:one', 'provider:two', 'provider:disabled-last'],
            new Set([0, 3]),
        );
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({
            flatVisibleOptionIds: [],
            virtualizedOptionSource: source,
        })));

        await act(async () => { harness.getCurrent().handleKey(makeKeyEvent({ key: 'End' }).event); });
        expect(harness.getCurrent().focusedOptionId).toBe('provider:two');
        await act(async () => { harness.getCurrent().handleKey(makeKeyEvent({ key: 'Home' }).event); });
        expect(harness.getCurrent().focusedOptionId).toBe('provider:one');
    });

    it('Enter activates the focused option id', async () => {
        const onActivate = vi.fn();
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({ onActivate })));
        let consumed = false;
        await act(async () => { consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Enter' }).event); });
        expect(consumed).toBe(true);
        expect(onActivate).toHaveBeenCalledWith('a');
    });

    it('Enter with no focused option is consumed but does not activate', async () => {
        const onActivate = vi.fn();
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({ onActivate, flatVisibleOptionIds: [] })));
        let consumed = false;
        await act(async () => { consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Enter' }).event); });
        expect(consumed).toBe(true);
        expect(onActivate).not.toHaveBeenCalled();
    });

    it('handleEscape returns "pop-step" and calls onPopStep when canPopStep is true', async () => {
        const onPopStep = vi.fn();
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({ canPopStep: true, onPopStep, inputValue: 'abc' })));
        let outcome: ReturnType<ReturnType<typeof useSelectionListKeyboardNav>['handleEscape']> | undefined;
        await act(async () => { outcome = harness.getCurrent().handleEscape(); });
        expect(outcome).toBe('pop-step');
        expect(onPopStep).toHaveBeenCalledTimes(1);
    });

    it('handleEscape returns "clear-input" and calls onClearInput when no step to pop but input is non-empty', async () => {
        const onClearInput = vi.fn();
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({ canPopStep: false, onClearInput, inputValue: 'foo' })));
        let outcome: ReturnType<ReturnType<typeof useSelectionListKeyboardNav>['handleEscape']> | undefined;
        await act(async () => { outcome = harness.getCurrent().handleEscape(); });
        expect(outcome).toBe('clear-input');
        expect(onClearInput).toHaveBeenCalledTimes(1);
    });

    it('handleEscape returns "close" when no step and input is empty', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams()));
        let outcome: ReturnType<ReturnType<typeof useSelectionListKeyboardNav>['handleEscape']> | undefined;
        await act(async () => { outcome = harness.getCurrent().handleEscape(); });
        expect(outcome).toBe('close');
    });

    it('Escape via handleKey delegates to handleEscape and consumes the event', async () => {
        const onPopStep = vi.fn();
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({ canPopStep: true, onPopStep })));
        const { event, preventDefault } = makeKeyEvent({ key: 'Escape' });
        let consumed = false;
        await act(async () => { consumed = harness.getCurrent().handleKey(event); });
        expect(consumed).toBe(true);
        expect(preventDefault).toHaveBeenCalled();
        expect(onPopStep).toHaveBeenCalled();
    });

    it('Cmd+N triggers the bound quick-action shortcut and consumes', async () => {
        const onActivate = vi.fn();
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({
            onActivate,
            quickActionShortcuts: [{ shortcut: 'cmd+n', optionId: 'new-worktree' }],
        })));
        let consumed = false;
        await act(async () => { consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'n', metaKey: true }).event); });
        expect(consumed).toBe(true);
        expect(onActivate).toHaveBeenCalledWith('new-worktree');
    });

    it('Ctrl+N also triggers cmd+n shortcut on non-mac platforms', async () => {
        const onActivate = vi.fn();
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({
            onActivate,
            quickActionShortcuts: [{ shortcut: 'cmd+n', optionId: 'new-worktree' }],
        })));
        await act(async () => { harness.getCurrent().handleKey(makeKeyEvent({ key: 'n', ctrlKey: true }).event); });
        expect(onActivate).toHaveBeenCalledWith('new-worktree');
    });

    it('plain N (no modifier) does not trigger the shortcut and is not consumed', async () => {
        const onActivate = vi.fn();
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams({
            onActivate,
            quickActionShortcuts: [{ shortcut: 'cmd+n', optionId: 'new-worktree' }],
        })));
        let consumed = false;
        await act(async () => { consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'n' }).event); });
        expect(consumed).toBe(false);
        expect(onActivate).not.toHaveBeenCalled();
    });

    it('returns false for an unhandled key', async () => {
        const harness = await renderHook(() => useSelectionListKeyboardNav(makeParams()));
        let consumed = true;
        await act(async () => { consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'a' }).event); });
        expect(consumed).toBe(false);
    });

    it('clamps focusedIndex when the visible option list shrinks', async () => {
        const harness = await renderHook<ReturnType<typeof useSelectionListKeyboardNav>, Params>(
            (props) => useSelectionListKeyboardNav(props),
            { initialProps: makeParams() },
        );
        await act(async () => { harness.getCurrent().setFocusedIndex(2); });
        await harness.rerender(makeParams({ flatVisibleOptionIds: ['a'] }));
        expect(harness.getCurrent().focusedIndex).toBe(0);
    });

    it('preserves the fully namespaced focused option across insertion and reordering', async () => {
        const harness = await renderHook<ReturnType<typeof useSelectionListKeyboardNav>, Params>(
            (props) => useSelectionListKeyboardNav(props),
            {
                initialProps: makeParams({
                    inputValue: 'query',
                    flatVisibleOptionIds: ['commands:open', 'messages:target', 'files:readme'],
                }),
            },
        );
        await act(async () => { harness.getCurrent().setFocusedIndex(1); });
        expect(harness.getCurrent().focusedOptionId).toBe('messages:target');

        await harness.rerender(makeParams({
            inputValue: 'query',
            flatVisibleOptionIds: ['files:new', 'files:readme', 'messages:target', 'commands:open'],
        }));

        expect(harness.getCurrent().focusedOptionId).toBe('messages:target');
        expect(harness.getCurrent().focusedIndex).toBe(2);
    });

    it('chooses the nearest surviving position when the focused option is removed', async () => {
        const harness = await renderHook<ReturnType<typeof useSelectionListKeyboardNav>, Params>(
            (props) => useSelectionListKeyboardNav(props),
            {
                initialProps: makeParams({
                    inputValue: 'query',
                    flatVisibleOptionIds: ['commands:first', 'messages:removed', 'files:last'],
                }),
            },
        );
        await act(async () => { harness.getCurrent().setFocusedIndex(1); });

        await harness.rerender(makeParams({
            inputValue: 'query',
            flatVisibleOptionIds: ['commands:first', 'files:last'],
        }));

        expect(harness.getCurrent().focusedOptionId).toBe('files:last');
        expect(harness.getCurrent().focusedIndex).toBe(1);
    });
});
