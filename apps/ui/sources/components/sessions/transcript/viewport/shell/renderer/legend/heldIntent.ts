import type * as React from 'react';
import type { LegendListState } from '@legendapp/list/react-native';

import type { TranscriptRendererEntryAnchorHold } from '../types';

// Legend/browser reconciliation can replay the pre-resize DOM offset about 400ms after
// a composer resize. Keep that specific layout-settle transaction distinguishable from
// a later keyboard/user scroll; wheel/drag interactions cancel it immediately.
export const LEGEND_HELD_INTENT_SETTLE_MS = 1_500;
// Keyed target identity remains available after the active polling cadence goes quiet. Fresh
// load/size/commit evidence can resume verification anywhere in this bounded window.
export const LEGEND_HELD_TARGET_IDENTITY_MS = 10_000;
// Native-only fallback: how recent wheel/touch/drag evidence must be for a scroll away
// from a held tail to count as a user detach. Web consumes the canonical movement fact.
export const LEGEND_USER_INPUT_DETACH_WINDOW_MS = 3_500;
// While genuine user scrolling is live (recent wheel/touch/keyboard evidence, an active drag,
// or user fling momentum), held-target residual corrections must not write at all: live S-D
// write attribution (2026-07-11) traced every scored scroll reversal to verifyLanding fighting
// active wheel input (24-96px churn "repairs" per tick, and a 4x tug-of-war re-writing the same
// target against consecutive 240px user deltas). The bounded window stays open so the same
// transaction resumes once input has been quiet for this margin.
export const LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS = 250;
// A momentum phase counts as USER momentum only when it chains off a real drag release (or a
// previous user momentum phase, e.g. the boundary rubber-band spring) within this window.
// Momentum emitted by programmatic animated scrolls never suppresses corrections.
export const LEGEND_USER_MOMENTUM_CHAIN_WINDOW_MS = 500;
// Maximum gap between scroll events for an UNCLASSIFIED event to count as the inertia
// continuation of the last classified user movement. Trackpad momentum emits events every
// ~16-100ms; Legend replay/measurement bursts arrive after longer gaps or with a
// correction write interleaved.
export const LEGEND_USER_SCROLL_INERTIA_CONTINUATION_MS = 320;

export const LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX = 1;
// A keyed web residual that exceeds the viewport is only trustworthy when two consecutive
// reads agree: during a giant cold-page commit the scroll compensation and the DOM commit can
// be observed out of sync for one frame, and acting on that single read wrote a ~19200px-stale
// offset live (DR-030 session-B write attribution, 2026-07-11). Consecutive genuine reads of
// the same landing agree within this tolerance; a transient incoherent read never repeats.
export const LEGEND_HELD_INTENT_LARGE_RESIDUAL_CONFIRM_TOLERANCE_PX = 32;

export type LegendHeldScrollIntent =
    | Readonly<{ kind: 'end' }>
    | Readonly<{
        entryAnchor?: TranscriptRendererEntryAnchorHold;
        identityExpiresAtMs: number;
        fallbackIndex: number;
        key: React.Key;
        kind: 'index';
        viewOffset: number;
        viewPosition: number;
    }>
    | Readonly<{
        anchor: TranscriptRendererEntryAnchorHold;
        identityExpiresAtMs: number;
        kind: 'anchor';
    }>;

export type LegendHeldIntentLanding = Readonly<{
    basis: 'legend-state' | 'native-physical' | 'web-dom';
    currentOffset: number;
    residual: number;
    targetOffset: number;
    /** Viewport length backing the landing read; web-dom and estimate-basis landings report it. */
    viewportLength?: number;
    /** Misalignment before scroll-range clamping; web-dom keyed and estimate-basis landings report it. */
    rawResidual?: number;
    /**
     * TRUE when the landing was derived from Legend position estimates (web: anchor not in
     * the DOM; native: target row not mounted/measured). Estimate landings never confirm
     * and only steer within the bounded tracking range.
     */
    estimateBasis?: boolean;
    /** Physical scroll range max (content minus viewport) backing the landing read. */
    maxOffset?: number;
}>;

