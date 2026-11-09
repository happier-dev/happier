import * as React from 'react';

import { hapticsLight } from '@/components/ui/theme/haptics';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import type { WorkflowRunStateV1 } from '@happier-dev/protocol/workflows';

import { isObservedCompletionTransition } from './workflowRunDetailPresentation';

/**
 * The one owner of the Run's completion moment.
 *
 * Haptics and the visible emphasis are decided here together, so a native
 * device can never buzz for something that produced nothing on screen. The
 * moment is keyed to the state transition this mounted instance actually
 * observed — not to a refresh, a remount or a transport label — so re-entering
 * a finished Run replays nothing and no "already played" flag has to be
 * persisted.
 *
 * The observation belongs to one Run. The detail screen stays mounted across a
 * Run change, so without `identity` the previous Run's `running` was compared
 * against the next Run's already-`completed` state and celebrated a completion
 * this instance never watched happen.
 *
 * Under reduced motion the emphasis never appears: the authoritative status
 * change is applied immediately and is itself the visible twin of the haptic.
 */
export function useWorkflowCompletionMoment(params: Readonly<{
    /** The authoritative parent state, or `null` before the Run has resolved. */
    state: WorkflowRunStateV1 | null;
    /** False when this instance is not the one the user is watching. */
    observing: boolean;
    /** What the state belongs to. A change re-baselines instead of transitioning. */
    identity?: string | null;
}>): boolean {
    const { identity = null, state, observing } = params;
    const reducedMotion = useReducedMotionPreference();
    const previousStateRef = React.useRef<WorkflowRunStateV1 | null>(state);
    const observedIdentityRef = React.useRef<string | null>(identity);
    const [emphasised, setEmphasised] = React.useState(false);

    React.useEffect(() => {
        const previous = observedIdentityRef.current === identity ? previousStateRef.current : null;
        observedIdentityRef.current = identity;
        previousStateRef.current = state;
        // Emphasis belongs to the exact observation that started it. Re-baseline
        // immediately when identity, visibility, motion preference, or state
        // changes so a cancelled timer cannot leave the next Run highlighted.
        setEmphasised(false);
        if (state === null || !observing) return;
        if (!isObservedCompletionTransition({ previousState: previous, nextState: state })) return;

        void hapticsLight();
        if (reducedMotion) return;

        setEmphasised(true);
        const timer = setTimeout(() => setEmphasised(false), motionTokens.durationMs.base);
        return () => clearTimeout(timer);
    }, [identity, observing, reducedMotion, state]);

    return emphasised;
}
