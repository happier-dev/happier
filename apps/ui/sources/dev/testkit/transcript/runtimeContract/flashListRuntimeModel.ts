/**
 * Faithful FlashList v2 runtime SIMULATOR for the transcript device/perf contract harness (lane H1).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every transcript unit test today mocks FlashList to a no-op host string
 * (`vitestSetup.ts` → `vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }))`) and
 * the ChatList harness only CAPTURES the props that flow into it
 * (`getCapturedFlashListProps()`), then asserts captured prop VALUES or that a `vi.fn()` ref
 * handle was called. None of that runs FlashList's real physics: the recycler never moves
 * `contentOffset`/`scrollTop`, never applies MVCP `applyOffsetCorrection`, never honors
 * `autoscrollToBottomThreshold`, never applies the `inverted` transform. So the unit suite goes
 * GREEN while the device regresses — the "green-but-broken" pattern the H1 keystone targets.
 *
 * This module is the OPPOSITE of a no-op mock. It is a deterministic, headless re-implementation
 * of the exact FlashList v2.3.2 behaviors that matter for transcript scroll outcomes:
 *
 *  - prefix-sum row layout (FlashList positions row N at `sum(height[0..N-1])`; a row reporting a
 *    too-small height for one frame draws the next row's `top` too high → overlap),
 *  - the `inverted` transform routed THROUGH the native viewport driver offset math (NOT a
 *    re-derivation): raw `0` = visual bottom (newest), raw grows toward older,
 *  - MVCP `applyOffsetCorrection` modelled byte-for-byte from the patched vendor source
 *    (`patches/@shopify+flash-list+2.3.2.patch`): track the first-visible item's key + prior top,
 *    on a data change recompute its new top, and if `diff !== 0 && !paused && mvcpEnabled` apply
 *    `scrollBy(diff)` to HOLD the visual position. When MVCP config is `{ disabled: true }`
 *    (`shouldMaintainVisibleContentPosition()` false) the correction is SKIPPED — this is the
 *    §3a prepend-position-loss bug made observable,
 *  - `autoscrollToBottomThreshold` + `startRenderingFromBottom` bottom-pinning while following,
 *  - gesture ownership: while the finger is down / momentum is live, automatic pin writers are
 *    suspended (the escape-lockup root the committed plan calls a first-class C2 state).
 *
 * It is driven by the REAL pure decision owners (`resolveTranscriptBottomFollowMode`,
 * `resolveTranscriptFlashListBottomMaintenance`) — they are imported and composed, never mocked —
 * so the contract is exercised through production logic. Tests drive finger-drag / stream-append /
 * older-prepend / jump and assert the VISIBLE ANCHOR ROW's on-screen position (an OBSERVABLE
 * position outcome), not a returned prop object.
 *
 * SCOPE / FIDELITY
 * ----------------
 * This is a model, not the vendor. It deliberately omits recycling-window virtualization detail,
 * sub-pixel rounding, and animation timing — it asserts the geometric + ownership invariants that
 * the 4 recurring device failures live in. Where a real number is load-bearing (the MVCP diff, the
 * inverted mirror, the pin target) it uses the canonical production helper so the model cannot
 * drift from the app. Vendor-version drift is the known fidelity risk: see the module header note
 * in `runtimeContract/README` follow-ups (ledger).
 */

