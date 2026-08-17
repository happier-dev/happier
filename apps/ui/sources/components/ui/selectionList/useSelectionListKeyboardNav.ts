import * as React from 'react';

import type { SelectionListVirtualizedOptionSource } from './_types';

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
    /**
     * The focused option's id — the SAME fact as `focusedIndex`, derived from
     * it during render rather than mirrored into a second state. Consumers
     * (`aria-activedescendant`, autocomplete, the body's focus ring) speak ids;
     * navigation speaks indices. One owner, two projections.
     */
    focusedOptionId: string | null;
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

/** The four arrow keys a multi-column layout can redirect. */
export type SelectionListArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/**
 * Inputs that decide WHERE roving focus sits. Deliberately narrow: everything
 * else the key dispatcher needs (autocomplete, IME, step stack) is read at
 * event time and can therefore be resolved AFTER focus, which is what lets
 * `SelectionList` derive the focused option before autocomplete consumes it.
 */
export type SelectionListRovingFocusParams = Readonly<{
    /** Flat ordered list of currently-visible option ids (skeleton/disabled rows excluded). */
    flatVisibleOptionIds: ReadonlyArray<string>;
    /**
     * Direct virtualized sources retain opaque source-local option positions
     * instead of allocating a second full id array solely for keyboard focus.
     */
    virtualizedOptionSource?: SelectionListVirtualizedOptionSource;
    /**
     * Preferred visible option to focus before the user explicitly navigates
     * rows. Selection surfaces use this to align keyboard focus with an
     * existing selected row on open.
     */
    preferredFocusedOptionId?: string | null;
    inputValue: string;
    /** Phase 2.5: 'search' (default) or 'value' (typed input is the commit value). */
    inputMode?: SelectionListInputMode;
}>;

/**
 * The single owner of roving row focus.
 *
 * Focus is stored ONCE, as an index into `flatVisibleOptionIds`, because the
 * index is the fact that survives an option disappearing — the value-mode
 * contract below clamps a vanished row's position, which an id cannot express.
 * The id is derived from it during render; nothing mirrors it into a second
 * state.
 */
export type SelectionListRovingFocusApi = Readonly<{
    focusedIndex: number;
    focusedOptionId: string | null;
    /** True once the user has moved focus with ↑/↓/←/→ rather than inheriting it. */
    hasExplicitRowFocus: boolean;
    /** Move focus to an absolute index; marks the focus explicit. */
    setFocusedIndex: (index: number) => void;
    /** Move focus relative to the latest committed index; marks the focus explicit. */
    updateFocusedIndex: (resolveNext: (current: number) => number) => void;
    /** Keep the position but drop the "user aimed here" claim (e.g. Tab accepted a ghost). */
    clearExplicitRowFocus: () => void;
}>;

export type SelectionListKeyboardNavParams = SelectionListRovingFocusParams & Readonly<{
    /** The roving-focus owner, created by the caller so it can be read earlier in the render. */
    focus: SelectionListRovingFocusApi;
    onActivate: (optionId: string) => void;
    canPopStep: boolean;
    onPopStep: () => void;
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
    /**
     * Layout-aware arrow movement. Given the CURRENT index into
     * `flatVisibleOptionIds` and the pressed arrow, return the index to move
     * to, or `null` to decline.
     *
     * Supplied only by a multi-column layout, where "one row down" is no
     * longer "one index later". Declining (or omitting the callback entirely)
     * leaves the single-column contract exactly as it was: ↑/↓ walk the flat
     * array with modulo wrap, and ←/→ never touch row focus at all.
     */
    resolveArrowTarget?: (index: number, key: SelectionListArrowKey) => number | null;
}>;

function consume(event: SelectionListKeyboardEvent): true {
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
}

function isCmdOrCtrl(event: SelectionListKeyboardEvent): boolean {
    return Boolean(event.metaKey) || Boolean(event.ctrlKey);
}

function resolveDefaultFocusedIndex(
    flatVisibleOptionIds: ReadonlyArray<string>,
    preferredFocusedOptionId: string | null | undefined,
    virtualizedOptionSource?: SelectionListVirtualizedOptionSource,
): number {
    if (virtualizedOptionSource) {
        if (preferredFocusedOptionId) {
            const preferredIndex = virtualizedOptionSource.findOptionIndexById(preferredFocusedOptionId);
            if (virtualizedOptionSource.isFocusableOptionIndex(preferredIndex)) {
                return preferredIndex;
            }
        }
        return virtualizedOptionSource.getFirstFocusableOptionIndex();
    }
    if (preferredFocusedOptionId) {
        const preferredIndex = flatVisibleOptionIds.indexOf(preferredFocusedOptionId);
        if (preferredIndex >= 0) return preferredIndex;
    }
    return flatVisibleOptionIds.length > 0 ? 0 : -1;
}

