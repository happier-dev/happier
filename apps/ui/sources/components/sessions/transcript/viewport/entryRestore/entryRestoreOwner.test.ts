import { describe, expect, it } from 'vitest';

import {
    createEntryRestoreOwner,
    type EntryRestoreOwner,
    type EntryRestoreOwnerAttemptInput,
    type EntryRestoreOwnerEffect,
} from './entryRestoreOwner';

const anchor = {
    kind: 'message' as const,
    itemId: 'msg:m-20',
    messageId: 'm-20',
    itemOffsetPx: 84,
};

const targetAnchor = {
    kind: 'message' as const,
    itemId: 'msg:m-20',
    messageId: 'm-20',
};

const baseAttempt = {
    canMaterializeOlder: false,
    contentHeight: 2400,
    currentSessionId: 'session-a',
    deadlineMs: 1500,
    exactAnchorIndex: 2,
    fillSettled: true,
    items: [{ id: 'msg:m-10' }, { id: 'msg:m-15' }, { id: 'msg:m-20' }],
    jumpToSeqActive: false,
    layoutHeight: 600,
    nearestAnchorIndex: null,
    nowMs: 1000,
    platform: 'native' as const,
    restoredViewport: {
        anchor,
        offsetY: 120,
        sessionId: 'session-a',
        shouldFollowBottom: false,
    },
    slice: { capable: false as const },
    userScrollObserved: false,
} satisfies EntryRestoreOwnerAttemptInput<Readonly<{ id: string }>>;

function effectTypes(effects: readonly EntryRestoreOwnerEffect[]): readonly EntryRestoreOwnerEffect['type'][] {
    return effects.map((effect) => effect.type);
}

function executeEffects(effects: readonly EntryRestoreOwnerEffect[]) {
    return effects.filter((effect) => effect.type === 'execute-command');
}

/**
 * Every owner effect that ENDS the first-paint hold over the transcript.
 * Each one reaches the cover through a different host member:
 * - `close-entry-ownership` -> `recordEntryOwnerOutcome` -> `entry-confirmed` /
 *   `entry-fallback` -> `released` (entryPresentation.ts).
 * - `schedule-native-entry-paint-release` -> `nativeEntryRestorePaintReleased`.
 * - `native-initial-viewport-applied` -> clears
 *   `nativeInitialViewportPendingObservation`; both drop the native placeholder
 *   hold in `sessionOpenLatch.shouldShowNativeFirstPaintPlaceholder`.
 * - `reveal-entry-slice-window` -> `revealEntrySliceWindow`.
 */
const ENTRY_COVER_RELEASING_EFFECT_TYPES: readonly EntryRestoreOwnerEffect['type'][] = [
    'close-entry-ownership',
    'schedule-native-entry-paint-release',
    'native-initial-viewport-applied',
    'reveal-entry-slice-window',
];