// Overscroll rubber-band settlement: when the correction target already sits ON a physical
// clamp boundary and the viewport is beyond that boundary, the platform spring settles exactly
// at the target by itself. Writing "corrections" against the spring re-launches it — the S-D
// boundary vibration (violent top/bottom overscroll oscillation, 2026-07-11 user report).
export function isLegendLandingSettledByPhysicalClamp(landing: LegendHeldIntentLanding): boolean {
    if (landing.targetOffset <= 0 && landing.currentOffset <= 0) return true;
    return typeof landing.maxOffset === 'number'
        && landing.targetOffset >= landing.maxOffset
        && landing.currentOffset >= landing.targetOffset;
}

export function clampLegendScrollOffset(offset: number, contentLength: number, scrollLength: number): number {
    return Math.max(0, Math.min(offset, Math.max(0, contentLength - scrollLength)));
}

export function resolveLegendStateHeldIntentLanding(params: Readonly<{
    index?: number;
    intent: LegendHeldScrollIntent;
    state: LegendListState;
}>): LegendHeldIntentLanding | null {
    const { intent, state } = params;
    if (
        !Number.isFinite(state.contentLength)
        || !Number.isFinite(state.scroll)
        || !Number.isFinite(state.scrollLength)
    ) {
        return null;
    }
    let targetOffset: number;
    let rawTargetOffset: number | null = null;
    let estimateBasis = false;
    if (intent.kind === 'end') {
        targetOffset = Math.max(0, state.contentLength - state.scrollLength);
    } else if (intent.kind === 'index') {
        const index = params.index;
        if (typeof index !== 'number' || index < 0) return null;
        const position = state.positionAtIndex?.(index);
        if (!Number.isFinite(position)) return null;
        const size = state.sizeAtIndex?.(index);
        // Only a MOUNTED row's position is confirmation-grade layout truth: Legend keeps
        // serving cached sizesKnown entries for unmounted rows while their positions are
        // estimate-phase cumulative sums, and mid-expansion-cascade those estimates are
        // garbage (live native S-C 2026-07-11: corrections steered into them, read
        // themselves back as "aligned", and parked the viewport hours away). Estimate-basis
        // landings never confirm and only steer within the bounded tracking range — the
        // same CASCADE-FIX bar the web-dom anchor landing already obeys.
        const startBuffered = Number.isFinite(state.startBuffered) ? state.startBuffered : state.start;
        const endBuffered = Number.isFinite(state.endBuffered) ? state.endBuffered : state.end;
        const mounted = Number.isFinite(startBuffered)
            && Number.isFinite(endBuffered)
            && index >= startBuffered
            && index <= endBuffered;
        estimateBasis = !mounted || !Number.isFinite(size);
        // An unmeasured size degrades the viewPosition term to 0 instead of aborting the
        // landing: the estimate-basis hold keeps steering toward the row and precise
        // alignment resumes once the row mounts and measures.
        const sizeForAlignment = Number.isFinite(size) ? (size as number) : 0;
        rawTargetOffset = (position as number)
            - intent.viewOffset
            - intent.viewPosition * Math.max(0, state.scrollLength - sizeForAlignment);
        targetOffset = clampLegendScrollOffset(
            rawTargetOffset,
            state.contentLength,
            state.scrollLength,
        );
    } else return null;
    return {
        basis: 'legend-state',
        currentOffset: state.scroll,
        residual: targetOffset - state.scroll,
        targetOffset,
        maxOffset: Math.max(0, state.contentLength - state.scrollLength),
        ...(estimateBasis
            ? {
                estimateBasis: true,
                rawResidual: (rawTargetOffset ?? targetOffset) - state.scroll,
                viewportLength: state.scrollLength,
            }
            : {}),
    };
}

export function settleLegendScroll(
    promise: Promise<void> | undefined,
    onSettled?: () => void,
): void {
    void promise?.then(
        () => onSettled?.(),
        () => onSettled?.(),
    );
}
