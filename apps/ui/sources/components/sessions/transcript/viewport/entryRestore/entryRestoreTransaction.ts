import type { EntryRestoreFinalNoneReason, EntryRestoreTarget } from './resolveEntryRestoreTarget';

/**
 * Pure entry-restore transaction state machine. No React, no timers — the
 * caller drives time through `nowMs` arguments.
 *
 * Contract: creating a transaction with a writable target means the caller
 * issues the initial viewport write immediately; the transaction counts it.
 * After that, the ONLY way another write can be authorized is the single
 * `issue-correction-write` directive returned for the first misaligned
 * observation. There is deliberately no API surface that reacts to
 * content-size changes: height churn during entry must never re-issue
 * scroll writes (evidence E1).
 *
 * Targets exclude `materialize-then-anchor` (materialization happens BEFORE a
 * transaction exists; the host re-resolves once the data arrives) and the wait
 * `none` verdicts (`awaiting-fill-settle` / `content-unmeasured`): turning a
 * wait verdict into a transaction would close the entry phase as `no-target`
 * prematurely. Only final `none` verdicts may open (and instantly close) one.
 */
export type EntryRestoreTransactionTarget =
    | Exclude<EntryRestoreTarget, Readonly<{ kind: 'materialize-then-anchor' | 'none' }>>
    | Readonly<{ kind: 'none'; reason: EntryRestoreFinalNoneReason }>;

export type EntryRestoreTransactionState = 'pending' | 'confirming' | 'closed';

export type EntryRestoreTransactionOutcome =
    | 'confirmed'
    | 'deadline'
    | 'preempted-user-scroll'
    | 'no-target';

export type EntryRestoreTransactionObservation = Readonly<{
    status: 'aligned' | 'misaligned';
}>;

export type EntryRestoreTransactionObservationDirective = Readonly<{
    action: 'none' | 'issue-correction-write';
}>;

export type EntryRestoreTransaction = Readonly<{
    sessionId: string;
    target: EntryRestoreTransactionTarget;
    state(): EntryRestoreTransactionState;
    issueCount(): number;
    onObservation(observation: EntryRestoreTransactionObservation, nowMs: number): EntryRestoreTransactionObservationDirective;
    onTrustedUserScroll(): void;
    onDeadline(nowMs: number): void;
    isClosed(): boolean;
    outcome(): EntryRestoreTransactionOutcome | null;
}>;

export function createEntryRestoreTransaction(params: Readonly<{
    sessionId: string;
    target: EntryRestoreTransactionTarget;
    nowMs: number;
    deadlineMs: number;
}>): EntryRestoreTransaction {
    const deadlineAtMs = params.nowMs + normalizeMs(params.deadlineMs);
    let state: EntryRestoreTransactionState = 'pending';
    let outcome: EntryRestoreTransactionOutcome | null = null;
    let issueCount = 1;

    if (params.target.kind === 'none') {
        issueCount = 0;
        close('no-target');
    }

    return {
        sessionId: params.sessionId,
        target: params.target,
        state: () => state,
        issueCount: () => issueCount,
        onObservation(observation, nowMs) {
            if (state === 'closed' || closeIfPastDeadline(nowMs)) {
                return { action: 'none' };
            }
            if (observation.status === 'aligned') {
                close('confirmed');
                return { action: 'none' };
            }
            if (state === 'pending') {
                state = 'confirming';
                issueCount += 1;
                return { action: 'issue-correction-write' };
            }
            // The single correction is spent: hold ownership without writing
            // until an aligned observation, a preemption, or the deadline.
            return { action: 'none' };
        },
        onTrustedUserScroll() {
            if (state === 'closed') return;
            close('preempted-user-scroll');
        },
        onDeadline(nowMs) {
            if (state === 'closed') return;
            closeIfPastDeadline(nowMs);
        },
        isClosed: () => state === 'closed',
        outcome: () => outcome,
    };

    function close(nextOutcome: EntryRestoreTransactionOutcome): void {
        state = 'closed';
        outcome = nextOutcome;
    }

    function closeIfPastDeadline(nowMs: number): boolean {
        if (nowMs < deadlineAtMs) return false;
        close('deadline');
        return true;
    }
}

function normalizeMs(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
