import { describe, expect, it } from 'vitest';

import {
    TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1,
    reduceTriageRowInteraction,
} from './rowActionState.js';

describe('reduceTriageRowInteraction', () => {
    it('starts with both actions idle and no focus of its own', () => {
        expect(TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1).toEqual({
            attachment: { kind: 'idle' },
            viewDetails: { kind: 'idle' },
            focus: null,
        });
    });

    it('keeps the sibling action untouched while a mutation settles', () => {
        // One pending flag for the whole row would disable View details while an
        // attach is in flight, which is exactly the coupling the contract forbids.
        const state = reduceTriageRowInteraction(TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1, {
            kind: 'invoked',
            action: 'attachment',
        });

        expect(state.attachment).toEqual({ kind: 'pending' });
        expect(state.viewDetails).toEqual({ kind: 'idle' });
        expect(state.focus).toBe('attachment');
    });

    it('does not make View details busy or run when the mutation is invoked', () => {
        const invoked = reduceTriageRowInteraction(TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1, {
            kind: 'invoked',
            action: 'attachment',
        });
        const settled = reduceTriageRowInteraction(invoked, { kind: 'settled', action: 'attachment' });

        expect(settled.viewDetails).toEqual({ kind: 'idle' });
        expect(settled.attachment).toEqual({ kind: 'idle' });
    });

    it('keeps focus on the invoked control when its mutation fails', () => {
        const invoked = reduceTriageRowInteraction(TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1, {
            kind: 'invoked',
            action: 'attachment',
        });
        const failed = reduceTriageRowInteraction(invoked, {
            kind: 'failed',
            action: 'attachment',
            reason: 'composerUnavailable',
        });

        expect(failed.attachment).toEqual({ kind: 'failed', reason: 'composerUnavailable' });
        expect(failed.focus).toBe('attachment');
        expect(failed.viewDetails).toEqual({ kind: 'idle' });
    });

    it('returns focus to View details when a detail open is denied or cancelled', () => {
        const invoked = reduceTriageRowInteraction(TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1, {
            kind: 'invoked',
            action: 'viewDetails',
        });
        const cancelled = reduceTriageRowInteraction(invoked, { kind: 'cancelled', action: 'viewDetails' });

        expect(cancelled.viewDetails).toEqual({ kind: 'idle' });
        expect(cancelled.focus).toBe('viewDetails');
        expect(cancelled.attachment).toEqual({ kind: 'idle' });
    });

    it('delegates focus to the generic opener owner after a successful detail open', () => {
        // The picker is replaced or dismissed by the navigation owner, so holding
        // focus here would fight it for the restored control.
        const invoked = reduceTriageRowInteraction(TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1, {
            kind: 'invoked',
            action: 'viewDetails',
        });
        const settled = reduceTriageRowInteraction(invoked, { kind: 'settled', action: 'viewDetails' });

        expect(settled.viewDetails).toEqual({ kind: 'idle' });
        expect(settled.focus).toBeNull();
    });

    it('never clears the sibling action failure when the other one settles', () => {
        const detailFailed = reduceTriageRowInteraction(
            reduceTriageRowInteraction(TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1, {
                kind: 'invoked',
                action: 'viewDetails',
            }),
            { kind: 'failed', action: 'viewDetails', reason: 'destinationUnavailable' },
        );
        const afterAttach = reduceTriageRowInteraction(
            reduceTriageRowInteraction(detailFailed, { kind: 'invoked', action: 'attachment' }),
            { kind: 'settled', action: 'attachment' },
        );

        expect(afterAttach.viewDetails).toEqual({ kind: 'failed', reason: 'destinationUnavailable' });
    });

    it('clears one failure only when that control is invoked again or acknowledged', () => {
        const failed = reduceTriageRowInteraction(
            reduceTriageRowInteraction(TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1, {
                kind: 'invoked',
                action: 'attachment',
            }),
            { kind: 'failed', action: 'attachment', reason: 'conflict' },
        );

        expect(reduceTriageRowInteraction(failed, { kind: 'acknowledged', action: 'attachment' }).attachment)
            .toEqual({ kind: 'idle' });
        expect(reduceTriageRowInteraction(failed, { kind: 'invoked', action: 'attachment' }).attachment)
            .toEqual({ kind: 'pending' });
    });

    it('ignores a settlement for an action that is not pending', () => {
        // A late result from a mutation the row already reported must not clear a
        // fresh failure or resurrect focus.
        const failed = reduceTriageRowInteraction(
            reduceTriageRowInteraction(TRIAGE_ROW_INTERACTION_INITIAL_STATE_V1, {
                kind: 'invoked',
                action: 'attachment',
            }),
            { kind: 'failed', action: 'attachment', reason: 'conflict' },
        );

        expect(reduceTriageRowInteraction(failed, { kind: 'settled', action: 'attachment' })).toBe(failed);
    });
});
