/**
 * Phase 2.5 — advanced keyboard nav contract (Tab / →-at-end / Backspace /
 * IME guard / Shift+Tab traversal / Enter precedence for value mode /
 * Cmd+N quick-action).
 *
 * These tests are kept in a separate file so the base contract suite (Phase 1.4)
 * stays focused on Up/Down/Enter/Escape. Both files exercise the same exported
 * hook.
 */

import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

import { useSelectionListKeyboardNav } from '../useSelectionListKeyboardNav';

type Params = Parameters<typeof useSelectionListKeyboardNav>[0];

function makeKeyEvent(overrides: Partial<{
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
}> = {}) {
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
        ...overrides,
    };
}

describe('useSelectionListKeyboardNav (Phase 2.5 — advanced)', () => {
    describe('Tab autocompletes when ghost is present', () => {
        it('consumes Tab and calls onAcceptAutocomplete when ghostSuffixPresent is true', async () => {
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onAcceptAutocomplete,
                    ghostSuffixPresent: true,
                    isComposing: false,
                })),
            );
            const { event, preventDefault } = makeKeyEvent({ key: 'Tab' });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(true);
            expect(preventDefault).toHaveBeenCalled();
            expect(onAcceptAutocomplete).toHaveBeenCalledTimes(1);
        });

        it('does NOT call onAcceptAutocomplete when ghostSuffixPresent is false', async () => {
            // Note (RUX-2 Issue 3): when there's no ghost AND no focused row,
            // Tab now falls through (covered by the dedicated "no row + no
            // ghost" test below). When there IS a focused row, Tab activates
            // it instead of the ghost. Either way, onAcceptAutocomplete must
            // never fire if the ghost is absent.
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onAcceptAutocomplete,
                    ghostSuffixPresent: false,
                    flatVisibleOptionIds: [],
                })),
            );
            const { event } = makeKeyEvent({ key: 'Tab' });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(false);
            expect(onAcceptAutocomplete).not.toHaveBeenCalled();
        });

        it('Tab activates the focused row when no ghost is present (Issue 3 RUX-2)', async () => {
            // Issue 3: user uses ↑/↓ to focus a row, then expects Tab to
            // activate it (just like Enter). If we don't consume here, the
            // browser default Tab traversal moves focus to the next focusable
            // element (e.g. the browse-folder button on the right).
            const onActivate = vi.fn();
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onActivate,
                    onAcceptAutocomplete,
                    ghostSuffixPresent: false,
                    flatVisibleOptionIds: ['row-a', 'row-b'],
                })),
            );
            const { event, preventDefault } = makeKeyEvent({ key: 'Tab' });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(true);
            expect(preventDefault).toHaveBeenCalled();
            expect(onActivate).toHaveBeenCalledWith('row-a');
            expect(onAcceptAutocomplete).not.toHaveBeenCalled();
        });

        it('Tab does NOT preventDefault or activate when no row is focused AND no ghost (Issue 3 RUX-2)', async () => {
            // Accessibility guarantee: if there's nothing to act on, Tab MUST
            // fall through so keyboard users can still traverse out of the
            // popover with native focus order.
            const onActivate = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onActivate,
                    flatVisibleOptionIds: [],
                    ghostSuffixPresent: false,
                })),
            );
            const { event, preventDefault } = makeKeyEvent({ key: 'Tab' });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(false);
            expect(preventDefault).not.toHaveBeenCalled();
            expect(onActivate).not.toHaveBeenCalled();
        });

        it('ghost autocomplete still wins over focused row when both are available (Issue 3 RUX-2)', async () => {
            // Precedence: when a ghost is present, Tab accepts the ghost
            // (existing behavior preserved) — the row is not activated.
            const onActivate = vi.fn();
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onActivate,
                    onAcceptAutocomplete,
                    ghostSuffixPresent: true,
                    flatVisibleOptionIds: ['row-a'],
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Tab' }).event);
            });
            expect(consumed).toBe(true);
            expect(onAcceptAutocomplete).toHaveBeenCalledTimes(1);
            expect(onActivate).not.toHaveBeenCalled();
        });

        it('Shift+Tab does NOT accept autocomplete even when ghost is present (autocomplete is Tab-only)', async () => {
            // RUX-13: Shift+Tab is now reserved for the back/up shortcut. It
            // never accepts an autocomplete ghost. When there is nothing to
            // back to (no canPopStep, no onBackUp), Shift+Tab falls through
            // to native focus traversal — the ghost is left untouched.
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onAcceptAutocomplete,
                    ghostSuffixPresent: true,
                })),
            );
            const { event } = makeKeyEvent({ key: 'Tab', shiftKey: true });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(false);
            expect(onAcceptAutocomplete).not.toHaveBeenCalled();
        });

        it('does NOT consume Tab while IME composition is active', async () => {
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onAcceptAutocomplete,
                    ghostSuffixPresent: true,
                    isComposing: true,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Tab' }).event);
            });
            expect(consumed).toBe(false);
            expect(onAcceptAutocomplete).not.toHaveBeenCalled();
        });
    });

    describe('Shift+Tab → back/up (RUX-13)', () => {
        it('pops the step stack and consumes the event when canPopStep is true', async () => {
            const onPopStep = vi.fn();
            const onBackUp = vi.fn(() => true);
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    canPopStep: true,
                    onPopStep,
                    onBackUp,
                })),
            );
            const { event, preventDefault } = makeKeyEvent({ key: 'Tab', shiftKey: true });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(true);
            expect(preventDefault).toHaveBeenCalled();
            expect(onPopStep).toHaveBeenCalledTimes(1);
            // canPopStep wins over onBackUp — input walk-up does not run.
            expect(onBackUp).not.toHaveBeenCalled();
        });

        it('falls back to onBackUp when canPopStep is false and onBackUp returns true', async () => {
            const onPopStep = vi.fn();
            const onBackUp = vi.fn(() => true);
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    canPopStep: false,
                    onPopStep,
                    onBackUp,
                    inputValue: '~/Documents/dev',
                })),
            );
            const { event, preventDefault } = makeKeyEvent({ key: 'Tab', shiftKey: true });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(true);
            expect(preventDefault).toHaveBeenCalled();
            expect(onBackUp).toHaveBeenCalledTimes(1);
            expect(onPopStep).not.toHaveBeenCalled();
        });

        it('does NOT consume Shift+Tab when nothing to back to (no canPopStep, no onBackUp)', async () => {
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    canPopStep: false,
                })),
            );
            const { event, preventDefault } = makeKeyEvent({ key: 'Tab', shiftKey: true });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(false);
            expect(preventDefault).not.toHaveBeenCalled();
        });

        it('does NOT consume Shift+Tab when onBackUp returns false (already at root)', async () => {
            const onPopStep = vi.fn();
            const onBackUp = vi.fn(() => false);
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    canPopStep: false,
                    onPopStep,
                    onBackUp,
                    inputValue: '/',
                })),
            );
            const { event, preventDefault } = makeKeyEvent({ key: 'Tab', shiftKey: true });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(false);
            expect(preventDefault).not.toHaveBeenCalled();
            expect(onBackUp).toHaveBeenCalledTimes(1);
            expect(onPopStep).not.toHaveBeenCalled();
        });

        it('FR3-7: Shift+Tab is IME-exempt and still pops the step stack while composing', async () => {
            // FR3-7 (reconciled plan §line 460): Shift+Tab does NOT commit text,
            // so the IME guard must NOT block it. Only Enter / plain Tab /
            // ArrowRight / Backspace stay guarded while composing. This keeps
            // the back/up shortcut available to CJK/IME users.
            const onPopStep = vi.fn();
            const onBackUp = vi.fn(() => true);
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    canPopStep: true,
                    onPopStep,
                    onBackUp,
                    isComposing: true,
                })),
            );
            const { event, preventDefault } = makeKeyEvent({ key: 'Tab', shiftKey: true });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(true);
            expect(preventDefault).toHaveBeenCalled();
            expect(onPopStep).toHaveBeenCalledTimes(1);
            expect(onBackUp).not.toHaveBeenCalled();
        });

        it('FR3-7: Shift+Tab is IME-exempt and falls back to onBackUp at the root step while composing', async () => {
            const onPopStep = vi.fn();
            const onBackUp = vi.fn(() => true);
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    canPopStep: false,
                    onPopStep,
                    onBackUp,
                    inputValue: '~/Documents/dev',
                    isComposing: true,
                })),
            );
            const { event, preventDefault } = makeKeyEvent({ key: 'Tab', shiftKey: true });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(event);
            });
            expect(consumed).toBe(true);
            expect(preventDefault).toHaveBeenCalled();
            expect(onBackUp).toHaveBeenCalledTimes(1);
            expect(onPopStep).not.toHaveBeenCalled();
        });

        it('plain Tab REMAINS blocked while IME composition is active (IME owns the keystroke)', async () => {
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onAcceptAutocomplete,
                    ghostSuffixPresent: true,
                    isComposing: true,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Tab' }).event);
            });
            expect(consumed).toBe(false);
            expect(onAcceptAutocomplete).not.toHaveBeenCalled();
        });
    });

    describe('ArrowRight at end of input', () => {
        it('consumes → and accepts autocomplete when caret is at end AND ghost is present', async () => {
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onAcceptAutocomplete,
                    inputCaretAtEnd: true,
                    ghostSuffixPresent: true,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowRight' }).event);
            });
            expect(consumed).toBe(true);
            expect(onAcceptAutocomplete).toHaveBeenCalledTimes(1);
        });

        it('does NOT consume → when caret is mid-input (falls through to native cursor)', async () => {
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onAcceptAutocomplete,
                    inputCaretAtEnd: false,
                    ghostSuffixPresent: true,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowRight' }).event);
            });
            expect(consumed).toBe(false);
            expect(onAcceptAutocomplete).not.toHaveBeenCalled();
        });

        it('does NOT consume → when no ghost is present', async () => {
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onAcceptAutocomplete,
                    inputCaretAtEnd: true,
                    ghostSuffixPresent: false,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowRight' }).event);
            });
            expect(consumed).toBe(false);
        });

        it('does NOT consume → while IME composition is active', async () => {
            const onAcceptAutocomplete = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onAcceptAutocomplete,
                    inputCaretAtEnd: true,
                    ghostSuffixPresent: true,
                    isComposing: true,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowRight' }).event);
            });
            expect(consumed).toBe(false);
        });
    });

    describe('Backspace at end of input → walk-up', () => {
        it('consumes Backspace at end when onWalkUp returns true', async () => {
            const onWalkUp = vi.fn(() => true);
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputValue: '~/Documents/',
                    inputCaretAtEnd: true,
                    onWalkUp,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Backspace' }).event);
            });
            expect(consumed).toBe(true);
            expect(onWalkUp).toHaveBeenCalledTimes(1);
        });

        it('does NOT consume Backspace when caret is mid-input', async () => {
            const onWalkUp = vi.fn(() => true);
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputValue: '~/Documents/',
                    inputCaretAtEnd: false,
                    onWalkUp,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Backspace' }).event);
            });
            expect(consumed).toBe(false);
            expect(onWalkUp).not.toHaveBeenCalled();
        });

        it('does NOT consume Backspace when onWalkUp returns false (no replacement available)', async () => {
            const onWalkUp = vi.fn(() => false);
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputValue: '~',
                    inputCaretAtEnd: true,
                    onWalkUp,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Backspace' }).event);
            });
            expect(consumed).toBe(false);
        });

        it('does NOT consume Backspace while IME composition is active', async () => {
            const onWalkUp = vi.fn(() => true);
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputValue: '~/D',
                    inputCaretAtEnd: true,
                    isComposing: true,
                    onWalkUp,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Backspace' }).event);
            });
            expect(consumed).toBe(false);
            expect(onWalkUp).not.toHaveBeenCalled();
        });
    });

    describe('Enter precedence in value mode', () => {
        it('commits the raw input when value mode only has the implicit first-row focus', async () => {
            const onActivate = vi.fn();
            const onCommitInputValue = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputMode: 'value',
                    onActivate,
                    onCommitInputValue,
                    flatVisibleOptionIds: ['a', 'b'],
                    inputValue: '~/Doc',
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Enter' }).event);
            });
            expect(consumed).toBe(true);
            expect(onActivate).not.toHaveBeenCalled();
            expect(onCommitInputValue).toHaveBeenCalledTimes(1);
        });

        it('explicit keyboard row focus wins over committing the raw input in value mode', async () => {
            const onActivate = vi.fn();
            const onCommitInputValue = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputMode: 'value',
                    onActivate,
                    onCommitInputValue,
                    flatVisibleOptionIds: ['a', 'b'],
                    inputValue: '~/Doc',
                })),
            );
            await act(async () => {
                harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowDown' }).event);
            });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Enter' }).event);
            });
            expect(consumed).toBe(true);
            expect(onActivate).toHaveBeenCalledWith('b');
            expect(onCommitInputValue).not.toHaveBeenCalled();
        });

        it('Tab autocomplete returns value mode to raw-input commit semantics', async () => {
            const onActivate = vi.fn();
            const onAcceptAutocomplete = vi.fn();
            const onCommitInputValue = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputMode: 'value',
                    onActivate,
                    onAcceptAutocomplete,
                    onCommitInputValue,
                    flatVisibleOptionIds: ['a', 'b'],
                    ghostSuffixPresent: true,
                    inputValue: '~/Doc',
                })),
            );
            await act(async () => {
                harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowDown' }).event);
            });
            await act(async () => {
                harness.getCurrent().handleKey(makeKeyEvent({ key: 'Tab' }).event);
            });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Enter' }).event);
            });
            expect(consumed).toBe(true);
            expect(onAcceptAutocomplete).toHaveBeenCalledTimes(1);
            expect(onActivate).not.toHaveBeenCalled();
            expect(onCommitInputValue).toHaveBeenCalledTimes(1);
        });

        it('Tab accepts an explicitly focused row autocomplete target in value mode even when the ghost is hidden', async () => {
            const onActivate = vi.fn();
            const onAcceptAutocomplete = vi.fn();
            const onAcceptFocusedAutocomplete = vi.fn(() => true);
            const onCommitInputValue = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputMode: 'value',
                    onActivate,
                    onAcceptAutocomplete,
                    onAcceptFocusedAutocomplete,
                    onCommitInputValue,
                    flatVisibleOptionIds: ['a', 'b'],
                    ghostSuffixPresent: false,
                    inputValue: '~/Documents/',
                })),
            );
            await act(async () => {
                harness.getCurrent().handleKey(makeKeyEvent({ key: 'ArrowDown' }).event);
            });
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Tab' }).event);
            });
            expect(consumed).toBe(true);
            expect(onAcceptAutocomplete).not.toHaveBeenCalled();
            expect(onAcceptFocusedAutocomplete).toHaveBeenCalledWith('b');
            expect(onActivate).not.toHaveBeenCalled();
            expect(onCommitInputValue).not.toHaveBeenCalled();
        });

        it('commits the raw input when no row is focused in value mode', async () => {
            const onCommitInputValue = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputMode: 'value',
                    onCommitInputValue,
                    flatVisibleOptionIds: [],
                    inputValue: '/usr/local/',
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Enter' }).event);
            });
            expect(consumed).toBe(true);
            expect(onCommitInputValue).toHaveBeenCalledTimes(1);
        });

        it('search mode does NOT commit raw input when no row is focused', async () => {
            const onCommitInputValue = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputMode: 'search',
                    onCommitInputValue,
                    flatVisibleOptionIds: [],
                    inputValue: 'searchish',
                })),
            );
            await act(async () => {
                harness.getCurrent().handleKey(makeKeyEvent({ key: 'Enter' }).event);
            });
            expect(onCommitInputValue).not.toHaveBeenCalled();
        });

        it('does NOT consume Enter while IME composition is active (propagates)', async () => {
            const onActivate = vi.fn();
            const onCommitInputValue = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    inputMode: 'value',
                    onActivate,
                    onCommitInputValue,
                    isComposing: true,
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'Enter' }).event);
            });
            expect(consumed).toBe(false);
            expect(onActivate).not.toHaveBeenCalled();
            expect(onCommitInputValue).not.toHaveBeenCalled();
        });
    });

    describe('Cmd+N quick action', () => {
        it('invokes the bound option when Cmd+N is pressed', async () => {
            const onActivate = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({
                    onActivate,
                    quickActionShortcuts: [{ shortcut: 'cmd+n', optionId: 'create-new' }],
                })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'n', metaKey: true }).event);
            });
            expect(consumed).toBe(true);
            expect(onActivate).toHaveBeenCalledWith('create-new');
        });

        it('falls through when no Cmd+N shortcut is bound', async () => {
            const onActivate = vi.fn();
            const harness = await renderHook(() =>
                useSelectionListKeyboardNav(makeParams({ onActivate })),
            );
            let consumed = false;
            await act(async () => {
                consumed = harness.getCurrent().handleKey(makeKeyEvent({ key: 'n', metaKey: true }).event);
            });
            expect(consumed).toBe(false);
            expect(onActivate).not.toHaveBeenCalled();
        });
    });
});
