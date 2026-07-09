import { describe, expect, it } from 'vitest';

import type { PrependCapturedAnchor, PrependOutcome } from '@/components/sessions/transcript/viewport/prepend/observePrependOutcome';
import { createPrependTransaction } from '@/components/sessions/transcript/viewport/prepend/prependTransaction';

function capturedAnchor(): PrependCapturedAnchor {
    return {
        key: { itemId: 'msg:m3', messageId: 'm3' },
        itemOffsetPx: 80,
        capturedDataLength: 3,
        capturedFirstItemId: 'msg:m3',
    };
}

const preserved: PrependOutcome = { kind: 'mvcp-preserved', observedItemOffsetPx: 80, deltaPx: 0 };
const needsFallback: PrependOutcome = { kind: 'needs-fallback', targetOffsetY: 820, deltaPx: -80 };
const layoutNotReady: PrependOutcome = { kind: 'unresolvable', reason: 'layout-not-ready' };
const identityUnchanged: PrependOutcome = { kind: 'unresolvable', reason: 'identity-unchanged' };
const anchorMissing: PrependOutcome = { kind: 'unresolvable', reason: 'anchor-missing' };

function createTransaction() {
    return createPrependTransaction({ sessionId: 'session-1', capturedAnchor: capturedAnchor() });
}

describe('createPrependTransaction', () => {
    it('starts awaiting commit with no outcome and no writes', () => {
        const transaction = createTransaction();
        expect(transaction.state()).toBe('awaiting-commit');
        expect(transaction.isClosed()).toBe(false);
        expect(transaction.outcome()).toBeNull();
        expect(transaction.writeCount()).toBe(0);
        expect(transaction.sessionId).toBe('session-1');
        expect(transaction.capturedAnchor).toEqual(capturedAnchor());
    });

    it('ignores observation windows before commit (no premature write)', () => {
        const transaction = createTransaction();
        expect(transaction.onObservationWindow(needsFallback)).toBeNull();
        expect(transaction.state()).toBe('awaiting-commit');
        expect(transaction.writeCount()).toBe(0);
    });

    it('closes mvcp-preserved with zero writes when the observation confirms MVCP held', () => {
        const transaction = createTransaction();
        transaction.onCommit();
        expect(transaction.state()).toBe('committed');

        expect(transaction.onObservationWindow(preserved)).toBeNull();
        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('mvcp-preserved');
        expect(transaction.writeCount()).toBe(0);
    });

    it('issues the fallback write exactly once and closes fallback-restored', () => {
        const transaction = createTransaction();
        transaction.onCommit();

        expect(transaction.onObservationWindow(needsFallback)).toEqual({ write: { targetOffsetY: 820 } });
        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('fallback-restored');
        expect(transaction.writeCount()).toBe(1);

        // Invariant: never more than one write, even if a window fires again.
        expect(transaction.onObservationWindow(needsFallback)).toBeNull();
        expect(transaction.writeCount()).toBe(1);
        expect(transaction.outcome()).toBe('fallback-restored');
    });

    it('E5 regression: a slow load (many pre-commit and not-ready windows, no TTL) still restores', () => {
        const transaction = createTransaction();

        // Long in-flight load: stray observation windows and layout timeouts must not expire the capture.
        for (let i = 0; i < 25; i += 1) {
            expect(transaction.onObservationWindow(layoutNotReady)).toBeNull();
        }
        transaction.onLayoutTimeout();
        expect(transaction.isClosed()).toBe(false);

        transaction.onCommit();
        // Layout settles slowly after commit: not-ready observations keep the single window open.
        for (let i = 0; i < 10; i += 1) {
            expect(transaction.onObservationWindow(layoutNotReady)).toBeNull();
            expect(transaction.state()).toBe('committed');
        }

        expect(transaction.onObservationWindow(needsFallback)).toEqual({ write: { targetOffsetY: 820 } });
        expect(transaction.outcome()).toBe('fallback-restored');
        expect(transaction.writeCount()).toBe(1);
    });

    it('abandons with zero writes when the user scrolls mid-flight before commit', () => {
        const transaction = createTransaction();
        transaction.onTrustedUserScroll();

        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('abandoned-user-scroll');
        expect(transaction.writeCount()).toBe(0);

        transaction.onCommit();
        expect(transaction.state()).toBe('closed');
        expect(transaction.onObservationWindow(needsFallback)).toBeNull();
        expect(transaction.writeCount()).toBe(0);
    });

    it('abandons with zero writes when the user scrolls during the observation window', () => {
        const transaction = createTransaction();
        transaction.onCommit();
        transaction.onTrustedUserScroll();

        expect(transaction.outcome()).toBe('abandoned-user-scroll');
        expect(transaction.onObservationWindow(needsFallback)).toBeNull();
        expect(transaction.writeCount()).toBe(0);
    });

    it('keeps the window open on identity-unchanged so a premature observation cannot close the transaction', () => {
        // The observation can race ahead of the prepended items propagating into the rendered
        // array; an unchanged snapshot is "not yet", never a terminal verdict (plan C2: the anchor
        // is invalid ONLY when identity changed beyond mapping).
        const transaction = createTransaction();
        transaction.onCommit();

        expect(transaction.onObservationWindow(identityUnchanged)).toBeNull();
        expect(transaction.isClosed()).toBe(false);
        expect(transaction.state()).toBe('committed');
        expect(transaction.writeCount()).toBe(0);

        // Once the items land, the same single window still resolves conclusively.
        expect(transaction.onObservationWindow(needsFallback)).toEqual({ write: { targetOffsetY: 820 } });
        expect(transaction.outcome()).toBe('fallback-restored');
        expect(transaction.writeCount()).toBe(1);
    });

    it('closes abandoned-identity with zero writes when the host invalidates the capture before commit', () => {
        // Host-known no-ops: the older-page load yielded nothing, the session changed mid-flight,
        // or the list is unmounting. Disposal must surface an outcome, never drop silently.
        const transaction = createTransaction();
        transaction.onCaptureInvalidated();

        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('abandoned-identity');
        expect(transaction.writeCount()).toBe(0);

        transaction.onCommit();
        expect(transaction.onObservationWindow(needsFallback)).toBeNull();
        expect(transaction.writeCount()).toBe(0);
    });

    it('closes abandoned-identity when the host invalidates the capture during the observation window', () => {
        const transaction = createTransaction();
        transaction.onCommit();
        expect(transaction.onObservationWindow(layoutNotReady)).toBeNull();

        transaction.onCaptureInvalidated();
        expect(transaction.outcome()).toBe('abandoned-identity');
        expect(transaction.onObservationWindow(needsFallback)).toBeNull();
        expect(transaction.writeCount()).toBe(0);
    });

    it('closes abandoned-identity when the anchor is no longer mappable to the committed data', () => {
        const transaction = createTransaction();
        transaction.onCommit();

        expect(transaction.onObservationWindow(anchorMissing)).toBeNull();
        expect(transaction.outcome()).toBe('abandoned-identity');
        expect(transaction.writeCount()).toBe(0);
    });

    it('closes abandoned-layout-timeout when layout never becomes observable after commit', () => {
        const transaction = createTransaction();
        transaction.onCommit();
        expect(transaction.onObservationWindow(layoutNotReady)).toBeNull();

        transaction.onLayoutTimeout();
        expect(transaction.isClosed()).toBe(true);
        expect(transaction.outcome()).toBe('abandoned-layout-timeout');
        expect(transaction.writeCount()).toBe(0);
    });

    it('ignores layout timeout before commit (load duration must never expire the transaction)', () => {
        const transaction = createTransaction();
        transaction.onLayoutTimeout();

        expect(transaction.isClosed()).toBe(false);
        expect(transaction.state()).toBe('awaiting-commit');

        transaction.onCommit();
        expect(transaction.onObservationWindow(preserved)).toBeNull();
        expect(transaction.outcome()).toBe('mvcp-preserved');
    });

    it('treats commit as idempotent and keeps closed outcomes stable', () => {
        const transaction = createTransaction();
        transaction.onCommit();
        transaction.onCommit();
        expect(transaction.state()).toBe('committed');

        expect(transaction.onObservationWindow(preserved)).toBeNull();
        const closedOutcome = transaction.outcome();

        transaction.onCommit();
        transaction.onTrustedUserScroll();
        transaction.onLayoutTimeout();
        transaction.onCaptureInvalidated();
        expect(transaction.onObservationWindow(needsFallback)).toBeNull();

        expect(transaction.outcome()).toBe(closedOutcome);
        expect(transaction.writeCount()).toBe(0);
        expect(transaction.state()).toBe('closed');
    });
});

