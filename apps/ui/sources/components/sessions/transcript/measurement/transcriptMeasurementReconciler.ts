import {
    createDefaultTranscriptItemHeightCache,
    isTranscriptItemHeightSignatureStable,
    type TranscriptItemHeightCache,
    type TranscriptItemHeightCacheOptions,
    type TranscriptItemHeightValiditySignature,
} from './transcriptItemHeightCache';

/**
 * C1 — the committed-height reconciler for transcript rows.
 *
 * Single authority for the three measurement reads a FlashList host makes per render/commit:
 *   R1 recycle identity (shape-stable recycle type so cells never remount mid-stream),
 *   R2 reserved height (exact for stable rows; a monotonic PER-ITEM floor for streaming/prepended
 *      rows so FlashList never positions a neighbour from a height it will contradict within a frame),
 *   R3 global invalidation (the sole clearLayoutCacheOnUpdate decision: structural deltas only,
 *      coalesced per commit, never while a prepend/entry-restore transaction owns the viewport).
 *
 * Pure core (no React, no FlashList). The host wires it to onLayout/commit timing.
 * Orientation-agnostic: a content `minHeight` floor behaves identically under the inverted
 * `scaleY:-1` transform (intrinsic cell content height is unchanged).
 *
 * R2 reserves ONLY a row's OWN last-measured height (keyed by `itemId`+geometry). It deliberately
 * does NOT seed a per-recycle-type median first-paint floor: the recycle type is shape-only (all
 * `message:agent` share one bucket), so a median mixes short and long rows and force-reserves short
 * rows too tall — and a content `minHeight` is self-fulfilling (onLayout then measures the FORCED
 * height, so the over-reservation never recovers). A never-measured row reserves nothing and uses
 * FlashList's natural onLayout measurement; the per-item floor protects subsequent frames once the
 * row's real height exists.
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

    /** R2. Sole reservation producer. Exact for stable rows; monotonic per-item floor for non-stable; undefined if unknown. */
    resolveReservation(signature: TranscriptItemHeightValiditySignature): TranscriptRowHeightReservation | undefined;

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
     * R3. Coalesced, transaction-gated decision: may the whole-list cache be cleared this commit?
     * Supply a signature pair or an explicit structural flag for a discrete structural action.
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
    /** Last-measured monotonic floor for this exact item+geometry, or null while reset-pending. */
    minHeight: number | null;
}>;

function isValidHeight(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function buildFloorKey(signature: TranscriptItemHeightValiditySignature): string {
    return `${signature.itemId.length}:${signature.itemId}|${signature.widthBucket}|${signature.fontScaleKey}`;
}

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
 * Per-ITEM floor-reset trigger. Returns true when a row's reservation floor must be re-seeded from
 * its next onLayout because the shape changed in a shrink-capable way. `TranscriptRowShell` calls
 * this to decide whether to `resetReservationForStructuralChange`.
 *
 * A pure streaming append (rowState stays `streaming`, only the content revision grew) is NOT
 * structural — the per-row onLayout channel absorbs growth, and the monotonic floor is exactly what
 * prevents append overlap there, so it must not be reset.
 *
 * It additionally re-seeds on a SETTLED-row content change: a `structuralKey` delta while BOTH sides
 * are `stable` is shrink-capable. The motivating case is a grouped tool-calls HEADER, whose height
 * drops (≈36→33px) when its status goes running→completed — the status lives in `structuralKey`,
 * which the rowState/expansion/width/font checks all miss, so the per-item floor (keyed without
 * `structuralKey`) keeps serving the taller running-state height and the `minHeight` self-fulfills a
 * persistent gap. Growing rows (`streaming`/`tool-progress`) are excluded by the both-`stable` guard:
 * their `structuralKey` churns every frame and the monotonic floor is what prevents append overlap.
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
        previous.rowState === 'stable'
        && next.rowState === 'stable'
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
    let lastClearedCommitToken: number | null = null;

    function resolveFloorReservation(
        signature: TranscriptItemHeightValiditySignature,
    ): TranscriptRowHeightReservation | undefined {
        const floor = floorsByKey.get(buildFloorKey(signature));
        if (floor !== undefined && floor.minHeight !== null && isValidHeight(floor.minHeight)) {
            return { kind: 'floor', minHeight: floor.minHeight };
        }
        // Never-measured (or reset-pending) row: reserve NOTHING → FlashList's natural onLayout
        // measures the row's real height. (No per-type median seed — see the module doc.)
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

        recordMeasuredHeight(input) {
            const { signature, heightPx } = input;
            if (!isValidHeight(heightPx)) return;
            const measured = Math.trunc(heightPx);

            // Exact path: stable rows write the LRU height cache (its existing stable-only contract).
            if (isTranscriptItemHeightSignatureStable(signature)) {
                cache.set(signature, { heightPx: measured });
            }

            // Floor path: monotonic per item+geometry. A reset-pending (null) floor re-seeds from
            // this measurement (taking the new, possibly smaller, height); otherwise it only grows.
            const floorKey = buildFloorKey(signature);
            const existing = floorsByKey.get(floorKey);
            const nextFloor = existing === undefined || existing.minHeight === null
                ? measured
                : Math.max(existing.minHeight, measured);
            floorsByKey.set(floorKey, { minHeight: nextFloor });
        },

        resetReservationForStructuralChange(input) {
            const floorKey = buildFloorKey(input.signature);
            // Mark reset-pending (null) rather than deleting: a known-but-reset item re-seeds its
            // floor from the next real onLayout (so a collapse never reserves the pre-collapse height).
            floorsByKey.set(floorKey, { minHeight: null });
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
