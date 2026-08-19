import {
    createDefaultTranscriptItemHeightCache,
    isTranscriptItemHeightSignatureStable,
    type TranscriptItemHeightCache,
    type TranscriptItemHeightCacheOptions,
    type TranscriptItemHeightRowState,
    type TranscriptItemHeightValiditySignature,
} from './transcriptItemHeightCache';

/**
 * C1 — the committed-height reconciler for transcript rows.
 *
 * Single authority for the three measurement reads a FlashList host must make per render/commit:
 *   R1 recycle identity (shape-stable getItemType so cells never remount mid-stream),
 *   R2 reserved height (exact for stable rows; a monotonic PER-ITEM floor for streaming/prepended
 *      rows so FlashList never positions a neighbour from a height it will contradict within a frame.
 *      The floor lives only as long as the state that needs it: once a row settles, its reservation
 *      is its own real measured height and never the peak it reached while growing — see
 *      {@link isFloorShapeValid}),
 *   R3 global invalidation (the sole clearLayoutCacheOnUpdate decision: structural deltas only,
 *      coalesced per commit, never while a prepend/entry-restore transaction owns the viewport).
 *
 * Pure core (no React, no FlashList). The host hook wires it to refs/commit timing and is the only
 * place the FlashList ref is touched. Orientation-agnostic: a content `minHeight` floor behaves
 * identically under the inverted `scaleY:-1` transform (intrinsic cell content height is unchanged).
 *
 * R2 reserves ONLY a row's OWN last-measured height (keyed by `itemId`). It deliberately does NOT
 * seed a per-recycle-type median first-paint floor: the recycle type is shape-only (all `message:agent`
 * share one bucket), so a median mixes short and long rows and force-reserves short rows too tall — and
 * a content `minHeight` is self-fulfilling (onLayout then measures the FORCED height, so the
 * over-reservation never recovers). A never-measured row reserves nothing and uses FlashList's natural
 * onLayout measurement; the per-item floor protects subsequent frames once the row's real height exists.
 *
 * Design: `.reviews/2026-06-14-091335-transcript-deep-audit/subagents/19-design-C1-measurement.md`.
 */

/** Floor (>=) vs exact (==): a floor may never force FlashList to a height it would not itself measure. */
export type TranscriptRowHeightReservation =
    | Readonly<{ kind: 'exact'; minHeight: number }>
    | Readonly<{ kind: 'floor'; minHeight: number }>;

export type TranscriptGlobalInvalidationReason =
    | 'structural-delta'
    | 'viewport-transaction-open'
    | 'already-cleared-this-commit'
    | 'append-no-structural-delta';

export type TranscriptGlobalInvalidationDecision = Readonly<{
    clear: boolean;
    reason: TranscriptGlobalInvalidationReason;
}>;

export type TranscriptGlobalInvalidationRequest = Readonly<{
    viewportTransactionOpen: boolean;
    commitToken: number;
}> & (
    | Readonly<{ previous: TranscriptItemHeightValiditySignature; next: TranscriptItemHeightValiditySignature }>
    | Readonly<{ structural: boolean }>
);

