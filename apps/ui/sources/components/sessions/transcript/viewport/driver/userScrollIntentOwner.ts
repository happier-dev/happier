/**
 * Maximum gap after the last raw scroll input for the gesture to still count as physically
 * in progress. Trackpad/wheel momentum and browser smooth-scroll continuation emit frames
 * every ~16-100ms; a Legend replay/measurement burst arrives after a longer gap or with a
 * programmatic correction interleaved. Same value the DOM observation owner uses for its
 * inertia continuation, and the renderer for its own — one window, one owner.
 */
export const TRANSCRIPT_USER_SCROLL_INPUT_CONTINUATION_WINDOW_MS = 320;

/**
 * A continuous, self-closing input phase. `drag` covers a native finger drag and a web
 * scrollbar-thumb drag (pointerdown in the scrollbar band until pointerup); `momentum`
 * covers a fling that chained off a real drag release.
 */
export type TranscriptUserScrollIntentGesture = 'drag' | 'momentum';

/**
 * Read-only view of the owner's single last-input cell, in the `{ current }` shape the host
 * already threads into its bottom-follow, entry-restore, prepend and lifecycle consumers.
 *
 * READ-ONLY IS THE POINT. The first version of this owner exposed a mutable ref *and* kept a
 * private `lastRawInputAtMs`, so nine host sites assigned the ref directly and desynchronized the
 * two halves: a command-boundary revoke cleared the ref while `isLive()` still claimed the reader
 * was driving, and a host record advanced the ref while `lastInputAtMs()` stayed `-Infinity`. That
 * is the same split brain this owner exists to remove, one layer down. There is now exactly one
 * cell; every writer goes through `recordInput` / `setGestureActive` / `revokeInputEvidence` /
 * `clear`, and the compiler enforces it.
 */
export type TranscriptUserScrollIntentTimestampReader = Readonly<{ readonly current: number }>;

export type TranscriptUserScrollIntentOwner = Readonly<{
    /**
     * Live read-only view of the ONE storage location for "when did the reader last express scroll
     * intent". Producers: raw input handlers (host + renderer) and the classifier's
     * `web-user-scroll-intent-timestamp` lifecycle effect.
     */
    readonly timestampRef: TranscriptUserScrollIntentTimestampReader;
    /** True while a drag/momentum phase is open. */
    isGestureActive(): boolean;
    /**
     * True while the reader's hand is on the scroller: an open drag/momentum phase, or raw
     * scroll input within the bounded continuation window. This is the STATE-shaped fact that
     * pin suppression needs — an event timestamp alone cannot answer it for a scrollbar drag
     * (one pointerdown then silence for the whole drag), a held key, or an inertia tail that
     * outlives the last wheel event.
     */
    isLive(nowMs: number): boolean;
    /** Latest RAW scroll input timestamp; never a classifier derivation. */
    lastInputAtMs(): number;
    /**
     * Direction the reader last ASKED for (-1 toward older, +1 toward newer), or null when the
     * input carried none (a scrollbar-thumb press, a bare drag start). Needed because "input is
     * live" alone must never license attributing movement the reader did not ask for: at the top
     * clamp an upward wheel produces no movement while estimate churn pushes the offset DOWN, and
     * treating that as the reader's would abandon the anchor they are reading (live S-D, 2026-07-11).
     */
    lastInputDirection(): -1 | 1 | null;
    /**
     * STATE, not an event: the reader left the live tail under their own hand and has not come
     * back. Does NOT decay — `isLive` and every `nowMs - t < window` predicate go false a few
     * hundred milliseconds after the gesture ends, which is exactly when an automatic follow
     * writer used to move a reader who had deliberately parked away from the tail. A reader who
     * scrolled up and stopped has not consented to being returned to the bottom; that consent is
     * only re-established by their own return or by an explicit command.
     *
     * Mirrors the persisted-viewport shape on purpose: `markSessionLiveTailIntent` DELETES the
     * stored viewport record on send / enqueue / leave-at-tail, i.e. "pinned to the live tail" is
     * already expressed as the ABSENCE of a parked position. This is the same fact, in-session.
     */
    isParkedAwayFromLiveTail(): boolean;
    /** The parked distance in px, or `null` when the reader is at the live tail. */
    parkedDistanceFromLiveTailPx(): number | null;
    /**
     * Feed a MEASURED distance from the live tail. Deliberately asymmetric:
     * - Parking (leaving the tail) requires live raw input, so content growing below a following
     *   reader — which also increases the measured distance — can never park them.
     * - Releasing (arriving inside the pin band) is unconditional, because being at the tail is
     *   being at the tail whatever moved you there. This also makes a false park self-healing:
     *   the worst case is that one automatic follow write is skipped and the next measured
     *   arrival clears it.
     * No per-frame attribution is consulted: `resolveWebGenuineScrollMovement` stays the owner of
     * "is THIS frame ours or the reader's", and it must not become an input to liveness or parking
     * (that is the Q1-WEB-1 exclusion, and collapsing them re-breaks it).
     */
    observeDistanceFromLiveTail(input: Readonly<{
        atMs: number;
        distanceFromLiveTailPx: number;
        pinThresholdPx: number;
    }>): void;
    /**
     * The reader is (back) at the live tail by explicit command: jump-to-bottom, follow-bottom
     * intent, send/enqueue, a trusted bottom arrival. Clears the parked position — the same
     * deletion `markSessionLiveTailIntent` performs on the persisted record.
     *
     * SEPARATE FROM `revokeInputEvidence` ON PURPOSE. The two facts have different producers:
     * input evidence is revoked at EVERY command boundary (the renderer invalidates inertia
     * continuation on `scrollToIndex`, `scrollToOffset`, an entry-anchor landing and an explicit
     * jump takeover), and only a SUBSET of those commands returns the reader to the live tail.
     * Folding the parked release into the revoke let a jump to an arbitrary older message —
     * navigation AWAY from the tail — silently re-authorize automatic bottom-follow writes,
     * which is precisely what parking exists to refuse.
     */
    releaseLiveTailParking(): void;
    /** Record raw, unforgeable scroll input (wheel / drag / momentum / touch / keyboard). */
    recordInput(input: Readonly<{ atMs: number; direction?: -1 | 1 | null }>): void;
    /** Open or close a continuous gesture phase. Closing also records terminal input. */
    setGestureActive(input: Readonly<{
        active: boolean;
        atMs: number;
        gesture: TranscriptUserScrollIntentGesture;
    }>): void;
    /**
     * Revoke recorded input EVIDENCE at a command/data boundary (explicit jump, logical session
     * phase change) while leaving an OPEN gesture phase intact: a command issued mid-fling must not
     * pretend the finger left the screen.
     *
     * Does NOT touch the parked position. Most callers are navigation commands with no opinion
     * about the live tail (`scrollToIndex`/`scrollToOffset` to an older message, an entry-anchor
     * landing); a deliberate return calls `releaseLiveTailParking` in addition.
     */
    revokeInputEvidence(): void;
    /** Full revoke, including any open gesture phase: session change / teardown. */
    clear(): void;
}>;

