import type {
    TranscriptViewportTelemetryTransactionState,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type {
    TranscriptViewportControllerInput,
    TranscriptViewportOwner,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import {
    observePrependOutcome,
    type PrependCapturedAnchor,
    type PrependPostCommitObservation,
} from './observePrependOutcome';
import {
    resolveNativePrependCloseEffects,
    type NativePrependCloseEffect,
} from './prependCloseEffects';
import {
    createPrependTransaction,
    type PrependTransaction,
    type PrependTransactionOutcome,
} from './prependTransaction';

type ApplyHistoryCorrectionCommand = Extract<TranscriptViewportControllerInput, {
    type: 'apply-history-correction';
}>;

type NativePrependRestoreDecisionEffect =
    Omit<Extract<NativePrependCloseEffect, { type: 'restore-decision-for-session' }>, 'type'>
    & Readonly<{ type: 'record-restore-decision-for-session' }>;

export type NativePrependOwnerEffect =
    | Readonly<{
        sessionId: string;
        type: 'preempt-entry-restore-for-prepend';
    }>
    | Readonly<{
        sessionId: string;
        type: 'open-prepend-ownership';
    }>
    | Readonly<{
        outcome: PrependTransactionOutcome;
        sessionId: string;
        type: 'close-prepend-ownership';
    }>
    | Readonly<{
        command: ApplyHistoryCorrectionCommand;
        type: 'execute-command';
    }>
    | Readonly<{
        delayMs: number;
        sessionId: string;
        type: 'schedule-layout-timeout';
    }>
    | Readonly<{
        sessionId: string;
        type: 'clear-layout-timeout';
    }>
    | Readonly<{
        delayMs: number;
        sessionId: string;
        type: 'schedule-corrector-reobserve';
    }>
    | Readonly<{
        sessionId: string;
        type: 'clear-corrector-reobserve';
    }>
    | Readonly<{
        sessionId: string;
        type: 'bump-transaction-revision';
    }>
    | NativePrependRestoreDecisionEffect;

export type NativePrependBeginInput = Readonly<{
    activeOwner: TranscriptViewportOwner;
    capturedAnchor: PrependCapturedAnchor | null;
    contentHeight: number;
    layoutHeight: number;
    preservePrependViewport: boolean;
    sessionId: string;
}>;

export type NativePrependObservationInput = Readonly<{
    activeOwner: TranscriptViewportOwner;
    postCommit: PrependPostCommitObservation;
    sessionId: string;
}>;

export type NativePrependOwner = Readonly<{
    armCommit(params: Readonly<{
        layoutTimeoutMs: number;
        sessionId: string;
    }>): readonly NativePrependOwnerEffect[];
    begin(params: NativePrependBeginInput): readonly NativePrependOwnerEffect[];
    dispose(params: Readonly<{
        activeOwner?: TranscriptViewportOwner;
        currentSessionId: string;
    }>): readonly NativePrependOwnerEffect[];
    disposeForExit(params: Readonly<{
        activeOwner?: TranscriptViewportOwner;
        currentSessionId: string;
    }>): readonly NativePrependOwnerEffect[];
    hasOpenTransaction(sessionId: string): boolean;
    invalidate(params: Readonly<{
        activeOwner?: TranscriptViewportOwner;
        reason: 'identity' | 'session-entry' | 'load-empty' | 'jump' | 'dispose' | 'ownership-rejected';
        sessionId?: string;
    }>): readonly NativePrependOwnerEffect[];
    observe(params: NativePrependObservationInput): readonly NativePrependOwnerEffect[];
    recordCorrectorCorrection(params: Readonly<{
        diffPx: number;
        sessionId: string;
    }>): readonly NativePrependOwnerEffect[];
    runCorrectorReobserve(params: NativePrependObservationInput): readonly NativePrependOwnerEffect[];
    runLayoutTimeout(params: NativePrependObservationInput): readonly NativePrependOwnerEffect[];
    telemetryState(sessionId: string): TranscriptViewportTelemetryTransactionState;
    trustedScroll(params: Readonly<{
        activeOwner?: TranscriptViewportOwner;
        sessionId: string;
    }>): readonly NativePrependOwnerEffect[];
}>;

export function createNativePrependOwner(): NativePrependOwner {
    let transaction: PrependTransaction | null = null;
    let layoutTimeoutScheduled = false;
    let correctorReobserveScheduled = false;
    let lastClosedSessionId: string | null = null;

    function begin(params: NativePrependBeginInput): readonly NativePrependOwnerEffect[] {
        if (params.activeOwner === 'entry') {
            return [{ sessionId: params.sessionId, type: 'preempt-entry-restore-for-prepend' }];
        }
        if (!isValidBeginInput(params)) return [];

        const replacementEffects = transaction == null
            ? []
            : invalidate({ activeOwner: params.activeOwner, reason: 'identity', sessionId: params.sessionId });

        transaction = createPrependTransaction({
            capturedAnchor: params.capturedAnchor,
            sessionId: params.sessionId,
        });
        layoutTimeoutScheduled = false;
        correctorReobserveScheduled = false;
        lastClosedSessionId = null;

        return [
            ...replacementEffects,
            { sessionId: params.sessionId, type: 'bump-transaction-revision' },
        ];
    }

    function armCommit(params: Readonly<{
        layoutTimeoutMs: number;
        sessionId: string;
    }>): readonly NativePrependOwnerEffect[] {
        if (
            transaction == null ||
            transaction.sessionId !== params.sessionId ||
            transaction.isClosed() ||
            transaction.state() !== 'awaiting-commit'
        ) {
            return [];
        }

        transaction.onCommit();
        layoutTimeoutScheduled = true;
        return [
            { sessionId: params.sessionId, type: 'open-prepend-ownership' },
            {
                delayMs: normalizeDelayMs(params.layoutTimeoutMs),
                sessionId: params.sessionId,
                type: 'schedule-layout-timeout',
            },
            { sessionId: params.sessionId, type: 'bump-transaction-revision' },
        ];
    }

    function observe(params: NativePrependObservationInput): readonly NativePrependOwnerEffect[] {
        const current = transaction;
        if (current == null) return [];
        if (current.sessionId !== params.sessionId) {
            current.onCaptureInvalidated();
            return finishTransaction(params.activeOwner);
        }
        if (current.isClosed()) return finishTransaction(params.activeOwner);
        if (current.state() !== 'committed') return [];

        const outcome = observePrependOutcome({
            capturedAnchor: current.capturedAnchor,
            correctorCoverage: current.correctorCoverage(),
            postCommit: params.postCommit,
        });
        return applyObservationOutcome(current, params.activeOwner, outcome);
    }

    function runCorrectorReobserve(params: NativePrependObservationInput): readonly NativePrependOwnerEffect[] {
        return observe(params);
    }

    function runLayoutTimeout(params: NativePrependObservationInput): readonly NativePrependOwnerEffect[] {
        const current = transaction;
        if (current == null) return [];
        if (current.sessionId !== params.sessionId) {
            current.onCaptureInvalidated();
            return finishTransaction(params.activeOwner);
        }
        if (current.isClosed()) return finishTransaction(params.activeOwner);
        if (current.state() !== 'committed') return [];

        const outcome = observePrependOutcome({
            capturedAnchor: current.capturedAnchor,
            correctorCoverage: current.correctorCoverage(),
            postCommit: params.postCommit,
        });
        if (outcome.kind === 'mvcp-preserved' || outcome.kind === 'needs-fallback') {
            return applyObservationOutcome(current, params.activeOwner, outcome);
        }
        current.onLayoutTimeout();
        return finishTransaction(params.activeOwner);
    }

    function recordCorrectorCorrection(params: Readonly<{
        diffPx: number;
        sessionId: string;
    }>): readonly NativePrependOwnerEffect[] {
        const current = transaction;
        if (
            current == null ||
            current.sessionId !== params.sessionId ||
            current.isClosed()
        ) {
            return [];
        }
        const previousEventCount = current.correctorCoverage().eventCount;
        current.onCorrectorCorrectionApplied(params.diffPx);
        const nextEventCount = current.correctorCoverage().eventCount;
        if (
            nextEventCount === previousEventCount ||
            current.state() !== 'committed' ||
            correctorReobserveScheduled
        ) {
            return [];
        }
        correctorReobserveScheduled = true;
        return [{ delayMs: 0, sessionId: params.sessionId, type: 'schedule-corrector-reobserve' }];
    }

    function trustedScroll(params: Readonly<{
        activeOwner?: TranscriptViewportOwner;
        sessionId: string;
    }>): readonly NativePrependOwnerEffect[] {
        if (
            transaction == null ||
            transaction.sessionId !== params.sessionId ||
            transaction.isClosed()
        ) {
            return [];
        }
        transaction.onTrustedUserScroll();
        return finishTransaction(params.activeOwner ?? 'idle');
    }

    function invalidate(params: Readonly<{
        activeOwner?: TranscriptViewportOwner;
        reason: 'identity' | 'session-entry' | 'load-empty' | 'jump' | 'dispose' | 'ownership-rejected';
        sessionId?: string;
    }>): readonly NativePrependOwnerEffect[] {
        void params.reason;
        void params.sessionId;
        if (transaction == null) return [];
        if (!transaction.isClosed()) {
            transaction.onCaptureInvalidated();
        }
        return finishTransaction(params.activeOwner ?? 'idle');
    }

    function dispose(params: Readonly<{
        activeOwner?: TranscriptViewportOwner;
        currentSessionId: string;
    }>): readonly NativePrependOwnerEffect[] {
        void params.currentSessionId;
        return invalidate({ activeOwner: params.activeOwner, reason: 'dispose' });
    }

    function hasOpenTransaction(sessionId: string): boolean {
        return transaction?.sessionId === sessionId && !transaction.isClosed();
    }

    function telemetryState(sessionId: string): TranscriptViewportTelemetryTransactionState {
        if (hasOpenTransaction(sessionId)) return 'open';
        if (lastClosedSessionId === sessionId) return 'closed';
        return 'none';
    }

    function applyObservationOutcome(
        current: PrependTransaction,
        activeOwner: TranscriptViewportOwner,
        outcome: Parameters<PrependTransaction['onObservationWindow']>[0],
    ): readonly NativePrependOwnerEffect[] {
        const write = current.onObservationWindow(outcome);
        const effects: NativePrependOwnerEffect[] = [];
        if (write != null) {
            effects.push({
                command: {
                    animated: false,
                    reason: 'prepend-restore',
                    sessionId: current.sessionId,
                    targetDistanceFromHistoryStartPx: write.write.targetOffsetY,
                    type: 'apply-history-correction',
                },
                type: 'execute-command',
            });
        }
        if (current.isClosed()) {
            effects.push(...finishTransaction(activeOwner));
        }
        return effects;
    }

    function finishTransaction(activeOwner: TranscriptViewportOwner): readonly NativePrependOwnerEffect[] {
        const current = transaction;
        if (current == null) return [];

        transaction = null;
        lastClosedSessionId = current.sessionId;

        const effects: NativePrependOwnerEffect[] = [
            ...cleanupTimerEffects(current.sessionId),
            ...mapCloseEffects(current, activeOwner),
            { sessionId: current.sessionId, type: 'bump-transaction-revision' },
        ];
        return effects;
    }

    function cleanupTimerEffects(sessionId: string): readonly NativePrependOwnerEffect[] {
        const effects: NativePrependOwnerEffect[] = [];
        if (layoutTimeoutScheduled) {
            effects.push({ sessionId, type: 'clear-layout-timeout' });
        }
        if (correctorReobserveScheduled) {
            effects.push({ sessionId, type: 'clear-corrector-reobserve' });
        }
        layoutTimeoutScheduled = false;
        correctorReobserveScheduled = false;
        return effects;
    }

    return {
        armCommit,
        begin,
        dispose,
        disposeForExit: dispose,
        hasOpenTransaction,
        invalidate,
        observe,
        recordCorrectorCorrection,
        runCorrectorReobserve,
        runLayoutTimeout,
        telemetryState,
        trustedScroll,
    };
}

function mapCloseEffects(
    transaction: PrependTransaction,
    activeOwner: TranscriptViewportOwner,
): readonly NativePrependOwnerEffect[] {
    return resolveNativePrependCloseEffects({
        activeOwnerIsPrepend: activeOwner === 'prepend',
        anchorDeltaPx: transaction.conclusiveAnchorDeltaPx(),
        anchorItemOffsetPx: transaction.capturedAnchor.itemOffsetPx,
        correctorCoverage: transaction.correctorCoverage(),
        outcome: transaction.outcome(),
        sessionId: transaction.sessionId,
    }).map((effect): NativePrependOwnerEffect => {
        if (effect.type === 'close-prepend-ownership') {
            return {
                outcome: effect.outcome,
                sessionId: transaction.sessionId,
                type: 'close-prepend-ownership',
            };
        }
        return {
            ...effect,
            type: 'record-restore-decision-for-session',
        };
    });
}

function isValidBeginInput(params: NativePrependBeginInput): params is NativePrependBeginInput & Readonly<{
    capturedAnchor: PrependCapturedAnchor;
}> {
    const anchor = params.capturedAnchor;
    return (
        params.preservePrependViewport &&
        Number.isFinite(params.layoutHeight) &&
        params.layoutHeight > 0 &&
        Number.isFinite(params.contentHeight) &&
        params.contentHeight > params.layoutHeight + 1 &&
        anchor != null &&
        typeof anchor.key.itemId === 'string' &&
        anchor.key.itemId.length > 0 &&
        Number.isFinite(anchor.itemOffsetPx) &&
        Number.isFinite(anchor.capturedDataLength) &&
        anchor.capturedDataLength >= 0
    );
}

function normalizeDelayMs(value: number): number {
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.trunc(value);
}
