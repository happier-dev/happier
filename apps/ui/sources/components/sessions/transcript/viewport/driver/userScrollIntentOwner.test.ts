import { describe, expect, it } from 'vitest';

import { resolveWebGenuineScrollMovement } from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';
import { createWebDomScrollObservation } from './webDomObservation';
import {
    createTranscriptUserScrollIntentOwner,
    TRANSCRIPT_USER_SCROLL_INPUT_CONTINUATION_WINDOW_MS,
} from './userScrollIntentOwner';

function metrics(scrollTop: number, scrollHeight: number, clientHeight = 600) {
    return { clientHeight, scrollHeight, scrollTop } as any;
}

describe('createTranscriptUserScrollIntentOwner', () => {
    it('reports live intent for a whole scrollbar drag even though only its press is an event', () => {
        const owner = createTranscriptUserScrollIntentOwner();
        owner.setGestureActive({ active: true, atMs: 1_000, gesture: 'drag' });

        // A scrollbar thumb drag emits one pointerdown and then nothing until release. An
        // event-shaped guard goes stale mid-drag; the state-shaped fact must not.
        expect(owner.isLive(1_000 + 5_000)).toBe(true);

        owner.setGestureActive({ active: false, atMs: 6_000, gesture: 'drag' });
        expect(owner.isLive(6_000)).toBe(true);
        expect(owner.isLive(6_000 + TRANSCRIPT_USER_SCROLL_INPUT_CONTINUATION_WINDOW_MS + 1)).toBe(false);
    });

    it('exposes ONE cell: the timestamp view and raw-input liveness can never disagree', () => {
        // The predecessor kept `timestampRef.current` AND a private `lastRawInputAtMs`, so the nine
        // host sites that assigned the ref directly desynchronized them: a command-boundary revoke
        // cleared the ref while `isLive` still claimed the reader was driving, and a host record
        // advanced the ref while `lastInputAtMs()` stayed -Infinity. There is now one cell, and the
        // reader view is a live projection of it through every writer.
        const owner = createTranscriptUserScrollIntentOwner();

        owner.recordInput({ atMs: 1_000 });
        expect(owner.timestampRef.current).toBe(1_000);
        expect(owner.lastInputAtMs()).toBe(1_000);
        expect(owner.isLive(1_000)).toBe(true);

        owner.revokeInputEvidence();
        expect(owner.timestampRef.current).toBe(Number.NEGATIVE_INFINITY);
        expect(owner.lastInputAtMs()).toBe(Number.NEGATIVE_INFINITY);
        // The half that used to survive its own revoke.
        expect(owner.isLive(1_000)).toBe(false);
        expect(owner.lastInputDirection()).toBeNull();

        owner.setGestureActive({ active: true, atMs: 2_000, gesture: 'drag' });
        expect(owner.timestampRef.current).toBe(2_000);
        expect(owner.lastInputAtMs()).toBe(2_000);

        owner.clear();
        expect(owner.timestampRef.current).toBe(Number.NEGATIVE_INFINITY);
        expect(owner.lastInputAtMs()).toBe(Number.NEGATIVE_INFINITY);
        expect(owner.isLive(2_000)).toBe(false);
    });
});

