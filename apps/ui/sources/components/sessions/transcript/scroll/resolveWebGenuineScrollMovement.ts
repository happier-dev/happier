/**
 * A movement smaller than this (px) on a NON-churn frame is treated as a clamp / sub-pixel / async-re-clamp
 * residue of the app's own programmatic write — NOT an eager user gesture. Only the eager fast-path is gated:
 * a genuine slow scroll still releases via the sustained-streak path, so this never suppresses real intent.
 */
const EAGER_MOVEMENT_EPSILON_PX = 1;

export type WebScrollMovementStreak = Readonly<{ direction: -1 | 1; count: number }>;

export type WebScrollMovementFact = Readonly<{
    /**
     * Semantic cause for an at-end publication produced from this exact observation.
     * Layout/state-listener observations that have no movement fact remain layout-owned.
     */
    atEndPublicationCause: 'user' | 'layout' | 'command';
    /** scrollTop changed since the last observation (vs the self-write/echo case where it did not). */
    movedSinceLastObservation: boolean;
    /** -1 = toward the visual top (older), +1 = toward the visual bottom (newer); null when there was no movement. */
    direction: -1 | 1 | null;
    /** TRUE only for a GENUINE non-programmatic user scroll that should carry release/intent authority. */
    isGenuineUserMovement: boolean;
    /** Genuine upward (toward older) intent — releases bottom-follow. */
    upwardIntent: boolean;
    /** Genuine downward (toward newer) intent. */
    downwardIntent: boolean;
}>;

export type WebGenuineScrollMovementResult = WebScrollMovementFact & Readonly<{
    /** The streak to persist for the next frame (same direction increments, direction flip / churn resets). */
    nextStreak: WebScrollMovementStreak | null;
}>;

/**
 * C3b `WebStandardDomAdapter` — the single owner of "did the WEB user genuinely scroll?" (Plan E3).
 *
 * Web release authority must NOT use the DOM `scroll` event's `isTrusted` flag: RN-web fires
 * `isTrusted:true` even for the app's OWN programmatic `scrollTop=` pin/restore writes, so trusting it
 * lets a programmatic pin under-shoot masquerade as a user scroll and silently release bottom-follow
 * (the Q1-WEB-1 root cause). Instead, genuine movement is "scrollTop moved to a value that does NOT match
 * the last write we observed": every programmatic writer updates `lastObservedScrollTop` to its LANDED
 * value, so the write's echo `onScroll` matches it (`scrollTop === previousObservedScrollTop`) and is NOT
 * genuine; a real scrollbar drag / keyboard scroll moves to a different value and IS.
 *
 * Eagerness: a TRUSTED user gesture (`isTrusted`, a real pointer/keyboard scroll event) releases EAGERLY even
 * within the pin threshold — but ONLY when layout is stable. A trusted event DURING a content-height or
 * viewport-height change (notably the app's own pin write echo that UNDER-SHOT while the stream was growing,
 * or a composer-resize compensation frame — `isTrusted` yet not an exact self-write match) must still be
 * filtered, so eager release requires `isTrusted && !churn`.
 * Untrusted frames (virtualization noise, or scrollbar/keyboard scrolls RN-web does not reliably mark trusted)
 * NEVER release on a single frame — not even when the landing is beyond the pin threshold: a renderer-internal
 * scroll adjustment (Legend MVCP/alignItemsAtEnd) or a composer-inset compensation can move scrollTop
 * arbitrarily far in one untrusted frame (live-captured R3 root cause, 2026-07-08). Untrusted release requires
 * SUSTAINED (>= `sustainFrames`) same-direction movement; a content-height OR viewport-height (clientHeight)
 * change breaks the sustained streak so streaming/layout/resize churn can never masquerade as intent — a user
 * scroll never changes clientHeight. Real gestures emit a continuous stream of frames, so they still release
 * immediately in practice. This is the pure, orientation-agnostic single owner of web release authority —
 * no duplication between the FlashList-onScroll and DOM-observer paths.
 *
 * WITNESSED INPUT (`hasWitnessedUserInput`). Churn-filtering answers "could this frame be our own
 * write or a reflow?" — a question that only has to be asked when nothing else attests the reader.
 * A content-height change is also the ONLY thing that arms the auto-pin, so making churn a blanket
 * veto left the classifier structurally blind exactly when the pin decision needed it: the reader
 * scrolls up while the tail grows, no frame can be certified, bottom-follow is never released, and
 * the pin writes them back to the bottom. When the user-scroll-intent owner attests unforgeable raw
 * input (`viewport/driver/userScrollIntentOwner`), that outranks the churn heuristic. Q1-WEB-1 is
 * preserved by construction, not by the churn clause: a programmatic write records its LANDED value,
 * so its echo is excluded by value identity above, and command-caused frames are excluded outright by
 * the DOM observation owner's semantic context. `isTrusted` alone is still never sufficient.
 */
