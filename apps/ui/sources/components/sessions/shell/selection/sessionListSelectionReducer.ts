import {
    createInitialHappierListMultiSelectionState,
    reduceHappierListMultiSelection,
    type CreateHappierListMultiSelectionStateInput,
    type HappierListMultiSelectionAction,
} from '@happier-dev/plugin-ui/presentation';

import type { SessionListSelectionState } from './sessionListSelectionTypes';

/**
 * The sessions list's binding to the ONE keyed multi-selection reducer.
 *
 * The rules — what a toggle does to the anchor, which rows a range extension
 * spans, what survives a narrowed query, what a scope change clears — belong to
 * `@happier-dev/plugin-ui`'s collection owner and are shared with the `List`
 * capability every plugin list opts into. Nothing is re-decided here; this file
 * exists only so the sessions list keeps its local names.
 */
export type CreateSessionListSelectionStateInput = CreateHappierListMultiSelectionStateInput;

export type SessionListSelectionReducerAction = HappierListMultiSelectionAction;

export function createInitialSessionListSelectionState(
    input: CreateSessionListSelectionStateInput,
): SessionListSelectionState {
    return createInitialHappierListMultiSelectionState(input);
}

export function reduceSessionListSelection(
    state: SessionListSelectionState,
    action: SessionListSelectionReducerAction,
): SessionListSelectionState {
    return reduceHappierListMultiSelection(state, action);
}
