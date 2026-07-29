import * as React from 'react';

/**
 * Lets a deeply-nested option row ask the SelectionList to draw attention to its
 * input field (focus it + a brief shake) instead of selecting. Provided once by
 * the orchestrator and consumed by `PlanOptionRow` so the signal does not need
 * threading through every body/row layer. Mirrors the
 * `SelectionListScrollIntoViewContext` pattern.
 *
 * Used by value-mode `requiresInputValue` rows (e.g. the worktree "type a name"
 * combobox row while the field is empty): activating one prompts the user to
 * type rather than committing a fallback value.
 */
export type SelectionListRequestInputAttention = () => void;

export const SelectionListInputAttentionContext =
    React.createContext<SelectionListRequestInputAttention | null>(null);
