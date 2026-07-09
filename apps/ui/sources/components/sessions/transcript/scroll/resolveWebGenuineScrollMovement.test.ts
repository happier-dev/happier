import { describe, expect, it } from 'vitest';

import { resolveWebGenuineScrollMovement } from './resolveWebGenuineScrollMovement';

const BASE = {
    scrollHeight: 10000,
    previousObservedScrollHeight: 10000,
    clientHeight: 800,
    previousObservedClientHeight: 800,
    previousStreak: null,
    pinThresholdPx: 72,
    sustainFrames: 2,
    isTrusted: false,
} as const;

describe('resolveWebGenuineScrollMovement — web release authority (C3b / Q1-WEB-1)', () => {
    it('the app own programmatic write echo (scrollTop == last observed) is NOT genuine user movement, even when isTrusted (Q1-WEB-1 root fix)', () => {
        // After a programmatic pin write, lastObservedScrollTop holds the LANDED scrollTop (e.g. an under-shoot
        // to 9477). The write's echo onScroll reports the same scrollTop → must be excluded, even though RN-web
        // marks it isTrusted:true. This is the exact bug: a pinned reader must NOT release on the app's own write.
        const r = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9477,
            previousObservedScrollTop: 9477,
            distanceFromBottom: 23, // the under-shoot distance from QA-T's trace
            isTrusted: true,
        });
        expect(r.movedSinceLastObservation).toBe(false);
        expect(r.isGenuineUserMovement).toBe(false);
        expect(r.upwardIntent).toBe(false);
    });

    it('a TRUSTED programmatic pin under-shoot DURING streaming churn is NOT released (Q1-WEB-1 under-shoot variant)', () => {
        // The pin write under-shot to 9477 (< the prior 9500) WHILE content was growing, so it is not an exact
        // self-write match AND isTrusted:true — but the content-height change must keep it filtered, so a pinned
        // reader is not released by the app's own under-shooting write mid-stream.
        const r = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9477,
            previousObservedScrollTop: 9500,
            scrollHeight: 12000, // content grew during the write (streaming)
            previousObservedScrollHeight: 10000,
            distanceFromBottom: 23, // within the 72px threshold
            isTrusted: true,
        });
        expect(r.movedSinceLastObservation).toBe(true);
        expect(r.direction).toBe(-1);
        expect(r.upwardIntent).toBe(false); // churn defeats eager-trusted release
        expect(r.isGenuineUserMovement).toBe(false);
    });

    it('a TRUSTED <=1px clamp residue toward the top on a NON-churn frame is NOT an eager release (non-churn under-shoot guard)', () => {
        // The app's own write landed at 9500; the echo reports 9499 — a 1px async-clamp residue toward the top,
        // isTrusted, no churn, not an exact self-write match. Without the eager-path epsilon this would falsely
        // release a pinned reader. It still counts as movement (streak), but must not eager-release.
        const r = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9499,
            previousObservedScrollTop: 9500,
            distanceFromBottom: 1, // within threshold, single frame
            isTrusted: true,
        });
        expect(r.movedSinceLastObservation).toBe(true);
        expect(r.upwardIntent).toBe(false);
        expect(r.isGenuineUserMovement).toBe(false);
    });

    it('a single UNTRUSTED far jump beyond the threshold is NOT single-frame release authority (Legend/inset writers can produce it)', () => {
        // Landing beyond the pin threshold is NOT user evidence by itself: a renderer-internal
        // adjustment (Legend MVCP/alignItemsAtEnd) or a composer-inset compensation can move
        // scrollTop arbitrarily far in ONE untrusted frame. Only movement evidence releases:
        // trusted eager, or a sustained same-direction streak (a real scrollbar/keyboard scroll
        // emits a continuous stream of frames, so genuine gestures still release immediately).
        const single = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 7000, // moved up from 9500 to 7000 (toward older)
            previousObservedScrollTop: 9500,
            distanceFromBottom: 600, // beyond the 72px threshold
        });
        expect(single.movedSinceLastObservation).toBe(true);
        expect(single.direction).toBe(-1);
        expect(single.upwardIntent).toBe(false);
        expect(single.isGenuineUserMovement).toBe(false);
        expect(single.nextStreak).toEqual({ direction: -1, count: 1 });
        const sustained = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 6800,
            previousObservedScrollTop: 7000,
            distanceFromBottom: 800,
            previousStreak: { direction: -1, count: 1 },
        });
        expect(sustained.upwardIntent).toBe(true);
        expect(sustained.isGenuineUserMovement).toBe(true);
    });

    it('a viewport-height (clientHeight) change frame is layout churn: no eager release and the streak resets (composer-resize compensation)', () => {
        // R3 root cause (live-captured 2026-07-08): growing the composer shrinks the list
        // clientHeight; the same commit shifts scrollTop down (e.g. -90px, isTrusted:false)
        // and the landing dfb exceeds the pin threshold. That frame is layout-driven, not a
        // user scroll — a user scroll never changes clientHeight. It must not release, must
        // not seed a sustained streak, and must not eager-release even when trusted.
        const untrusted = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 10471,
            previousObservedScrollTop: 10561,
            clientHeight: 558,
            previousObservedClientHeight: 648,
            distanceFromBottom: 112, // beyond the 72px threshold
            previousStreak: { direction: -1, count: 1 }, // even with a prior upward frame...
        });
        expect(untrusted.movedSinceLastObservation).toBe(true);
        expect(untrusted.upwardIntent).toBe(false);
        expect(untrusted.isGenuineUserMovement).toBe(false);
        // ...the churn resets the streak basis: count restarts at 1.
        expect(untrusted.nextStreak).toEqual({ direction: -1, count: 1 });
        const trusted = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 10471,
            previousObservedScrollTop: 10561,
            clientHeight: 558,
            previousObservedClientHeight: 648,
            distanceFromBottom: 112,
            isTrusted: true, // RN-web marks non-user scroll echoes trusted too
        });
        expect(trusted.upwardIntent).toBe(false);
        expect(trusted.isGenuineUserMovement).toBe(false);
    });

    it('a TRUSTED small upward scroll WITHIN the threshold (no churn) IS intent on the first frame — eager web release (:402)', () => {
        // A real user pointer/keyboard scroll up (isTrusted) must release on the first frame even within the
        // pin threshold when content height is stable.
        const r = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9480,
            previousObservedScrollTop: 9500,
            distanceFromBottom: 20, // within the 72px threshold, single frame, NO churn
            isTrusted: true,
        });
        expect(r.movedSinceLastObservation).toBe(true);
        expect(r.direction).toBe(-1);
        expect(r.upwardIntent).toBe(true);
        expect(r.isGenuineUserMovement).toBe(true);
    });

    it('an UNTRUSTED single upward frame WITHIN the threshold (virtualization noise) is NOT intent (:266)', () => {
        // An isolated untrusted within-threshold frame is virtualization/recycling noise — it must not unpin
        // on a single frame (only beyond-threshold or sustained untrusted movement releases).
        const r = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9480,
            previousObservedScrollTop: 9500,
            distanceFromBottom: 20, // within the threshold, single frame, NO churn, untrusted
        });
        expect(r.movedSinceLastObservation).toBe(true);
        expect(r.direction).toBe(-1);
        expect(r.upwardIntent).toBe(false);
        expect(r.nextStreak).toEqual({ direction: -1, count: 1 });
    });

    it('a single within-threshold upward CHURN frame (content height changed) is NOT intent without sustain (:266)', () => {
        // When content is reflowing/streaming, a single within-threshold shift must NOT count — only a
        // beyond-threshold or sustained move can, so layout churn cannot masquerade as user intent.
        const r = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9480,
            previousObservedScrollTop: 9500,
            scrollHeight: 12000, // content grew at this frame (streaming)
            previousObservedScrollHeight: 10000,
            distanceFromBottom: 20, // within the threshold, single churn frame
        });
        expect(r.movedSinceLastObservation).toBe(true);
        expect(r.direction).toBe(-1);
        expect(r.upwardIntent).toBe(false);
        expect(r.isGenuineUserMovement).toBe(false);
    });

    it('a SUSTAINED within-threshold upward scroll (scrollbar/keyboard, plan E3) becomes genuine intent', () => {
        const r = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9460,
            previousObservedScrollTop: 9480,
            distanceFromBottom: 40, // within threshold
            previousStreak: { direction: -1, count: 1 }, // a prior within-threshold upward frame
        });
        expect(r.nextStreak).toEqual({ direction: -1, count: 2 });
        expect(r.upwardIntent).toBe(true); // sustained (>= sustainFrames=2)
        expect(r.isGenuineUserMovement).toBe(true);
    });

    it('a content-height change breaks the sustained streak (streaming/layout churn cannot masquerade as intent)', () => {
        const r = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9460,
            previousObservedScrollTop: 9480,
            scrollHeight: 12000, // content grew (streaming)
            previousObservedScrollHeight: 10000,
            distanceFromBottom: 40,
            previousStreak: { direction: -1, count: 1 }, // would have been sustained...
        });
        // ...but the height change resets the streak basis → count restarts at 1 → not sustained → not intent.
        expect(r.nextStreak).toEqual({ direction: -1, count: 1 });
        expect(r.upwardIntent).toBe(false);
        expect(r.isGenuineUserMovement).toBe(false);
    });

    it('returns no movement when there is no prior observation', () => {
        const r = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9500,
            previousObservedScrollTop: null,
            distanceFromBottom: 0,
        });
        expect(r.movedSinceLastObservation).toBe(false);
        expect(r.isGenuineUserMovement).toBe(false);
    });

    it('a downward scroll requires both beyond-threshold AND sustained to count as intent', () => {
        const single = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9520,
            previousObservedScrollTop: 9000,
            distanceFromBottom: 480, // beyond threshold but single frame
        });
        expect(single.direction).toBe(1);
        expect(single.downwardIntent).toBe(false); // needs sustain too
        const sustained = resolveWebGenuineScrollMovement({
            ...BASE,
            scrollTop: 9520,
            previousObservedScrollTop: 9000,
            distanceFromBottom: 480,
            previousStreak: { direction: 1, count: 1 },
        });
        expect(sustained.downwardIntent).toBe(true);
    });
});
