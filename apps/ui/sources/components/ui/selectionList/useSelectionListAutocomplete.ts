import * as React from 'react';

import type { SelectionListOption } from './_types';

export type AutocompleteState = Readonly<{
    /**
     * Suffix to ghost-render after the user's typed text; empty string when no
     * autocomplete is available for the current input + focused option.
     */
    ghostSuffix: string;
    /**
     * Full value to substitute on accept; equals `inputValue + ghostSuffix`
     * when `ghostSuffix` is non-empty, otherwise the raw `inputValue`.
     */
    nextInputValue: string;
}>;

export type ComputeAutocompleteStateParams = Readonly<{
    inputValue: string;
    focusedOption: SelectionListOption | null;
    /**
     * Optional gate: only ghost when the focused option lives in a section
     * that the input is driving. Default: undefined (ghost regardless).
     */
    isFocusedOptionInDynamicSection?: boolean;
    /**
     * Optional predicate from `inputBehavior.shouldSuppressAutocomplete`.
     * When it returns true for the current input, ghost is empty.
     */
    shouldSuppress?: (input: string) => boolean;
    /** When true, ghost is suppressed regardless of other conditions. */
    isComposing?: boolean;
}>;

/**
 * Pure deriver: computes the ghost suffix + next input value for the current
 * input + focused option. Extracted so unit tests can hit every edge case
 * without rendering a tree.
 *
 * Rules (Phase 2.3):
 *  - no focusedOption → empty
 *  - no autocompleteValue on focused option → empty
 *  - empty input → empty (otherwise the ghost would expand to the full label)
 *  - autocompleteValue does NOT start with input (case-sensitive) → empty
 *  - autocompleteValue equals input (nothing to suggest) → empty
 *  - isComposing → empty (IME active; never suggest mid-composition)
 *  - shouldSuppress(input) → empty (path adapter signals separator/root)
 *  - isFocusedOptionInDynamicSection === false → empty (focused row outside
 *    the section the input is driving)
 */
export function computeAutocompleteState(params: ComputeAutocompleteStateParams): AutocompleteState {
    const {
        inputValue,
        focusedOption,
        isFocusedOptionInDynamicSection,
        shouldSuppress,
        isComposing,
    } = params;
    if (focusedOption === null) return { ghostSuffix: '', nextInputValue: inputValue };
    const autocompleteValue = focusedOption.autocompleteValue;
    if (autocompleteValue === undefined) return { ghostSuffix: '', nextInputValue: inputValue };
    if (inputValue.length === 0) return { ghostSuffix: '', nextInputValue: inputValue };
    if (isComposing === true) return { ghostSuffix: '', nextInputValue: inputValue };
    if (isFocusedOptionInDynamicSection === false) {
        return { ghostSuffix: '', nextInputValue: inputValue };
    }
    if (shouldSuppress && shouldSuppress(inputValue)) {
        return { ghostSuffix: '', nextInputValue: inputValue };
    }
    // Case-sensitive prefix match (paths are case-sensitive on most filesystems
    // and the autocomplete value is canonical).
    if (!autocompleteValue.startsWith(inputValue)) {
        return { ghostSuffix: '', nextInputValue: inputValue };
    }
    if (autocompleteValue.length === inputValue.length) {
        return { ghostSuffix: '', nextInputValue: inputValue };
    }
    const ghostSuffix = autocompleteValue.slice(inputValue.length);
    return { ghostSuffix, nextInputValue: autocompleteValue };
}

/**
 * React-facing hook that memoises `computeAutocompleteState` against its
 * inputs.
 */
export function useSelectionListAutocomplete(
    params: ComputeAutocompleteStateParams,
): AutocompleteState {
    const {
        inputValue,
        focusedOption,
        isFocusedOptionInDynamicSection,
        shouldSuppress,
        isComposing,
    } = params;
    return React.useMemo(
        () =>
            computeAutocompleteState({
                inputValue,
                focusedOption,
                isFocusedOptionInDynamicSection,
                shouldSuppress,
                isComposing,
            }),
        [inputValue, focusedOption, isFocusedOptionInDynamicSection, shouldSuppress, isComposing],
    );
}
