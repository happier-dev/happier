import { describe, expect, it } from 'vitest';

import type { PrependCapturedAnchor, PrependPostCommitObservation } from './observePrependOutcome';
import {
    createNativePrependOwner,
    type NativePrependBeginInput,
    type NativePrependObservationInput,
    type NativePrependOwnerEffect,
} from './nativePrependOwner';

type Item = Readonly<{ id: string; kind: 'message'; messageId: string }>;

function messageItem(messageId: string): Item {
    return { id: `msg:${messageId}`, kind: 'message', messageId };
}

function capturedAnchor(overrides?: Partial<PrependCapturedAnchor>): PrependCapturedAnchor {
    return {
        key: { itemId: 'msg:m3', messageId: 'm3' },
        itemOffsetPx: 80,
        capturedDataLength: 3,
        capturedFirstItemId: 'msg:m3',
        ...overrides,
    };
}

function beginInput(overrides?: Partial<NativePrependBeginInput>): NativePrependBeginInput {
    return {
        activeOwner: 'follow',
        capturedAnchor: capturedAnchor(),
        contentHeight: 1500,
        layoutHeight: 300,
        preservePrependViewport: true,
        sessionId: 'session-a',
        ...overrides,
    };
}

function postCommit(params: Readonly<{
    absoluteScrollOffset: number;
    contentHeight?: number;
    items?: readonly Item[];
    layoutHeight?: number;
    layoutYByIndex: Readonly<Record<number, number>>;
}>): PrependPostCommitObservation {
    return {
        absoluteScrollOffset: params.absoluteScrollOffset,
        contentHeight: params.contentHeight ?? 1500,
        getLayout: (index) => {
            const y = params.layoutYByIndex[index];
            return typeof y === 'number' ? { y } : undefined;
        },
        items: params.items ?? [
            messageItem('m1'),
            messageItem('m2'),
            messageItem('m3'),
            messageItem('m4'),
            messageItem('m5'),
        ],
        layoutHeight: params.layoutHeight ?? 300,
    };
}

function preservedObservation(): PrependPostCommitObservation {
    return postCommit({
        absoluteScrollOffset: 820,
        layoutYByIndex: { 0: 0, 1: 450, 2: 900, 3: 1100, 4: 1300 },
    });
}

function misalignedObservation(): PrependPostCommitObservation {
    return postCommit({
        absoluteScrollOffset: 0,
        layoutYByIndex: { 0: 0, 1: 450, 2: 900, 3: 1100, 4: 1300 },
    });
}

function unchangedObservation(): PrependPostCommitObservation {
    return postCommit({
        absoluteScrollOffset: 0,
        items: [messageItem('m3'), messageItem('m4'), messageItem('m5')],
        layoutYByIndex: { 0: 0, 1: 200, 2: 400 },
    });
}

function observationInput(overrides?: Partial<NativePrependObservationInput>): NativePrependObservationInput {
    return {
        activeOwner: 'prepend',
        nowMs: 1_000,
        postCommit: preservedObservation(),
        sessionId: 'session-a',
        ...overrides,
    };
}

function effectTypes(effects: readonly NativePrependOwnerEffect[]): readonly NativePrependOwnerEffect['type'][] {
    return effects.map((effect) => effect.type);
}

function effectsOfType<TType extends NativePrependOwnerEffect['type']>(
    effects: readonly NativePrependOwnerEffect[],
    type: TType,
): readonly Extract<NativePrependOwnerEffect, { type: TType }>[] {
    return effects.filter((effect): effect is Extract<NativePrependOwnerEffect, { type: TType }> => effect.type === type);
}

function executeEffects(effects: readonly NativePrependOwnerEffect[]) {
    return effectsOfType(effects, 'execute-command');
}