export type TranscriptMeasurementReconciler = Readonly<{
    /** R1. Sole recycle-type authority. Pure function of the row's shape signature. */
    resolveRecycleType(signature: TranscriptItemHeightValiditySignature): string;

    /**
     * R2. Sole reservation producer. Exact for stable rows; a monotonic per-item floor for
     * non-stable rows, valid only under the provenance it was measured in
     * ({@link isFloorShapeValid}); undefined if unknown or provenance-stale.
     */
    resolveReservation(signature: TranscriptItemHeightValiditySignature): TranscriptRowHeightReservation | undefined;

    /**
     * R2b. The row's own last recorded onLayout height at this item+geometry, **independent of the
     * content shape it was measured from** — a PREDICTION, never a reservation.
     *
     * A reservation becomes a real `minHeight` style and is self-fulfilling, so it must be released
     * the instant a shrink-capable row's shape moves ({@link isFloorShapeValid}); a prediction is
     * only what the renderer virtualizes an UNMOUNTED row with until that row's next onLayout
     * replaces it. Fusing the two made a released floor delete the app's only real measurement of a
     * row, so the renderer re-sized already-scrolled-past rows from a flat content heuristic and
     * dragged every row below them (W-1 web scroll regression).
     *
     * Returns `undefined` for a never-measured or reset-pending row. This is the row's own last
     * real onLayout height and never the growth-episode PEAK: the peak is an aggregate over frames
     * the row no longer paints, so serving it as a prediction placed the next row from a height
     * nothing paints (W17). Callers still filter the growing states first
     * (`estimateTranscriptRowHeightFromCache`), because a growing row's last frame is stale by
     * construction — its content is still arriving.
     */
    resolveLastMeasuredHeight(signature: TranscriptItemHeightValiditySignature): number | undefined;

    /** Record a committed measurement (from onLayout). Updates exact (stable) or the monotonic per-item floor. */
    recordMeasuredHeight(input: Readonly<{
        signature: TranscriptItemHeightValiditySignature;
        heightPx: number;
    }>): void;

    /** Drop the floor for an item on a structural change (collapse/shrink/identity), NOT on append. */
    resetReservationForStructuralChange(input: Readonly<{
        itemId: string;
        signature: TranscriptItemHeightValiditySignature;
    }>): void;

    /**
     * R2c. The painted height of ONE user utterance's message bubble, carried ACROSS the two rows
     * that paint it.
     *
     * A send shows the same utterance twice under two different Legend item keys — inside the
     * `pending-queue` row, then as the committed `msg:<id>` row that replaces it. The committed key
     * has never been measured, so without this it is placed from
     * `estimateTranscriptRowHeightFromContent`'s flat wrap heuristic, which undershoots by whole
     * painted lines (72 modelled chars per line against ~43 really painted at a 402pt viewport).
     * The transcript is bottom-pinned, so that deficit moves the whole list DOWN on the crossover
     * frame and back UP one or more frames later when the row's own onLayout lands — measured on
     * device at 163px for a 236-char send and 379px for a 569-char one
     * (`.project/reviews/2026-08-18-send-crossover-native/DEVICE-MEASUREMENT.md`).
     *
     * The app already holds the answer: the pending block painted that exact bubble, at that exact
     * width, milliseconds earlier. This carries THAT measurement — not a prediction — so the
     * committed row's first commit is placed from a real height.
     *
     * It is the BUBBLE, never the row: the two presentations wrap different chrome around the same
     * bubble (the block adds its header, scroll padding and, on web, an action row; the committed
     * row adds `userMessageWrapper.paddingBottom`), and only the bubble is common to both. Each
     * consumer composes its own chrome around this value, so neither can encode the other's.
     *
     * Geometry-scoped exactly like a floor (`widthBucket|fontScaleKey`): the same utterance at a
     * different width is a different painted height. Dropped on session change.
     */
    recordPaintedUtteranceBubbleHeight(input: Readonly<{
        identity: string;
        bubbleHeightPx: number;
        widthBucket: string;
        fontScaleKey: string;
    }>): void;

    /** The carried bubble height for `identity` at this geometry, or `undefined`. */
    resolvePaintedUtteranceBubbleHeight(input: Readonly<{
        identity: string;
        widthBucket: string;
        fontScaleKey: string;
    }>): number | undefined;

    /**
     * R3. Coalesced, transaction-gated decision: may the whole-list cache be cleared this commit?
     * Supply a signature pair (the structural delta is computed) OR an explicit `structural: true`
     * for a discrete structural action (e.g. a direct expand/collapse) where no pair is available.
     */
    requestGlobalLayoutInvalidation(input: TranscriptGlobalInvalidationRequest): TranscriptGlobalInvalidationDecision;

    /** Lifecycle: drop per-session floors/commit latch on session change. */
    resetForSession(sessionId: string): void;
}>;

export type TranscriptMeasurementReconcilerOptions = Readonly<{
    cache?: TranscriptItemHeightCache;
    cacheOptions?: TranscriptItemHeightCacheOptions;
}>;

