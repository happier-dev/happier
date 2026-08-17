import type { TriageRowActionIdV1 } from './rowActions.js';

/**
 * The independent lifecycle of a row's two controls (`core/COMPOSER.md` §2).
 *
 * Attach/Remove and View details never share a pending flag, an error, or a
 * focus target. A single row-wide `busy` boolean is the usual shortcut and it is
 * exactly wrong: it disables View details while an attach settles, and it lets a
 * navigation refusal clear a mutation failure the user has not seen.
 *
 * The state deliberately holds no label and no intent. The control's
 * authoritative label comes from the canonical attachment snapshot through the
 * picker row, so a pending mutation cannot flip `Attach` to `Remove`
 * optimistically before the composer confirms it.
 */

export type TriageRowActionPhaseV1 =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'failed'; reason: string }>;

export type TriageRowInteractionStateV1 = Readonly<{
    attachment: TriageRowActionPhaseV1;
    viewDetails: TriageRowActionPhaseV1;
    /**
     * Which control keeps or regains focus. `null` hands focus back to the
     * generic picker/opener owner, which is what a successful detail open does:
     * the picker is dismissed or replaced by the navigation owner.
     */
    focus: TriageRowActionIdV1 | null;
}>;

export type TriageRowInteractionActionV1 =
    | Readonly<{ kind: 'invoked'; action: TriageRowActionIdV1 }>
    | Readonly<{ kind: 'settled'; action: TriageRowActionIdV1 }>
    | Readonly<{ kind: 'failed'; action: TriageRowActionIdV1; reason: string }>
    /** A denied or cancelled detail open: nothing mutated, focus comes back. */
    | Readonly<{ kind: 'cancelled'; action: TriageRowActionIdV1 }>
    | Readonly<{ kind: 'acknowledged'; action: TriageRowActionIdV1 }>;

const IDLE: TriageRowActionPhaseV1 = Object.freeze({ kind: 'idle' });

export const TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1: TriageRowInteractionStateV1 = Object.freeze({
    attachment: IDLE,
    viewDetails: IDLE,
    focus: null,
});

function withPhase(
    state: TriageRowInteractionStateV1,
    action: TriageRowActionIdV1,
    phase: TriageRowActionPhaseV1,
    focus: TriageRowActionIdV1 | null,
): TriageRowInteractionStateV1 {
    return action === 'attachment'
        ? { attachment: phase, viewDetails: state.viewDetails, focus }
        : { attachment: state.attachment, viewDetails: phase, focus };
}

export function reduceTriageRowInteraction(
    state: TriageRowInteractionStateV1,
    action: TriageRowInteractionActionV1,
): TriageRowInteractionStateV1 {
    const current = action.action === 'attachment' ? state.attachment : state.viewDetails;
    switch (action.kind) {
        case 'invoked':
            // Re-invoking is how a failed control is retried, so its own failure
            // clears here — and only here.
            return withPhase(state, action.action, { kind: 'pending' }, action.action);
        case 'settled':
            // A result for a control that is no longer pending is late: it must
            // not clear a fresh failure or move focus back.
            if (current.kind !== 'pending') return state;
            return withPhase(
                state,
                action.action,
                IDLE,
                action.action === 'viewDetails' ? null : action.action,
            );
        case 'failed':
            // The failure stays associated with the control that was invoked, and
            // focus stays there so the user can retry without hunting for it.
            return withPhase(state, action.action, { kind: 'failed', reason: action.reason }, action.action);
        case 'cancelled':
            return withPhase(state, action.action, IDLE, action.action);
        case 'acknowledged':
            return withPhase(state, action.action, IDLE, state.focus);
    }
}
