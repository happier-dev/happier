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
        ...overrides,
    };
}

type RendererOwnedInitialPositionArmInput = SessionOpenLatchArmInput & Readonly<{
    initialBottomPositionOwner: 'renderer';
}>;

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
    });

    it('disarms the positioning phase for route jump entries', () => {
        const latch = createSessionOpenLatch();

        const arm = latch.arm(armInput({ entryKind: 'jump', shouldFollowBottom: false }));
        const ready = latch.onHostFacts({
            contentHeight: 800,
            hasEntrySliceWindow: false,
            isLoaded: true,
            isScrollable: true,
            itemCount: 12,
            layoutHeight: 400,
            nowMs: 1_010,
            sessionId: 'session-a',
            userWantsPinned: true,
        });

        expect(arm.phase).toBe('disarmed');
        expect(latch.disarmedReason()).toBe('jump-entry');
        expect(ready.effects.some((effect) => effect.type === 'request-initial-pin')).toBe(false);
        expect(ready.effects.some((effect) => effect.type === 'request-initial-fill')).toBe(false);
    });

    it('starts bottom positioning from host data/layout facts and schedules web retry deadlines without owning timers', () => {
        const latch = createSessionOpenLatch();

        latch.arm(armInput());
        const decision = latch.onHostFacts({
            contentHeight: 240,
            hasEntrySliceWindow: false,
            isLoaded: true,
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
