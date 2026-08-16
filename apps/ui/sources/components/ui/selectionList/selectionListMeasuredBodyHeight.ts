/**
 * The measured natural height of the current step body, published by the
 * single offscreen measure mirror and read by the step-transition height
 * animator (`SelectionListAnimatedHeight`).
 *
 * Why an external store instead of orchestrator state? The orchestrator owns
 * BOTH the visible body and the measure mirror, and nothing in this folder is
 * memoised — so one orchestrator render rebuilds both subtrees and re-renders
 * every option row twice over. The mirror's `onLayout` fires on every height
 * change (on web, that is every filter keystroke that changes the list
 * height), and it is a pure measurement report: the only consumer is the
 * animator, and only while a step transition is in flight. Routing it through
 * `useState` on the orchestrator turned each of those reports into a full
 * extra render pass. The animator subscribes here instead, so a report costs
 * zero renders when no transition is running and never re-renders the list.
 *
 * The measurement is tagged with the step it describes. During a step swap the
 * mirror still holds the OUTGOING step for a beat; tagging is what stops the
 * animator from adopting that height as the incoming target.
 */

import * as React from 'react';

/** Matches `useSelectionListMeasuredPopoverHeight`'s dedupe window so the two
 * consumers of the same layout event agree on what counts as a change. */
const HEIGHT_EPSILON_PX = 1;

export type SelectionListStepKey = string | number;

type Measurement = Readonly<{ stepKey: SelectionListStepKey; height: number }>;

export type SelectionListMeasuredBodyHeightStore = Readonly<{
    /**
     * Record the mirror's height for `stepKey`. Ignores non-positive values
     * and changes smaller than the dedupe epsilon; notifies subscribers only
     * when the stored measurement actually moved.
     */
    publish: (stepKey: SelectionListStepKey, height: number) => void;
    /**
     * The height measured for `stepKey`, or `undefined` when the latest
     * measurement describes a different step (i.e. the mirror has not yet
     * reported the incoming step).
     */
    readForStep: (stepKey: SelectionListStepKey) => number | undefined;
    subscribe: (listener: () => void) => () => void;
}>;

export function createSelectionListMeasuredBodyHeightStore(): SelectionListMeasuredBodyHeightStore {
    let measurement: Measurement | null = null;
    const listeners = new Set<() => void>();

    return {
        publish(stepKey, height) {
            if (!Number.isFinite(height) || height <= 0) return;
            if (
                measurement !== null
                && measurement.stepKey === stepKey
                && Math.abs(measurement.height - height) <= HEIGHT_EPSILON_PX
            ) {
                return;
            }
            measurement = { stepKey, height };
            listeners.forEach((listener) => { listener(); });
        },
        readForStep(stepKey) {
            return measurement !== null && measurement.stepKey === stepKey
                ? measurement.height
                : undefined;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

/** One store per SelectionList instance, stable for its lifetime. */
export function useSelectionListMeasuredBodyHeightStore(): SelectionListMeasuredBodyHeightStore {
    const storeRef = React.useRef<SelectionListMeasuredBodyHeightStore | null>(null);
    if (storeRef.current === null) {
        storeRef.current = createSelectionListMeasuredBodyHeightStore();
    }
    return storeRef.current;
}
