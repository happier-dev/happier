import { describe, expect, it } from 'vitest';

import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { createWebDomScrollObservation } from './webDomObservation';

class FakeScroller {
    public constructor(
        public scrollHeight: number,
        public clientHeight: number,
        private scrollTopValue: number = 0,
    ) {}

    public get scrollTop(): number {
        return this.scrollTopValue;
    }

    public set scrollTop(value: number) {
        const max = Math.max(0, this.scrollHeight - this.clientHeight);
        this.scrollTopValue = Math.max(0, Math.min(value, max));
    }
}

function metrics(element: FakeScroller): WebTranscriptScrollMetrics {
    return {
        clientHeight: element.clientHeight,
        element: element as unknown as HTMLElement,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
    };
}

describe('createWebDomScrollObservation', () => {
    it('records landed programmatic writes and excludes their trusted scroll echo from user movement', () => {
        const observation = createWebDomScrollObservation();
        const element = new FakeScroller(1000, 400, 0);

        const write = observation.recordProgrammaticScrollTopWrite({
            element,
            targetScrollTop: 1000,
        });

        expect(write).toEqual({
            ok: true,
            landedScrollHeight: 1000,
            landedScrollTop: 600,
        });
        expect(observation.getState()).toMatchObject({
            observedScrollHeight: 1000,
            observedScrollTop: 600,
        });

        const echo = observation.observeGenuineScrollMovement({
            distanceFromBottom: 0,
            fallbackObservedScrollTop: 600,
            isTrusted: true,
            metrics: metrics(element),
            pinThresholdPx: 72,
            sustainFrames: 2,
        });

        expect(echo.isGenuineUserMovement).toBe(false);
        expect(echo.movedSinceLastObservation).toBe(false);
        expect(observation.getState()).toMatchObject({
            observedScrollHeight: 1000,
            observedScrollTop: 600,
        });
    });

    it('classifies a real upward web movement from the recorded write as genuine intent', () => {
        const observation = createWebDomScrollObservation();
        const element = new FakeScroller(1000, 400, 600);
        observation.recordProgrammaticScrollTopWrite({ element, targetScrollTop: 600 });
        element.scrollTop = 520;

        const movement = observation.observeGenuineScrollMovement({
            distanceFromBottom: 80,
            fallbackObservedScrollTop: 600,
            isTrusted: true,
            metrics: metrics(element),
            pinThresholdPx: 72,
            sustainFrames: 2,
        });

        expect(movement.isGenuineUserMovement).toBe(true);
        expect(movement.upwardIntent).toBe(true);
        expect(observation.getState()).toMatchObject({
            observedScrollHeight: 1000,
            observedScrollTop: 520,
        });
    });

    it('uses the current visual bottom fallback when pinned content grows from unscrollable to scrollable', () => {
        const observation = createWebDomScrollObservation();
        const element = new FakeScroller(200, 600, 0);
        observation.recordProgrammaticScrollTopWrite({ element, targetScrollTop: 200 });

        element.scrollHeight = 1200;
        element.scrollTop = 100;
        const movement = observation.observeGenuineScrollMovement({
            distanceFromBottom: 500,
            fallbackObservedScrollTop: 600,
            isTrusted: true,
            metrics: metrics(element),
            pinThresholdPx: 72,
            sustainFrames: 2,
        });

        // The growth frame itself is layout churn: a single frame landing beyond the threshold
        // during a content-height change is NOT user evidence (Legend growth bursts produce the
        // identical shape and previously false-released the pin — R3/open-drift root cause).
        // The fallback still seeds the movement ledger/streak from the visual bottom.
        expect(movement.isGenuineUserMovement).toBe(false);
        expect(movement.upwardIntent).toBe(false);
        expect(movement.movedSinceLastObservation).toBe(true);
        expect(movement.nextStreak).toEqual({ direction: -1, count: 1 });
        expect(observation.getState()).toMatchObject({
            observedScrollHeight: 1200,
            observedScrollTop: 100,
        });

        // The user's continued upward movement on the next (height-stable) frame releases.
        element.scrollTop = 40;
        const sustained = observation.observeGenuineScrollMovement({
            distanceFromBottom: 560,
            fallbackObservedScrollTop: null,
            isTrusted: false,
            metrics: metrics(element),
            pinThresholdPx: 72,
            sustainFrames: 2,
        });
        expect(sustained.isGenuineUserMovement).toBe(true);
        expect(sustained.upwardIntent).toBe(true);
    });

    it('resets observed writes and movement streak on session entry', () => {
        const observation = createWebDomScrollObservation();
        const element = new FakeScroller(1000, 400, 600);
        observation.recordProgrammaticScrollTopWrite({ element, targetScrollTop: 600 });
        element.scrollTop = 520;
        observation.observeGenuineScrollMovement({
            distanceFromBottom: 80,
            fallbackObservedScrollTop: 600,
            isTrusted: true,
            metrics: metrics(element),
            pinThresholdPx: 72,
            sustainFrames: 2,
        });

        observation.reset();

        expect(observation.getState()).toEqual({
            observedClientHeight: null,
            observedScrollHeight: null,
            observedScrollTop: null,
            streak: null,
        });
    });

    it('resets the non-programmatic movement streak when the app writes scrollTop', () => {
        const observation = createWebDomScrollObservation();
        const element = new FakeScroller(1000, 400, 600);

        element.scrollTop = 560;
        const firstMovement = observation.observeGenuineScrollMovement({
            distanceFromBottom: 40,
            fallbackObservedScrollTop: 600,
            isTrusted: false,
            metrics: metrics(element),
            pinThresholdPx: 72,
            sustainFrames: 2,
        });
        expect(firstMovement.isGenuineUserMovement).toBe(false);
        expect(observation.getState().streak).toEqual({ direction: -1, count: 1 });

        observation.recordProgrammaticScrollTopWrite({
            element,
            targetScrollTop: 580,
        });

        expect(observation.getState()).toMatchObject({
            observedScrollHeight: 1000,
            observedScrollTop: 580,
            streak: null,
        });

        element.scrollTop = 570;
        const afterWriteMovement = observation.observeGenuineScrollMovement({
            distanceFromBottom: 30,
            fallbackObservedScrollTop: 580,
            isTrusted: false,
            metrics: metrics(element),
            pinThresholdPx: 72,
            sustainFrames: 2,
        });
        expect(afterWriteMovement.isGenuineUserMovement).toBe(false);
        expect(observation.getState().streak).toEqual({ direction: -1, count: 1 });
    });
});
