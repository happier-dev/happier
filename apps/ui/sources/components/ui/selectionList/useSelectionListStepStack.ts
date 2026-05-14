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
    resetTo: (rootStep: SelectionListStep) => void;
    currentStep: SelectionListStep;
    canPop: boolean;
}>;

type StepStackAction =
    | { type: 'push'; step: SelectionListStep }
    | { type: 'pop' }
    | { type: 'reset'; rootStep: SelectionListStep };

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
        case 'reset':
            return { stack: [action.rootStep], direction: 'replace' };
    }
}

/**
 * Owns the SelectionList step stack. Push, pop, and resetTo emit a `direction`
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
    const resetTo = React.useCallback((nextRoot: SelectionListStep) => {
        dispatch({ type: 'reset', rootStep: nextRoot });
    }, []);

    const currentStep = state.stack[state.stack.length - 1] ?? rootStep;
    const canPop = state.stack.length > 1;

    return React.useMemo(
        () => ({ state, pushStep, popStep, resetTo, currentStep, canPop }),
        [state, pushStep, popStep, resetTo, currentStep, canPop],
    );
}