describe('native prepend owner', () => {
    it('begin stores an awaiting native prepend transaction and skips invalid or pinned-like inputs', () => {
        const owner = createNativePrependOwner();

        const effects = owner.begin(beginInput());

        expect(owner.hasOpenTransaction('session-a')).toBe(true);
        expect(owner.telemetryState('session-a')).toBe('open');
        expect(effectTypes(effects)).toContain('bump-transaction-revision');
        expect(executeEffects(effects)).toEqual([]);

        for (const input of [
            beginInput({ capturedAnchor: null }),
            beginInput({ preservePrependViewport: false }),
            beginInput({ layoutHeight: 0 }),
            beginInput({ contentHeight: 300 }),
            beginInput({ capturedAnchor: capturedAnchor({ itemOffsetPx: Number.NaN }) }),
            beginInput({ capturedAnchor: capturedAnchor({ key: { itemId: '', messageId: 'm3' } }) }),
        ]) {
            const skippedOwner = createNativePrependOwner();
            expect(skippedOwner.begin(input)).toEqual([]);
            expect(skippedOwner.hasOpenTransaction(input.sessionId)).toBe(false);
            expect(skippedOwner.telemetryState(input.sessionId)).toBe('none');
        }
    });

    it('begin requests entry preemption before opening prepend ownership', () => {
        const owner = createNativePrependOwner();

        const effects = owner.begin(beginInput({ activeOwner: 'entry' }));

        expect(effects).toEqual([
            { sessionId: 'session-a', type: 'preempt-entry-restore-for-prepend' },
        ]);
        expect(owner.hasOpenTransaction('session-a')).toBe(false);
        expect(owner.telemetryState('session-a')).toBe('none');
    });

    it('armCommit opens prepend ownership and schedules one layout timeout', () => {
        const owner = createNativePrependOwner();
        owner.begin(beginInput());

        const effects = owner.armCommit({ layoutTimeoutMs: 750, sessionId: 'session-a' });

        expect(effects).toEqual([
            { sessionId: 'session-a', type: 'open-prepend-ownership' },
            { delayMs: 750, sessionId: 'session-a', type: 'schedule-layout-timeout' },
            { sessionId: 'session-a', type: 'bump-transaction-revision' },
        ]);
        expect(owner.armCommit({ layoutTimeoutMs: 750, sessionId: 'session-a' })).toEqual([]);
    });

    it('mvcp-preserved observation closes with zero command writes and attributed telemetry', () => {
        const owner = createNativePrependOwner();
        owner.begin(beginInput());
        owner.armCommit({ layoutTimeoutMs: 750, sessionId: 'session-a' });

        const effects = owner.observe(observationInput());

        expect(executeEffects(effects)).toEqual([]);
        expect(effects).toContainEqual({
            outcome: 'mvcp-preserved',
            sessionId: 'session-a',
            type: 'close-prepend-ownership',
        });
        expect(effects).toContainEqual(expect.objectContaining({
            anchorDeltaPx: 0,
            anchorItemOffsetPx: 80,
            correctorAppliedDiffTotalPx: 0,
            correctorEventCount: 0,
            mode: 'restore-anchor',
            reason: 'mvcp-preserved',
            sessionId: 'session-a',
            type: 'record-restore-decision-for-session',
        }));
        expect(effectTypes(effects)).toContain('clear-layout-timeout');
        expect(effectTypes(effects)).toContain('bump-transaction-revision');
        expect(owner.telemetryState('session-a')).toBe('closed');
    });

    it('needs-fallback waits for quiet gate before issuing exactly one apply-history-correction command', () => {
        const owner = createNativePrependOwner();
        owner.begin(beginInput());
        owner.armCommit({ layoutTimeoutMs: 750, sessionId: 'session-a' });

        const first = owner.observe(observationInput({
            nowMs: 1_000,
            postCommit: misalignedObservation(),
        }));

        expect(executeEffects(first)).toEqual([]);
        const quietSchedule = effectsOfType(first, 'schedule-quiet-reobserve')[0];
        expect(quietSchedule).toMatchObject({ sessionId: 'session-a', type: 'schedule-quiet-reobserve' });
        expect(quietSchedule.delayMs).toBeGreaterThan(0);
        expect(owner.hasOpenTransaction('session-a')).toBe(true);

        const second = owner.runQuietReobserve(observationInput({
            nowMs: 1_000 + quietSchedule.delayMs,
            postCommit: misalignedObservation(),
        }));

        expect(executeEffects(second)).toEqual([
            {
                command: {
                    animated: false,
                    reason: 'prepend-restore',
                    sessionId: 'session-a',
                    targetDistanceFromHistoryStartPx: 820,
                    type: 'apply-history-correction',
                },
                type: 'execute-command',
            },
        ]);
        expect(effectsOfType(second, 'close-prepend-ownership')).toEqual([
            { outcome: 'fallback-restored', sessionId: 'session-a', type: 'close-prepend-ownership' },
        ]);

        const afterClose = owner.observe(observationInput({
            nowMs: 2_000,
            postCommit: misalignedObservation(),
        }));
        expect(executeEffects(afterClose)).toEqual([]);
    });

    it('corrector-covered residual closes mvcp-preserved and clears quiet/corrector timers', () => {
        const owner = createNativePrependOwner();
        owner.begin(beginInput());
        owner.armCommit({ layoutTimeoutMs: 750, sessionId: 'session-a' });

        owner.observe(observationInput({
            nowMs: 1_000,
            postCommit: misalignedObservation(),
        }));
        const correctorEffects = owner.recordCorrectorCorrection({
            diffPx: 820,
            sessionId: 'session-a',
        });

        expect(correctorEffects).toEqual([
            { delayMs: 0, sessionId: 'session-a', type: 'schedule-corrector-reobserve' },
        ]);

        const effects = owner.runCorrectorReobserve(observationInput({
            nowMs: 1_001,
            postCommit: misalignedObservation(),
        }));

        expect(executeEffects(effects)).toEqual([]);
        expect(effectsOfType(effects, 'close-prepend-ownership')).toEqual([
            { outcome: 'mvcp-preserved', sessionId: 'session-a', type: 'close-prepend-ownership' },
        ]);
        expect(effects).toContainEqual(expect.objectContaining({
            anchorDeltaPx: 820,
            correctorAppliedDiffTotalPx: 820,
            correctorEventCount: 1,
            reason: 'mvcp-preserved',
            sessionId: 'session-a',
            type: 'record-restore-decision-for-session',
        }));
        expect(effectTypes(effects)).toContain('clear-quiet-reobserve');
        expect(effectTypes(effects)).toContain('clear-corrector-reobserve');
    });

    it('trusted scroll preempts open native prepend with zero writes', () => {
        const owner = createNativePrependOwner();
        owner.begin(beginInput());
        owner.armCommit({ layoutTimeoutMs: 750, sessionId: 'session-a' });

        const effects = owner.trustedScroll({ activeOwner: 'prepend', sessionId: 'session-a' });

        expect(executeEffects(effects)).toEqual([]);
        expect(effectsOfType(effects, 'close-prepend-ownership')).toEqual([
            { outcome: 'abandoned-user-scroll', sessionId: 'session-a', type: 'close-prepend-ownership' },
        ]);
        expect(effects).toContainEqual(expect.objectContaining({
            reason: 'abandoned-user-scroll',
            sessionId: 'session-a',
            type: 'record-restore-decision-for-session',
        }));
    });

    it('invalidate and dispose telemeter the transaction session and cannot write into the next session', () => {
        const invalidated = createNativePrependOwner();
        invalidated.begin(beginInput({ sessionId: 'session-a' }));
        invalidated.armCommit({ layoutTimeoutMs: 750, sessionId: 'session-a' });

        const invalidateEffects = invalidated.invalidate({
            activeOwner: 'prepend',
            reason: 'session-entry',
            sessionId: 'session-b',
        });

        expect(executeEffects(invalidateEffects)).toEqual([]);
        expect(invalidateEffects).toContainEqual(expect.objectContaining({
            reason: 'abandoned-identity',
            sessionId: 'session-a',
            type: 'record-restore-decision-for-session',
        }));
        expect(invalidated.telemetryState('session-a')).toBe('closed');
        expect(invalidated.telemetryState('session-b')).toBe('none');

        const disposed = createNativePrependOwner();
        disposed.begin(beginInput({ sessionId: 'session-a' }));
        disposed.armCommit({ layoutTimeoutMs: 750, sessionId: 'session-a' });

        const disposeEffects = disposed.dispose({ activeOwner: 'prepend', currentSessionId: 'session-b' });

        expect(executeEffects(disposeEffects)).toEqual([]);
        expect(disposeEffects).toContainEqual(expect.objectContaining({
            reason: 'abandoned-identity',
            sessionId: 'session-a',
            type: 'record-restore-decision-for-session',
        }));
        expect(disposed.telemetryState('session-a')).toBe('closed');
        expect(disposed.telemetryState('session-b')).toBe('none');
    });

    it('layout timeout spends conclusive fallback if available, otherwise abandons layout timeout', () => {
        const conclusive = createNativePrependOwner();
        conclusive.begin(beginInput());
        conclusive.armCommit({ layoutTimeoutMs: 750, sessionId: 'session-a' });

        const conclusiveEffects = conclusive.runLayoutTimeout(observationInput({
            nowMs: 1_750,
            postCommit: misalignedObservation(),
        }));

        expect(executeEffects(conclusiveEffects)).toEqual([
            {
                command: {
                    animated: false,
                    reason: 'prepend-restore',
                    sessionId: 'session-a',
                    targetDistanceFromHistoryStartPx: 820,
                    type: 'apply-history-correction',
                },
                type: 'execute-command',
            },
        ]);
        expect(effectsOfType(conclusiveEffects, 'close-prepend-ownership')).toEqual([
            { outcome: 'fallback-restored', sessionId: 'session-a', type: 'close-prepend-ownership' },
        ]);

        const abandoned = createNativePrependOwner();
        abandoned.begin(beginInput());
        abandoned.armCommit({ layoutTimeoutMs: 750, sessionId: 'session-a' });

        const abandonedEffects = abandoned.runLayoutTimeout(observationInput({
            nowMs: 1_750,
            postCommit: unchangedObservation(),
        }));

        expect(executeEffects(abandonedEffects)).toEqual([]);
        expect(effectsOfType(abandonedEffects, 'close-prepend-ownership')).toEqual([
            { outcome: 'abandoned-layout-timeout', sessionId: 'session-a', type: 'close-prepend-ownership' },
        ]);
        expect(abandonedEffects).toContainEqual(expect.objectContaining({
            reason: 'abandoned-layout-timeout',
            sessionId: 'session-a',
            type: 'record-restore-decision-for-session',
        }));
    });
});