/**
 * ONE owner for "is the reader scrolling / does the reader still want the live tail".
 *
 * Before this owner the same question had three faces: a host timestamp ref
 * (`ChatListInternal`), a same-named renderer timestamp ref (`legendListRenderer`), and the
 * renderer's private `userDragActive`/`userMomentumActive` bits. The host's auto-pin guard
 * therefore could not see a web scrollbar drag at all (that gesture lives only in the
 * renderer), and the renderer could not see host-side keyboard/pointer intent. Pin
 * suppression was event-shaped (a timestamp that expires 250ms after an EVENT) while the
 * fact it needed is state-shaped (a gesture that is still in progress).
 *
 * Ownership split that remains, deliberately:
 * - THIS owner answers "does the reader have their hand on the scroller / did they just
 *   express scroll intent". It is fed only by unforgeable input and by the classifier's
 *   certified-movement effect.
 * - `resolveWebGenuineScrollMovement` keeps answering "is THIS scroll frame attributable to
 *   the user rather than to our own write" (the Q1-WEB-1 self-write exclusion). It is a
 *   per-frame attribution question, not a liveness question, and it stays single-owner.
 * - "Any interaction" (a bare tap) is NOT scroll intent and is deliberately not recorded
 *   here: an expansion commit keeps moving the offset for seconds after a toggling tap, and
 *   treating that as a detach strands the armed hold (live native S-C, 2026-07-11).
 */
export function createTranscriptUserScrollIntentOwner(): TranscriptUserScrollIntentOwner {
    // THE one cell. `timestampRef` below is a read-only live view over it, not a second copy.
    let lastRawInputAtMs = Number.NEGATIVE_INFINITY;
    let lastRawInputDirection: -1 | 1 | null = null;
    let dragActive = false;
    let momentumActive = false;
    let parkedDistanceFromLiveTailPx: number | null = null;

    const timestampRef: TranscriptUserScrollIntentTimestampReader = {
        get current(): number {
            return lastRawInputAtMs;
        },
    };

    const isLive = (nowMs: number): boolean => {
        if (dragActive || momentumActive) return true;
        if (!Number.isFinite(nowMs)) return false;
        return nowMs - lastRawInputAtMs <= TRANSCRIPT_USER_SCROLL_INPUT_CONTINUATION_WINDOW_MS;
    };

    const recordInput = (input: Readonly<{ atMs: number; direction?: -1 | 1 | null }>): void => {
        if (!Number.isFinite(input.atMs)) return;
        lastRawInputAtMs = input.atMs;
        lastRawInputDirection = input.direction ?? null;
    };

    return {
        timestampRef,
        isGestureActive() {
            return dragActive || momentumActive;
        },
        isLive,
        lastInputAtMs() {
            return lastRawInputAtMs;
        },
        lastInputDirection() {
            return lastRawInputDirection;
        },
        isParkedAwayFromLiveTail() {
            return parkedDistanceFromLiveTailPx !== null;
        },
        parkedDistanceFromLiveTailPx() {
            return parkedDistanceFromLiveTailPx;
        },
        observeDistanceFromLiveTail(input) {
            if (!Number.isFinite(input.distanceFromLiveTailPx)) return;
            const distance = Math.max(0, input.distanceFromLiveTailPx);
            const threshold = Number.isFinite(input.pinThresholdPx) ? Math.max(0, input.pinThresholdPx) : 0;
            if (distance <= threshold) {
                parkedDistanceFromLiveTailPx = null;
                return;
            }
            if (!isLive(input.atMs)) return;
            parkedDistanceFromLiveTailPx = distance;
        },
        releaseLiveTailParking() {
            parkedDistanceFromLiveTailPx = null;
        },
        recordInput,
        setGestureActive(input) {
            if (input.gesture === 'drag') {
                dragActive = input.active;
            } else {
                momentumActive = input.active;
            }
            // Both edges are input evidence: the press that opens a scrollbar drag and the
            // release that closes it are the reader acting on the scroller.
            recordInput({ atMs: input.atMs });
        },
        revokeInputEvidence() {
            lastRawInputAtMs = Number.NEGATIVE_INFINITY;
            lastRawInputDirection = null;
        },
        clear() {
            lastRawInputAtMs = Number.NEGATIVE_INFINITY;
            lastRawInputDirection = null;
            dragActive = false;
            momentumActive = false;
            parkedDistanceFromLiveTailPx = null;
        },
    };
}