type FloorState = Readonly<{
    /**
     * Monotonic floor for this item+geometry WITHIN the provenance recorded below, or null while
     * reset-pending. For a growing row that provenance is the growth episode (the floor is a
     * deliberate cross-shape peak); for every other row it is one content shape.
     */
    minHeight: number | null;
    /**
     * The row's own last real onLayout height — no monotonic max, no aggregation. Kept apart from
     * {@link FloorState.minHeight} because a growth-episode peak is not a size the row still paints
     * (W17), while `resolveLastMeasuredHeight` must hand the renderer a real measurement.
     */
    lastMeasuredHeight: number | null;
    /** The content shape the floor was recorded from. Scopes the floor for shrink-capable rows. */
    structuralKey: string;
    /** The presentation (recycle type) the floor was recorded from. */
    kind: string;
    /** The row state the floor was recorded in. Separates a growth-episode peak from a settled height. */
    rowState: TranscriptItemHeightRowState;
}>;

/**
 * Row states whose content only ever GROWS within one shape. Their monotonic floor must survive
 * `structuralKey` churn: it is the thing that stops a mid-stream frame from under-reserving.
 *
 * Everything else — `stable`, `pending-action`, `tool-progress` — is SHRINK-CAPABLE: a draining
 * pending queue, a granted permission prompt collapsing into a running row, a shrinking tool preview.
 * For those the floor is only valid for the shape that produced it (see {@link isFloorShapeValid}).
 *
 * `thinking` is growing and NOT `streaming`: `resolveMessageRowState` returns 'thinking' BEFORE any
 * streaming branch, so a genuinely growing thinking block reports 'thinking'. A settled thinking
 * block must therefore stop reporting 'thinking' at the assignment owner, not be special-cased here.
 */
export const TRANSCRIPT_GROWING_ROW_STATES: ReadonlySet<TranscriptItemHeightRowState> = new Set<TranscriptItemHeightRowState>([
    'streaming',
    'thinking',
]);

function isGrowingRowState(rowState: TranscriptItemHeightRowState): boolean {
    return TRANSCRIPT_GROWING_ROW_STATES.has(rowState);
}

