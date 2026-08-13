import * as React from 'react';

import type { SelectionListStep } from './_types';

export type SelectionListStepStackDirection = 'forward' | 'backward' | 'replace';

export type SelectionListStepStackState = Readonly<{
    stack: ReadonlyArray<SelectionListStep>;
    /** Direction for the most recent change (forwarded to the cross-slide transition frame). */
    direction: SelectionListStepStackDirection;
}>;

export type SelectionListStepStackApi = Readonly<{
    state: SelectionListStepStackState;
    pushStep: (step: SelectionListStep) => void;
    popStep: () => void;
    /**
     * Take the consumer's latest root step. A root rebuilt for the SAME step id is a
     * content refresh and replaces the root entry in place; a root with a different id
     * is a different destination and drains the stack. See the reducer for why.
     */
    adoptRootStep: (rootStep: SelectionListStep) => void;
    currentStep: SelectionListStep;
    canPop: boolean;
}>;

type StepStackAction =
    | { type: 'push'; step: SelectionListStep }
    | { type: 'pop' }
    | { type: 'adoptRoot'; rootStep: SelectionListStep };

function stepStackReducer(
    state: SelectionListStepStackState,
    action: StepStackAction,
): SelectionListStepStackState {
    switch (action.type) {
        case 'push':
            return { stack: [...state.stack, action.step], direction: 'forward' };
        case 'pop': {
            if (state.stack.length <= 1) return state; // no-op at root; keep prior direction
            return { stack: state.stack.slice(0, -1), direction: 'backward' };
        }
        case 'adoptRoot': {
            const currentRoot = state.stack[0];
            if (currentRoot === action.rootStep) return state;
            // Rebuilding a step tree is not navigation. Consumers mint a fresh root
            // object whenever any of its inputs move — the worktree picker rebuilds
            // once a minute so its relative-time labels stay fresh, and again on every
            // SCM snapshot refresh — and the rebuild carries the SAME step id because
            // it describes the same destination. Swapping only the root entry keeps
            // that refresh from evicting the user out of a step they pushed (and, with
            // it, the worktree name they were half-way through typing). A root with a
            // DIFFERENT id is a genuinely different destination, so the pushed steps
            // belong to a tree that no longer exists and the stack drains.
            if (currentRoot !== undefined && currentRoot.id === action.rootStep.id && state.stack.length > 1) {
                // `currentStep` is untouched, so the cross-slide must not be told
                // anything happened: keep the prior direction.
                return { stack: [action.rootStep, ...state.stack.slice(1)], direction: state.direction };
            }
            return { stack: [action.rootStep], direction: 'replace' };
        }
    }
}

/**
 * Owns the SelectionList step stack. Push, pop, and adoptRootStep emit a `direction`
 * marker (`'forward' | 'backward' | 'replace'`) consumed by `SlideTransitionSwitch`
 * (Phase 1A discrete adapter) to choreograph the content cross-slide.
 *
 * The reducer treats pop-at-root as a no-op (preserves the prior direction so
 * the cross-slide doesn't snap to `'backward'` on a misfire). Consumers should
 * gate the pop affordance on `canPop` rather than relying on this no-op.
 */
export function useSelectionListStepStack(rootStep: SelectionListStep): SelectionListStepStackApi {
    const [state, dispatch] = React.useReducer(stepStackReducer, undefined, () => ({
        stack: [rootStep],
        direction: 'replace' as const,
    }));

    const pushStep = React.useCallback((step: SelectionListStep) => {
        dispatch({ type: 'push', step });
    }, []);
    const popStep = React.useCallback(() => {
        dispatch({ type: 'pop' });
    }, []);
    const adoptRootStep = React.useCallback((nextRoot: SelectionListStep) => {
        dispatch({ type: 'adoptRoot', rootStep: nextRoot });
    }, []);

    const currentStep = state.stack[state.stack.length - 1] ?? rootStep;
    const canPop = state.stack.length > 1;

    return React.useMemo(
        () => ({ state, pushStep, popStep, adoptRootStep, currentStep, canPop }),
        [state, pushStep, popStep, adoptRootStep, currentStep, canPop],
    );
}