describe('parked away from the live tail (state, not an event)', () => {
    const PIN_THRESHOLD_PX = 72;

    it('keeps the reader parked long after every input-recency window has expired', () => {
        const owner = createTranscriptUserScrollIntentOwner();
        // The reader wheels up and the frame that lands reports them 300px from the tail.
        owner.recordInput({ atMs: 1_000, direction: -1 });
        owner.observeDistanceFromLiveTail({
            atMs: 1_000,
            distanceFromLiveTailPx: 300,
            pinThresholdPx: PIN_THRESHOLD_PX,
        });

        expect(owner.isParkedAwayFromLiveTail()).toBe(true);
        expect(owner.parkedDistanceFromLiveTailPx()).toBe(300);
        // Five seconds of reading. `isLive` is long false — the fact must not be.
        expect(owner.isLive(6_000)).toBe(false);
        expect(owner.isParkedAwayFromLiveTail()).toBe(true);
    });

    it('never parks a following reader when content grows below them', () => {
        const owner = createTranscriptUserScrollIntentOwner();
        // No input at all: growth pushes the measured distance far past the pin band.
        owner.observeDistanceFromLiveTail({
            atMs: 1_000,
            distanceFromLiveTailPx: 4_000,
            pinThresholdPx: PIN_THRESHOLD_PX,
        });

        expect(owner.isParkedAwayFromLiveTail()).toBe(false);
    });

    it('releases on any measured arrival inside the pin band, so a false park heals', () => {
        const owner = createTranscriptUserScrollIntentOwner();
        owner.recordInput({ atMs: 1_000, direction: -1 });
        owner.observeDistanceFromLiveTail({
            atMs: 1_000,
            distanceFromLiveTailPx: 300,
            pinThresholdPx: PIN_THRESHOLD_PX,
        });
        expect(owner.isParkedAwayFromLiveTail()).toBe(true);

        // Arrival inside the band, with no live input to explain it (browser smooth-scroll
        // continuation, or our own landed write): being at the tail is being at the tail.
        owner.observeDistanceFromLiveTail({
            atMs: 9_000,
            distanceFromLiveTailPx: 12,
            pinThresholdPx: PIN_THRESHOLD_PX,
        });
        expect(owner.isParkedAwayFromLiveTail()).toBe(false);
    });

    const park = () => {
        const owner = createTranscriptUserScrollIntentOwner();
        owner.recordInput({ atMs: 1_000, direction: -1 });
        owner.observeDistanceFromLiveTail({
            atMs: 1_000,
            distanceFromLiveTailPx: 300,
            pinThresholdPx: PIN_THRESHOLD_PX,
        });
        return owner;
    };

    it('releases at the explicit return-to-live-tail boundaries', () => {
        const released = park();
        released.releaseLiveTailParking();
        expect(released.isParkedAwayFromLiveTail()).toBe(false);

        // Session change / teardown drops every fact, parking included.
        const cleared = park();
        cleared.clear();
        expect(cleared.isParkedAwayFromLiveTail()).toBe(false);
    });

    it('survives a command boundary that revokes input evidence WITHOUT returning to the tail', () => {
        // `revokeInputEvidence` is called at EVERY command boundary — the renderer invalidates
        // inertia continuation on `scrollToIndex`, `scrollToOffset`, an entry-anchor landing and
        // an explicit jump takeover. Jumping to an older message is navigation AWAY from the
        // tail; if that revoke also released parking, the very next content growth would be
        // authorized to yank the reader to the bottom — the symptom parking exists to refuse.
        const owner = park();

        owner.revokeInputEvidence();

        expect(owner.isLive(1_000)).toBe(false);
        expect(owner.isParkedAwayFromLiveTail()).toBe(true);
        expect(owner.parkedDistanceFromLiveTailPx()).toBe(300);
    });

    it('never needs an automatic write to escape: the reader\'s own scroll back releases it', () => {
        // The deadlock shape to rule out: while parked, every automatic bottom-follow write is
        // refused, so nothing the APP does can produce the measured arrival that would release
        // it. Release must therefore be reachable from the reader alone. It is: their own scroll
        // is measured by the same observation that parked them.
        const owner = park();
        expect(owner.isParkedAwayFromLiveTail()).toBe(true);

        // Reader wheels back down under their own hand; the landing frame measures the tail.
        owner.recordInput({ atMs: 20_000, direction: 1 });
        owner.observeDistanceFromLiveTail({
            atMs: 20_000,
            distanceFromLiveTailPx: 4,
            pinThresholdPx: PIN_THRESHOLD_PX,
        });

        expect(owner.isParkedAwayFromLiveTail()).toBe(false);
        expect(owner.parkedDistanceFromLiveTailPx()).toBeNull();
    });
});