function isValidHeight(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function buildFloorKey(signature: TranscriptItemHeightValiditySignature): string {
    return `${signature.itemId.length}:${signature.itemId}|${signature.widthBucket}|${signature.fontScaleKey}`;
}

/**
 * Only utterances still crossing over are ever read back, so this bound exists to stop a long-lived
 * session accumulating one entry per send, not to express a policy about which sends matter.
 */
const MAX_PAINTED_UTTERANCE_BUBBLE_HEIGHTS = 32;

function buildPaintedUtteranceKey(identity: string, widthBucket: string, fontScaleKey: string): string {
    return `${identity.length}:${identity}|${widthBucket}|${fontScaleKey}`;
}

/**
 * The floor key is deliberately geometry-scoped (`itemId|widthBucket|fontScaleKey`) and carries no
 * `structuralKey`, so one entry survives content churn. For a GROWING row that is the whole point.
 * For a shrink-capable row it is how the tallest historical height outlived its content: the reset
 * trigger cannot run at all on a fresh mount (`TranscriptRowShell` initialises both signature refs
 * to the current signature, so there is no previous signature to diff), and a viewport resize plus
 * return re-selects the same warm key. Serving and carrying over are therefore both gated here —
 * one predicate, so the producer and the consumer of a floor can never disagree about its scope.
 *
 * A floor is only valid for the PROVENANCE it was recorded under:
 *  - same presentation (`kind`): a `message:thinking` measurement is not a `message:agent` height;
 *  - same growth classification: a height measured mid-growth is an aggregate of frames the row no
 *    longer paints, and a settled height is not a bound on a row whose content is still arriving;
 *  - and, once settled, the same content shape.
 *
 * W17 — the growth-classification leg is what makes the stale-peak state unreachable rather than
 * correctable. A growing row's floor is deliberately carried across `structuralKey` churn (that is
 * what stops a mid-stream frame from under-reserving), and `recordMeasuredHeight` stores the carried
 * peak under the shape it was carried INTO. With `structuralKey` as the only gate, the instant the
 * row settled at that same shape — which for an assistant message is the instant a tool call is
 * committed after it, since `streaming` is `sessionActive && isLatestCommittedActivity` and the
 * latest activity key is simply the last message — the peak compared equal and could never be
 * refused again. Live web capture 2026-07-28 (`cmrdwwsd60bg0tmo6n0k6zq79`): [42, 24, 48]px of blank
 * band under three settled messages, every one of them at a `msg->toolCalls` boundary, while every
 * `toolCalls->*` boundary measured 0 — no tool row can hold a growing peak, because
 * `resolveMessageRowState` pins tool-call messages to 'tool-progress' and every tool-group unit row
 * to 'stable'. Gating on provenance releases the peak at the transition instead of on a later
 * corrector, so no consumer ever observes it.
 */
function isFloorShapeValid(
    floor: FloorState,
    signature: TranscriptItemHeightValiditySignature,
): boolean {
    if (floor.kind !== signature.kind) return false;
    const floorIsGrowing = isGrowingRowState(floor.rowState);
    if (floorIsGrowing !== isGrowingRowState(signature.rowState)) return false;
    if (floorIsGrowing) return true;
    return floor.structuralKey === signature.structuralKey;
}

/**
 * Structural delta = a shape change that can shrink or re-flow a row, warranting a whole-list
 * re-stack. A row that is (or just was) streaming is mid content-flux: the per-row onLayout channel
 * absorbs BOTH its growth AND its stream-finalize (`streaming -> stable`) without a whole-list
 * re-stack. Clearing the global FlashList layout cache while streaming is involved resets
 * bottom-maintenance and DROPS the pin on stream-finalize / tool-arrival (the next content then
 * lands below the viewport) — so suppress whenever EITHER side is streaming. A genuine re-stack
 * (expand/collapse, width/font, or a kind/rowState change between two settled rows) only happens
 * when neither side is streaming. (Matches the prior working suppression; replaces it.)
 */
function hasStructuralDelta(
    previous: TranscriptItemHeightValiditySignature,
    next: TranscriptItemHeightValiditySignature,
): boolean {
    if (previous.rowState === 'streaming' || next.rowState === 'streaming') return false;
    if (previous.rowState !== next.rowState) return true;
    if (previous.kind !== next.kind) return true;
    if (previous.expansionKey !== next.expansionKey) return true;
    if (previous.widthBucket !== next.widthBucket) return true;
    if (previous.fontScaleKey !== next.fontScaleKey) return true;
    return false;
}

/**
 * Per-ITEM floor-reset trigger (distinct from {@link hasStructuralDelta}, the whole-list cache
 * invalidation gate). Returns true when a row's reservation floor must be re-seeded from its next
 * onLayout because the shape changed in a shrink-capable way. `TranscriptRowShell` calls this to
 * decide whether to `resetReservationForStructuralChange`.
 *
 * Difference from `hasStructuralDelta`: that gate suppresses on ANY streaming side (clearing the
 * whole-list cache mid-stream drops the pin); this one suppresses only when BOTH sides stream — a
 * streaming row's own frames keep their growing floor, but a streaming→stable finalize re-seeds.
 *
 * It additionally re-seeds on a SHRINK-CAPABLE content change: a `structuralKey` delta while NEITHER
 * side is growing ({@link TRANSCRIPT_GROWING_ROW_STATES}). The motivating cases are a grouped
 * tool-calls HEADER whose height drops (≈36→33px) when its status goes running→completed, a pending
 * queue draining 3→1, and a `permission_pending`→`running` collapse — which keeps the SAME
 * `tool-progress` rowState, so every rowState/expansion/width/font check misses it. In all of them
 * the status lives in `structuralKey` while the per-item floor is keyed WITHOUT it, so the floor
 * keeps serving the taller historical height and the `minHeight` self-fulfils a persistent gap.
 *
 * This clause was previously gated on `stable && stable`, which excluded `tool-progress` and
 * `pending-action` on the premise that they grow like a stream. That premise is refuted: a
 * `minHeight` is INERT for a growing row — it binds only BELOW natural height — so the floor never
 * protected growth; it only stranded shrinks. Only `streaming` and `thinking` are growing, and for
 * those the monotonic floor still absorbs transient mid-frame shortfalls.
 */
export function isStructuralSignatureDelta(
    previous: TranscriptItemHeightValiditySignature,
    next: TranscriptItemHeightValiditySignature,
): boolean {
    if (previous.rowState === 'streaming' && next.rowState === 'streaming') return false;
    if (previous.rowState !== next.rowState) return true;
    if (previous.kind !== next.kind) return true;
    if (previous.expansionKey !== next.expansionKey) return true;
    if (previous.widthBucket !== next.widthBucket) return true;
    if (previous.fontScaleKey !== next.fontScaleKey) return true;
    if (
        !isGrowingRowState(previous.rowState)
        && !isGrowingRowState(next.rowState)
        && previous.structuralKey !== next.structuralKey
    ) {
        return true;
    }
    return false;
}

export function createTranscriptMeasurementReconciler(
    options: TranscriptMeasurementReconcilerOptions = {},
): TranscriptMeasurementReconciler {
    const cache = options.cache ?? createDefaultTranscriptItemHeightCache(options.cacheOptions);

    // Per-item monotonic floor, keyed by itemId+width+font. `minHeight: null` marks reset-pending:
    // the row was measured then structurally reset, so its next real onLayout re-seeds the floor
    // (taking the new, possibly smaller, height) rather than reserving the stale pre-collapse height.
    const floorsByKey = new Map<string, FloorState>();

    /**
     * Painted bubble heights carried across the pending→committed crossover, keyed by
     * `identity|widthBucket|fontScaleKey`. Bounded and insertion-ordered: only the utterances
     * currently in flight can ever be read (a committed row is measured on its first layout and
     * never consults this again), so the cap is a leak guard, not a policy.
     */
    const paintedUtteranceBubbleHeights = new Map<string, number>();

    let lastClearedCommitToken: number | null = null;

    function resolveFloorReservation(
        signature: TranscriptItemHeightValiditySignature,
    ): TranscriptRowHeightReservation | undefined {
        const floor = floorsByKey.get(buildFloorKey(signature));
        if (
            floor !== undefined
            && floor.minHeight !== null
            && isValidHeight(floor.minHeight)
            && isFloorShapeValid(floor, signature)
        ) {
            return { kind: 'floor', minHeight: floor.minHeight };
        }
        // Never-measured, reset-pending, or provenance-stale row: reserve NOTHING → FlashList's
        // natural onLayout measures the row's real height. (No per-type median seed — module doc.)
        return undefined;
    }

    return {
        resolveRecycleType(signature) {
            return signature.kind;
        },

        resolveReservation(signature) {
            if (isTranscriptItemHeightSignatureStable(signature)) {
                const entry = cache.get(signature);
                if (entry !== undefined && isValidHeight(entry.heightPx)) {
                    return { kind: 'exact', minHeight: entry.heightPx };
                }
                // A stable row whose content changed misses the exact cache; it may still carry a
                // per-item floor (e.g. it just finalized) — serve that rather than nothing.
                return resolveFloorReservation(signature);
            }
            return resolveFloorReservation(signature);
        },

        resolveLastMeasuredHeight(signature) {
            const floor = floorsByKey.get(buildFloorKey(signature));
            if (
                floor === undefined
                || floor.lastMeasuredHeight === null
                || !isValidHeight(floor.lastMeasuredHeight)
            ) {
                return undefined;
            }
            return floor.lastMeasuredHeight;
        },

        recordMeasuredHeight(input) {
            const { signature, heightPx } = input;
            if (!isValidHeight(heightPx)) return;
            const measured = Math.trunc(heightPx);

            // Exact path: stable rows write the LRU height cache (its existing stable-only contract).
            if (isTranscriptItemHeightSignatureStable(signature)) {
                cache.set(signature, { heightPx: measured });
            }

            // Floor path: monotonic per item+geometry, WITHIN the provenance this measurement is
            // taken under. A reset-pending (null) floor, or a floor recorded under a different
            // provenance, re-seeds from this measurement (taking the new, possibly smaller, height);
            // otherwise it only grows. Carrying a floor across a provenance change is what let the
            // tallest historical height leak back in after the row had already re-measured shorter.
            //
            // The carried value keeps growing across `structuralKey` churn WHILE the row grows, and
            // `isFloorShapeValid` — not the stored `structuralKey` — is what refuses it once the
            // row settles, so re-labelling it here can no longer resurrect it (W17). The row's own
            // last real height is stored beside it, unaggregated, for the prediction consumer.
            const floorKey = buildFloorKey(signature);
            const existing = floorsByKey.get(floorKey);
            const carriedPeak = existing !== undefined
                && existing.minHeight !== null
                && isFloorShapeValid(existing, signature)
                ? existing.minHeight
                : null;
            floorsByKey.set(floorKey, {
                minHeight: carriedPeak === null ? measured : Math.max(carriedPeak, measured),
                lastMeasuredHeight: measured,
                structuralKey: signature.structuralKey,
                kind: signature.kind,
                rowState: signature.rowState,
            });
        },

        recordPaintedUtteranceBubbleHeight(input) {
            const identity = String(input.identity ?? '').trim();
            if (identity.length === 0 || !isValidHeight(input.bubbleHeightPx)) return;
            const key = buildPaintedUtteranceKey(identity, input.widthBucket, input.fontScaleKey);
            // Re-insert so the eviction order tracks recency, not first paint: a queue that keeps
            // re-measuring one row must not push the utterance a later send is about to commit out.
            paintedUtteranceBubbleHeights.delete(key);
            paintedUtteranceBubbleHeights.set(key, Math.trunc(input.bubbleHeightPx));
            while (paintedUtteranceBubbleHeights.size > MAX_PAINTED_UTTERANCE_BUBBLE_HEIGHTS) {
                const oldest = paintedUtteranceBubbleHeights.keys().next();
                if (oldest.done) break;
                paintedUtteranceBubbleHeights.delete(oldest.value);
            }
        },

        resolvePaintedUtteranceBubbleHeight(input) {
            const identity = String(input.identity ?? '').trim();
            if (identity.length === 0) return undefined;
            return paintedUtteranceBubbleHeights.get(
                buildPaintedUtteranceKey(identity, input.widthBucket, input.fontScaleKey),
            );
        },

        resetReservationForStructuralChange(input) {
            const floorKey = buildFloorKey(input.signature);
            // Mark reset-pending (null) rather than deleting: a known-but-reset item re-seeds its
            // floor from the next real onLayout (so a collapse never reserves the pre-collapse height).
            floorsByKey.set(floorKey, {
                minHeight: null,
                lastMeasuredHeight: null,
                structuralKey: input.signature.structuralKey,
                kind: input.signature.kind,
                rowState: input.signature.rowState,
            });
        },

        requestGlobalLayoutInvalidation(input) {
            if (input.viewportTransactionOpen) {
                return { clear: false, reason: 'viewport-transaction-open' };
            }
            const structural = 'structural' in input
                ? input.structural
                : hasStructuralDelta(input.previous, input.next);
            if (!structural) {
                return { clear: false, reason: 'append-no-structural-delta' };
            }
            if (lastClearedCommitToken === input.commitToken) {
                return { clear: false, reason: 'already-cleared-this-commit' };
            }
            lastClearedCommitToken = input.commitToken;
            return { clear: true, reason: 'structural-delta' };
        },

        resetForSession() {
            // Drop only this reconciler's per-session policy state (floors, commit latch).
            // The exact-height LRU cache is intentionally cross-session WARM storage: its entries are
            // keyed by the full validity signature (id + structural + width/font/grouping/fork/
            // expansion), so a stale entry can never mis-apply, and a re-entered row reserves its real
            // height on warm open. Clearing it here would defeat warm-open reservation.
            floorsByKey.clear();
            paintedUtteranceBubbleHeights.clear();
            lastClearedCommitToken = null;
        },
    };
}

export function createTestTranscriptMeasurementReconciler(
    options?: TranscriptMeasurementReconcilerOptions,
): TranscriptMeasurementReconciler {
    return createTranscriptMeasurementReconciler(options);
}

let defaultReconcilerInstance: TranscriptMeasurementReconciler | null = null;

export function getDefaultTranscriptMeasurementReconciler(
    options?: TranscriptMeasurementReconcilerOptions,
): TranscriptMeasurementReconciler {
    if (defaultReconcilerInstance === null) {
        defaultReconcilerInstance = createTranscriptMeasurementReconciler(options);
    }
    return defaultReconcilerInstance;
}

export function __resetDefaultTranscriptMeasurementReconcilerForTests(): void {
    defaultReconcilerInstance = null;
}