type RovingFocusState = Readonly<{
    /** The seed identity this position was resolved for; see `resolveFocusSeedKey`. */
    seedKey: string;
    index: number;
    explicit: boolean;
}>;

const FOCUS_SEED_FIELD_SEPARATOR = '\u0001';
const FOCUS_SEED_OPTION_SEPARATOR = '\u0000';
let nextVirtualizedOptionSourceToken = 0;
const virtualizedOptionSourceTokens = new WeakMap<object, number>();

function resolveVirtualizedOptionSourceToken(source: SelectionListVirtualizedOptionSource): number {
    const existing = virtualizedOptionSourceTokens.get(source);
    if (existing !== undefined) return existing;
    nextVirtualizedOptionSourceToken += 1;
    virtualizedOptionSourceTokens.set(source, nextVirtualizedOptionSourceToken);
    return nextVirtualizedOptionSourceToken;
}

/**
 * Identity of everything that re-seeds default focus. When it changes, the
 * previous position was resolved for a list, mode, or query that no longer
 * exists and must be re-derived.
 *
 * `inputValue` participates only in search mode: a value-mode input IS the
 * user's typed value, so re-seeding on every keystroke would fight the caret.
 */
function resolveFocusSeedKey(params: SelectionListRovingFocusParams): string {
    const {
        flatVisibleOptionIds,
        preferredFocusedOptionId,
        inputMode,
        inputValue,
        virtualizedOptionSource,
    } = params;
    const optionIdentity = virtualizedOptionSource
        ? `source:${resolveVirtualizedOptionSourceToken(virtualizedOptionSource)}:${virtualizedOptionSource.optionCount}:${virtualizedOptionSource.stateKey}`
        : [
            flatVisibleOptionIds.join(FOCUS_SEED_OPTION_SEPARATOR),
            String(flatVisibleOptionIds.length),
        ].join(FOCUS_SEED_FIELD_SEPARATOR);
    return [
        optionIdentity,
        inputMode ?? '',
        preferredFocusedOptionId ?? '',
        inputMode === 'value' ? '' : inputValue,
    ].join(FOCUS_SEED_FIELD_SEPARATOR);
}

function resolveReseededFocusedIndex(
    previous: RovingFocusState,
    params: SelectionListRovingFocusParams,
): number {
    const {
        flatVisibleOptionIds,
        preferredFocusedOptionId,
        inputMode,
        virtualizedOptionSource,
    } = params;
    if (virtualizedOptionSource) {
        const defaultIndex = resolveDefaultFocusedIndex(
            flatVisibleOptionIds,
            preferredFocusedOptionId,
            virtualizedOptionSource,
        );
        if (inputMode !== 'value' || !previous.explicit) return defaultIndex;
        return virtualizedOptionSource.isFocusableOptionIndex(previous.index)
            ? previous.index
            : defaultIndex;
    }
    if (flatVisibleOptionIds.length === 0) return -1;
    // Value mode preserves a POSITION the user deliberately aimed at while the
    // rows underneath it churn (a path picker re-lists on every keystroke);
    // every other case returns to the default row.
    if (inputMode !== 'value' || !previous.explicit) {
        return resolveDefaultFocusedIndex(flatVisibleOptionIds, preferredFocusedOptionId);
    }
    if (previous.index < 0) return 0;
    if (previous.index >= flatVisibleOptionIds.length) return flatVisibleOptionIds.length - 1;
    return previous.index;
}

/**
 * Roving row focus — the single owner (see `SelectionListRovingFocusApi`).
 *
 * Re-seeding happens DURING RENDER, not from an effect. An effect published
 * the outgoing position for one committed frame and cost a second commit for
 * every selection change; the render-phase adjustment React documents for
 * "state that depends on props" re-runs this component before anything is
 * committed, so the first frame at the new props is already correct.
 */
