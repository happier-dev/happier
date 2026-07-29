import { describe, expect, it } from 'vitest';

import { createSessionOpenLatch } from './sessionOpenLatch';
import type { SessionOpenEntryKind, SessionOpenLatchArmInput } from './types';

function armInput(overrides: Partial<SessionOpenLatchArmInput> = {}): SessionOpenLatchArmInput {
    const entryKind: SessionOpenEntryKind = overrides.entryKind ?? 'bottom';
    return {
        entryKind,
        nativeFirstPaintFallbackDelayMs: 450,
        nowMs: 1_000,
        platform: 'web',
        sessionId: 'session-a',
        shouldFollowBottom: entryKind === 'bottom',
        webOpenPhaseDeadlineDelayMs: 30_000,
        ...overrides,
    };
}

describe('session open latch', () => {
    it('arms once for a session and emits a single arm reset plan', () => {
        const latch = createSessionOpenLatch();

        const first = latch.arm(armInput());
        const second = latch.arm(armInput({ nowMs: 1_050 }));

        expect(first.effects.map((effect) => effect.type)).toEqual([
            'apply-arm-reset-plan',
            'hold-native-first-paint-placeholder',
        ]);
        expect(first.phase).toBe('awaiting-data');
        expect(second.effects).toEqual([]);
        expect(second.phase).toBe('awaiting-data');
    });

    it('disposes the previous session when a new session arms', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({ sessionId: 'session-a' }));
        const decision = latch.arm(armInput({ sessionId: 'session-b' }));

        expect(decision.effects.map((effect) => effect.type)).toEqual([
            'apply-dispose-reset-plan',
            'apply-arm-reset-plan',
            'hold-native-first-paint-placeholder',
        ]);
        expect(decision.phase).toBe('awaiting-data');
    });

    it('re-arms the same session when route-jump disarm resolves to an anchored entry', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({ entryKind: 'jump', shouldFollowBottom: false }));
        expect(latch.onJumpEntrySettled({ sessionId: 'session-a' })).toBe(true);
        expect(latch.initialFillStatus()).toBe('done');
        const decision = latch.arm(armInput({
            entryKind: 'anchored',
            nowMs: 1_050,
            shouldFollowBottom: false,
        }));

        expect(decision.effects).toEqual([
            {
                plan: {
                    entryKind: 'anchored',
                    sessionId: 'session-a',
                    shouldFollowBottom: false,
                },
                type: 'apply-arm-reset-plan',
            },
            { type: 'hold-native-first-paint-placeholder' },
        ]);
        expect(decision.phase).toBe('awaiting-data');
        expect(latch.disarmedReason()).toBeNull();
        expect(latch.initialFillStatus()).toBe('idle');
    });

    it('disarms the positioning phase for route jump entries', () => {
        const latch = createSessionOpenLatch();

        const arm = latch.arm(armInput({ entryKind: 'jump', shouldFollowBottom: false }));
        const ready = latch.onHostFacts({
            contentHeight: 800,
            isLoaded: true,
            isScrollable: true,
            itemCount: 12,
            layoutHeight: 400,
            nowMs: 1_010,
            sessionId: 'session-a',
        });

        expect(arm.phase).toBe('disarmed');
        expect(latch.disarmedReason()).toBe('jump-entry');
        expect(latch.initialFillStatus()).toBe('idle');
        expect(ready.effects).toEqual([]);
        expect(latch.onJumpEntrySettled({ sessionId: 'stale-session' })).toBe(false);
        expect(latch.initialFillStatus()).toBe('idle');
        expect(latch.onJumpEntrySettled({ sessionId: 'session-a' })).toBe(true);
        expect(latch.initialFillStatus()).toBe('done');
        expect(latch.phase()).toBe('disarmed');
    });

    it('keeps bottom positioning renderer-owned while requesting only the initial fill duty', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput());
        const decision = latch.onHostFacts({
            contentHeight: 240,
            isLoaded: true,
            isScrollable: false,
            itemCount: 3,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
        });

        expect(decision.phase).toBe('positioning');
        expect(decision.effects).toEqual([{ type: 'request-initial-fill' }]);
    });

    it('treats already-scrollable bottom entries as fill-settled without requesting a generic initial fill', () => {
        // Regression (Legend 2026-07-08): a renderer whose scroll container is already
        // scrollable at the first measured host facts never emits `request-initial-fill`,
        // and the fill status previously stayed 'idle' forever — permanently suspending
        // older pagination behind the 'fill-not-done' reason. A scrollable bottom entry
        // has nothing to fill: it must settle the fill status immediately.
        const latch = createSessionOpenLatch();

        latch.arm(armInput());
        const decision = latch.onHostFacts({
            contentHeight: 10_052,
            isLoaded: true,
            isScrollable: true,
            itemCount: 121,
            layoutHeight: 317,
            nowMs: 1_025,
            sessionId: 'session-a',
        });

        expect(decision.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(false);
        expect(latch.initialFillStatus()).toBe('done');
    });

    it('requests the bottom fill duty once per arm across repeated host facts', () => {
        const latch = createSessionOpenLatch();
        const facts = {
            contentHeight: 240,
            isLoaded: true,
            isScrollable: false,
            itemCount: 3,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
        };

        latch.arm(armInput());
        const first = latch.onHostFacts(facts);
        const repeated = latch.onHostFacts({
            ...facts,
            nowMs: 1_050,
        });

        expect(first.effects).toEqual([{ type: 'request-initial-fill' }]);
        expect(repeated.effects).toEqual([]);
    });

    it('keeps bottom entries write-free until layout is measured', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput());
        const decision = latch.onHostFacts({
            contentHeight: 0,
            isLoaded: true,
            isScrollable: false,
            itemCount: 3,
            layoutHeight: 0,
            nowMs: 1_025,
            sessionId: 'session-a',
        });

        expect(decision.phase).toBe('awaiting-layout');
        expect(decision.effects).toEqual([]);
    });

    it('fills underfilled anchored entries before coordinating entry restore', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            entryKind: 'anchored',
            platform: 'native',
            shouldFollowBottom: false,
        }));
        const ready = latch.onHostFacts({
            contentHeight: 240,
            isLoaded: true,
            isScrollable: false,
            itemCount: 3,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
        });
        const fill = latch.onInitialFillSettled({
            nowMs: 1_030,
            sessionId: 'session-a',
        });

        expect(ready.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(true);
        expect(fill.effects).toEqual([{ type: 'request-entry-restore-attempt' }]);
        expect(fill.phase).toBe('confirming');
    });

    it('treats measured scrollable anchored entries as fill-settled without generic initial fill', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            entryKind: 'anchored',
            platform: 'web',
            shouldFollowBottom: false,
        }));
        const ready = latch.onHostFacts({
            contentHeight: 1_000,
            isLoaded: true,
            isScrollable: true,
            itemCount: 1,
            layoutHeight: 100,
            nowMs: 1_025,
            sessionId: 'session-a',
        });

        expect(ready.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(false);
        expect(ready.effects).toEqual([{ type: 'request-entry-restore-attempt' }]);
        expect(ready.phase).toBe('confirming');
        expect(latch.initialFillStatus()).toBe('done');
    });

    it('completes the open (phase done) when a bottom entry is already scrollable at measured facts', () => {
        // Monolith regression caught 2026-07-11 (SGM lane): the synchronous already-scrollable
        // settle set initialFillStatus 'done' but left phase 'positioning'. The
        // synchronous settle must mirror onInitialFillSettled's phase transition so
        // open-lifecycle consumers observe one terminal state.
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            entryKind: 'bottom',
            platform: 'web',
            shouldFollowBottom: true,
        }));
        const ready = latch.onHostFacts({
            contentHeight: 1_000,
            isLoaded: true,
            isScrollable: true,
            itemCount: 2,
            layoutHeight: 100,
            nowMs: 1_025,
            sessionId: 'session-a',
        });

        expect(latch.initialFillStatus()).toBe('done');
        expect(ready.phase).toBe('done');
        expect(latch.phase()).toBe('done');
    });

    it('routes an UNDERFILLED anchored entry through the fill duty instead of settling fill immediately (S-M)', () => {
        // Live S-M (2026-07-11): a restored (anchored-entry) session whose displayable content
        // is smaller than the viewport cannot scroll, so the scroll-triggered older-load can
        // never arm — the user is stuck on a near-empty transcript even though older pages
        // exist. The rework settled anchored fill 'done' unconditionally; underfilled anchored
        // entries must run the same bounded fill-until-scrollable duty as bottom entries.
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            entryKind: 'anchored',
            platform: 'web',
            shouldFollowBottom: false,
        }));
        const ready = latch.onHostFacts({
            contentHeight: 80,
            isLoaded: true,
            isScrollable: false,
            itemCount: 1,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
        });

        expect(ready.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(true);
        expect(ready.effects.some((effect) => effect.type === 'request-entry-restore-attempt')).toBe(false);
        expect(latch.initialFillStatus()).toBe('idle');

        // The executor marks progress, loads older pages until scrollable/no-more, then settles:
        // the anchored coordination (confirming + entry-restore attempt) happens exactly once,
        // at fill settlement.
        expect(latch.markInitialFillInProgress('session-a')).toBe(true);
        const fill = latch.onInitialFillSettled({
            nowMs: 1_030,
            sessionId: 'session-a',
        });
        expect(fill.effects).toEqual([{ type: 'request-entry-restore-attempt' }]);
        expect(fill.phase).toBe('confirming');
    });

    it('re-requests the anchored fill duty on later facts until the executor actually starts (S-M)', () => {
        // The executor bails without marking progress when layout is not measured yet; the
        // latch must keep requesting on subsequent facts instead of losing the duty.
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            entryKind: 'anchored',
            platform: 'web',
            shouldFollowBottom: false,
        }));
        const first = latch.onHostFacts({
            contentHeight: 80,
            isLoaded: true,
            isScrollable: false,
            itemCount: 1,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
        });
        const second = latch.onHostFacts({
            contentHeight: 90,
            isLoaded: true,
            isScrollable: false,
            itemCount: 1,
            layoutHeight: 600,
            nowMs: 1_050,
            sessionId: 'session-a',
        });

        expect(first.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(true);
        expect(second.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(true);

        // Once the executor is in progress, the duty stops re-firing.
        expect(latch.markInitialFillInProgress('session-a')).toBe(true);
        const third = latch.onHostFacts({
            contentHeight: 100,
            isLoaded: true,
            isScrollable: false,
            itemCount: 1,
            layoutHeight: 600,
            nowMs: 1_075,
            sessionId: 'session-a',
        });
        expect(third.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(false);
    });

    it('expires the web open-phase authority at its deadline when fill settlement starves', () => {
        // The open phase remains bounded even if the initial fill's settlement never
        // arrives (aborted or hung executor).
        const latch = createSessionOpenLatch();
        latch.arm(armInput({ webOpenPhaseDeadlineDelayMs: 5_000 }));
        const facts = (nowMs: number) => latch.onHostFacts({
            contentHeight: 4_000,
            isLoaded: true,
            isScrollable: false,
            itemCount: 20,
            layoutHeight: 600,
            nowMs,
            sessionId: 'session-a',
        });

        expect(facts(1_100).phase).toBe('positioning');
        latch.markInitialFillInProgress('session-a');

        // Settlement never arrives; before the deadline the authority stays open.
        expect(facts(5_900).phase).toBe('positioning');

        // At the deadline the open phase completes unconditionally and fill-gated
        // consumers unblock.
        const expired = facts(6_100);
        expect(expired.phase).toBe('done');
        expect(latch.initialFillStatus()).toBe('done');
        expect(expired.effects).toEqual([]);
        expect(facts(6_200).effects).toEqual([]);
    });

    it('releases the native first-paint placeholder on its caller-clocked fallback deadline', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            platform: 'native',
        }));
        const early = latch.onNativeFirstPaintFallbackDeadline({
            nativeViewportPaintObserved: false,
            nowMs: 1_449,
            sessionId: 'session-a',
        });
        const due = latch.onNativeFirstPaintFallbackDeadline({
            nativeViewportPaintObserved: false,
            nowMs: 1_450,
            sessionId: 'session-a',
        });

        expect(early.effects).toEqual([]);
        expect(due.effects).toEqual([{ type: 'release-native-first-paint-placeholder' }]);
    });

    it('keeps the native first-paint placeholder contract for standard-space native renderers', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            platform: 'native',
        }));

        expect(latch.shouldShowNativeFirstPaintPlaceholder({
            firstListPaintObserved: false,
            hasOpenEntryRestoreTransaction: false,
            isLoaded: true,
            isWarmKeepAliveInstance: false,
            itemCount: 12,
            jumpToSeqActive: false,
            lastPinOffsetForIntent: null,
            nativeEntryRestorePaintReleased: false,
            nativeInitialViewportPendingObservation: false,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: false,
            nativeViewportPaintObserved: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
        })).toBe(true);
    });

    it('holds the placeholder for a warm keep-alive entry while its restore transaction is pending (AUD live jiggle 2026-07-12)', () => {
        // Live measured cascade on a warm same-session re-entry restoring a DETACHED
        // position: blank transcript -> content pops at position A -> whole viewport
        // shifts ~12-15px to position B 230ms later. Mechanism: the warm-instance
        // suppression short-circuited ABOVE the open-restore hold, so the restore write
        // and its post-measure correction ran in full view. A warm instance with an open
        // entry-restore transaction and a pending initial-viewport observation must keep
        // the placeholder until the restore settles (deadline-bounded like every other
        // hold in this predicate).
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            entryKind: 'anchored',
            platform: 'native',
            shouldFollowBottom: false,
        }));

        expect(latch.shouldShowNativeFirstPaintPlaceholder({
            firstListPaintObserved: true,
            hasOpenEntryRestoreTransaction: true,
            isLoaded: true,
            isWarmKeepAliveInstance: true,
            itemCount: 120,
            jumpToSeqActive: false,
            lastPinOffsetForIntent: null,
            nativeEntryRestorePaintReleased: false,
            nativeInitialViewportPendingObservation: true,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: false,
            nativeViewportPaintObserved: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
        })).toBe(true);

        // The settle deadline stays the bound: past it, the placeholder must not hang.
        expect(latch.shouldShowNativeFirstPaintPlaceholder({
            firstListPaintObserved: true,
            hasOpenEntryRestoreTransaction: true,
            isLoaded: true,
            isWarmKeepAliveInstance: true,
            itemCount: 120,
            jumpToSeqActive: false,
            lastPinOffsetForIntent: null,
            nativeEntryRestorePaintReleased: false,
            nativeInitialViewportPendingObservation: true,
            nativeMountSettleDeadlineReached: true,
            nativeMountSettleStable: false,
            nativeViewportPaintObserved: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
        })).toBe(false);
    });

    it('keeps the instant warm reveal when no restore is pending', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({ platform: 'native' }));

        expect(latch.shouldShowNativeFirstPaintPlaceholder({
            firstListPaintObserved: true,
            hasOpenEntryRestoreTransaction: false,
            isLoaded: true,
            isWarmKeepAliveInstance: true,
            itemCount: 120,
            jumpToSeqActive: false,
            lastPinOffsetForIntent: 0,
            nativeEntryRestorePaintReleased: false,
            nativeInitialViewportPendingObservation: false,
            nativeMountSettleDeadlineReached: false,
            nativeMountSettleStable: false,
            nativeViewportPaintObserved: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
        })).toBe(false);
    });

    it('releases the standard-space native first-paint placeholder on the fallback deadline', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            platform: 'native',
        }));

        const due = latch.onNativeFirstPaintFallbackDeadline({
            nativeViewportPaintObserved: false,
            nowMs: 1_450,
            sessionId: 'session-a',
        });

        expect(due.effects).toEqual([{ type: 'release-native-first-paint-placeholder' }]);
    });
});
