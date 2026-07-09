import {
    resolveWebGenuineScrollMovement,
    type WebGenuineScrollMovementResult,
    type WebScrollMovementStreak,
} from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    writeWebScrollTopAndObserve,
    type WebScrollTopWriteResult,
    type WebScrollTopWriteTarget,
} from './webScrollTopWriter';

export type WebDomScrollObservationState = Readonly<{
    observedClientHeight: number | null;
    observedScrollHeight: number | null;
    observedScrollTop: number | null;
    streak: WebScrollMovementStreak | null;
}>;

export type WebDomScrollObservation = Readonly<{
    getState(): WebDomScrollObservationState;
    observeGenuineScrollMovement(params: Readonly<{
        distanceFromBottom: number;
        fallbackObservedScrollTop: number | null;
        isTrusted: boolean;
        metrics: WebTranscriptScrollMetrics;
        pinThresholdPx: number;
        sustainFrames: number;
    }>): WebGenuineScrollMovementResult;
    recordProgrammaticScrollTopWrite(params: Readonly<{
        element: WebScrollTopWriteTarget;
        targetScrollTop: number;
    }>): WebScrollTopWriteResult;
    reset(): void;
}>;

/**
 * C3b web DOM observation owner.
 *
 * Programmatic web scroll writes and subsequent `onScroll` classification share the same observation
 * state here. That keeps the Q1-WEB-1 self-write exclusion out of `ChatList`: a write records the
 * LANDED `scrollTop`/`scrollHeight`, and the scroll echo is genuine only if it moves away from that
 * recorded value.
 */
export function createWebDomScrollObservation(): WebDomScrollObservation {
    const observedScrollTopRef = { current: null as number | null };
    const observedScrollHeightRef = { current: null as number | null };
    const observedClientHeightRef = { current: null as number | null };
    let streak: WebScrollMovementStreak | null = null;

    return {
        getState() {
            return {
                observedClientHeight: observedClientHeightRef.current,
                observedScrollHeight: observedScrollHeightRef.current,
                observedScrollTop: observedScrollTopRef.current,
                streak,
            };
        },
        observeGenuineScrollMovement(params) {
            const observedScrollTop = observedScrollTopRef.current;
            const observedScrollHeight = observedScrollHeightRef.current;
            const usePinnedHeightChangeFallback =
                observedScrollTop != null &&
                observedScrollHeight != null &&
                observedScrollHeight !== params.metrics.scrollHeight &&
                params.fallbackObservedScrollTop != null;
            const movement = resolveWebGenuineScrollMovement({
                scrollTop: params.metrics.scrollTop,
                scrollHeight: params.metrics.scrollHeight,
                clientHeight: params.metrics.clientHeight,
                previousObservedScrollTop:
                    usePinnedHeightChangeFallback
                        ? params.fallbackObservedScrollTop
                        : observedScrollTop ?? params.fallbackObservedScrollTop,
                previousObservedScrollHeight:
                    observedScrollHeight
                    ?? params.metrics.scrollHeight,
                previousObservedClientHeight:
                    observedClientHeightRef.current
                    ?? params.metrics.clientHeight,
                previousStreak: streak,
                distanceFromBottom: params.distanceFromBottom,
                pinThresholdPx: params.pinThresholdPx,
                sustainFrames: params.sustainFrames,
                isTrusted: params.isTrusted,
            });
            if (movement.movedSinceLastObservation) {
                streak = movement.nextStreak;
            }
            observedScrollTopRef.current = params.metrics.scrollTop;
            observedScrollHeightRef.current = params.metrics.scrollHeight;
            observedClientHeightRef.current = params.metrics.clientHeight;
            return movement;
        },
        recordProgrammaticScrollTopWrite(params) {
            const write = writeWebScrollTopAndObserve({
                element: params.element,
                targetScrollTop: params.targetScrollTop,
                observedScrollHeightRef,
                observedScrollTopRef,
            });
            if (write.ok) {
                streak = null;
            }
            return write;
        },
        reset() {
            observedScrollTopRef.current = null;
            observedScrollHeightRef.current = null;
            observedClientHeightRef.current = null;
            streak = null;
        },
    };
}