export function useSelectionListRovingFocus(
    params: SelectionListRovingFocusParams,
): SelectionListRovingFocusApi {
    const {
        flatVisibleOptionIds,
        preferredFocusedOptionId,
        inputMode,
        inputValue,
        virtualizedOptionSource,
    } = params;
    const virtualizedOptionSourceStateKey = virtualizedOptionSource?.stateKey;
    const seedKey = React.useMemo(
        () => resolveFocusSeedKey({
            flatVisibleOptionIds,
            preferredFocusedOptionId,
            inputMode,
            inputValue,
            ...(virtualizedOptionSource === undefined ? {} : { virtualizedOptionSource }),
        }),
        [
            flatVisibleOptionIds,
            preferredFocusedOptionId,
            inputMode,
            inputValue,
            virtualizedOptionSource,
            virtualizedOptionSourceStateKey,
        ],
    );

    const [state, setState] = React.useState<RovingFocusState>(() => ({
        seedKey,
        index: resolveDefaultFocusedIndex(
            flatVisibleOptionIds,
            preferredFocusedOptionId,
            virtualizedOptionSource,
        ),
        explicit: false,
    }));

    let current = state;
    if (state.seedKey !== seedKey) {
        current = {
            seedKey,
            index: resolveReseededFocusedIndex(state, {
                flatVisibleOptionIds,
                preferredFocusedOptionId,
                inputMode,
                inputValue,
                ...(virtualizedOptionSource === undefined ? {} : { virtualizedOptionSource }),
            }),
            explicit: false,
        };
        setState(current);
    }

    const setFocusedIndex = React.useCallback((index: number) => {
        setState((previous) => (
            previous.index === index && previous.explicit
                ? previous
                : { seedKey: previous.seedKey, index, explicit: true }
        ));
    }, []);

    const updateFocusedIndex = React.useCallback((resolveNext: (index: number) => number) => {
        setState((previous) => {
            const index = resolveNext(previous.index);
            return previous.index === index && previous.explicit
                ? previous
                : { seedKey: previous.seedKey, index, explicit: true };
        });
    }, []);

    const clearExplicitRowFocus = React.useCallback(() => {
        setState((previous) => (
            previous.explicit
                ? { seedKey: previous.seedKey, index: previous.index, explicit: false }
                : previous
        ));
    }, []);

    const focusedIndex = current.index;
    const hasExplicitRowFocus = current.explicit;
    const focusedOptionId = virtualizedOptionSource
        ? virtualizedOptionSource.isFocusableOptionIndex(focusedIndex)
            ? virtualizedOptionSource.getOptionId(focusedIndex)
            : null
        : focusedIndex >= 0 && focusedIndex < flatVisibleOptionIds.length
            ? flatVisibleOptionIds[focusedIndex] ?? null
            : null;

    return React.useMemo(() => ({
        focusedIndex,
        focusedOptionId,
        hasExplicitRowFocus,
        setFocusedIndex,
        updateFocusedIndex,
        clearExplicitRowFocus,
    }), [
        focusedIndex,
        focusedOptionId,
        hasExplicitRowFocus,
        setFocusedIndex,
        updateFocusedIndex,
        clearExplicitRowFocus,
    ]);
}

function resolveFocusableOptionId(
    flatVisibleOptionIds: ReadonlyArray<string>,
    virtualizedOptionSource: SelectionListVirtualizedOptionSource | undefined,
    index: number,
): string | undefined {
    if (virtualizedOptionSource) {
        return virtualizedOptionSource.isFocusableOptionIndex(index)
            ? virtualizedOptionSource.getOptionId(index)
            : undefined;
    }
    return index >= 0 && index < flatVisibleOptionIds.length
        ? flatVisibleOptionIds[index]
        : undefined;
}

