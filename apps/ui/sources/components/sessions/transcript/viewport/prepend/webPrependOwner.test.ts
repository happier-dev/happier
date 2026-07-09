import { describe, expect, it } from 'vitest';

import type { WebTranscriptPrependAnchor } from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptViewportAnchorIdentity } from '../transcriptViewportTypes';
import {
    createWebPrependOwner,
    type WebPrependOwner,
    type WebPrependOwnerEffect,
} from './webPrependOwner';

type TestItem = Readonly<{
    id: string;
    kind: string;
    messageId?: string;
    toolMessageIds?: readonly string[];
}>;

function effectTypes(effects: readonly WebPrependOwnerEffect[]): readonly WebPrependOwnerEffect['type'][] {
    return effects.map((effect) => effect.type);
}

function effectsOfType<TType extends WebPrependOwnerEffect['type']>(
    effects: readonly WebPrependOwnerEffect[],
    type: TType,
): readonly Extract<WebPrependOwnerEffect, { type: TType }>[] {
    return effects.filter((effect): effect is Extract<WebPrependOwnerEffect, { type: TType }> => (
        effect.type === type
    ));
}

function createMetrics(params: Readonly<{
    clientHeight?: number;
    scrollHeight?: number;
    scrollTop?: number;
}> = {}): WebTranscriptScrollMetrics {
    return {
        clientHeight: params.clientHeight ?? 600,
        element: {} as HTMLElement,
        scrollHeight: params.scrollHeight ?? 1200,
        scrollTop: params.scrollTop ?? 120,
    };
}

function createAnchor(params: Partial<WebTranscriptPrependAnchor> = {}): WebTranscriptPrependAnchor {
    const metrics = params.metrics ?? createMetrics();
    return {
        anchorTestId: 'transcript-anchor-message-m1',
        anchorTop: 80,
        expiresAtMs: 1500,
        itemTestId: 'transcript-item-turn:1',
        itemTop: 24,
        metrics,
        stabilizeForMs: 500,
        userIntentAtMs: 10,
        ...params,
    };
}

function createInvalidAnchor(): WebTranscriptPrependAnchor {
    return createAnchor({
        anchorTestId: null,
        anchorTop: null,
        itemTestId: null,
        itemTop: null,
        metrics: createMetrics({ scrollHeight: Number.NaN }),
    });
}

function createMetricOnlyAnchor(params: Partial<WebTranscriptPrependAnchor> = {}): WebTranscriptPrependAnchor {
    return createAnchor({
        anchorTestId: null,
        anchorTop: null,
        itemTestId: null,
        itemTop: null,
        ...params,
    });
}

function beginPendingRestore(
    owner: WebPrependOwner,
    params: Readonly<{
        anchor?: WebTranscriptPrependAnchor;
        nowMs?: number;
        sessionId?: string;
    }> = {},
): WebTranscriptPrependAnchor {
    const anchor = params.anchor ?? createAnchor();
    const sessionId = params.sessionId ?? 'session-a';
    owner.beforeLoad({
        anchor,
        preservePrependViewport: true,
        sessionId,
    });
    const effects = owner.afterLoad({
        activeOwner: 'follow',
        loadedRowCount: 3,
        nowMs: params.nowMs ?? 1000,
        preservePrependViewport: true,
        sessionId,
    });
    const restore = effectsOfType(effects, 'execute-web-prepend-restore')[0];
    expect(restore).toBeDefined();
    return restore.anchor;
}

