import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

import { useSelectionListKeyboardNav } from '../useSelectionListKeyboardNav';

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
});