describe('entry restore owner', () => {
    it('attempt anchored native entry opens the transaction and returns one semantic restore-anchor command', () => {
        const owner = createEntryRestoreOwner();

        const effects = owner.attempt(baseAttempt);

        expect(executeEffects(effects)).toEqual([
            {
                command: {
                    anchor: targetAnchor,
                    itemOffsetPx: 84,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-anchor',
                },
                type: 'execute-command',
            },
        ]);
        expect(effectTypes(effects)).toEqual([
            'execute-command',
            'schedule-entry-deadline',
            'set-native-initial-viewport-pending-observation',
            'record-restore-decision',
        ]);
        expect(owner.telemetryState('session-a')).toBe('open');
        expect(owner.nativePaintReleaseHandle({ sessionId: 'session-a' })).toEqual({
            issuedAtMs: 1000,
        });
        expect(owner.matchesNativePaintReleaseHandle({
            issuedAtMs: 1000,
            sessionId: 'session-a',
        })).toBe(true);
        expect(owner.visibleDistanceForOpenNativeEntry({
            observedDistanceFromBottom: 40,
            sessionId: 'session-a',
        })).toBe(120);
    });

    it('content and layout churn after the initial write does not reissue entry restore', () => {
        const owner = createEntryRestoreOwner();

        owner.attempt(baseAttempt);
        const retryEffects = owner.attempt({
            ...baseAttempt,
            contentHeight: 2600,
            layoutHeight: 640,
            nowMs: 1100,
        });

        expect(executeEffects(retryEffects)).toEqual([]);
        expect(owner.telemetryState('session-a')).toBe('open');
    });

    it('degrades identity-rotted anchors without durable seq to distance instead of materializing older pages', () => {
        const owner = createEntryRestoreOwner();

        const effects = owner.attempt({
            ...baseAttempt,
            canMaterializeOlder: true,
            exactAnchorIndex: null,
            nearestAnchorIndex: null,
            restoredViewport: {
                ...baseAttempt.restoredViewport,
                anchor: {
                    kind: 'toolGroup',
                    itemId: 'runtime-tool-group',
                    messageId: 'rotated-tool-id',
                    itemOffsetPx: 24,
                },
                offsetY: 300,
            },
        });

        expect(effectTypes(effects)).not.toContain('request-bounded-materialization');
        expect(executeEffects(effects)).toEqual([
            {
                command: {
                    animated: undefined,
                    contentHeight: 2400,
                    distanceFromLiveTailPx: 300,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-distance',
                },
                type: 'execute-command',
            },
        ]);
    });

    it('native conclusive misalignment spends exactly one correction and then holds ownership', () => {
        const owner = createEntryRestoreOwner();

        owner.attempt({
            ...baseAttempt,
            exactAnchorIndex: null,
            restoredViewport: {
                ...baseAttempt.restoredViewport,
                anchor: null,
            },
        });

        const first = owner.observeNative({
            contentHeight: 2500,
            layoutHeight: 600,
            nowMs: 1050,
            observation: { status: 'misaligned' },
            sessionId: 'session-a',
        });
        const second = owner.observeNative({
            contentHeight: 2600,
            layoutHeight: 600,
            nowMs: 1180,
            observation: { status: 'misaligned' },
            sessionId: 'session-a',
        });

        expect(executeEffects(first)).toEqual([
            {
                command: {
                    animated: false,
                    contentHeight: 2500,
                    distanceFromLiveTailPx: 120,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-distance',
                },
                type: 'execute-command',
            },
        ]);
        expect(executeEffects(second)).toEqual([]);
        expect(owner.telemetryState('session-a')).toBe('open');
    });

    it('observe-only slice entry never emits a scroll command and reveals slice on close', () => {
        const owner = createEntryRestoreOwner();

        const effects = owner.attempt({
            ...baseAttempt,
            exactAnchorIndex: null,
            slice: {
                anchorRowId: 'msg:m-20',
                capable: true,
                renderedAnchor: anchor,
                renderedAnchorIndex: 2,
                target: {
                    anchorItemOffsetPx: 84,
                    anchorMessageId: 'm-20',
                    anchorSeq: 20,
                    kind: 'slice',
                },
                writeFree: true,
            },
        });

        expect(executeEffects(effects)).toEqual([]);
        expect(effectTypes(effects)).toContain('set-entry-slice-window');

        const closed = owner.observeNative({
            contentHeight: 2400,
            layoutHeight: 600,
            nowMs: 1100,
            observation: { status: 'aligned' },
            sessionId: 'session-a',
        });

        expect(executeEffects(closed)).toEqual([]);
        expect(effectTypes(closed)).toEqual([
            'clear-entry-deadline',
            'close-entry-ownership',
            'record-restore-decision',
            'native-initial-viewport-applied',
            'reveal-entry-slice-window',
        ]);
        expect(owner.telemetryState('session-a')).toBe('closed');
    });

    it('falls through from a missing slice anchor to the durable loaded anchor instead of materializing older pages', () => {
        const owner = createEntryRestoreOwner();

        const effects = owner.attempt({
            ...baseAttempt,
            canMaterializeOlder: true,
            exactAnchorIndex: 2,
            nearestAnchorIndex: null,
            restoredViewport: {
                ...baseAttempt.restoredViewport,
                anchorSeqLoaded: true,
            },
            slice: {
                anchorRowId: null,
                capable: true,
                renderedAnchor: null,
                renderedAnchorIndex: null,
                target: {
                    anchorItemOffsetPx: 84,
                    anchorMessageId: 'stale-server-m-20',
                    anchorSeq: 20,
                    kind: 'slice',
                },
                writeFree: true,
            },
        });

        expect(effectTypes(effects)).not.toContain('request-bounded-materialization');
        expect(executeEffects(effects)).toEqual([
            {
                command: {
                    anchor: targetAnchor,
                    itemOffsetPx: 84,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-anchor',
                },
                type: 'execute-command',
            },
        ]);
    });

    it('carries the normalized durable sequence when a missing native slice anchor needs materialization', () => {
        const owner = createEntryRestoreOwner();

        const effects = owner.attempt({
            ...baseAttempt,
            canMaterializeOlder: true,
            exactAnchorIndex: null,
            nearestAnchorIndex: null,
            restoredViewport: {
                ...baseAttempt.restoredViewport,
                anchorSeqLoaded: false,
            },
            slice: {
                anchorRowId: null,
                capable: true,
                renderedAnchor: null,
                renderedAnchorIndex: null,
                target: {
                    anchorItemOffsetPx: 84,
                    anchorMessageId: 'm-20',
                    anchorSeq: 20.9,
                    kind: 'slice',
                },
                writeFree: false,
            },
        });

        expect(effects).toContainEqual({
            targetSeq: 20,
            type: 'request-bounded-materialization',
        });
    });

    it('carries the durable anchor sequence for regular identity materialization', () => {
        const owner = createEntryRestoreOwner();

        const effects = owner.attempt({
            ...baseAttempt,
            canMaterializeOlder: true,
            exactAnchorIndex: null,
            nearestAnchorIndex: null,
            restoredViewport: {
                ...baseAttempt.restoredViewport,
                anchor: {
                    ...anchor,
                    seq: 20,
                },
                anchorSeqLoaded: false,
            },
        });

        expect(effects).toContainEqual({
            targetSeq: 20,
            type: 'request-bounded-materialization',
        });
    });

    it('keeps distance-only growth targetless even when bounded materialization is available', () => {
        const owner = createEntryRestoreOwner();

        const effects = owner.attempt({
            ...baseAttempt,
            canMaterializeOlder: true,
            exactAnchorIndex: null,
            nearestAnchorIndex: null,
            restoredViewport: {
                ...baseAttempt.restoredViewport,
                anchor: null,
                offsetY: 3000,
            },
        });

        expect(effects).toContainEqual({
            targetSeq: null,
            type: 'request-bounded-materialization',
        });
    });

    it('disposeForExit telemeters the transaction session and does not schedule current-session paint effects', () => {
        const owner = createEntryRestoreOwner();
        owner.attempt(baseAttempt);

        const effects = owner.disposeForExit({ currentSessionId: 'session-b' });

        expect(effectTypes(effects)).toEqual([
            'clear-entry-deadline',
            'close-entry-ownership',
            'record-restore-decision-for-session',
        ]);
        expect(effects).toContainEqual({
            mode: 'restore-anchor',
            offsetY: 120,
            reason: 'skipped',
            sessionId: 'session-a',
            type: 'record-restore-decision-for-session',
        });
        expect(effectTypes(effects)).not.toContain('schedule-native-entry-paint-release');
        expect(effectTypes(effects)).not.toContain('native-initial-viewport-applied');
    });

    it('resetForSession clears closed-session suppression so the same session can restore again', () => {
        const owner = createEntryRestoreOwner();
        owner.attempt(baseAttempt);
        owner.observeNative({
            contentHeight: 2400,
            layoutHeight: 600,
            nowMs: 1100,
            observation: { status: 'aligned' },
            sessionId: 'session-a',
        });

        owner.resetForSession({ sessionId: 'session-a' });
        const effects = owner.attempt({
            ...baseAttempt,
            nowMs: 1200,
        });

        expect(executeEffects(effects)).toEqual([
            {
                command: {
                    anchor: targetAnchor,
                    itemOffsetPx: 84,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-anchor',
                },
                type: 'execute-command',
            },
        ]);
    });

    it('re-anchors a distance restore once settled measurements shrink content below the issued height', () => {
        // Live capture 2026-07-13 (Happier-Perf sim, streaming session): the open fill
        // measured content at an estimate-inflated 13708px, the persisted distance (177px
        // from bottom) was written as an absolute offset into that space, then real row
        // measurements shrank content to 9216px. The offset clamped to the bottom
        // (distance 0) and the shrink direction blacked out every observation — the
        // transaction never spent its correction and the viewport landed at the tail.
        const owner = createEntryRestoreOwner();
        owner.attempt({
            ...baseAttempt,
            contentHeight: 13708,
            layoutHeight: 690,
            exactAnchorIndex: null,
            restoredViewport: {
                ...baseAttempt.restoredViewport,
                anchor: null,
                offsetY: 177,
            },
        });

        const hostFacts = (overrides: Readonly<{
            contentHeight?: number;
            mountSettleStable?: boolean;
            nowMs?: number;
        }>) => ({
            contentHeight: 9216,
            distanceFromBottom: 0,
            layoutHeight: 690,
            nowMs: 1300,
            observedOffsetY: 8527,
            resolveAnchorObservation: () => null,
            resolveSliceObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 32,
            ...overrides,
        });

        // Mid-churn (mount settle not yet stable): judgment stays withheld — no writes.
        expect(executeEffects(owner.observeNativeHostFacts(hostFacts({ mountSettleStable: false })))).toEqual([]);

        // Post-settle: the still-open transaction re-judges in distance space and spends
        // its single correction against the SETTLED geometry.
        expect(executeEffects(owner.observeNativeHostFacts(hostFacts({ mountSettleStable: true, nowMs: 1400 })))).toEqual([
            {
                command: {
                    animated: false,
                    contentHeight: 9216,
                    distanceFromLiveTailPx: 177,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-distance',
                },
                type: 'execute-command',
            },
        ]);

        // The single-correction budget is spent (anti-storm invariant E1): further churn
        // holds ownership without writing.
        expect(executeEffects(owner.observeNativeHostFacts(hostFacts({
            contentHeight: 9000,
            mountSettleStable: true,
            nowMs: 1500,
        })))).toEqual([]);
        expect(owner.telemetryState('session-a')).toBe('open');
    });

    it('requires exact bottom confirmation for web bottom entry restore before closing', () => {
        const owner = createEntryRestoreOwner();

        owner.beginWebBottom({
            contentHeight: 10_785,
            deadlineMs: 1500,
            layoutHeight: 779,
            nowMs: 1000,
            sessionId: 'session-a',
        });

        const nearBottom = owner.observeWebHostFacts({
            contentHeight: 10_785,
            distanceFromBottom: 63,
            layoutHeight: 779,
            nowMs: 1050,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
        });

        expect(executeEffects(nearBottom)).toEqual([
            {
                command: {
                    animated: false,
                    contentHeight: 10_785,
                    distanceFromLiveTailPx: 0,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-distance',
                },
                type: 'execute-command',
            },
        ]);
        expect(effectTypes(nearBottom)).not.toContain('close-entry-ownership');
        expect(owner.telemetryState('session-a')).toBe('open');

        const exactBottom = owner.observeWebHostFacts({
            contentHeight: 10_785,
            distanceFromBottom: 0,
            layoutHeight: 779,
            nowMs: 1100,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
        });

        expect(effectTypes(exactBottom)).toEqual([
            'clear-entry-deadline',
            'close-entry-ownership',
            'record-restore-decision',
        ]);
        expect(owner.telemetryState('session-a')).toBe('closed');
    });

    it('rechecks web bottom confirmation after late content-height settle and requests one corrective repin', () => {
        const owner = createEntryRestoreOwner();

        owner.beginWebBottom({
            contentHeight: 11_556,
            deadlineMs: 1500,
            layoutHeight: 334,
            nowMs: 1000,
            sessionId: 'session-a',
        });

        const initiallyAligned = owner.observeWebHostFacts({
            contentHeight: 11_556,
            distanceFromBottom: 0,
            layoutHeight: 334,
            nowMs: 1050,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
            wantsPinned: true,
        });

        expect(effectTypes(initiallyAligned)).toContain('close-entry-ownership');
        expect(owner.telemetryState('session-a')).toBe('closed');

        const lateSettled = owner.observeWebHostFacts({
            contentHeight: 11_548,
            distanceFromBottom: 8,
            layoutHeight: 334,
            nowMs: 1100,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
            wantsPinned: true,
        });
        const repeatedLateSettled = owner.observeWebHostFacts({
            contentHeight: 11_548,
            distanceFromBottom: 8,
            layoutHeight: 334,
            nowMs: 1120,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
            wantsPinned: true,
        });

        expect(executeEffects(lateSettled)).toEqual([]);
        expect(lateSettled).toEqual([
            {
                reason: 'mount-settle',
                sessionId: 'session-a',
                type: 'request-bottom-follow-write',
                writer: 'settle-reconfirm',
            },
        ]);
        expect(executeEffects(repeatedLateSettled)).toEqual([]);
    });

    it('clears the web bottom settle confirmation after trusted-scroll preemption', () => {
        const owner = createEntryRestoreOwner();

        owner.beginWebBottom({
            contentHeight: 11_556,
            deadlineMs: 1500,
            layoutHeight: 334,
            nowMs: 1000,
            sessionId: 'session-a',
        });
        owner.observeWebHostFacts({
            contentHeight: 11_556,
            distanceFromBottom: 0,
            layoutHeight: 334,
            nowMs: 1050,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
            wantsPinned: true,
        });

        owner.preempt({ reason: 'trusted-scroll', sessionId: 'session-a' });
        const afterEscapeStreamAppend = owner.observeWebHostFacts({
            contentHeight: 11_700,
            distanceFromBottom: 180,
            layoutHeight: 334,
            nowMs: 1100,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
            wantsPinned: false,
        });

        expect(executeEffects(afterEscapeStreamAppend)).toEqual([]);
        expect(effectTypes(afterEscapeStreamAppend)).toEqual([]);
    });

    it('requests scheduler authority instead of emitting a direct web bottom settle command', () => {
        const owner = createEntryRestoreOwner();

        owner.beginWebBottom({
            contentHeight: 11_556,
            deadlineMs: 1500,
            layoutHeight: 334,
            nowMs: 1000,
            sessionId: 'session-a',
        });
        owner.observeWebHostFacts({
            contentHeight: 11_556,
            distanceFromBottom: 0,
            layoutHeight: 334,
            nowMs: 1050,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
            wantsPinned: true,
        });

        const lateSettled = owner.observeWebHostFacts({
            contentHeight: 11_548,
            distanceFromBottom: 8,
            layoutHeight: 334,
            nowMs: 1100,
            resolveAnchorObservation: () => null,
            sessionId: 'session-a',
            tolerancePx: 72,
            wantsPinned: true,
        });

        expect(executeEffects(lateSettled)).toEqual([]);
        expect(lateSettled).toEqual([
            {
                reason: 'mount-settle',
                sessionId: 'session-a',
                type: 'request-bottom-follow-write',
                writer: 'settle-reconfirm',
            },
        ]);
    });

    it('on web, does not permanently close the transaction when items are empty before fill settles', () => {
        // Regression: direct URL cold loads on web mount the entry restore layout
        // effect before any items are present. The old code treated empty-transcript
        // as a FINAL verdict which set lastClosedSessionId, permanently blocking all
        // subsequent restore attempts once content arrived.
        const owner = createEntryRestoreOwner();
        const webAnchoredBase: EntryRestoreOwnerAttemptInput<Readonly<{ id: string }>> = {
            ...baseAttempt,
            platform: 'web',
            contentHeight: 0,
            layoutHeight: 317,
            items: [],
            fillSettled: false,
            exactAnchorIndex: null,
            nearestAnchorIndex: null,
        };

        // First attempt with empty items and fill not settled — must be a WAIT, not final.
        const firstEffects = owner.attempt(webAnchoredBase);
        expect(firstEffects).toEqual([]);
        expect(owner.telemetryState('session-a')).toBe('none');

        // Once items arrive, the restore should succeed.
        const secondEffects = owner.attempt({
            ...webAnchoredBase,
            items: [{ id: 'msg:m-10' }, { id: 'msg:m-15' }, { id: 'msg:m-20' }],
            contentHeight: 4000,
            fillSettled: true,
            exactAnchorIndex: 2,
        });
        expect(executeEffects(secondEffects).length).toBeGreaterThan(0);
        expect(owner.telemetryState('session-a')).toBe('open');
    });

    /**
     * The first-paint cover survives a wait verdict only BY CONSTRUCTION, across
     * three modules and with nothing pinning the join:
     *   `attempt` returns [] for a wait verdict, BEFORE `openTransaction`
     *     -> no `close-entry-ownership` effect
     *     -> `recordEntryOwnerOutcome` never fires (useTranscriptEntryHost)
     *     -> `released` stays false (entryPresentation.ts)
     *     -> `entryPlacementPending` stays true (useTranscriptItemsPipeline)
     *     -> the placeholder keeps covering the list while we wait to measure.
     * If a wait verdict ever gains a cover-releasing effect, the cover lifts on an
     * unrestored list still at offset 0 and the measured 2026-07-12 cascade
     * (placeholder removed, restore write landing ~1.1s later across ~175k px)
     * becomes routine and SILENT. Asserted at the owner rather than at the
     * resolver because the owner is where such an effect would be added.
     */
    it('a wait verdict stays a no-op at the owner, so the first-paint cover holds until the anchor is actually writable', () => {
        const owner = createEntryRestoreOwner();
        // Cold anchored native open: the anchor row is RESOLVED (a data fact),
        // but the list has not measured a scrollable range yet, so the anchor
        // write is held behind the `content-unmeasured` wait verdict.
        const unmeasured: EntryRestoreOwnerAttemptInput<Readonly<{ id: string }>> = {
            ...baseAttempt,
            contentHeight: 0,
            layoutHeight: 812,
        };

        const waiting = owner.attempt(unmeasured);

        expect(effectTypes(waiting).filter((type) => ENTRY_COVER_RELEASING_EFFECT_TYPES.includes(type)))
            .toEqual([]);
        expect(executeEffects(waiting)).toEqual([]);
        // 'none' is the two-sided proof through the public boundary: no
        // transaction was opened for this session, and none was closed for it.
        expect(owner.telemetryState('session-a')).toBe('none');

        // ...and the hold is a WAIT, not a stop: the first measured attempt restores.
        const measured = owner.attempt({ ...unmeasured, contentHeight: 46_080, nowMs: 1100 });

        expect(executeEffects(measured)).toEqual([
            {
                command: {
                    anchor: targetAnchor,
                    itemOffsetPx: 84,
                    reason: 'entry-restore',
                    sessionId: 'session-a',
                    type: 'restore-anchor',
                },
                type: 'execute-command',
            },
        ]);
        expect(owner.telemetryState('session-a')).toBe('open');
    });
});