describe('web prepend owner', () => {
    it('beforeLoad captures only when preservation is requested and a valid anchor exists', () => {
        const owner = createWebPrependOwner();

        expect(owner.beforeLoad({
            anchor: createAnchor(),
            preservePrependViewport: false,
            sessionId: 'session-a',
        })).toEqual([]);
        expect(owner.hasRestoreWindow()).toBe(false);

        expect(owner.beforeLoad({
            anchor: createInvalidAnchor(),
            preservePrependViewport: true,
            sessionId: 'session-a',
        })).toEqual([]);
        expect(owner.hasRestoreWindow()).toBe(false);

        expect(owner.beforeLoad({
            anchor: createAnchor(),
            preservePrependViewport: true,
            sessionId: 'session-a',
        })).toEqual([]);
        expect(owner.hasRestoreWindow()).toBe(true);
    });

    it('afterLoad records pending restore and requests a command-host web prepend restore when rows loaded', () => {
        const owner = createWebPrependOwner();
        const captured = createAnchor({ expiresAtMs: 400, stabilizeForMs: 350 });

        owner.beforeLoad({
            anchor: captured,
            preservePrependViewport: true,
            sessionId: 'session-a',
        });

        const effects = owner.afterLoad({
            activeOwner: 'follow',
            loadedRowCount: 2,
            nowMs: 1000,
            preservePrependViewport: true,
            sessionId: 'session-a',
        });

        expect(effectTypes(effects)).toEqual([
            'record-restore-decision',
            'open-prepend-ownership',
            'execute-web-prepend-restore',
        ]);
        expect(effectsOfType(effects, 'record-restore-decision')).toEqual([
            {
                mode: 'restore-anchor',
                programmaticWebWrite: false,
                reason: 'pending',
                type: 'record-restore-decision',
                webTrigger: 'prepend-restore',
            },
        ]);
        expect(effectsOfType(effects, 'execute-web-prepend-restore')).toEqual([
            {
                anchor: {
                    ...captured,
                    expiresAtMs: 1350,
                },
                sessionId: 'session-a',
                type: 'execute-web-prepend-restore',
            },
        ]);
        expect(owner.hasRestoreWindow()).toBe(true);
    });

    it('afterLoad preserves metric-only anchors for scroll-height growth restores', () => {
        const owner = createWebPrependOwner();
        const captured = createMetricOnlyAnchor({ expiresAtMs: 400, stabilizeForMs: 350 });

        owner.beforeLoad({
            anchor: captured,
            preservePrependViewport: true,
            sessionId: 'session-a',
        });

        const effects = owner.afterLoad({
            activeOwner: 'follow',
            loadedRowCount: 2,
            nowMs: 1000,
            preservePrependViewport: true,
            sessionId: 'session-a',
        });

        expect(effectTypes(effects)).toEqual([
            'record-restore-decision',
            'open-prepend-ownership',
            'execute-web-prepend-restore',
        ]);
        expect(effectsOfType(effects, 'execute-web-prepend-restore')).toEqual([
            {
                anchor: {
                    ...captured,
                    expiresAtMs: 1350,
                },
                sessionId: 'session-a',
                type: 'execute-web-prepend-restore',
            },
        ]);
    });

    it('keeps metric-only growth restores pending without spinning index recovery', () => {
        const owner = createWebPrependOwner();
        beginPendingRestore(owner, {
            anchor: createMetricOnlyAnchor({ stabilizeForMs: 500 }),
            nowMs: 1000,
        });

        const effects = owner.acceptRestoreResult({
            currentMetrics: createMetrics({ scrollHeight: 1400, scrollTop: 300 }),
            nowMs: 1100,
            result: { didAdjustScroll: true, strategy: 'growth' },
            sessionId: 'session-a',
        });

        expect(effectTypes(effects)).toEqual([
            'record-restore-decision',
            'clear-web-range-reserve',
            'schedule-web-restore-expiry',
        ]);
        expect(owner.hasRestoreWindow()).toBe(true);
        expect(owner.observePending({ nowMs: 1200, sessionId: 'session-a' })).toEqual([
            expect.objectContaining({
                sessionId: 'session-a',
                type: 'execute-web-prepend-restore',
            }),
        ]);
    });

    it('afterLoad preempts an open entry owner before opening prepend ownership', () => {
        const owner = createWebPrependOwner();

        owner.beforeLoad({
            anchor: createMetricOnlyAnchor(),
            preservePrependViewport: true,
            sessionId: 'session-a',
        });

        const effects = owner.afterLoad({
            activeOwner: 'entry',
            loadedRowCount: 2,
            nowMs: 1000,
            preservePrependViewport: true,
            sessionId: 'session-a',
        });

        expect(effectTypes(effects)).toEqual([
            'record-restore-decision',
            'preempt-entry-restore-for-prepend',
            'open-prepend-ownership',
            'execute-web-prepend-restore',
        ]);
    });

    it('afterLoad records skipped telemetry when loaded rows have no captured anchor', () => {
        const owner = createWebPrependOwner();

        const effects = owner.afterLoad({
            activeOwner: 'follow',
            loadedRowCount: 2,
            nowMs: 1000,
            preservePrependViewport: true,
            sessionId: 'session-a',
        });

        expect(effectTypes(effects)).toEqual(['record-restore-decision']);
        expect(effectsOfType(effects, 'record-restore-decision')).toEqual([
            {
                mode: 'restore-anchor',
                programmaticWebWrite: false,
                reason: 'skipped',
                type: 'record-restore-decision',
                webTrigger: 'prepend-restore',
            },
        ]);
        expect(owner.hasRestoreWindow()).toBe(false);
    });

    it.each([
        {
            expectedMode: 'restore-anchor',
            expectedReason: 'observed',
            expectedRecovery: false,
            result: { didAdjustScroll: false, strategy: 'anchor' },
        },
        {
            expectedMode: 'restore-anchor',
            expectedReason: 'restored',
            expectedRecovery: false,
            result: { didAdjustScroll: true, strategy: 'item' },
        },
        {
            expectedMode: 'restore-distance',
            expectedReason: 'restored',
            expectedRecovery: true,
            result: { didAdjustScroll: true, strategy: 'growth' },
        },
        {
            expectedMode: 'restore-anchor',
            expectedReason: 'not-ready',
            expectedRecovery: false,
            result: { didAdjustScroll: false, strategy: 'none' },
        },
    ] as const)('acceptRestoreResult classifies prepend strategy $result.strategy', ({
        expectedMode,
        expectedReason,
        expectedRecovery,
        result,
    }) => {
        const owner = createWebPrependOwner();
        const pendingAnchor = beginPendingRestore(owner);
        const refreshedAnchor = createAnchor({
            anchorTop: 96,
            expiresAtMs: pendingAnchor.expiresAtMs,
            metrics: createMetrics({ scrollHeight: 1000 }),
        });

        const effects = owner.acceptRestoreResult({
            currentMetrics: createMetrics({ scrollHeight: 900 }),
            nowMs: 1100,
            refreshedAnchor,
            result,
            sessionId: 'session-a',
        });

        expect(effectsOfType(effects, 'record-restore-decision')).toEqual([
            {
                mode: expectedMode,
                programmaticWebWrite: result.didAdjustScroll,
                reason: expectedReason,
                type: 'record-restore-decision',
                webTrigger: 'prepend-restore',
            },
        ]);
        expect(effectsOfType(effects, 'set-web-range-reserve')).toEqual([
            {
                reservePx: 300,
                type: 'set-web-range-reserve',
            },
        ]);
        expect(effectsOfType(effects, 'schedule-web-restore-expiry')).toEqual([
            {
                expiresAtMs: result.didAdjustScroll
                    ? 1100 + refreshedAnchor.stabilizeForMs
                    : refreshedAnchor.expiresAtMs,
                sessionId: 'session-a',
                type: 'schedule-web-restore-expiry',
            },
        ]);
        expect(effectsOfType(effects, 'schedule-web-index-recovery')).toHaveLength(expectedRecovery ? 1 : 0);
    });

    it.each([
        {
            expectedReason: 'restored',
            expectedRecovery: false,
            result: { didAdjustScroll: true, status: 'restored' },
        },
        {
            expectedReason: 'observed',
            expectedRecovery: false,
            result: { didAdjustScroll: false, status: 'already_aligned' },
        },
        {
            expectedReason: 'not-ready',
            expectedRecovery: true,
            result: { didAdjustScroll: false, status: 'not_found' },
        },
        {
            expectedReason: 'not-ready',
            expectedRecovery: false,
            result: { didAdjustScroll: false, status: 'not_applied' },
        },
    ] as const)('acceptRestoreResult classifies viewport status $result.status', ({
        expectedReason,
        expectedRecovery,
        result,
    }) => {
        const owner = createWebPrependOwner();
        beginPendingRestore(owner);

        const effects = owner.acceptRestoreResult({
            currentMetrics: createMetrics(),
            nowMs: 1100,
            result,
            sessionId: 'session-a',
        });

        expect(effectsOfType(effects, 'record-restore-decision')).toEqual([
            {
                mode: 'restore-anchor',
                programmaticWebWrite: result.didAdjustScroll,
                reason: expectedReason,
                type: 'record-restore-decision',
                webTrigger: 'prepend-restore',
            },
        ]);
        expect(effectsOfType(effects, 'schedule-web-index-recovery')).toHaveLength(expectedRecovery ? 1 : 0);
    });

    it('expire clears pending anchor state, range reserve, timers, ownership, and skipped telemetry', () => {
        const owner = createWebPrependOwner();
        beginPendingRestore(owner, { nowMs: 1000 });
        owner.acceptRestoreResult({
            currentMetrics: createMetrics({ scrollHeight: 900 }),
            nowMs: 1100,
            result: { didAdjustScroll: true, strategy: 'growth' },
            sessionId: 'session-a',
        });

        const effects = owner.expire({ nowMs: 2000 });

        expect(effectTypes(effects)).toEqual([
            'clear-web-restore-expiry',
            'clear-web-index-recovery',
            'clear-web-range-reserve',
            'close-prepend-ownership',
            'record-restore-decision',
        ]);
        expect(effectsOfType(effects, 'close-prepend-ownership')).toEqual([
            {
                outcome: 'abandoned-identity',
                sessionId: 'session-a',
                type: 'close-prepend-ownership',
            },
        ]);
        expect(effectsOfType(effects, 'record-restore-decision')).toEqual([
            {
                mode: 'restore-anchor',
                programmaticWebWrite: false,
                reason: 'skipped',
                type: 'record-restore-decision',
                webTrigger: 'prepend-restore',
            },
        ]);
        expect(owner.hasRestoreWindow()).toBe(false);
        expect(owner.telemetryFacts({ items: [] })).toEqual({
            pendingWebPrependAnchorKind: 'none',
        });
    });

    it('observes a pending restore window by reissuing restore or expiring stale state', () => {
        const owner = createWebPrependOwner();
        const pendingAnchor = beginPendingRestore(owner, {
            anchor: createAnchor({ stabilizeForMs: 500 }),
            nowMs: 1000,
        });

        expect(owner.observePending({ nowMs: 1100, sessionId: 'session-a' })).toEqual([
            {
                anchor: pendingAnchor,
                sessionId: 'session-a',
                type: 'execute-web-prepend-restore',
            },
        ]);

        expect(effectTypes(owner.observePending({ nowMs: 2000, sessionId: 'session-a' }))).toEqual([
            'clear-web-restore-expiry',
            'clear-web-index-recovery',
            'clear-web-range-reserve',
            'close-prepend-ownership',
            'record-restore-decision',
        ]);
    });

    it('extends the pending restore window after an accepted scroll adjustment', () => {
        const owner = createWebPrependOwner();
        const pendingAnchor = beginPendingRestore(owner, {
            anchor: createAnchor({ stabilizeForMs: 1500 }),
            nowMs: 1000,
        });

        owner.acceptRestoreResult({
            currentMetrics: createMetrics({ scrollHeight: 1600, scrollTop: 500 }),
            nowMs: 2400,
            refreshedAnchor: {
                ...pendingAnchor,
                metrics: createMetrics({ scrollHeight: 1200, scrollTop: 100 }),
            },
            result: { didAdjustScroll: true, strategy: 'growth' },
            sessionId: 'session-a',
        });

        const effects = owner.observePending({ nowMs: 3000, sessionId: 'session-a' });

        expect(effectsOfType(effects, 'execute-web-prepend-restore')).toEqual([
            {
                anchor: expect.objectContaining({
                    expiresAtMs: 3900,
                    metrics: expect.objectContaining({
                        scrollHeight: 1200,
                        scrollTop: 100,
                    }),
                }),
                sessionId: 'session-a',
                type: 'execute-web-prepend-restore',
            },
        ]);
    });

    it('refreshes an in-flight user scroll without replacing the pre-prepend height baseline', () => {
        const owner = createWebPrependOwner();
        const captured = createMetricOnlyAnchor({
            metrics: createMetrics({ scrollHeight: 1200, scrollTop: 100 }),
            userIntentAtMs: 10,
        });

        owner.beforeLoad({
            anchor: captured,
            preservePrependViewport: true,
            sessionId: 'session-a',
        });
        owner.refreshInFlightForUserScroll({
            anchor: createMetricOnlyAnchor({
                metrics: createMetrics({ scrollHeight: 1800, scrollTop: 140 }),
                userIntentAtMs: 20,
            }),
            sessionId: 'session-a',
            userScrolledDuringLoad: true,
        });

        const effects = owner.afterLoad({
            activeOwner: 'follow',
            loadedRowCount: 2,
            nowMs: 1000,
            preservePrependViewport: true,
            sessionId: 'session-a',
        });
        const restore = effectsOfType(effects, 'execute-web-prepend-restore')[0];

        expect(restore.anchor.metrics.scrollHeight).toBe(1200);
        expect(restore.anchor.metrics.scrollTop).toBe(140);
        expect(restore.anchor.userIntentAtMs).toBe(20);
    });

    it('user scroll retargets pending anchor and clears index recovery', () => {
        const owner = createWebPrependOwner();
        beginPendingRestore(owner);
        owner.acceptRestoreResult({
            currentMetrics: createMetrics(),
            nowMs: 1100,
            result: { didAdjustScroll: true, strategy: 'growth' },
            sessionId: 'session-a',
        });

        const retargetedAnchor = createAnchor({
            anchorTestId: 'transcript-anchor-message-m2',
            expiresAtMs: 2600,
            itemTestId: 'transcript-item-turn:2',
            userIntentAtMs: 20,
        });
        const effects = owner.retargetPendingForUserScroll({
            anchor: retargetedAnchor,
            sessionId: 'session-a',
        });

        expect(effectTypes(effects)).toEqual([
            'clear-web-index-recovery',
            'schedule-web-restore-expiry',
        ]);
        expect(owner.telemetryFacts({
            items: [
                { id: 'turn:1', kind: 'message', messageId: 'm1' },
                { id: 'turn:2', kind: 'message', messageId: 'm2' },
            ],
        })).toEqual({
            pendingWebPrependAnchorId: 'transcript-anchor-message-m2',
            pendingWebPrependAnchorIndex: 1,
            pendingWebPrependAnchorKind: 'stable',
        });
    });

    it('growth restore schedules index recovery until the anchor remounts or expires', () => {
        const owner = createWebPrependOwner();
        beginPendingRestore(owner, {
            anchor: createAnchor({ expiresAtMs: 1500, stabilizeForMs: 500 }),
            nowMs: 1000,
        });
        owner.acceptRestoreResult({
            currentMetrics: createMetrics(),
            nowMs: 1100,
            result: { didAdjustScroll: true, strategy: 'growth' },
            sessionId: 'session-a',
        });

        expect(effectTypes(owner.retryPending({
            items: [],
            nowMs: 1200,
            recoveryAnchor: null,
            sessionId: 'session-a',
        }))).toEqual(['schedule-web-index-recovery']);

        const recoveryAnchor: TranscriptViewportAnchorIdentity = {
            itemId: 'turn:1',
            kind: 'message',
            messageId: 'm1',
        };
        const recoveryEffects = owner.retryPending({
            items: [{ id: 'turn:1', kind: 'message', messageId: 'm1' }],
            nowMs: 1200,
            recoveryAnchor,
            sessionId: 'session-a',
        });

        expect(effectTypes(recoveryEffects)).toEqual([
            'clear-web-index-recovery',
            'execute-anchor-recovery',
            'execute-web-prepend-restore',
        ]);
        expect(effectsOfType(recoveryEffects, 'execute-anchor-recovery')).toEqual([
            {
                anchor: recoveryAnchor,
                index: 0,
                itemOffsetPx: 0,
                sessionId: 'session-a',
                type: 'execute-anchor-recovery',
            },
        ]);

        const expiredOwner = createWebPrependOwner();
        beginPendingRestore(expiredOwner, {
            anchor: createAnchor({ stabilizeForMs: 100 }),
            nowMs: 1000,
        });
        expiredOwner.acceptRestoreResult({
            currentMetrics: createMetrics(),
            nowMs: 1010,
            result: { didAdjustScroll: true, strategy: 'growth' },
            sessionId: 'session-a',
        });

        expect(effectTypes(expiredOwner.retryPending({
            items: [],
            nowMs: 1200,
            recoveryAnchor: null,
            sessionId: 'session-a',
        }))).toEqual([
            'clear-web-restore-expiry',
            'clear-web-index-recovery',
            'clear-web-range-reserve',
            'close-prepend-ownership',
            'record-restore-decision',
        ]);
    });

    it('keeps index recovery pending when a recovery attempt still cannot find the original anchor', () => {
        const owner = createWebPrependOwner();
        beginPendingRestore(owner, {
            anchor: createAnchor({ expiresAtMs: 1500, stabilizeForMs: 500 }),
            nowMs: 1000,
        });
        owner.acceptRestoreResult({
            currentMetrics: createMetrics(),
            nowMs: 1100,
            result: { didAdjustScroll: true, strategy: 'growth' },
            sessionId: 'session-a',
        });

        const recoveryAnchor: TranscriptViewportAnchorIdentity = {
            itemId: 'turn:1',
            kind: 'message',
            messageId: 'm1',
        };
        expect(effectTypes(owner.retryPending({
            items: [{ id: 'turn:1', kind: 'message', messageId: 'm1' }],
            nowMs: 1200,
            recoveryAnchor,
            sessionId: 'session-a',
        }))).toEqual([
            'clear-web-index-recovery',
            'execute-anchor-recovery',
            'execute-web-prepend-restore',
        ]);

        const effects = owner.acceptRestoreResult({
            currentMetrics: createMetrics({ scrollHeight: 5200, scrollTop: 4100 }),
            nowMs: 1200,
            result: { didAdjustScroll: false, strategy: 'none' },
            sessionId: 'session-a',
        });

        expect(effectTypes(effects)).toEqual([
            'record-restore-decision',
            'clear-web-range-reserve',
            'schedule-web-restore-expiry',
            'schedule-web-index-recovery',
        ]);
    });

    it('telemetryFacts reports pending anchor kind id and index without exposing mutable refs', () => {
        const owner = createWebPrependOwner();
        beginPendingRestore(owner);

        const facts = owner.telemetryFacts({
            items: [
                { id: 'turn:0', kind: 'message', messageId: 'm0' },
                { id: 'tools:1', kind: 'tool-calls-group', toolMessageIds: ['tool-1'] },
                { id: 'turn:1', kind: 'message', messageId: 'm1' },
            ] satisfies readonly TestItem[],
        });

        expect(facts).toEqual({
            pendingWebPrependAnchorId: 'transcript-anchor-message-m1',
            pendingWebPrependAnchorIndex: 2,
            pendingWebPrependAnchorKind: 'stable',
        });
    });
});