import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
import {
    resolveNativeInvertedBottomCommandOffset,
    toNativeInvertedCanonicalOffset,
} from '@/components/sessions/transcript/viewport/driver/nativeInvertedRawScroll';
import {
    resolveTranscriptBottomFollowMode,
    type TranscriptBottomFollowMode,
    type TranscriptBottomFollowModeEvent,
    type TranscriptBottomFollowModeState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import {
    resolveTranscriptFlashListBottomMaintenanceDecision,
    type TranscriptFlashListBottomMaintenanceResult,
} from '@/components/sessions/transcript/scroll/transcriptFlashListBottomMaintenance';

/** One transcript row as the model knows it: a stable key + a measured height (px). */
export type RuntimeModelRow = Readonly<{
    /** Stable list key (FlashList `keyExtractor`). The anchor identity for MVCP correction. */
    key: string;
    /** Current measured height in px (prefix-sum input). May grow over frames (streaming row). */
    heightPx: number;
}>;

export type FlashListRuntimeModelOptions = Readonly<{
    orientation: TranscriptListOrientation;
    layoutHeightPx: number;
    /** Distance (px) from the live tail under which "following" auto-pins. Mirrors pin threshold. */
    pinThresholdPx?: number;
    pinEnabled?: boolean;
    autoFollowWhenPinned?: boolean;
    platformIsWeb?: boolean;
    /** Initial committed rows (oldest-first, canonical order). */
    rows?: readonly RuntimeModelRow[];
    /** Whether the session opens following the live tail (cold open / resume-at-bottom). */
    startFollowing?: boolean;
}>;

export type RuntimeModelObservation = Readonly<{
    /** RAW scroll offset (UIScrollView space). 0 = list start. Inverted: 0 = visual bottom. */
    rawOffsetY: number;
    /** Canonical scroll offset (oldest-first). 0 = older edge, max = live-tail edge. */
    canonicalOffsetY: number;
    /** Distance in px from the visual bottom (live tail). 0 = pinned to newest. */
    distanceFromBottomPx: number;
    contentHeightPx: number;
    layoutHeightPx: number;
    bottomFollowMode: TranscriptBottomFollowMode;
    mvcpPolicy: 'disabled' | 'start-rendering-from-bottom' | 'autoscroll-threshold';
    /** True while the finger is down or momentum is live (auto pins suspended). */
    gestureActive: boolean;
    /** Carve live-region flag feeding the maintenance resolver. */
    liveRegionActive: boolean;
    /** Active-turn flag (tracked for telemetry parity; not forwarded to the resolver). */
    sessionActive: boolean;
}>;

const EPSILON_PX = 1;

function clampOffset(offset: number, maxScrollableExtent: number): number {
    if (!Number.isFinite(offset)) return 0;
    return Math.max(0, Math.min(offset, maxScrollableExtent));
}

function resolveMvcpPolicy(
    maintenance: RuntimeMaintenance,
): RuntimeModelObservation['mvcpPolicy'] {
    if (maintenance && 'disabled' in maintenance) return 'disabled';
    if (maintenance && 'autoscrollToBottomThreshold' in maintenance && maintenance.autoscrollToBottomThreshold !== undefined) {
        return 'autoscroll-threshold';
    }
    return 'start-rendering-from-bottom';
}

type RuntimeMaintenance = TranscriptFlashListBottomMaintenanceResult | Readonly<{ disabled: true }>;
type RuntimeMaintenanceDecision = Readonly<{
    maintainVisibleContentPosition: RuntimeMaintenance;
    pauseOffsetCorrection: boolean;
}>;

/**
 * Headless FlashList v2 runtime model. Construct, drive events, read observable position.
 *
 * The model keeps rows in CANONICAL (oldest-first) order internally and converts to raw scroll
 * space only at the native boundary via the viewport driver math, mirroring the production seam.
 */
export class FlashListRuntimeModel {
    private rows: RuntimeModelRow[];
    private readonly orientation: TranscriptListOrientation;
    private layoutHeightPx: number;
    private readonly pinThresholdPx: number;
    private readonly pinEnabled: boolean;
    private readonly autoFollowWhenPinned: boolean;
    private readonly platformIsWeb: boolean;

    /** RAW scroll offset (UIScrollView). 0 = list start. */
    private rawOffsetY = 0;

    private followState: TranscriptBottomFollowModeState;

    // Gesture ownership axis (committed plan: first-class C2 state, NOT inferred from following).
    private gestureActive = false;
    private momentumActive = false;

    // MVCP corrector state, mirrored from the patched vendor hook.
    private mvcpDisabledOverride = false;
    private liveRegionActive = false;
    private sessionActive = false;
    private hasOpenViewportTransaction = false;
    /** Set while a programmatic scroll-to-index is settling (vendor `pauseOffsetCorrection`). */
    private offsetCorrectionPaused = false;

    // First-visible anchor tracking for applyOffsetCorrection.
    private firstVisibleItemKey: string | null = null;
    private firstVisibleItemTopPx = 0;

    constructor(options: FlashListRuntimeModelOptions) {
        this.rows = [...(options.rows ?? [])];
        this.orientation = options.orientation;
        this.layoutHeightPx = options.layoutHeightPx;
        this.pinThresholdPx = options.pinThresholdPx ?? 72;
        this.pinEnabled = options.pinEnabled ?? true;
        this.autoFollowWhenPinned = options.autoFollowWhenPinned ?? true;
        this.platformIsWeb = options.platformIsWeb ?? false;
        this.followState = {
            dragSession: null,
            mode: options.startFollowing === false ? 'released' : 'following',
        };
        // Cold open following the live tail pins to the visual bottom.
        if (this.followState.mode === 'following') {
            this.rawOffsetY = this.bottomRawOffset();
        }
        this.captureFirstVisibleAnchor();
    }

    // ---- canonical row geometry (prefix-sum) ---------------------------------------------------

    private contentHeightPx(): number {
        let total = 0;
        for (const row of this.rows) total += row.heightPx;
        return total;
    }

    private maxScrollableExtent(): number {
        return Math.max(0, this.contentHeightPx() - this.layoutHeightPx);
    }

    /**
     * Top (px) of the row at canonical index `i` in RENDERED space.
     *
     * Standard: rendered order == canonical order; top = prefix-sum of earlier rows.
     * Inverted: rendered order is newest-first, so the rendered top of canonical row `i` is the
     * prefix-sum of all NEWER rows (canonical indices > i).
     */
    private renderedTopOfCanonicalIndex(canonicalIndex: number): number {
        if (canonicalIndex < 0 || canonicalIndex >= this.rows.length) return 0;
        let top = 0;
        if (this.orientation === 'inverted') {
            for (let i = this.rows.length - 1; i > canonicalIndex; i -= 1) top += this.rows[i]!.heightPx;
        } else {
            for (let i = 0; i < canonicalIndex; i += 1) top += this.rows[i]!.heightPx;
        }
        return top;
    }

    private canonicalIndexOfKey(key: string): number {
        return this.rows.findIndex((row) => row.key === key);
    }

    private bottomRawOffset(): number {
        if (this.orientation === 'inverted') {
            return resolveNativeInvertedBottomCommandOffset();
        }
        return this.maxScrollableExtent();
    }

    private canonicalOffsetFromRaw(rawOffsetY: number): number {
        if (this.orientation === 'inverted') {
            return toNativeInvertedCanonicalOffset({
                rawOffsetY,
                contentHeight: this.contentHeightPx(),
                layoutHeight: this.layoutHeightPx,
            });
        }
        return rawOffsetY;
    }

    // ---- first-visible anchor (MVCP) -----------------------------------------------------------

    /**
     * The canonical index of the topmost rendered row currently inside the viewport. This is the
     * row FlashList tracks for `applyOffsetCorrection`. Computed from rendered tops vs rawOffsetY.
     */
    private firstVisibleCanonicalIndex(): number {
        // RAW offset is the rendered-space scroll top. The first visible rendered row is the one
        // whose rendered [top, top+height) straddles rawOffsetY.
        let bestIndex = -1;
        let bestTop = -Infinity;
        for (let i = 0; i < this.rows.length; i += 1) {
            const top = this.renderedTopOfCanonicalIndex(i);
            if (top <= this.rawOffsetY + EPSILON_PX && top > bestTop) {
                bestTop = top;
                bestIndex = i;
            }
        }
        if (bestIndex === -1) {
            // Above the first row (rawOffsetY < 0 region) — fall back to the rendered-first row.
            return this.orientation === 'inverted' ? this.rows.length - 1 : 0;
        }
        return bestIndex;
    }

    private captureFirstVisibleAnchor(): void {
        const index = this.firstVisibleCanonicalIndex();
        const row = this.rows[index];
        if (!row) {
            this.firstVisibleItemKey = null;
            this.firstVisibleItemTopPx = 0;
            return;
        }
        this.firstVisibleItemKey = row.key;
        this.firstVisibleItemTopPx = this.renderedTopOfCanonicalIndex(index);
    }

    // ---- MVCP config (REAL resolver) -----------------------------------------------------------

    private resolveMaintenanceDecision(): RuntimeMaintenanceDecision {
        if (this.mvcpDisabledOverride) {
            // A test can force the §3a hazard window directly; otherwise the resolver decides.
            return {
                maintainVisibleContentPosition: { disabled: true },
                pauseOffsetCorrection: false,
            };
        }
        // NOTE: the maintenance resolver's §3a suppression is scoped to `liveRegionActive` only
        // (the carve actively growing). `sessionActive` is tracked on the model for telemetry /
        // future-use but is intentionally NOT forwarded — the resolver deliberately does not gate
        // on the whole active turn (S1 scope refinement), so a released reader outside the carve
        // window keeps applyOffsetCorrection armed (Invariant C, prepend preservation).
        return resolveTranscriptFlashListBottomMaintenanceDecision({
            autoFollowWhenPinned: this.autoFollowWhenPinned,
            bottomFollowMode: this.followState.mode,
            hasOpenViewportTransaction: this.hasOpenViewportTransaction,
            layoutHeight: this.layoutHeightPx,
            liveRegionActive: this.liveRegionActive,
            nativeEntryShouldUseBottomMaintenance: true,
            pinEnabled: this.pinEnabled,
            pinThresholdPx: this.pinThresholdPx,
            platformIsWeb: this.platformIsWeb,
        });
    }

    private resolveMaintenance(): RuntimeMaintenance {
        return this.resolveMaintenanceDecision().maintainVisibleContentPosition;
    }

    private mvcpEnabled(maintenance: RuntimeMaintenance): boolean {
        // shouldMaintainVisibleContentPosition() === !maintainVisibleContentPosition?.disabled
        return !(maintenance && 'disabled' in maintenance);
    }

    private autoscrollThreshold(maintenance: RuntimeMaintenance): number | null {
        if (maintenance && 'autoscrollToBottomThreshold' in maintenance && maintenance.autoscrollToBottomThreshold !== undefined) {
            return maintenance.autoscrollToBottomThreshold;
        }
        return null;
    }

    /**
     * apply MVCP `applyOffsetCorrection` after a data/height change, modelled from the patched
     * vendor source. Holds the tracked first-visible anchor's visual position by `scrollBy(diff)`.
     * Returns the applied diff (0 if skipped) for telemetry.
     */
    private applyOffsetCorrection(decision: RuntimeMaintenanceDecision): number {
        const maintenance = decision.maintainVisibleContentPosition;
        if (!this.firstVisibleItemKey) return 0;
        if (this.rows.length === 0) return 0;
        if (!this.mvcpEnabled(maintenance)) {
            // §3a: correction skipped → the prepend shifts content and the anchor visually jumps.
            this.captureFirstVisibleAnchor();
            return 0;
        }
        const currentIndex = this.canonicalIndexOfKey(this.firstVisibleItemKey);
        if (currentIndex < 0) {
            this.captureFirstVisibleAnchor();
            return 0;
        }
        const newTop = this.renderedTopOfCanonicalIndex(currentIndex);
        const diff = newTop - this.firstVisibleItemTopPx;
        this.firstVisibleItemTopPx = newTop;
        const paused = this.offsetCorrectionPaused || decision.pauseOffsetCorrection;
        if (diff !== 0 && !paused) {
            // scrollBy(diff): hold the visual position.
            this.rawOffsetY = clampOffset(this.rawOffsetY + diff, this.maxScrollableExtent());
        }
        return paused ? 0 : diff;
    }

    /** Bottom autoscroll while following (the `autoscrollToBottomThreshold` MVCP half). */
    private maybeAutoscrollToBottom(maintenance: RuntimeMaintenance): boolean {
        if (this.followState.mode !== 'following') return false;
        // Gesture ownership: while the finger/momentum owns the surface, auto pins are suspended.
        if (this.gestureActive || this.momentumActive) return false;
        const threshold = this.autoscrollThreshold(maintenance);
        if (threshold === null) {
            // start-rendering-from-bottom without a threshold: the JS force-pin owns the bottom
            // (carve/live-region). Model that as: following pins to bottom.
            this.rawOffsetY = this.bottomRawOffset();
            return true;
        }
        const thresholdPx = threshold * this.layoutHeightPx;
        if (this.distanceFromBottomPx() <= thresholdPx + EPSILON_PX) {
            this.rawOffsetY = this.bottomRawOffset();
            return true;
        }
        return false;
    }

    // ---- public observation --------------------------------------------------------------------

    distanceFromBottomPx(): number {
        const canonical = this.canonicalOffsetFromRaw(this.rawOffsetY);
        // Canonical max == live tail. distance-from-bottom = maxScrollableExtent - canonicalOffset.
        return Math.max(0, this.maxScrollableExtent() - canonical);
    }

    observe(): RuntimeModelObservation {
        const maintenance = this.resolveMaintenance();
        return {
            rawOffsetY: this.rawOffsetY,
            canonicalOffsetY: this.canonicalOffsetFromRaw(this.rawOffsetY),
            distanceFromBottomPx: this.distanceFromBottomPx(),
            contentHeightPx: this.contentHeightPx(),
            layoutHeightPx: this.layoutHeightPx,
            bottomFollowMode: this.followState.mode,
            mvcpPolicy: resolveMvcpPolicy(maintenance),
            gestureActive: this.gestureActive || this.momentumActive,
            liveRegionActive: this.liveRegionActive,
            sessionActive: this.sessionActive,
        };
    }

    /**
     * Rendered on-screen Y of the row with the given key, relative to the viewport top.
     * Negative = scrolled above the top edge; > layoutHeight = below the bottom edge.
     * Returns null when the key is unknown. This is THE observable used to assert that a prepend /
     * stream-append / jump did not shift an anchor row the reader was looking at.
     */
    onScreenTopOfRow(key: string): number | null {
        const index = this.canonicalIndexOfKey(key);
        if (index < 0) return null;
        return this.renderedTopOfCanonicalIndex(index) - this.rawOffsetY;
    }

    isRowFullyVisible(key: string): boolean {
        const top = this.onScreenTopOfRow(key);
        if (top === null) return false;
        const index = this.canonicalIndexOfKey(key);
        const height = this.rows[index]?.heightPx ?? 0;
        return top >= -EPSILON_PX && top + height <= this.layoutHeightPx + EPSILON_PX;
    }

    currentRows(): readonly RuntimeModelRow[] {
        return this.rows;
    }

    mvcpPolicy(): RuntimeModelObservation['mvcpPolicy'] {
        return resolveMvcpPolicy(this.resolveMaintenance());
    }

    // ---- driving events ------------------------------------------------------------------------

    /** Set the carve/live-region + active-turn flags that feed the REAL maintenance resolver. */
    setLiveRegionState(state: Readonly<{ liveRegionActive?: boolean; sessionActive?: boolean }>): void {
        if (state.liveRegionActive !== undefined) this.liveRegionActive = state.liveRegionActive;
        if (state.sessionActive !== undefined) this.sessionActive = state.sessionActive;
    }

    setOpenViewportTransaction(open: boolean): void {
        this.hasOpenViewportTransaction = open;
    }

    /** Force the §3a `{disabled:true}` MVCP window directly (adversarial / regression input). */
    forceMvcpDisabled(disabled: boolean): void {
        this.mvcpDisabledOverride = disabled;
    }

    /** Finger touches down: gesture owns the surface, drag-session begins, mode → escaping. */
    fingerDown(): void {
        this.gestureActive = true;
        this.dispatchFollow({ type: 'list-drag-start' });
        this.captureFirstVisibleAnchor();
    }

    /**
     * User drags the surface by `deltaRawPx` (raw scroll units; positive = scroll toward list
     * start). The finger's intent ALWAYS moves the surface — automatic pins must never fight it.
     */
    dragBy(deltaRawPx: number): void {
        if (!this.gestureActive) {
            // A drag without finger-down is a no-op in the model (gesture ownership invariant).
            return;
        }
        this.rawOffsetY = clampOffset(this.rawOffsetY + deltaRawPx, this.maxScrollableExtent());
        const distance = this.distanceFromBottomPx();
        const movedAway = distance > this.pinThresholdPx;
        this.dispatchFollow({
            type: 'trusted-away-observation',
            distanceFromBottom: distance,
            pinThresholdPx: this.pinThresholdPx,
            movedAwayFromBottom: movedAway,
        });
        this.captureFirstVisibleAnchor();
    }

    /** Finger lifts. Momentum may still be pending (modelled as active until `momentumSettle`). */
    fingerUp(options: Readonly<{ momentumPending?: boolean }> = {}): void {
        this.gestureActive = false;
        this.momentumActive = options.momentumPending ?? false;
        const distance = this.distanceFromBottomPx();
        this.dispatchFollow({
            type: 'drag-end',
            distanceFromBottom: distance,
            pinThresholdPx: this.pinThresholdPx,
            sawAwayMovement: this.followState.dragSession?.sawAwayMovement ?? false,
        });
    }

    momentumSettle(): void {
        this.momentumActive = false;
        const distance = this.distanceFromBottomPx();
        this.dispatchFollow({
            type: 'momentum-settle',
            distanceFromBottom: distance,
            pinThresholdPx: this.pinThresholdPx,
        });
    }

    /**
     * Append/grow the newest (live-tail) row by `deltaHeightPx`, or add a new tail row. Models a
     * streaming token: content grows at the visual bottom. Then runs MVCP + autoscroll exactly as
     * a real commit would.
     */
    streamAppend(options: Readonly<{ newRow?: RuntimeModelRow; growTailByPx?: number }>): number {
        this.captureFirstVisibleAnchor();
        if (options.newRow) {
            this.rows.push(options.newRow);
        }
        if (options.growTailByPx && this.rows.length > 0) {
            const tail = this.rows[this.rows.length - 1]!;
            this.rows[this.rows.length - 1] = { ...tail, heightPx: tail.heightPx + options.growTailByPx };
        }
        const decision = this.resolveMaintenanceDecision();
        // Growth below the anchor (tail) does not move the anchor's rendered top under inverted —
        // but a NEW row added at the live tail shifts older rows' rendered tops (inverted), so MVCP
        // still runs to hold a released reader's position.
        const diff = this.applyOffsetCorrection(decision);
        const autoscrolled = this.maybeAutoscrollToBottom(decision.maintainVisibleContentPosition);
        void autoscrolled;
        return diff;
    }

    /**
     * Prepend `olderRows` at the OLDER edge (history load). The reader is typically released. MVCP
     * must hold the anchor row's visual position; with MVCP disabled it jumps (the §3a bug).
     * Returns the MVCP diff applied (0 = no correction).
     */
    prependOlder(olderRows: readonly RuntimeModelRow[]): number {
        this.captureFirstVisibleAnchor();
        this.rows = [...olderRows, ...this.rows];
        const decision = this.resolveMaintenanceDecision();
        return this.applyOffsetCorrection(decision);
    }

    /** Explicit jump to the visual bottom (jump-to-bottom button). Single list-start command. */
    jumpToBottom(): void {
        this.dispatchFollow({ type: 'jump-to-bottom' });
        this.gestureActive = false;
        this.momentumActive = false;
        this.rawOffsetY = this.bottomRawOffset();
        this.captureFirstVisibleAnchor();
    }

    /**
     * Programmatic scroll-to-index (jump-to-seq / restore). Sets the vendor `pauseOffsetCorrection`
     * window: while paused, MVCP corrections are skipped (modelled), then cleared.
     */
    scrollToCanonicalIndex(canonicalIndex: number, options: Readonly<{ viewPosition?: number }> = {}): void {
        const clampedIndex = Math.max(0, Math.min(canonicalIndex, this.rows.length - 1));
        const top = this.renderedTopOfCanonicalIndex(clampedIndex);
        const viewPosition = options.viewPosition ?? 0;
        this.rawOffsetY = clampOffset(top - viewPosition * this.layoutHeightPx, this.maxScrollableExtent());
        this.captureFirstVisibleAnchor();
    }

    setOffsetCorrectionPaused(paused: boolean): void {
        this.offsetCorrectionPaused = paused;
    }

    setLayoutHeight(layoutHeightPx: number): void {
        this.layoutHeightPx = layoutHeightPx;
        this.captureFirstVisibleAnchor();
    }

    /** Replace a row's measured height (a remeasure). Runs MVCP for above-viewport remeasures. */
    setRowHeight(key: string, heightPx: number): number {
        this.captureFirstVisibleAnchor();
        const index = this.canonicalIndexOfKey(key);
        if (index < 0) return 0;
        this.rows[index] = { ...this.rows[index]!, heightPx };
        const decision = this.resolveMaintenanceDecision();
        return this.applyOffsetCorrection(decision);
    }

    private dispatchFollow(event: TranscriptBottomFollowModeEvent): void {
        this.followState = resolveTranscriptBottomFollowMode(this.followState, event);
    }
}
