import { describe, expect, it } from 'vitest';

import { createSessionOpenLatch } from './sessionOpenLatch';
import type { SessionOpenEntryKind, SessionOpenLatchArmInput } from './types';

function armInput(overrides: Partial<SessionOpenLatchArmInput> = {}): SessionOpenLatchArmInput {
    const entryKind: SessionOpenEntryKind = overrides.entryKind ?? 'bottom';
    return {
        entryKind,
        isNativeFlashListBottomMaintenanceEnabled: false,
        nativeFirstPaintFallbackDelayMs: 450,
        nowMs: 1_000,
        platform: 'web',
        sessionId: 'session-a',
        shouldFollowBottom: entryKind === 'bottom',
        webInitialPinRetryDelaysMs: [50, 100],
        webInitialPinStabilizeMs: 250,
        webOpenPhaseDeadlineDelayMs: 30_000,
        ...overrides,
    };
}

type RendererOwnedInitialPositionArmInput = SessionOpenLatchArmInput & Readonly<{
    initialBottomPositionOwner: 'renderer';
}>;

describe('session open latch', () => {
    it('does not expire data readiness before a delayed initial page can start its fill', () => {
        const latch = createSessionOpenLatch();
        latch.arm(armInput({ initialBottomPositionOwner: 'renderer', webOpenPhaseDeadlineDelayMs: 10_000 }));
        const facts = {
            contentHeight: 0,
            hasEntrySliceWindow: false,
            isLoaded: false,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 0,
            layoutHeight: 600,
            nowMs: 11_001,
            sessionId: 'session-a',
            userWantsPinned: true,
        };
        expect(latch.onHostFacts(facts).phase).toBe('awaiting-data');
        expect(latch.initialFillStatus()).toBe('idle');
        expect(latch.onHostFacts({ ...facts, isLoaded: true }).effects).toContainEqual({ type: 'request-initial-fill' });
        expect(latch.markInitialFillInProgress('session-a')).toBe(true);
        // A fill that actually started still has bounded authority.
        expect(latch.onHostFacts({ ...facts, isLoaded: true, nowMs: 11_002 }).phase).toBe('done');
    });

    it('still expires anchored confirmation after its real fill settles', () => {
        const latch = createSessionOpenLatch();
        latch.arm(armInput({ entryKind: 'anchored', webOpenPhaseDeadlineDelayMs: 10_000 }));
        latch.markInitialFillInProgress('session-a');
        expect(latch.onInitialFillSettled({ sessionId: 'session-a', nowMs: 1_100 }).phase).toBe('confirming');
        expect(latch.onHostFacts({
            contentHeight: 1200,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: true,
            itemCount: 3,
            layoutHeight: 600,
            nowMs: 11_001,
            sessionId: 'session-a',
            userWantsPinned: false,
        }).phase).toBe('done');
    });

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
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: true,
            itemCount: 12,
            layoutHeight: 400,
            nowMs: 1_010,
            sessionId: 'session-a',
            userWantsPinned: true,
        });

        expect(arm.phase).toBe('disarmed');
        expect(latch.disarmedReason()).toBe('jump-entry');
        expect(latch.initialFillStatus()).toBe('idle');
        expect(ready.effects.some((effect) => effect.type === 'request-initial-pin')).toBe(false);
        expect(ready.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(false);
        expect(latch.onJumpEntrySettled({ sessionId: 'stale-session' })).toBe(false);
        expect(latch.initialFillStatus()).toBe('idle');
        expect(latch.onJumpEntrySettled({ sessionId: 'session-a' })).toBe(true);
        expect(latch.initialFillStatus()).toBe('done');
        expect(latch.phase()).toBe('disarmed');
    });

    it('starts bottom positioning from host data/layout facts and schedules web retry deadlines without owning timers', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput());
        const decision = latch.onHostFacts({
            contentHeight: 240,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 3,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: true,
        });

        expect(decision.phase).toBe('positioning');
        expect(decision.effects).toEqual([
            { reason: 'initial-open', type: 'request-initial-pin' },
            { deadlineMs: 250, type: 'begin-web-bottom-entry' },
            { deadlineAtMs: 1_075, type: 'schedule-web-initial-pin-retry' },
            { type: 'request-initial-fill' },
        ]);
    });

    it('keeps renderer-owned web bottom entries free of app initial pin and retry writes', () => {
        const latch = createSessionOpenLatch();
        const rendererOwnedArm = {
            ...armInput(),
            initialBottomPositionOwner: 'renderer',
        } satisfies RendererOwnedInitialPositionArmInput;

        latch.arm(rendererOwnedArm);
        const decision = latch.onHostFacts({
            contentHeight: 240,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 3,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: true,
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
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: true,
            itemCount: 121,
            layoutHeight: 317,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: true,
        });

        expect(decision.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(false);
        expect(latch.initialFillStatus()).toBe('done');
    });

    it('requests initial web pin and retry once per arm across repeated host facts', () => {
        const latch = createSessionOpenLatch();
        const facts = {
            contentHeight: 240,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 3,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: true,
        };

        latch.arm(armInput());
        latch.onHostFacts(facts);
        const repeated = latch.onHostFacts({
            ...facts,
            nowMs: 1_050,
        });

        expect(repeated.effects.some((effect) => effect.type === 'request-initial-pin')).toBe(false);
        expect(repeated.effects.some((effect) => effect.type === 'schedule-web-initial-pin-retry')).toBe(false);
    });

    it('allows the first bottom pin after data arrives even before layout is measured', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput());
        const decision = latch.onHostFacts({
            contentHeight: 0,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 3,
            layoutHeight: 0,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: true,
        });

        expect(decision.phase).toBe('awaiting-layout');
        expect(decision.effects).toEqual([
            { reason: 'initial-open', type: 'request-initial-pin' },
            { deadlineAtMs: 1_075, type: 'schedule-web-initial-pin-retry' },
        ]);
    });

    it('does not issue an early data-arrival pin when renderer owns initial bottom positioning', () => {
        const latch = createSessionOpenLatch();
        const rendererOwnedArm = {
            ...armInput(),
            initialBottomPositionOwner: 'renderer',
        } satisfies RendererOwnedInitialPositionArmInput;

        latch.arm(rendererOwnedArm);
        const decision = latch.onHostFacts({
            contentHeight: 0,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 3,
            layoutHeight: 0,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: true,
        });

        expect(decision.phase).toBe('awaiting-layout');
        expect(decision.effects).toEqual([]);
    });

    it('keeps anchored entries write-free and coordinates with entry restore after fill settles', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            entryKind: 'anchored',
            platform: 'native',
            shouldFollowBottom: false,
        }));
        const ready = latch.onHostFacts({
            contentHeight: 240,
            hasEntrySliceWindow: true,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 3,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: false,
        });
        const fill = latch.onInitialFillSettled({
            nowMs: 1_030,
            sessionId: 'session-a',
        });

        expect(ready.effects.some((effect) => effect.type === 'request-initial-pin')).toBe(false);
        expect(ready.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(false);
        expect(fill.effects).toEqual([{ type: 'request-entry-restore-attempt' }]);
        expect(fill.phase).toBe('confirming');
    });

    it('treats measured anchored entries without an entry slice as fill-settled without generic initial fill', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            entryKind: 'anchored',
            platform: 'web',
            shouldFollowBottom: false,
        }));
        const ready = latch.onHostFacts({
            contentHeight: 1_000,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: true,
            itemCount: 1,
            layoutHeight: 100,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: false,
        });

        expect(ready.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(false);
        expect(ready.effects).toEqual([{ type: 'request-entry-restore-attempt' }]);
        expect(ready.phase).toBe('confirming');
        expect(latch.initialFillStatus()).toBe('done');
    });

    it('completes the open (phase done) when a bottom entry is already scrollable at measured facts', () => {
        // Monolith regression caught 2026-07-11 (SGM lane): the synchronous already-scrollable
        // settle set initialFillStatus 'done' but left phase 'positioning', so the web
        // initial-pin gate (phase() !== 'done') kept re-executing the bottom pin — a later
        // followed-content growth was slammed to the EXACT bottom instead of preserving the
        // user's small bottom distance. The synchronous settle must mirror
        // onInitialFillSettled's phase transition.
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            entryKind: 'bottom',
            platform: 'web',
            shouldFollowBottom: true,
        }));
        const ready = latch.onHostFacts({
            contentHeight: 1_000,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: true,
            itemCount: 2,
            layoutHeight: 100,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: true,
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
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 1,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: false,
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
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 1,
            layoutHeight: 600,
            nowMs: 1_025,
            sessionId: 'session-a',
            userWantsPinned: false,
        });
        const second = latch.onHostFacts({
            contentHeight: 90,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 1,
            layoutHeight: 600,
            nowMs: 1_050,
            sessionId: 'session-a',
            userWantsPinned: false,
        });

        expect(first.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(true);
        expect(second.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(true);

        // Once the executor is in progress, the duty stops re-firing.
        expect(latch.markInitialFillInProgress('session-a')).toBe(true);
        const third = latch.onHostFacts({
            contentHeight: 100,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 1,
            layoutHeight: 600,
            nowMs: 1_075,
            sessionId: 'session-a',
            userWantsPinned: false,
        });
        expect(third.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(false);
    });

    it('expires the web open-phase authority at its deadline when fill settlement starves', () => {
        // Live capture 2026-07-20 (web, heavy session): `initial-open` pin writes were
        // still firing 60s after the open and fought user scrolling (72 writes during a
        // 16-step upscroll). The initial fill's settlement never arrived (aborted or
        // hung executor), the phase stayed 'positioning', and the host re-executed the
        // open pin on every content tick. The open phase is a BOUNDED authority: it
        // completes at its deadline even when settlement starves.
        const latch = createSessionOpenLatch();
        latch.arm(armInput({ webOpenPhaseDeadlineDelayMs: 5_000 }));
        const facts = (nowMs: number) => latch.onHostFacts({
            contentHeight: 4_000,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isNearOlderEdge: false,
            isScrollable: false,
            itemCount: 20,
            layoutHeight: 600,
            nowMs,
            sessionId: 'session-a',
            userWantsPinned: true,
        });

        expect(facts(1_100).phase).toBe('positioning');
        latch.markInitialFillInProgress('session-a');

        // Settlement never arrives; before the deadline the authority stays open.
        expect(facts(5_900).phase).toBe('positioning');

        // At the deadline the open phase completes unconditionally: no further
        // initial-open pin authority, and fill-gated consumers unblock.
        const expired = facts(6_100);
        expect(expired.phase).toBe('done');
        expect(latch.initialFillStatus()).toBe('done');
        expect(expired.effects).toEqual([]);
        expect(facts(6_200).effects).toEqual([]);
    });

    it('releases the native first-paint placeholder on its caller-clocked fallback deadline', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            isNativeFlashListBottomMaintenanceEnabled: true,
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
            isNativeFlashListBottomMaintenanceEnabled: false,
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
            usesNativeFlashListBottomMaintenance: false,
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
            usesNativeFlashListBottomMaintenance: false,
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
            usesNativeFlashListBottomMaintenance: false,
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
            usesNativeFlashListBottomMaintenance: false,
        })).toBe(false);
    });

    it('releases the standard-space native first-paint placeholder on the fallback deadline', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput({
            isNativeFlashListBottomMaintenanceEnabled: false,
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