describe('createPrependTransaction corrector coverage (N2d.1)', () => {
    it('starts with empty coverage', () => {
        const transaction = createTransaction();
        expect(transaction.correctorCoverage()).toEqual({ appliedDiffTotalPx: 0, eventCount: 0 });
    });

    it('accumulates corrections across the whole open window, including before commit', () => {
        const transaction = createTransaction();
        transaction.onCorrectorCorrectionApplied(2640);
        transaction.onCommit();
        transaction.onCorrectorCorrectionApplied(-47);
        transaction.onCorrectorCorrectionApplied(52);
        expect(transaction.correctorCoverage()).toEqual({ appliedDiffTotalPx: 2645, eventCount: 3 });
    });

    it('ignores corrections after the transaction closed', () => {
        const transaction = createTransaction();
        transaction.onCommit();
        transaction.onObservationWindow(preserved);
        expect(transaction.isClosed()).toBe(true);
        transaction.onCorrectorCorrectionApplied(120);
        expect(transaction.correctorCoverage()).toEqual({ appliedDiffTotalPx: 0, eventCount: 0 });
    });

    it('drops non-finite and zero diffs', () => {
        const transaction = createTransaction();
        transaction.onCorrectorCorrectionApplied(Number.NaN);
        transaction.onCorrectorCorrectionApplied(Number.POSITIVE_INFINITY);
        transaction.onCorrectorCorrectionApplied(0);
        expect(transaction.correctorCoverage()).toEqual({ appliedDiffTotalPx: 0, eventCount: 0 });
    });
});

describe('createPrependTransaction conclusive anchor delta (R1 gap)', () => {
    it('records the conclusive observation deltaPx on mvcp-preserved', () => {
        const transaction = createTransaction();
        transaction.onCommit();
        transaction.onObservationWindow({ kind: 'mvcp-preserved', observedItemOffsetPx: 82, deltaPx: 2 });
        expect(transaction.conclusiveAnchorDeltaPx()).toBe(2);
    });

    it('records the conclusive observation deltaPx on fallback-restored', () => {
        const transaction = createTransaction();
        transaction.onCommit();
        transaction.onObservationWindow(needsFallback);
        expect(transaction.conclusiveAnchorDeltaPx()).toBe(-80);
    });

    it('stays null for abandoned outcomes', () => {
        const transaction = createTransaction();
        transaction.onCommit();
        transaction.onTrustedUserScroll();
        expect(transaction.conclusiveAnchorDeltaPx()).toBeNull();
    });
});