export function resolveWebGenuineScrollMovement(params: Readonly<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    previousObservedScrollTop: number | null;
    previousObservedScrollHeight: number | null;
    previousObservedClientHeight: number | null;
    previousStreak: WebScrollMovementStreak | null;
    distanceFromBottom: number;
    /** The intent owner attests raw wheel/drag/keyboard/touch input for this frame. */
    hasWitnessedUserInput?: boolean;
    pinThresholdPx: number;
    sustainFrames: number;
    isTrusted: boolean;
}>): WebGenuineScrollMovementResult {
    const {
        scrollTop,
        scrollHeight,
        clientHeight,
        previousObservedScrollTop,
        previousObservedScrollHeight,
        previousObservedClientHeight,
        previousStreak,
        distanceFromBottom,
        hasWitnessedUserInput,
        pinThresholdPx,
        sustainFrames,
        isTrusted,
    } = params;

    // No prior observation, or scrollTop landed exactly where we last wrote it (the programmatic write's
    // own echo) → not a user movement.
    if (
        previousObservedScrollTop == null ||
        !Number.isFinite(scrollTop) ||
        scrollTop === previousObservedScrollTop
    ) {
        return {
            atEndPublicationCause: 'layout',
            movedSinceLastObservation: false,
            direction: null,
            nextStreak: previousStreak,
            isGenuineUserMovement: false,
            upwardIntent: false,
            downwardIntent: false,
        };
    }

    const direction: -1 | 1 = scrollTop < previousObservedScrollTop ? -1 : 1;
    const contentHeightChanged =
        previousObservedScrollHeight != null &&
        Number.isFinite(scrollHeight) &&
        scrollHeight !== previousObservedScrollHeight;
    const viewportHeightChanged =
        previousObservedClientHeight != null &&
        Number.isFinite(clientHeight) &&
        clientHeight !== previousObservedClientHeight;
    // Layout churn (content reflow OR viewport resize — e.g. the composer growing shrinks the list
    // clientHeight and shifts scrollTop in the same commit) breaks the sustained streak so it can't
    // accumulate into "sustained user intent". A user scroll never changes either height.
    const layoutChurn = contentHeightChanged || viewportHeightChanged;
    // Witnessed raw input is direct evidence of the reader. It keeps the streak alive across churn
    // so a growing tail cannot, by itself, prevent certification of a gesture already in progress.
    const basisStreak = layoutChurn && hasWitnessedUserInput !== true ? null : previousStreak;
    const streakCount = basisStreak?.direction === direction ? basisStreak.count + 1 : 1;
    const nextStreak: WebScrollMovementStreak = { direction, count: streakCount };

    const beyondPinThreshold = distanceFromBottom > Math.max(0, pinThresholdPx);
    const sustainedMovement = streakCount >= Math.max(1, sustainFrames);
    // A TRUSTED user gesture releases eagerly even within the threshold — but only when layout is
    // stable. A trusted event during reflow (e.g. the app's own pin write that UNDER-SHOT while
    // streaming, or a resize compensation frame — `isTrusted` yet not an exact self-write) must still
    // be filtered, so eager requires `isTrusted && !churn`. Untrusted frames release ONLY when
    // SUSTAINED: a beyond-threshold landing alone is not user evidence, because renderer-internal
    // adjustments (Legend MVCP) and inset compensations can land arbitrarily far in one frame.
    const movementMagnitudePx = Math.abs(scrollTop - previousObservedScrollTop);
    const eagerTrustedRelease =
        isTrusted === true
        && (!layoutChurn || hasWitnessedUserInput === true)
        && movementMagnitudePx > EAGER_MOVEMENT_EPSILON_PX;
    const upwardIntent = direction === -1 && (eagerTrustedRelease || sustainedMovement);
    const downwardIntent = direction === 1 && beyondPinThreshold && sustainedMovement;

    const isGenuineUserMovement = upwardIntent || downwardIntent;
    return {
        atEndPublicationCause: isGenuineUserMovement ? 'user' : 'layout',
        movedSinceLastObservation: true,
        direction,
        nextStreak,
        isGenuineUserMovement,
        upwardIntent,
        downwardIntent,
    };
}
