import { describe, expect, it } from 'vitest';

import {
    createEntryRestoreTransaction,
    type EntryRestoreTransaction,
    type EntryRestoreTransactionTarget,
} from './entryRestoreTransaction';

const anchorTarget: EntryRestoreTransactionTarget = { kind: 'anchor', index: 12, viewOffset: -84 };

function buildTransaction(overrides: Partial<{
    target: EntryRestoreTransactionTarget;
    nowMs: number;
    deadlineMs: number;
}> = {}) {
    return createEntryRestoreTransaction({
        sessionId: 'session-a',
        target: anchorTarget,
        nowMs: 1000,
        deadlineMs: 1500,
        ...overrides,
    });
}

describe('entry restore transaction', () => {
    it('only final verdicts can open a transaction; wait verdicts are rejected at the type level', () => {
        // Wait verdicts must be re-resolved by the host once fill settles / content measures.
        // Turning one into a transaction would close the entry phase as no-target prematurely
        // (releasing the reveal gate and entry ownership before any restore was attempted).
        // @ts-expect-error -- 'awaiting-fill-settle' is a wait verdict, not a transaction target
        const waitForFill: EntryRestoreTransactionTarget = { kind: 'none', reason: 'awaiting-fill-settle' };
        // @ts-expect-error -- 'content-unmeasured' is a wait verdict, not a transaction target
        const waitForMeasure: EntryRestoreTransactionTarget = { kind: 'none', reason: 'content-unmeasured' };
        // @ts-expect-error -- materialization happens before a transaction exists
        const materialize: EntryRestoreTransactionTarget = { kind: 'materialize-then-anchor', anchorSeqHint: null };
        expect([waitForFill, waitForMeasure, materialize]).toHaveLength(3);
    });

    it('exposes no re-issue surface (E1 structural guarantee)', () => {
        // E1: height churn during entry re-issued scroll writes through ad-hoc reaction
        // surfaces (content-size-change reapply). The transaction's ONLY write-authorizing
        // path is onObservation's single correction directive. Any new public surface added
        // here must be reviewed against that invariant before this pin is updated.
        const transaction = buildTransaction();
        const surface: Record<keyof EntryRestoreTransaction, true> = {
            sessionId: true,
            target: true,
            state: true,
            issueCount: true,
            onObservation: true,
            onTrustedUserScroll: true,
            onDeadline: true,
            isClosed: true,
            outcome: true,
        };
        expect(Object.keys(transaction).sort()).toEqual(Object.keys(surface).sort());
    });

    it('closes immediately with no-target when there is nothing to restore', () => {
        const transaction = buildTransaction({ target: { kind: 'none', reason: 'empty-transcript' } });

        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('no-target');
        expect(transaction.issueCount()).toBe(0);

        expect(transaction.onObservation({ status: 'misaligned' }, 1100)).toEqual({ action: 'none' });
        expect(transaction.issueCount()).toBe(0);
        expect(transaction.outcome()).toBe('no-target');
    });

    it('counts the initial write at creation and confirms on one aligned observation', () => {
        const transaction = buildTransaction();

        expect(transaction.state()).toBe('pending');
        expect(transaction.isClosed()).toBe(false);
        expect(transaction.issueCount()).toBe(1);
        expect(transaction.outcome()).toBeNull();

        expect(transaction.onObservation({ status: 'aligned' }, 1100)).toEqual({ action: 'none' });
        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('confirmed');
        expect(transaction.issueCount()).toBe(1);
    });

    it('allows exactly one correction write after a misaligned observation', () => {
        const transaction = buildTransaction();

        expect(transaction.onObservation({ status: 'misaligned' }, 1050)).toEqual({ action: 'issue-correction-write' });
        expect(transaction.state()).toBe('confirming');
        expect(transaction.isClosed()).toBe(false);
        expect(transaction.issueCount()).toBe(2);

        expect(transaction.onObservation({ status: 'aligned' }, 1120)).toEqual({ action: 'none' });
        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('confirmed');
        expect(transaction.issueCount()).toBe(2);
    });

    it('never re-issues writes during content-size churn after the correction (E1 trace shape)', () => {
        const transaction = buildTransaction({ nowMs: 1000, deadlineMs: 1500 });

        // E1: five content-height changes landed during entry and each one re-issued a
        // scroll write. Replayed against the transaction, each change surfaces as a
        // misaligned observation; only the first may produce the single correction write.
        const directives = [1050, 1180, 1320, 1410, 1490].map((nowMs) =>
            transaction.onObservation({ status: 'misaligned' }, nowMs).action,
        );

        expect(directives).toEqual(['issue-correction-write', 'none', 'none', 'none', 'none']);
        expect(transaction.issueCount()).toBe(2);
        expect(transaction.issueCount()).toBeLessThanOrEqual(2);
        expect(transaction.isClosed()).toBe(false);

        transaction.onDeadline(2500);
        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('deadline');
        expect(transaction.issueCount()).toBe(2);
    });

    it('closes as preempted when a trusted user scroll arrives', () => {
        const transaction = buildTransaction();

        transaction.onTrustedUserScroll();
        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('preempted-user-scroll');

        expect(transaction.onObservation({ status: 'misaligned' }, 1100)).toEqual({ action: 'none' });
        expect(transaction.issueCount()).toBe(1);
        expect(transaction.outcome()).toBe('preempted-user-scroll');
    });

    it('closes as preempted from the confirming state after the correction was spent', () => {
        const transaction = buildTransaction();

        expect(transaction.onObservation({ status: 'misaligned' }, 1050)).toEqual({ action: 'issue-correction-write' });
        transaction.onTrustedUserScroll();

        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('preempted-user-scroll');
        expect(transaction.issueCount()).toBe(2);
    });

    it('ignores early deadline checks and closes once the deadline passes', () => {
        const transaction = buildTransaction({ nowMs: 1000, deadlineMs: 1500 });

        transaction.onDeadline(2000);
        expect(transaction.isClosed()).toBe(false);

        transaction.onDeadline(2500);
        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('deadline');
    });

    it('drops observations that arrive past the deadline without issuing writes', () => {
        const transaction = buildTransaction({ nowMs: 1000, deadlineMs: 1500 });

        expect(transaction.onObservation({ status: 'misaligned' }, 2600)).toEqual({ action: 'none' });
        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('deadline');
        expect(transaction.issueCount()).toBe(1);
    });

    it('closes deadline-first even when a late observation is aligned', () => {
        // After the reveal deadline the entry owner must release ownership; a late aligned
        // observation still reports as deadline (unconfirmed within budget), never confirmed.
        const transaction = buildTransaction({ nowMs: 1000, deadlineMs: 1500 });

        expect(transaction.onObservation({ status: 'aligned' }, 2600)).toEqual({ action: 'none' });
        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('deadline');
        expect(transaction.issueCount()).toBe(1);
    });

    it('keeps the first outcome once closed', () => {
        const transaction = buildTransaction();

        transaction.onObservation({ status: 'aligned' }, 1100);
        expect(transaction.outcome()).toBe('confirmed');

        transaction.onTrustedUserScroll();
        transaction.onDeadline(9000);
        expect(transaction.outcome()).toBe('confirmed');
        expect(transaction.issueCount()).toBe(1);
    });
});
