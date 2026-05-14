import * as React from 'react';

export type SelectionListKeyboardEvent = Readonly<{
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;

export type SelectionListEscapeOutcome = 'pop-step' | 'clear-input' | 'close';

export type SelectionListKeyboardNavApi = Readonly<{
    focusedIndex: number;
    setFocusedIndex: (i: number) => void;
    /** Returns true if the key event was consumed (caller should preventDefault on web). */
    handleKey: (event: SelectionListKeyboardEvent) => boolean;
    /**
     * Returns the local Escape outcome:
     *   - 'pop-step'    : a step was popped
     *   - 'clear-input' : the input had a value that was cleared
     *   - 'close'       : nothing local; caller should close the popover
     */
    handleEscape: () => SelectionListEscapeOutcome;
}>;

export type SelectionListQuickActionShortcut = Readonly<{
    shortcut: 'cmd+n';
    optionId: string;
}>;

export type SelectionListInputMode = 'search' | 'value';

export type SelectionListKeyboardNavParams = Readonly<{
    /** Flat ordered list of currently-visible option ids (skeleton/disabled rows excluded). */
    flatVisibleOptionIds: ReadonlyArray<string>;
    onActivate: (optionId: string) => void;
    canPopStep: boolean;
    onPopStep: () => void;
    inputValue: string;
    onClearInput: () => void;
    /** Optional quick-action shortcuts (e.g. Cmd+N → "Create new worktree from…"). */
    quickActionShortcuts?: ReadonlyArray<SelectionListQuickActionShortcut>;
    /** Phase 2.5: input caret position; true when the cursor sits at end-of-input. */
    inputCaretAtEnd?: boolean;
    /** Phase 2.5: ghost autocomplete is visible right now. */
    ghostSuffixPresent?: boolean;
    /** Phase 2.5: IME composition is in progress (web: `event.isComposing`). */
    isComposing?: boolean;
    /** Phase 2.5: accept the autocomplete suggestion (replaces input with full value). */
    onAcceptAutocomplete?: () => void;
    /**
     * Accept the autocomplete target for the row focused at key-event time.
     * Returns true when it handled the focused row id.
     */
    onAcceptFocusedAutocomplete?: (optionId: string) => boolean;
    /**
     * Phase 2.5: commit the raw input value as a selection. Only invoked when
     * `inputMode === 'value'` AND no row is focused (or focused row has no
     * onSelect via `onActivate`).
     */
    onCommitInputValue?: () => void;
    /**
     * Phase 2.5: replace input with one segment removed. Return true when a
     * walk-up replacement was applied (Backspace is consumed). Return false to
     * fall through to native delete.
     */
    onWalkUp?: () => boolean;
    /**
     * RUX-13: Shift+Tab "back/up" handler. Invoked when the user presses
     * Shift+Tab AND the step stack cannot be popped (i.e. we're already at
     * the root step). Should walk the input value up one segment regardless
     * of trailing-separator state (more aggressive than `onWalkUp`, which
     * gates on trailing `/`). Return `true` when a back-up replacement was
     * applied (Shift+Tab is consumed). Return `false` to fall through to
     * native browser focus traversal — the escape hatch that preserves
     * accessible Tab cycling when there is genuinely nothing to back to.
     */
    onBackUp?: () => boolean;
    /** Phase 2.5: 'search' (default) or 'value' (typed input is the commit value). */
    inputMode?: SelectionListInputMode;
}>;

function consume(event: SelectionListKeyboardEvent): true {
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
}

function isCmdOrCtrl(event: SelectionListKeyboardEvent): boolean {
    return Boolean(event.metaKey) || Boolean(event.ctrlKey);
}

/**
 * Keyboard navigation for SelectionList (Phase 1.4 base + Phase 2.5 advanced).
 *
 * Handled keys (in the order checked):
 *  - **Tab** (no Shift): when `ghostSuffixPresent && !isComposing`, accept the
 *    autocomplete and consume.
 *  - **Shift+Tab** (RUX-13): universal back/up shortcut. When `canPopStep`,
 *    pops the step stack and consumes. Else when `onBackUp` returns true,
 *    consumes (path adapter walked the input up one segment). Else falls
 *    through to native focus traversal — preserves the accessibility escape
 *    hatch when there's nothing to back to.
 *  - **ArrowRight**: when `inputCaretAtEnd && ghostSuffixPresent && !isComposing`,
 *    accept the autocomplete and consume. Otherwise propagates (native cursor).
 *  - **ArrowUp / ArrowDown**: always advance focused option (consumed).
 *  - **Enter**: while composing → propagate. Otherwise, if a row is focused →
 *    activate it (consumed). Else if `inputMode === 'value'` → commit raw input
 *    (consumed). Otherwise consumed but no-op.
 *  - **Backspace at end of input**: when `inputCaretAtEnd && !isComposing && onWalkUp`,
 *    invoke `onWalkUp()`. If it returns true the event is consumed; false falls
 *    through to native delete.
 *  - **Escape**: routes via `handleEscape()` → 'pop-step' | 'clear-input' | 'close'.
 *  - **Cmd/Ctrl + N**: triggers the `quickActionShortcuts` 'cmd+n' binding.
 */
export function useSelectionListKeyboardNav(
    params: SelectionListKeyboardNavParams,
): SelectionListKeyboardNavApi {
    const {
        flatVisibleOptionIds,
        onActivate,
        canPopStep,
        onPopStep,
        inputValue,
        onClearInput,
        quickActionShortcuts,
        inputCaretAtEnd,
        ghostSuffixPresent,
        isComposing,
        onAcceptAutocomplete,
        onAcceptFocusedAutocomplete,
        onCommitInputValue,
        onWalkUp,
        onBackUp,
        inputMode,
    } = params;

    const [focusedIndex, setFocusedIndexRaw] = React.useState<number>(() => (
        flatVisibleOptionIds.length > 0 ? 0 : -1
    ));
    const [hasExplicitRowFocus, setHasExplicitRowFocus] = React.useState<boolean>(false);
    const flatVisibleOptionIdsKey = React.useMemo(
        () => flatVisibleOptionIds.join('\u0000'),
        [flatVisibleOptionIds],
    );

    React.useEffect(() => {
        if (flatVisibleOptionIds.length === 0) {
            setFocusedIndexRaw((current) => (current === -1 ? current : -1));
            setHasExplicitRowFocus(false);
            return;
        }
        setFocusedIndexRaw((current) => {
            if (current < 0) return 0;
            if (current >= flatVisibleOptionIds.length) return flatVisibleOptionIds.length - 1;
            return current;
        });
        if (inputMode === 'value') {
            setHasExplicitRowFocus(false);
        }
    }, [flatVisibleOptionIdsKey, flatVisibleOptionIds.length, inputMode]);

    const setFocusedIndex = React.useCallback((next: number) => {
        setFocusedIndexRaw(next);
        setHasExplicitRowFocus(true);
    }, []);

    const handleEscape = React.useCallback<SelectionListKeyboardNavApi['handleEscape']>(() => {
        if (canPopStep) {
            onPopStep();
            return 'pop-step';
        }
        if (inputValue.length > 0) {
            onClearInput();
            return 'clear-input';
        }
        return 'close';
    }, [canPopStep, onPopStep, inputValue, onClearInput]);

    const handleKey = React.useCallback<SelectionListKeyboardNavApi['handleKey']>((event) => {
        switch (event.key) {
            case 'Tab': {
                if (event.shiftKey === true) {
                    // RUX-13: Shift+Tab is the universal "back/up" shortcut.
                    // FR3-7: Shift+Tab does NOT commit text, so the IME guard
                    // does NOT apply. Only Enter / plain Tab / ArrowRight /
                    // Backspace stay suppressed during composition (those keys
                    // are owned by the IME for text commit / autocomplete
                    // acceptance / segment walk-up). Allowing Shift+Tab through
                    // keeps the back/up shortcut available to CJK/IME users.
                    // Precedence: pop sub-step first, then walk the input up
                    // one segment (path-mode). When neither applies, leave the
                    // event alone so accessible Tab traversal still works.
                    if (canPopStep) {
                        onPopStep();
                        return consume(event);
                    }
                    if (onBackUp) {
                        const handled = onBackUp();
                        if (handled === true) return consume(event);
                    }
                    return false;
                }
                if (isComposing === true) return false;
                // Precedence: ghost autocomplete wins over row activation.
                // (Plan §Phase 2.5: Tab autocompletes when a ghost is present.)
                if (onAcceptAutocomplete && ghostSuffixPresent === true) {
                    onAcceptAutocomplete();
                    setHasExplicitRowFocus(false);
                    return consume(event);
                }
                const length = flatVisibleOptionIds.length;
                const optionId = length > 0
                    && focusedIndex >= 0
                    && focusedIndex < length
                    ? flatVisibleOptionIds[focusedIndex]
                    : undefined;
                if (
                    inputMode === 'value'
                    && hasExplicitRowFocus
                    && optionId !== undefined
                    && onAcceptFocusedAutocomplete?.(optionId) === true
                ) {
                    setHasExplicitRowFocus(false);
                    return consume(event);
                }
                // Issue 3 (RUX-2): when a row is focused via ↑/↓ and there is
                // no ghost, Tab activates the focused row (parity with Enter).
                // Without this, the browser's default Tab traversal moves
                // focus to the next focusable element (e.g. the browse button)
                // and the user never gets to commit the row they just focused.
                if (
                    length > 0
                    && focusedIndex >= 0
                    && focusedIndex < length
                    && (inputMode !== 'value' || hasExplicitRowFocus)
                ) {
                    onActivate(flatVisibleOptionIds[focusedIndex]);
                    return consume(event);
                }
                // No row, no ghost → fall through so accessible focus
                // traversal still works (DON'T preventDefault).
                return false;
            }
            case 'ArrowRight': {
                if (isComposing === true) return false;
                if (
                    inputCaretAtEnd === true
                    && ghostSuffixPresent === true
                    && onAcceptAutocomplete
                ) {
                    onAcceptAutocomplete();
                    setHasExplicitRowFocus(false);
                    return consume(event);
                }
                return false;
            }
            case 'ArrowDown': {
                const length = flatVisibleOptionIds.length;
                if (length === 0) return consume(event);
                setFocusedIndexRaw((current) => {
                    const base = current < 0 ? -1 : current;
                    const next = (base + 1) % length;
                    return next;
                });
                setHasExplicitRowFocus(true);
                return consume(event);
            }
            case 'ArrowUp': {
                const length = flatVisibleOptionIds.length;
                if (length === 0) return consume(event);
                setFocusedIndexRaw((current) => {
                    const base = current < 0 ? length : current;
                    const next = (base - 1 + length) % length;
                    return next;
                });
                setHasExplicitRowFocus(true);
                return consume(event);
            }
            case 'Enter': {
                if (isComposing === true) return false;
                const length = flatVisibleOptionIds.length;
                if (
                    length > 0
                    && focusedIndex >= 0
                    && focusedIndex < length
                    && (inputMode !== 'value' || hasExplicitRowFocus)
                ) {
                    const optionId = flatVisibleOptionIds[focusedIndex];
                    onActivate(optionId);
                    return consume(event);
                }
                if (inputMode === 'value' && onCommitInputValue) {
                    onCommitInputValue();
                    return consume(event);
                }
                // No focused row + not value-mode = swallow the Enter so the
                // input doesn't accidentally submit a parent form.
                return consume(event);
            }
            case 'Backspace': {
                if (isComposing === true) return false;
                if (inputCaretAtEnd !== true) return false;
                if (!onWalkUp) return false;
                const handled = onWalkUp();
                if (handled === true) {
                    return consume(event);
                }
                return false;
            }
            case 'Escape': {
                handleEscape();
                return consume(event);
            }
            default:
                break;
        }

        // Cmd/Ctrl+N quick action shortcut.
        if ((event.key === 'n' || event.key === 'N') && isCmdOrCtrl(event)) {
            const shortcut = quickActionShortcuts?.find((s) => s.shortcut === 'cmd+n');
            if (shortcut) {
                onActivate(shortcut.optionId);
                return consume(event);
            }
        }

        return false;
    }, [
        flatVisibleOptionIds,
        focusedIndex,
        onActivate,
        handleEscape,
        quickActionShortcuts,
        isComposing,
        ghostSuffixPresent,
        inputCaretAtEnd,
        onAcceptAutocomplete,
        onAcceptFocusedAutocomplete,
        onCommitInputValue,
        onWalkUp,
        onBackUp,
        canPopStep,
        onPopStep,
        inputMode,
        hasExplicitRowFocus,
    ]);

    return React.useMemo(
        () => ({ focusedIndex, setFocusedIndex, handleKey, handleEscape }),
        [focusedIndex, setFocusedIndex, handleKey, handleEscape],
    );
}