/**
 * Keyboard navigation for SelectionList (Phase 1.4 base + Phase 2.5 advanced).
 *
 * Handled keys (in the order checked):
 *  - **Tab** (no Shift): when `ghostSuffixPresent && !isComposing`, accept the
 *    autocomplete and consume. Without a ghost, activate only a row explicitly
 *    focused by Arrow navigation; otherwise preserve native focus traversal.
 *  - **Shift+Tab** (RUX-13): universal back/up shortcut. When `canPopStep`,
 *    pops the step stack and consumes. Else when `onBackUp` returns true,
 *    consumes (path adapter walked the input up one segment). Else falls
 *    through to native focus traversal — preserves the accessibility escape
 *    hatch when there's nothing to back to.
 *  - **ArrowRight**: when `inputCaretAtEnd && ghostSuffixPresent && !isComposing`,
 *    accept the autocomplete and consume. Else, when a row is EXPLICITLY
 *    focused and `resolveArrowTarget` names a cell to the right (multi-column
 *    layouts only), move focus and consume. Otherwise propagates (native cursor).
 *  - **ArrowLeft**: mirror of the second ArrowRight branch — explicit row focus
 *    plus a `resolveArrowTarget` answer moves focus; otherwise propagates so
 *    the key still moves the text caret.
 *  - **ArrowUp / ArrowDown**: `resolveArrowTarget` first (multi-column row
 *    movement), else advance the flat focused option with modulo wrap. Always
 *    consumed.
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
        virtualizedOptionSource,
        focus,
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
        resolveArrowTarget,
    } = params;

    const {
        focusedIndex,
        focusedOptionId,
        hasExplicitRowFocus,
        setFocusedIndex,
        updateFocusedIndex,
        clearExplicitRowFocus,
    } = focus;

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
        // Ask the layout where this arrow lands. Returns false when there is no
        // layout adapter, when it declines, or when it names an index outside
        // the current nav array — every one of which means "use the default".
        const moveToArrowTarget = (arrow: SelectionListArrowKey): boolean => {
            if (virtualizedOptionSource) return false;
            if (!resolveArrowTarget) return false;
            const target = resolveArrowTarget(focusedIndex, arrow);
            if (target === null) return false;
            if (!Number.isInteger(target)) return false;
            if (target < 0 || target >= flatVisibleOptionIds.length) return false;
            setFocusedIndex(target);
            return true;
        };
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
                    clearExplicitRowFocus();
                    return consume(event);
                }
                const optionId = resolveFocusableOptionId(
                    flatVisibleOptionIds,
                    virtualizedOptionSource,
                    focusedIndex,
                );
                if (
                    inputMode === 'value'
                    && hasExplicitRowFocus
                    && optionId !== undefined
                    && onAcceptFocusedAutocomplete?.(optionId) === true
                ) {
                    clearExplicitRowFocus();
                    return consume(event);
                }
                // Issue 3 (RUX-2): when a row is focused via ↑/↓ and there is
                // no ghost, Tab activates the focused row (parity with Enter).
                // Without this, the browser's default Tab traversal moves
                // focus to the next focusable element (e.g. the browse button)
                // and the user never gets to commit the row they just focused.
                if (
                    optionId !== undefined
                    && hasExplicitRowFocus
                ) {
                    onActivate(optionId);
                    return consume(event);
                }
                // An implicitly highlighted row is context, not a Tab action.
                // Fall through until Arrow navigation explicitly focuses a row
                // so populated search inputs preserve native focus traversal.
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
                    clearExplicitRowFocus();
                    return consume(event);
                }
                // Horizontal row movement is the genuinely new interaction of
                // the columns variant, and it arrives on keys the text input
                // still needs. Same doctrine as Tab below: an IMPLICITLY
                // highlighted row is context, not a target — only a row the
                // user explicitly focused with ↑/↓ hands ←/→ to the grid.
                // Everything else (including every single-column list) keeps
                // the caret.
                if (hasExplicitRowFocus && moveToArrowTarget('ArrowRight')) {
                    return consume(event);
                }
                return false;
            }
            case 'ArrowLeft': {
                if (isComposing === true) return false;
                if (hasExplicitRowFocus && moveToArrowTarget('ArrowLeft')) {
                    return consume(event);
                }
                return false;
            }
            case 'ArrowDown': {
                if (virtualizedOptionSource) {
                    const next = virtualizedOptionSource.getNextFocusableOptionIndex(focusedIndex, 1);
                    if (next < 0) return consume(event);
                    setFocusedIndex(next);
                    return consume(event);
                }
                const length = flatVisibleOptionIds.length;
                if (length === 0) return consume(event);
                if (moveToArrowTarget('ArrowDown')) return consume(event);
                updateFocusedIndex((current) => {
                    const base = current < 0 ? -1 : current;
                    return (base + 1) % length;
                });
                return consume(event);
            }
            case 'ArrowUp': {
                if (virtualizedOptionSource) {
                    const next = virtualizedOptionSource.getNextFocusableOptionIndex(focusedIndex, -1);
                    if (next < 0) return consume(event);
                    setFocusedIndex(next);
                    return consume(event);
                }
                const length = flatVisibleOptionIds.length;
                if (length === 0) return consume(event);
                if (moveToArrowTarget('ArrowUp')) return consume(event);
                updateFocusedIndex((current) => {
                    const base = current < 0 ? length : current;
                    return (base - 1 + length) % length;
                });
                return consume(event);
            }
            case 'Enter': {
                if (isComposing === true) return false;
                const optionId = resolveFocusableOptionId(
                    flatVisibleOptionIds,
                    virtualizedOptionSource,
                    focusedIndex,
                );
                if (
                    optionId !== undefined
                    && (inputMode !== 'value' || hasExplicitRowFocus)
                ) {
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
        virtualizedOptionSource,
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
        resolveArrowTarget,
        setFocusedIndex,
        updateFocusedIndex,
        clearExplicitRowFocus,
    ]);

    return React.useMemo(
        () => ({ focusedIndex, focusedOptionId, setFocusedIndex, handleKey, handleEscape }),
        [focusedIndex, focusedOptionId, setFocusedIndex, handleKey, handleEscape],
    );
}
