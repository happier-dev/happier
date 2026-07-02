import type { PrependCapturedAnchor, PrependOutcome } from '@/components/sessions/transcript/viewport/prepend/observePrependOutcome';

export type PrependTransactionState = 'awaiting-commit' | 'committed' | 'closed';

export type PrependTransactionOutcome =
    | 'mvcp-preserved'
    | 'fallback-restored'
    | 'abandoned-user-scroll'
    | 'abandoned-identity'
    | 'abandoned-layout-timeout';

export type PrependTransactionWrite = Readonly<{
    write: Readonly<{ targetOffsetY: number }>;
}>;

/**
 * One native prepend = one transaction. Pure event-driven state machine (no React, no timers):
 *
 *   awaiting-commit --onCommit()--> committed --(one conclusive observation)--> closed
 *
 * There is intentionally NO TTL: a capture stays valid for however long the older-page load takes
 * (E5 regression). Expiry is data-driven instead — the anchor is invalid ONLY when the committed
 * items identity changed beyond mapping (`anchor-missing` → abandoned-identity). An
 * `identity-unchanged` observation is "not yet" (it can race ahead of the prepended items
 * propagating into the rendered array) and keeps the window open, bounded by the host-signalled
 * `onLayoutTimeout()` for post-commit layouts/data that never become observable. Host-known
 * no-ops (load yielded nothing, session changed, list unmounting) close through
 * `onCaptureInvalidated()` so disposal is never silent. A trusted user scroll preempts the
 * transaction at any time with zero writes.
 *
 * Invariant: at most ONE corrective write per transaction; `onObservationWindow` returns the write
 * exactly once (`needs-fallback`), then the transaction is closed and every later event is a no-op.
 */
export type PrependTransaction = Readonly<{
    sessionId: string;
    capturedAnchor: PrependCapturedAnchor;
    state(): PrependTransactionState;
    onCommit(): void;
    onObservationWindow(outcome: PrependOutcome): PrependTransactionWrite | null;
    onTrustedUserScroll(): void;
    onLayoutTimeout(): void;
    onCaptureInvalidated(): void;
    isClosed(): boolean;
    outcome(): PrependTransactionOutcome | null;
    writeCount(): number;
}>;

export function createPrependTransaction(params: Readonly<{
    sessionId: string;
    capturedAnchor: PrependCapturedAnchor;
}>): PrependTransaction {
    let state: PrependTransactionState = 'awaiting-commit';
    let outcome: PrependTransactionOutcome | null = null;
    let writeCount = 0;

    const close = (closedOutcome: PrependTransactionOutcome) => {
        state = 'closed';
        outcome = closedOutcome;
    };

    return {
        sessionId: params.sessionId,
        capturedAnchor: params.capturedAnchor,
        state: () => state,
        isClosed: () => state === 'closed',
        outcome: () => outcome,
        writeCount: () => writeCount,
        onCommit() {
            if (state !== 'awaiting-commit') return;
            state = 'committed';
        },
        onObservationWindow(observed) {
            if (state !== 'committed') return null;

            if (observed.kind === 'mvcp-preserved') {
                close('mvcp-preserved');
                return null;
            }
            if (observed.kind === 'needs-fallback') {
                writeCount += 1;
                close('fallback-restored');
                return { write: { targetOffsetY: observed.targetOffsetY } };
            }
            if (observed.reason === 'anchor-missing') {
                close('abandoned-identity');
                return null;
            }
            // 'layout-not-ready' | 'identity-unchanged': window stays open — the host re-observes
            // when layout/data lands or calls onLayoutTimeout().
            return null;
        },
        onTrustedUserScroll() {
            if (state === 'closed') return;
            close('abandoned-user-scroll');
        },
        onLayoutTimeout() {
            if (state !== 'committed') return;
            close('abandoned-layout-timeout');
        },
        onCaptureInvalidated() {
            if (state === 'closed') return;
            close('abandoned-identity');
        },
    };
}
