import {
    resolveWebGenuineScrollMovement,
    type WebGenuineScrollMovementResult,
    type WebScrollMovementStreak,
} from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    createTranscriptUserScrollIntentOwner,
    TRANSCRIPT_USER_SCROLL_INPUT_CONTINUATION_WINDOW_MS,
    type TranscriptUserScrollIntentOwner,
} from './userScrollIntentOwner';
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
    invalidateUserMovementAuthority(): void;
    observeGenuineScrollMovement(params: Readonly<{
        distanceFromBottom: number;
        fallbackObservedScrollTop: number | null;
        isTrusted: boolean;
        metrics: WebTranscriptScrollMetrics;
        pinThresholdPx: number;
        semanticContext?: Readonly<{
            atEndNonUserCause: 'layout' | 'command';
            isUserInputActive: boolean;
            nowMs: number;
        }>;
        sustainFrames: number;
    }>): WebGenuineScrollMovementResult;
    recordProgrammaticScrollTopWrite(params: Readonly<{
        element: WebScrollTopWriteTarget;
        targetScrollTop: number;
    }>): WebScrollTopWriteResult;
    recordUserScrollInput(params: Readonly<{
        direction: -1 | 1 | null;
        nowMs: number;
    }>): void;
    reset(): void;
    /**
     * The ONE user-scroll-intent owner for this transcript instance, carried here because this
     * object is already the single host<->renderer channel for "who moved the viewport". The host
     * reads its `timestampRef` for the auto-pin/entry/prepend guards; the renderer records input
     * into it and reads its liveness. There is no second copy on either side.
     */
    readonly userScrollIntent: TranscriptUserScrollIntentOwner;
}>;

const USER_MOVEMENT_CONTINUATION_WINDOW_MS = TRANSCRIPT_USER_SCROLL_INPUT_CONTINUATION_WINDOW_MS;

/**
 * C3b web DOM observation owner.
 *
 * Programmatic web scroll writes and subsequent `onScroll` classification share the same observation
 * state here. That keeps the Q1-WEB-1 self-write exclusion out of `ChatList`: a write records the
 * LANDED `scrollTop`/`scrollHeight`, and the scroll echo is genuine only if it moves away from that
 * recorded value.
 */
export function createWebDomScrollObservation(params?: Readonly<{
    userScrollIntent?: TranscriptUserScrollIntentOwner;
}>): WebDomScrollObservation {
    const userScrollIntent = params?.userScrollIntent ?? createTranscriptUserScrollIntentOwner();
    const observedScrollTopRef = { current: null as number | null };
    const observedScrollHeightRef = { current: null as number | null };
    const observedClientHeightRef = { current: null as number | null };
    let streak: WebScrollMovementStreak | null = null;
    let pendingUserInput: Readonly<{ atMs: number; direction: -1 | 1 | null }> | null = null;
    let lastUserMovement: Readonly<{ atMs: number; direction: -1 | 1 }> | null = null;

    const invalidateUserMovementAuthority = (): void => {
        pendingUserInput = null;
        lastUserMovement = null;
        streak = null;
    };

    return {
        getState() {
            return {
                observedClientHeight: observedClientHeightRef.current,
                observedScrollHeight: observedScrollHeightRef.current,
                observedScrollTop: observedScrollTopRef.current,
                streak,
            };
        },
        invalidateUserMovementAuthority,
        userScrollIntent,
        observeGenuineScrollMovement(params) {
            const observedScrollTop = observedScrollTopRef.current;
            const observedScrollHeight = observedScrollHeightRef.current;
            const usePinnedHeightChangeFallback =
                observedScrollTop != null &&
                observedScrollHeight != null &&
                observedScrollHeight !== params.metrics.scrollHeight &&
                params.fallbackObservedScrollTop != null;
            // Resolved BEFORE the classifier so churn cannot veto a gesture the intent owner has
            // already attested. A command-caused frame never counts: that exclusion is below.
            const hasWitnessedUserInput =
                params.semanticContext?.atEndNonUserCause !== 'command'
                && (
                    params.semanticContext?.isUserInputActive === true
                    || (
                        pendingUserInput !== null
                        && params.semanticContext != null
                        && params.semanticContext.nowMs - pendingUserInput.atMs
                            <= USER_MOVEMENT_CONTINUATION_WINDOW_MS
                    )
                );
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
                hasWitnessedUserInput,
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
            const semanticContext = params.semanticContext;
            if (!semanticContext) return movement;

            const direction = movement.direction;
            const moved = movement.movedSinceLastObservation && direction !== null;
            const pendingInputIsCurrent =
                pendingUserInput !== null
                && semanticContext.nowMs - pendingUserInput.atMs <= USER_MOVEMENT_CONTINUATION_WINDOW_MS;
            if (pendingUserInput !== null && !pendingInputIsCurrent) {
                pendingUserInput = null;
            }
            const pendingInputMatchesDirection =
                pendingInputIsCurrent
                && (
                    pendingUserInput?.direction === null
                    || pendingUserInput?.direction === direction
                );
            const directUserMovement =
                semanticContext.atEndNonUserCause !== 'command'
                && moved
                && (semanticContext.isUserInputActive || pendingInputMatchesDirection);
            const inertiaContinuation =
                semanticContext.atEndNonUserCause !== 'command'
                && moved
                && !directUserMovement
                && lastUserMovement !== null
                && lastUserMovement.direction === direction
                && semanticContext.nowMs - lastUserMovement.atMs <= USER_MOVEMENT_CONTINUATION_WINDOW_MS;
            const isGenuineUserMovement = directUserMovement || inertiaContinuation;

            // A command echo cannot consume user input that arrived after the command write.
            // The first later non-command physical movement consumes it, whether or not its
            // direction agrees, so input evidence cannot leak to an unrelated adjustment.
            if (moved && semanticContext.atEndNonUserCause !== 'command') {
                pendingUserInput = null;
            }
            if (isGenuineUserMovement && direction !== null) {
                lastUserMovement = { atMs: semanticContext.nowMs, direction };
            } else if (moved) {
                lastUserMovement = null;
            }

            return {
                ...movement,
                atEndPublicationCause:
                    semanticContext.atEndNonUserCause === 'command'
                        ? 'command'
                        : isGenuineUserMovement ? 'user' : 'layout',
                direction: moved ? direction : null,
                downwardIntent: isGenuineUserMovement && direction === 1,
                isGenuineUserMovement,
                movedSinceLastObservation: moved,
                upwardIntent: isGenuineUserMovement && direction === -1,
            };
        },
        recordProgrammaticScrollTopWrite(params) {
            const write = writeWebScrollTopAndObserve({
                element: params.element,
                targetScrollTop: params.targetScrollTop,
                observedScrollHeightRef,
                observedScrollTopRef,
            });
            if (write.ok) {
                // Our own write re-bases movement measurement, so the STREAK must restart. It does
                // NOT end the reader's gesture: wiping their input evidence here left the next frame
                // of an in-progress wheel scroll unclassified, bottom-follow unreleased, and the
                // auto-pin free to snap them back to the tail. A command/geometry boundary still
                // revokes everything through `invalidateUserMovementAuthority`.
                streak = null;
                if (!userScrollIntent.isLive(Date.now())) {
                    invalidateUserMovementAuthority();
                }
            }
            return write;
        },
        recordUserScrollInput(params) {
            pendingUserInput = {
                atMs: params.nowMs,
                direction: params.direction,
            };
        },
        reset() {
            observedScrollTopRef.current = null;
            observedScrollHeightRef.current = null;
            observedClientHeightRef.current = null;
            invalidateUserMovementAuthority();
        },
    };
}