describe('resolveWebGenuineScrollMovement under concurrent layout churn', () => {
    const baseFrame = {
        clientHeight: 600,
        distanceFromBottom: 900,
        pinThresholdPx: 60,
        previousObservedClientHeight: 600,
        previousObservedScrollHeight: 40_000,
        previousObservedScrollTop: 39_000,
        previousStreak: null,
        scrollHeight: 40_180, // content grew on this very frame
        scrollTop: 38_900,
        sustainFrames: 2,
    } as const;

    it('cannot certify a trusted movement under churn without witnessed input', () => {
        // Preserved: `isTrusted` alone is not evidence. RN-web marks the echo of the app's own
        // programmatic write trusted, and a reflow frame is not proof the reader moved.
        expect(resolveWebGenuineScrollMovement({
            ...baseFrame,
            isTrusted: true,
        }).isGenuineUserMovement).toBe(false);
    });

    it('certifies a trusted movement under churn when raw user input was witnessed', () => {
        // The keystone. A content-height change is the ONLY thing that arms the auto-pin, so a
        // classifier that cannot certify intent during churn is blind exactly when it matters.
        // Witnessed raw input is intent regardless of what layout is doing.
        const result = resolveWebGenuineScrollMovement({
            ...baseFrame,
            hasWitnessedUserInput: true,
            isTrusted: true,
        });
        expect(result.isGenuineUserMovement).toBe(true);
        expect(result.upwardIntent).toBe(true);
    });

    it('certifies a witnessed trusted movement while a measurement invalidation shrinks content', () => {
        // Signature/metadata-only churn: a row identity change deletes a measured size, so the
        // content height DROPS to an estimate. No new messages at all, same blindness.
        expect(resolveWebGenuineScrollMovement({
            ...baseFrame,
            hasWitnessedUserInput: true,
            isTrusted: true,
            scrollHeight: 39_200,
        }).isGenuineUserMovement).toBe(true);
    });

    it('does not certify a witnessed frame that did not move', () => {
        expect(resolveWebGenuineScrollMovement({
            ...baseFrame,
            hasWitnessedUserInput: true,
            isTrusted: true,
            scrollTop: baseFrame.previousObservedScrollTop,
        }).isGenuineUserMovement).toBe(false);
    });
});

describe('webDomObservation user authority', () => {
    it('still refuses user authority for our own command write echo during a live gesture', () => {
        // Q1-WEB-1 must survive: RN-web marks the echo of the app's OWN programmatic write
        // `isTrusted: true`. Witnessed input is not a licence to attribute a command frame to
        // the reader, otherwise a pin under-shoot masquerades as a user scroll again.
        const observation = createWebDomScrollObservation();
        const nowMs = 1_000;

        observation.observeGenuineScrollMovement({
            distanceFromBottom: 400,
            fallbackObservedScrollTop: null,
            isTrusted: true,
            metrics: metrics(39_000, 40_000),
            pinThresholdPx: 60,
            semanticContext: { atEndNonUserCause: 'layout', isUserInputActive: true, nowMs },
            sustainFrames: 2,
        });

        const commandFrame = observation.observeGenuineScrollMovement({
            distanceFromBottom: 0,
            fallbackObservedScrollTop: null,
            isTrusted: true,
            metrics: metrics(39_400, 40_000),
            pinThresholdPx: 60,
            semanticContext: { atEndNonUserCause: 'command', isUserInputActive: true, nowMs: nowMs + 16 },
            sustainFrames: 2,
        });

        expect(commandFrame.isGenuineUserMovement).toBe(false);
        expect(commandFrame.atEndPublicationCause).toBe('command');
    });

    it('keeps certifying a live gesture frame after a programmatic write cleared movement authority', () => {
        // The measured failure chain: a pin write during the reader's own wheel gesture wipes
        // `pendingUserInput`/`lastUserMovement`, so the NEXT frame of that same gesture is
        // unclassified — bottom-follow is never released and the auto-pin snaps the reader back.
        const observation = createWebDomScrollObservation();
        const owner = createTranscriptUserScrollIntentOwner();
        let nowMs = 1_000;

        observation.observeGenuineScrollMovement({
            distanceFromBottom: 400,
            fallbackObservedScrollTop: null,
            isTrusted: true,
            metrics: metrics(39_000, 40_000),
            pinThresholdPx: 60,
            semanticContext: { atEndNonUserCause: 'layout', isUserInputActive: false, nowMs },
            sustainFrames: 2,
        });

        owner.recordInput({ atMs: nowMs });
        const element = { scrollTop: 39_000 };
        observation.recordProgrammaticScrollTopWrite({ element: element as any, targetScrollTop: 39_400 });

        nowMs += 40;
        const userFrame = observation.observeGenuineScrollMovement({
            distanceFromBottom: 1_100,
            fallbackObservedScrollTop: null,
            isTrusted: true,
            metrics: metrics(38_500, 40_200),
            pinThresholdPx: 60,
            semanticContext: {
                atEndNonUserCause: 'layout',
                isUserInputActive: owner.isLive(nowMs),
                nowMs,
            },
            sustainFrames: 2,
        });

        expect(userFrame.isGenuineUserMovement).toBe(true);
        expect(userFrame.upwardIntent).toBe(true);
    });
});
