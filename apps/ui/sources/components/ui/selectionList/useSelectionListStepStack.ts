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
     * content refresh of the root and its open declarative steps. A different
     * root id is a different destination and drains the stack.
     */
    adoptRootStep: (rootStep: SelectionListStep) => void;
    /**
     * Mirror the consumer's controlled active step (see
     * `SelectionListProps.syncActiveStep`). `null` pops back to the root, a
     * mounted same-id entry is refreshed in place, and an unmounted id pushes.
     * See the reducer for the exact fixpoint contract.
     */
    syncActiveStep: (step: SelectionListStep | null) => void;
    currentStep: SelectionListStep;
    canPop: boolean;
}>;

type StepStackAction =
    | { type: 'push'; step: SelectionListStep }
    | { type: 'pop' }
    | { type: 'adoptRoot'; rootStep: SelectionListStep }
    | { type: 'syncActiveStep'; step: SelectionListStep | null };

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
            // Identity fixpoint. `adoptRootStep` is dispatched during render by
            // `SelectionList` (the rootStep resync), so a reducer that minted a
            // fresh object for an adoption that changes nothing would republish
            // `currentStep` → the render plan → a `direction: 'replace'` into
            // the cross-slide → a popover remeasure, for free, on every
            // dispatch. Returning the input state is what makes a
            // render-phase dispatch settle.
            if (currentRoot === action.rootStep) return state;
            if (currentRoot !== undefined && currentRoot.id === action.rootStep.id && state.stack.length > 1) {
                const stack = [action.rootStep];
                for (let index = 1; index < state.stack.length; index += 1) {
                    const parent = state.stack[index - 1];
                    const child = state.stack[index];
                    const section = parent.sections.find(section => section.kind === 'static'
                        && section.options.some(option => option.openStep === child));
                    if (section?.kind !== 'static') {
                        // Imperative and controlled steps own their own content.
                        return { stack: [...stack, ...state.stack.slice(index)], direction: state.direction };
                    }
                    const option = section.options.find(option => option.openStep === child);
                    const updatedSection = stack[index - 1].sections.find(candidate => candidate.id === section.id);
                    const updatedChild = updatedSection?.kind === 'static'
                        ? updatedSection.options.find(candidate => candidate.id === option?.id)?.openStep
                        : undefined;
                    if (updatedChild?.id !== child.id) return { stack, direction: 'backward' };
                    stack.push(updatedChild);
                }
                return { stack, direction: state.direction };
            }
            return { stack: [action.rootStep], direction: 'replace' };
        }
        case 'syncActiveStep': {
            // Controlled mirror of a route-sized consumer's active step (see
            // `SelectionListProps.syncActiveStep`). Three facts, each a fixpoint
            // when nothing changes:
            //   - `null` means the consumer LEFT the pushed step: pop back to the
            //     root with a backward direction so the cross-slide matches a pop.
            //   - a step whose id is already mounted is a CONTENT refresh of that
            //     entry — same contract as a rebuilt adopted root — so hydration
            //     and pagination keep flowing into a mounted pushed step without
            //     navigation, remount, or query/focus loss.
            //   - an unmounted id is the consumer activating a step directly; push
            //     it with a forward direction.
            if (action.step === null) {
                if (state.stack.length <= 1) return state;
                return { stack: state.stack.slice(0, 1), direction: 'backward' };
            }
            // Preserve the discriminated non-null value across callbacks;
            // TypeScript does not carry a mutable parameter-property narrowing
            // into `findIndex`/`map` closures.
            const step = action.step;
            const index = state.stack.findIndex((entry) => entry.id === step.id);
            if (index < 0) {
                return { stack: [...state.stack, step], direction: 'forward' };
            }
            if (state.stack[index] === step) return state;
            return {
                stack: state.stack.map((entry, position) => (
                    position === index ? step : entry
                )),
                direction: state.direction,
            };
        }
    }
}

/**
 * Owns the SelectionList step stack. Push, pop, and adoptRootStep emit a `direction`
 * marker (`'forward' | 'backward' | 'replace'`) consumed by `SlideTransitionSwitch`
 * (Phase 1A discrete adapter) to choreograph the content cross-slide.
 *
 * Every action is a fixpoint when it would change nothing: pop-at-root and an
 * adoption of the root the stack already holds both return the INPUT state
 * (which also preserves the prior direction, so the cross-slide doesn't snap on
 * a misfire). `push` always changes the stack depth, so it always produces new
 * state. Consumers should still gate the pop affordance on `canPop` rather than
 * relying on the no-op.
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
    const syncActiveStep = React.useCallback((step: SelectionListStep | null) => {
        dispatch({ type: 'syncActiveStep', step });
    }, []);

    const currentStep = state.stack[state.stack.length - 1] ?? rootStep;
    const canPop = state.stack.length > 1;

    return React.useMemo(
        () => ({ state, pushStep, popStep, adoptRootStep, syncActiveStep, currentStep, canPop }),
        [state, pushStep, popStep, adoptRootStep, syncActiveStep, currentStep, canPop],
    );
}
