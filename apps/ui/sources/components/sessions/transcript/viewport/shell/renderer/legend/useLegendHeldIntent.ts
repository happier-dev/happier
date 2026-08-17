import * as React from 'react';
import type { LegendListRef } from '@legendapp/list/react-native';

import { resolveWebTranscriptViewportAnchorAlignment } from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import type { WebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import type { TranscriptExplicitJumpOperationId } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { recordTranscriptHeldIntentLifecycle } from '@/components/sessions/transcript/viewport/driver/transcriptViewportWriteDiagnostics';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';

import type {
    TranscriptInitialPresentationSettlementRequest,
    TranscriptRendererEntryAnchorHold,
    TranscriptRendererEntryPlacementEvent,
    TranscriptRendererWebHoldTarget,
    TranscriptViewportMutationCause,
} from '../types';
import {
    clampLegendScrollOffset,
    isLegendLandingSettledByPhysicalClamp,
    LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX,
    LEGEND_HELD_INTENT_LARGE_RESIDUAL_CONFIRM_TOLERANCE_PX,
    LEGEND_HELD_INTENT_SETTLE_MS,
    LEGEND_HELD_TARGET_IDENTITY_MS,
    resolveLegendStateHeldIntentLanding,
    settleLegendScroll,
    type LegendHeldIntentLanding,
    type LegendHeldScrollIntent,
} from './heldIntent';

type MutableRef<T> = { current: T };

type PendingInitialPresentationSettlement = Readonly<{
    deadlineAtMs: number;
    request: TranscriptInitialPresentationSettlementRequest;
}>;

type LegendNativePhysicalEntryElement = Readonly<{
    measure: (
        onSuccess: (
            x: number,
            y: number,
            width: number,
            height: number,
            pageX: number,
            pageY: number,
        ) => void,
    ) => void;
    measureLayout: (
        relativeToNativeNode: unknown,
        onSuccess: (x: number, y: number, width: number, height: number) => void,
        onFail?: () => void,
    ) => void;
}>;

type LegendNativePhysicalScrollHost = Readonly<{
    measure: LegendNativePhysicalEntryElement['measure'];
}>;

/**
 * The hold's `reason` is part of its diagnostic identity, not telemetry: it names WHICH
 * placement armed the transaction (entry restore, a prepend restore-anchor, a jump landing),
 * and without it the ring cannot attribute an observed `residual-write` to the flow that
 * spent it.
 */
function readHeldIntentDiagnosticIdentity(intent: LegendHeldScrollIntent): Readonly<{
    anchorReason: TranscriptRendererEntryAnchorHold['reason'] | null;
    intentId: string | null;
    intentKind: 'anchor' | 'end' | 'index';
}> {
    if (intent.kind === 'end') return { anchorReason: null, intentId: null, intentKind: 'end' };
    if (intent.kind === 'anchor') {
        return {
            anchorReason: intent.anchor.reason ?? null,
            intentId: intent.anchor.itemId,
            intentKind: 'anchor',
        };
    }
    return {
        anchorReason: intent.entryAnchor?.reason ?? null,
        intentId: String(intent.key),
        intentKind: 'index',
    };
}

function readEntryPlacementItemId(intent: LegendHeldScrollIntent | null): string | null {
    if (intent?.kind === 'anchor' && intent.anchor.reason === 'entry-restore') {
        return intent.anchor.itemId;
    }
    if (intent?.kind === 'index' && intent.entryAnchor?.reason === 'entry-restore') {
        return intent.entryAnchor.itemId;
    }
    return null;
}

/**
 * The renderer-owned held-intent transaction: ONE keyed target (held-'end', keyed index, or
 * web DOM anchor) that survives Legend MVCP replay and estimate corrections. Owns the intent
 * identity, settle cadence, one-shot web-tail materialization, and the phase-scoped keyed/native
 * residual writes that repair displacement. Legend alone owns steady web held-end positioning.
 */
export function useLegendHeldIntent<TItem>(params: Readonly<{
    data: readonly TItem[];
    dataKey: string;
    dataLength: number;
    initialPlacementAtEnd: boolean;
    invalidateUserInertiaContinuation: () => void;
    isUserScrollInputLive: () => boolean;
    isWebFrame: boolean;
    keyExtractor: (item: TItem, index: number) => string;
    legendListRef: MutableRef<LegendListRef | null>;
    onEntryPlacementEvent?: (event: TranscriptRendererEntryPlacementEvent) => void;
    pendingViewportCauseRef: MutableRef<TranscriptViewportMutationCause>;
    readWebScrollMetrics: () => WebTranscriptScrollMetrics | null;
    suppressAutoEndLatchRef: MutableRef<boolean>;
    toSourceIndex: (legendIndex: number) => number;
    webScrollableElementRef: MutableRef<HTMLElement | null>;
    webDomObservation: WebDomScrollObservation;
}>) {
    const {
        data,
        dataKey,
        dataLength,
        initialPlacementAtEnd,
        invalidateUserInertiaContinuation,
        isUserScrollInputLive,
        isWebFrame,
        keyExtractor,
        legendListRef,
        onEntryPlacementEvent,
        pendingViewportCauseRef,
        readWebScrollMetrics,
        suppressAutoEndLatchRef,
        toSourceIndex,
        webScrollableElementRef,
        webDomObservation,
    } = params;

    const heldScrollIntentRef = React.useRef<LegendHeldScrollIntent | null>(
        initialPlacementAtEnd ? { kind: 'end' } : null,
    );
    const nativePhysicalEntryMeasurementRef = React.useRef<Readonly<{
        element: LegendNativePhysicalEntryElement;
        generation: object;
        intent: LegendHeldScrollIntent;
        scrollHost: LegendNativePhysicalScrollHost;
    }> | null>(null);
    const nativePhysicalEntryMeasurementGenerationRef = React.useRef<object>({});
    const explicitJumpTakeoverOperationRef = React.useRef<TranscriptExplicitJumpOperationId | null>(null);
    const [, renderPositioningPhase] = React.useReducer((revision: number) => revision + 1, 0);
    /**
     * The scheduled settle frame AND the intent it polls for. Every settle closure keys on the
     * held intent BY REFERENCE, and the intent object is replaced out from under an in-flight
     * frame (`handleLegendStartReached` refreshes expiry with a clone). Without the owner
     * recorded here, a superseded frame occupies the slot, `resumeHeldIntentSettle` reads it as
     * "already polling" and schedules nothing, and the stale frame then fires, fails its
     * identity check and reschedules nothing either — the transaction stops polling exactly
     * where the refreshed hold needed it.
     */
    const heldIntentSettleFrameRef = React.useRef<Readonly<{
        frame: number;
        intent: LegendHeldScrollIntent;
    }> | null>(null);
    const heldIntentSettleUntilRef = React.useRef(
        initialPlacementAtEnd ? Date.now() + LEGEND_HELD_INTENT_SETTLE_MS : 0,
    );
    const lastHeldIntentCorrectionRef = React.useRef<Readonly<{
        currentOffset: number;
        intent: LegendHeldScrollIntent;
        targetOffset: number;
        /** Offset read back right after a web-dom write (clamp-aware); null for other bases. */
        landedOffset: number | null;
    }> | null>(null);
    const pendingLargeResidualConfirmationRef = React.useRef<Readonly<{
        intent: LegendHeldScrollIntent;
        targetOffset: number;
    }> | null>(null);
    // The geometry the PREVIOUS web landing read of the live transaction observed. A correction
    // may only be spent on evidence that is no longer in motion (see the coherence precondition
    // in `evaluateLanding`); the app's own landed write rebases it, so correcting once never
    // disqualifies the next correction.
    const lastWebLandingObservationRef = React.useRef<Readonly<{
        currentOffset: number;
        intent: LegendHeldScrollIntent;
        scrollRange: number;
    }> | null>(null);
    const pendingWebTailMaterializationKeyRef = React.useRef<string | null>(null);
    const pendingInitialPresentationSettlementRef =
        React.useRef<PendingInitialPresentationSettlement | null>(null);
    const tryAcknowledgeInitialPresentationSettlementRef =
        React.useRef<() => boolean>(() => false);
    // One materialization scroll EVER per DATASET identity (`dataKey`): after a successful
    // mount, the measured residual owner re-mounts a flapped-out tail by scrolling — a second
    // imperative tail command re-enters Legend's estimate-target retry machinery and closes a
    // materialize↔correct loop (live capture 2026-07-23: 255 re-fired scrollToIndex vs the
    // measured-bottom corrections, oscillating the reopened viewport for minutes). Keying this
    // on the tail ROW identity plus `dataLength` re-armed it on every hydration wave, which is
    // how one cold open still issued 16 placement commands (2026-07-30).
    const completedWebTailMaterializationKeyRef = React.useRef<string | null>(null);
    const completedKeyedIdentityMaterializationRef = React.useRef(false);
    const onEntryPlacementEventRef = React.useRef(onEntryPlacementEvent);
    useCommittedTranscriptRef(onEntryPlacementEventRef, onEntryPlacementEvent);
    const activeEntryPlacementItemIdRef = React.useRef<string | null>(null);
    const finishedEntryPlacementItemIdRef = React.useRef<string | null>(null);
    const lastEntryPlacementExactAlignmentRef = React.useRef(false);

    const finishEntryPlacement = React.useCallback((
        intent: LegendHeldScrollIntent | null,
        outcome: 'settled' | 'deadline' | 'preempted' | 'superseded' | 'unavailable',
    ) => {
        if (intent == null) return;
        const itemId = readEntryPlacementItemId(intent);
        if (itemId == null) return;
        if (activeEntryPlacementItemIdRef.current !== itemId) return;
        if (finishedEntryPlacementItemIdRef.current === itemId) return;
        finishedEntryPlacementItemIdRef.current = itemId;
        // Publishing a terminal presentation outcome must atomically end this entry hold's
        // write authority. Otherwise a revealed placeholder can be followed by a late
        // size/layout residual from the same lifecycle. Non-entry reading/navigation holds
        // retain their independent identity deadline.
        if (heldScrollIntentRef.current === intent) {
            recordTranscriptHeldIntentLifecycle({
                ...readHeldIntentDiagnosticIdentity(intent),
                event: 'hold-release',
            });
            heldScrollIntentRef.current = null;
            heldIntentSettleUntilRef.current = 0;
            lastHeldIntentCorrectionRef.current = null;
            pendingLargeResidualConfirmationRef.current = null;
            pendingWebTailMaterializationKeyRef.current = null;
            completedKeyedIdentityMaterializationRef.current = false;
            const cancelAnimationFrame = globalThis.cancelAnimationFrame;
            if (typeof cancelAnimationFrame === 'function' && heldIntentSettleFrameRef.current !== null) {
                cancelAnimationFrame(heldIntentSettleFrameRef.current.frame);
            }
            heldIntentSettleFrameRef.current = null;
        }
        onEntryPlacementEventRef.current?.({
            dataKey,
            itemId,
            outcome,
            platform: isWebFrame ? 'web' : 'native',
            type: 'finished',
        });
    }, [dataKey, isWebFrame]);

    const startEntryPlacement = React.useCallback((intent: LegendHeldScrollIntent | null) => {
        const itemId = readEntryPlacementItemId(intent);
        if (intent == null || itemId == null) return;
        if (
            activeEntryPlacementItemIdRef.current === itemId
            && finishedEntryPlacementItemIdRef.current !== itemId
        ) {
            lastEntryPlacementExactAlignmentRef.current = false;
            return;
        }
        if (finishedEntryPlacementItemIdRef.current === itemId) return;
        activeEntryPlacementItemIdRef.current = itemId;
        finishedEntryPlacementItemIdRef.current = null;
        lastEntryPlacementExactAlignmentRef.current = false;
        onEntryPlacementEventRef.current?.({
            dataKey,
            itemId,
            platform: isWebFrame ? 'web' : 'native',
            type: 'started',
        });
    }, [dataKey, isWebFrame]);

    const setHeldScrollIntent = React.useCallback((intent: LegendHeldScrollIntent | null) => {
        const previous = heldScrollIntentRef.current;
        const previousEntryItemId = readEntryPlacementItemId(previous);
        const nextEntryItemId = readEntryPlacementItemId(intent);
        if (previousEntryItemId != null && previousEntryItemId !== nextEntryItemId) {
            finishEntryPlacement(previous, 'superseded');
        }
        if (
            previousEntryItemId == null
            && nextEntryItemId != null
            && finishedEntryPlacementItemIdRef.current === nextEntryItemId
        ) {
            activeEntryPlacementItemIdRef.current = null;
            finishedEntryPlacementItemIdRef.current = null;
        }
        const previousHeldEndOwnership = previous?.kind === 'end';
        const nextHeldEndOwnership = intent?.kind === 'end';
        if (previous !== intent) {
            completedKeyedIdentityMaterializationRef.current = false;
            if (intent) {
                recordTranscriptHeldIntentLifecycle({
                    ...readHeldIntentDiagnosticIdentity(intent),
                    event: 'hold-set',
                });
            } else if (
                previous
                && heldScrollIntentRef.current === previous
            ) {
                // finishEntryPlacement owns terminal entry release diagnostics and clears
                // the live ref before this generic transition continues.
                recordTranscriptHeldIntentLifecycle({
                    ...readHeldIntentDiagnosticIdentity(previous),
                    event: 'hold-release',
                });
            }
        }
        heldScrollIntentRef.current = intent;
        startEntryPlacement(intent);
        if (previousHeldEndOwnership !== nextHeldEndOwnership) renderPositioningPhase();
    }, [finishEntryPlacement, startEntryPlacement]);

    const hasHeldEndPositioningOwnership = React.useCallback((): boolean => {
        return explicitJumpTakeoverOperationRef.current === null
            && heldScrollIntentRef.current?.kind === 'end';
    }, []);

    // A live keyed (anchor/index) hold is the surviving pre-commit truth for the viewport; it
    // outlives Legend MVCP replay, estimate corrections, and this adapter's own residual
    // writes. Callers that opportunistically (re)capture a visible-anchor baseline must not
    // replace it from non-user movement.
    const hasLiveKeyedHeldIntent = React.useCallback((): boolean => {
        const heldIntent = heldScrollIntentRef.current;
        return heldIntent != null
            && heldIntent.kind !== 'end'
            && Date.now() <= heldIntent.identityExpiresAtMs;
    }, []);

    const hasActiveEntryPlacement = React.useCallback((): boolean => {
        const itemId = activeEntryPlacementItemIdRef.current;
        return itemId != null
            && finishedEntryPlacementItemIdRef.current !== itemId
            && readEntryPlacementItemId(heldScrollIntentRef.current) === itemId;
    }, []);

    const cancelScheduledHeldIntentSettle = React.useCallback(() => {
        const cancelAnimationFrame = globalThis.cancelAnimationFrame;
        if (typeof cancelAnimationFrame === 'function' && heldIntentSettleFrameRef.current !== null) {
            cancelAnimationFrame(heldIntentSettleFrameRef.current.frame);
        }
        heldIntentSettleFrameRef.current = null;
    }, []);

    const releaseHeldScrollIntent = React.useCallback((
        outcome: 'preempted' | 'superseded' = 'preempted',
    ) => {
        finishEntryPlacement(heldScrollIntentRef.current, outcome);
        setHeldScrollIntent(null);
        heldIntentSettleUntilRef.current = 0;
        lastHeldIntentCorrectionRef.current = null;
        pendingLargeResidualConfirmationRef.current = null;
        pendingWebTailMaterializationKeyRef.current = null;
        completedKeyedIdentityMaterializationRef.current = false;
        cancelScheduledHeldIntentSettle();
        tryAcknowledgeInitialPresentationSettlementRef.current();
    }, [
        cancelScheduledHeldIntentSettle,
        finishEntryPlacement,
        setHeldScrollIntent,
    ]);
    const cancelLegendInitialScrollPreservation = React.useCallback(() => {
        legendListRef.current?.cancelInitialScrollPreservation();
    }, [legendListRef]);

    const beginExplicitJumpTakeover = React.useCallback((
        operationId: TranscriptExplicitJumpOperationId,
    ): (() => void) => {
        const releaseOperation = () => {
            if (explicitJumpTakeoverOperationRef.current !== operationId) return;
            explicitJumpTakeoverOperationRef.current = null;
            renderPositioningPhase();
        };
        const alreadyActive = explicitJumpTakeoverOperationRef.current !== null;
        explicitJumpTakeoverOperationRef.current = operationId;
        cancelLegendInitialScrollPreservation();
        if (alreadyActive) return releaseOperation;
        const hadHeldEndOwnership = heldScrollIntentRef.current?.kind === 'end';
        invalidateUserInertiaContinuation();
        suppressAutoEndLatchRef.current = true;
        releaseHeldScrollIntent();
        if (!hadHeldEndOwnership) renderPositioningPhase();
        return releaseOperation;
    }, [
        cancelLegendInitialScrollPreservation,
        invalidateUserInertiaContinuation,
        releaseHeldScrollIntent,
        suppressAutoEndLatchRef,
    ]);

    // IDENTITY AMPLIFICATION — the two resolvers below are the root of the held-intent callback
    // chain (`readHeldIntentLanding`/`writeHeldIntentResidual` -> `requestHeldIntentSettle` -> the
    // renderer's dataset layout effect). Taking `keyExtractor` as a DEPENDENCY made a caller that
    // renders an inline arrow advance a movement epoch and re-open a full
    // LEGEND_HELD_INTENT_SETTLE_MS window of per-frame polling on every commit, including commits
    // that changed nothing (`legendIdleFrameCost.fabric.native.real.integration.test.tsx`: 94
    // animation frames per content-free commit, 0 at rest). Both resolvers run only from
    // post-commit paths, so the COMMITTED value is the correct one to read. Data-driven
    // invalidation is unchanged: `data` and `toSourceIndex` remain dependencies.
    const keyExtractorRef = React.useRef(keyExtractor);
    useCommittedTranscriptRef(keyExtractorRef, keyExtractor);

    const resolveHeldIntentIndex = React.useCallback((intent: Extract<LegendHeldScrollIntent, { kind: 'index' }>): number => {
        const currentIndex = data.findIndex((item, index) => (
            keyExtractorRef.current(item, toSourceIndex(index)) === intent.key
        ));
        return currentIndex >= 0 ? currentIndex : intent.fallbackIndex;
    }, [data, toSourceIndex]);

    const resolveAnchorHoldDataIndex = React.useCallback((itemId: string): number => {
        return data.findIndex((item, index) => (
            keyExtractorRef.current(item, toSourceIndex(index)) === itemId
        ));
    }, [data, toSourceIndex]);

    const requestWebHeldEndMaterialization = React.useCallback((intent: LegendHeldScrollIntent): boolean => {
        if (!isWebFrame || intent.kind !== 'end' || dataLength === 0) return false;
        const state = legendListRef.current?.getState();
        if (!state) return false;
        const lastIndex = dataLength - 1;
        const startBuffered = Number.isFinite(state.startBuffered) ? state.startBuffered : state.start;
        const endBuffered = Number.isFinite(state.endBuffered) ? state.endBuffered : state.end;
        const tailIsMaterialized = Number.isFinite(startBuffered)
            && Number.isFinite(endBuffered)
            && lastIndex >= startBuffered
            && lastIndex <= endBuffered;
        if (tailIsMaterialized) {
            pendingWebTailMaterializationKeyRef.current = null;
            return false;
        }

        // INITIAL PLACEMENT IS THE LIBRARY'S. Legend resolves a scrollToIndex target from its
        // own position table (`positions[index]`), and an unresolved entry collapses the target
        // to offset 0. On a cold/bulk hydration that table is still empty for the tail while
        // Legend's own bootstrap is converging, so an adapter request issued in that window
        // does not approach the tail — it pins the viewport at the HEAD, and Legend's bootstrap
        // dispatch then has to teleport away from it. That pair is the measured web open
        // defect: full content height with scrollTop 0, a short hold, then a jump to the tail.
        // Withhold the request until the library can resolve the target; the settle loop is
        // already polling, and by the time Legend's bootstrap lands the tail is normally
        // materialized and no adapter write is issued at all.
        const tailPosition = state.positionAtIndex?.(lastIndex);
        if (
            lastIndex > 0
            && (typeof tailPosition !== 'number' || !Number.isFinite(tailPosition) || tailPosition <= 0)
        ) {
            return true;
        }

        // A cold bulk hydration can leave Legend's mounted range at the old head while its
        // truncated DOM is already physically at that DOM's bottom. scrollHeight therefore
        // cannot prove held-end settlement until the actual final data index is materialized.
        // Target the tail through Legend once; ordinary Legend measurements then own alignment.
        //
        // COMMANDED BY INTENT, NOT BY A FROZEN INDEX, AND KEYED TO THE DATASET IDENTITY.
        // The previous form was keyed `${dataLength}:${keyExtractor(tail)}` and issued
        // `scrollToIndex({ index: dataLength - 1 })`. Both halves failed on a multi-wave
        // open (measured live on web, session cms4aenky5lnktm72sfmya6uk, cold route load,
        // reproduced twice: 16 scrollToIndex commands per open, 8 of them landing at
        // scrollTop 0 while maxScroll was ~1936):
        //   - `dataLength` in the key RE-ARMED the "one materialization EVER" guard on every
        //     hydration wave (measured content growth 324 -> 2291 -> 2253 -> 12241px);
        //   - `scrollToIndex` freezes `index` at REQUEST time while Legend resolves the
        //     offset at RUN time (`calculateOffsetForIndex` -> `positions[index] || 0`), and
        //     `runWhenReady` runs a deferred request regardless of readiness after 800ms. The
        //     tail index of the 1-row placeholder list a forked transcript publishes first is
        //     0, and index 0 is the HEAD of the content once messages arrive - on a fork that
        //     is literally the fork-divider row the reader was teleported to.
        // `scrollToEnd` re-derives `data.length - 1` inside Legend at run time and
        // re-evaluates its own readiness predicate there, which is why the same capture scored
        // it 0 wrong landings out of 7 against the index form's 8 out of 16. `dataKey` is the
        // logical dataset (session) identity, so one entry gets exactly one placement
        // transaction no matter how many hydration waves it takes.
        const materializationKey = dataKey;
        if (pendingWebTailMaterializationKeyRef.current === materializationKey) return true;
        if (completedWebTailMaterializationKeyRef.current === materializationKey) return false;
        completedWebTailMaterializationKeyRef.current = materializationKey;
        pendingWebTailMaterializationKeyRef.current = materializationKey;
        pendingViewportCauseRef.current = 'command';
        // Symmetric with the keyed-identity path below: without these, end placements were the
        // one materialization family no in-app instrument could count, so a capture could not
        // tell "the tail was never commanded" from "the tail was commanded and landed wrong".
        recordTranscriptHeldIntentLifecycle({
            ...readHeldIntentDiagnosticIdentity(intent),
            event: 'materialization-start',
        });
        settleLegendScroll(legendListRef.current?.scrollToEnd({ animated: false }), () => {
            if (pendingWebTailMaterializationKeyRef.current === materializationKey) {
                pendingWebTailMaterializationKeyRef.current = null;
            }
            recordTranscriptHeldIntentLifecycle({
                ...readHeldIntentDiagnosticIdentity(intent),
                event: 'materialization-settled',
            });
        });
        return true;
    }, [dataKey, dataLength, isWebFrame, legendListRef, pendingViewportCauseRef]);

    const requestWebKeyedIdentityMaterialization = React.useCallback((
        intent: LegendHeldScrollIntent,
        onSettled: () => void,
    ): boolean => {
        if (!isWebFrame || intent.kind === 'end' || completedKeyedIdentityMaterializationRef.current) {
            return false;
        }
        const index = intent.kind === 'anchor'
            ? resolveAnchorHoldDataIndex(intent.anchor.itemId)
            : resolveHeldIntentIndex(intent);
        if (index < 0 || index >= dataLength) return false;
        // WITHHOLD UNTIL THE TARGET CAN PHYSICALLY BE HELD — the keyed-identity twin of the
        // guard `requestWebHeldEndMaterialization` already carries. `scrollToIndex` freezes
        // `index` at REQUEST time while Legend resolves the offset at RUN time
        // (`calculateOffsetForIndex` -> `positions[index] || 0`) and `runWhenReady` dispatches a
        // deferred request regardless of readiness after 800ms, so an unresolved position
        // collapses the target to offset 0 — the HEAD — which is the exact opposite of a
        // saved-anchor restore. The DOM adds a second, independent collapse the end path never
        // hits: `scrollTo` CLAMPS to the scroller's CURRENT range, so a target beyond a
        // still-hydrating `scrollHeight` lands at that placeholder range's end and no later
        // signal re-issues the one-shot (live cold SPA entry with a persisted detached anchor,
        // session cms4aenky5lnktm72sfmya6uk 2026-07-30: `scrollToIndex` resolved 813 into a
        // transcript whose eventual range was 32878px, because the DOM range was still 813).
        // Withholding must NOT consume the one-shot: the bounded settle loop is already polling
        // and re-requests as soon as the geometry can hold the target.
        const targetPosition = legendListRef.current?.getState()?.positionAtIndex?.(index);
        const hasResolvedTargetPosition = typeof targetPosition === 'number'
            && Number.isFinite(targetPosition);
        if (index > 0 && (!hasResolvedTargetPosition || (targetPosition as number) <= 0)) return true;
        const materializationMetrics = readWebScrollMetrics();
        if (
            hasResolvedTargetPosition
            && materializationMetrics
            && Math.max(0, materializationMetrics.scrollHeight - materializationMetrics.clientHeight)
                < (targetPosition as number)
        ) {
            return true;
        }
        // One materialization request belongs to this held identity transaction. Estimated
        // geometry is not written; after the row mounts, the existing DOM-truth path corrects
        // the exact within-row offset.
        completedKeyedIdentityMaterializationRef.current = true;
        pendingViewportCauseRef.current = 'command';
        recordTranscriptHeldIntentLifecycle({
            ...readHeldIntentDiagnosticIdentity(intent),
            event: 'materialization-start',
        });
        settleLegendScroll(legendListRef.current?.scrollToIndex({
            animated: false,
            index,
            viewPosition: 0,
        }), () => {
            recordTranscriptHeldIntentLifecycle({
                ...readHeldIntentDiagnosticIdentity(intent),
                event: 'materialization-settled',
            });
            onSettled();
        });
        return true;
    }, [
        dataLength,
        isWebFrame,
        legendListRef,
        pendingViewportCauseRef,
        readWebScrollMetrics,
        resolveAnchorHoldDataIndex,
        resolveHeldIntentIndex,
    ]);

    const readHeldIntentLanding = React.useCallback((intent: LegendHeldScrollIntent): LegendHeldIntentLanding | null => {
        if (intent.kind === 'anchor') {
            const metrics = readWebScrollMetrics();
            if (!metrics) return null;
            const alignment = resolveWebTranscriptViewportAnchorAlignment({
                container: metrics.element,
                anchor: intent.anchor,
                tolerancePx: LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX - 1,
            });
            if (alignment.status === 'not_found') {
                // The anchor identity can leave the mounted window mid-transaction: a giant
                // cold/estimate collapse clamps the scroller faster than measurement signals
                // re-verify, and a DOM-only landing then reports not_found forever (live
                // A->B->A: the restored row was lost near the tail). While the identity is
                // still in renderer data, degrade to Legend's estimated data position so the
                // hold keeps steering toward the row; the DOM alignment above resumes precise
                // ownership as soon as the row mounts again.
                const dataIndex = resolveAnchorHoldDataIndex(intent.anchor.itemId);
                if (dataIndex < 0) return null;
                const position = legendListRef.current?.getState()?.positionAtIndex?.(dataIndex);
                if (typeof position !== 'number' || !Number.isFinite(position)) return null;
                const rawTarget = position - intent.anchor.itemOffsetPx;
                const targetOffset = clampLegendScrollOffset(rawTarget, metrics.scrollHeight, metrics.clientHeight);
                return {
                    basis: 'web-dom',
                    currentOffset: metrics.scrollTop,
                    residual: targetOffset - metrics.scrollTop,
                    targetOffset,
                    viewportLength: metrics.clientHeight,
                    rawResidual: rawTarget - metrics.scrollTop,
                    estimateBasis: true,
                    maxOffset: Math.max(0, metrics.scrollHeight - metrics.clientHeight),
                };
            }
            const targetOffset = clampLegendScrollOffset(
                metrics.scrollTop + alignment.deltaPx,
                metrics.scrollHeight,
                metrics.clientHeight,
            );
            return {
                basis: 'web-dom',
                currentOffset: metrics.scrollTop,
                residual: targetOffset - metrics.scrollTop,
                targetOffset,
                viewportLength: metrics.clientHeight,
                rawResidual: alignment.deltaPx,
                maxOffset: Math.max(0, metrics.scrollHeight - metrics.clientHeight),
            };
        }
        const state = legendListRef.current?.getState();
        if (!state) return null;
        const index = intent.kind === 'index' ? resolveHeldIntentIndex(intent) : undefined;
        const stateLanding = resolveLegendStateHeldIntentLanding({ index, intent, state });
        if (intent.kind === 'end') return stateLanding;
        const metrics = readWebScrollMetrics();
        if (!metrics) return stateLanding;
        const element = state.elementAtIndex?.(index ?? -1) as unknown as HTMLElement | null | undefined;
        if (!element || typeof element.getBoundingClientRect !== 'function') return stateLanding;
        const elementRect = element.getBoundingClientRect();
        const scrollerRect = metrics.element.getBoundingClientRect();
        const itemSize = elementRect.height;
        const desiredTop = intent.viewOffset
            + intent.viewPosition * Math.max(0, metrics.clientHeight - itemSize);
        const residual = elementRect.top - scrollerRect.top - desiredTop;
        const targetOffset = Math.max(
            0,
            Math.min(metrics.scrollTop + residual, Math.max(0, metrics.scrollHeight - metrics.clientHeight)),
        );
        return {
            basis: 'web-dom',
            currentOffset: metrics.scrollTop,
            residual: targetOffset - metrics.scrollTop,
            targetOffset,
            viewportLength: metrics.clientHeight,
            rawResidual: residual,
            maxOffset: Math.max(0, metrics.scrollHeight - metrics.clientHeight),
        };
    }, [legendListRef, readWebScrollMetrics, resolveAnchorHoldDataIndex, resolveHeldIntentIndex]);

    const tryAcknowledgeInitialPresentationSettlement = React.useCallback((): boolean => {
        const pending = pendingInitialPresentationSettlementRef.current;
        const request = pending?.request;
        if (!request || request.dataKey !== dataKey || !isWebFrame) return false;
        const heldIntent = heldScrollIntentRef.current;
        if (heldIntent?.kind === 'end') {
            const state = legendListRef.current?.getState();
            const metrics = readWebScrollMetrics();
            if (!state || !metrics || dataLength <= 0) return false;
            const lastIndex = dataLength - 1;
            const startBuffered = Number.isFinite(state.startBuffered) ? state.startBuffered : state.start;
            const endBuffered = Number.isFinite(state.endBuffered) ? state.endBuffered : state.end;
            const tailMaterialized =
                Number.isFinite(startBuffered) &&
                Number.isFinite(endBuffered) &&
                lastIndex >= startBuffered &&
                lastIndex <= endBuffered;
            const distanceFromBottom = Math.max(
                0,
                metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop,
            );
            // The bounded window is a DEADLINE, so nothing may outlive it - including an
            // in-flight tail materialization. Legend's end command dispatches through
            // `state.pendingScrollToEnd` + `scheduleImperativeScrollCommit`, so its promise
            // (and therefore the pending marker) can resolve strictly later than the frozen
            // index form's synchronous `runNow`. Gating the terminal release on the marker
            // alone let a placement that could not physically land hold the initial
            // presentation open forever, which is the exact failure this deadline exists to
            // end. In-flight placement still defers acknowledgement while the window is open.
            const withinSettleWindow = Date.now() < pending.deadlineAtMs;
            if (
                !tailMaterialized
                || (pendingWebTailMaterializationKeyRef.current !== null && withinSettleWindow)
                || (distanceFromBottom > 1 && withinSettleWindow)
            ) return false;
        } else if (heldIntent) {
            const landing = readHeldIntentLanding(heldIntent);
            const residual = landing?.basis === 'native-physical'
                ? landing.rawResidual ?? landing.residual
                : landing?.rawResidual ?? landing?.residual;
            if (
                !landing
                || landing.estimateBasis === true
                || typeof residual !== 'number'
                || Math.abs(residual) >= LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX
            ) return false;
        }
        // Held targets are confirmed against their physical landing above. With no held
        // positioning intent, no renderer alignment predicate remains to observe.
        if (pendingInitialPresentationSettlementRef.current !== pending) return false;
        pendingInitialPresentationSettlementRef.current = null;
        request.onSettled();
        return true;
    }, [
        dataKey,
        dataLength,
        isWebFrame,
        legendListRef,
        readHeldIntentLanding,
        readWebScrollMetrics,
    ]);
    tryAcknowledgeInitialPresentationSettlementRef.current =
        tryAcknowledgeInitialPresentationSettlement;

    const requestNativePhysicalEntryLanding = React.useCallback((
        intent: LegendHeldScrollIntent,
        generation: object,
        onLanding: (landing: LegendHeldIntentLanding) => void,
    ): boolean => {
        if (
            isWebFrame
            || intent.kind !== 'index'
            || readEntryPlacementItemId(intent) == null
        ) {
            return false;
        }
        const legendRef = legendListRef.current;
        const state = legendRef?.getState();
        if (!legendRef || !state) return false;
        const index = resolveHeldIntentIndex(intent);
        const element = state.elementAtIndex?.(index) as unknown as
            | LegendNativePhysicalEntryElement
            | null
            | undefined;
        const scrollView = legendRef.getNativeScrollRef?.() as unknown as Readonly<{
            getNativeScrollRef?: () => unknown;
        }> | null | undefined;
        // Legend exposes the RN ScrollView instance. Fabric measureLayout rejects the numeric
        // handle returned by ScrollView#getScrollableNode(); unwrap the native host ref instead.
        const scrollHost = scrollView?.getNativeScrollRef?.() as
            | LegendNativePhysicalScrollHost
            | null
            | undefined;
        if (
            !element
            || typeof element.measure !== 'function'
            || typeof element.measureLayout !== 'function'
            || typeof scrollHost?.measure !== 'function'
        ) {
            return false;
        }
        const inFlight = nativePhysicalEntryMeasurementRef.current;
        if (
            inFlight?.intent === intent
            && inFlight.element === element
            && inFlight.generation === generation
            && inFlight.scrollHost === scrollHost
        ) {
            return true;
        }
        // The request object is the measurement generation token. React Native does not
        // serialize measureLayout callbacks, so one row/intent request remains authoritative
        // until it completes; replacing the token also invalidates an older remounted-row read.
        const measurement = { element, generation, intent, scrollHost };
        nativePhysicalEntryMeasurementRef.current = measurement;
        let contentTop: number | null = null;
        let physicalHeight: number | null = null;
        let rowPageY: number | null = null;
        let scrollHostPageY: number | null = null;
        const abandonMeasurement = (): void => {
            if (nativePhysicalEntryMeasurementRef.current !== measurement) return;
            nativePhysicalEntryMeasurementRef.current = null;
        };
        const finishMeasurement = (): void => {
            if (
                nativePhysicalEntryMeasurementRef.current !== measurement
                || nativePhysicalEntryMeasurementGenerationRef.current !== generation
                || contentTop == null
                || physicalHeight == null
                || rowPageY == null
                || scrollHostPageY == null
            ) {
                return;
            }
            nativePhysicalEntryMeasurementRef.current = null;
            if (
                heldScrollIntentRef.current !== intent
                || Date.now() > heldIntentSettleUntilRef.current
                || Date.now() > intent.identityExpiresAtMs
            ) {
                return;
            }
            const currentLegendRef = legendListRef.current;
            const currentState = currentLegendRef?.getState();
            const currentScrollView = currentLegendRef?.getNativeScrollRef?.() as unknown as Readonly<{
                getNativeScrollRef?: () => unknown;
            }> | null | undefined;
            const currentScrollHost = currentScrollView?.getNativeScrollRef?.();
            const currentIndex = resolveHeldIntentIndex(intent);
            if (
                !currentState
                || currentIndex < 0
                || currentState.elementAtIndex?.(currentIndex) !== element
                || currentScrollHost !== scrollHost
                || !Number.isFinite(currentState.contentLength)
                || !Number.isFinite(currentState.scroll)
                || !Number.isFinite(currentState.scrollLength)
                || !Number.isFinite(contentTop)
                || !Number.isFinite(physicalHeight)
                || !Number.isFinite(rowPageY)
                || !Number.isFinite(scrollHostPageY)
            ) {
                return;
            }
            const desiredTop = intent.viewOffset
                + intent.viewPosition * Math.max(0, currentState.scrollLength - physicalHeight);
            // Fabric measureLayout excludes the ScrollView content offset, so `contentTop`
            // is the content-space basis for the absolute target. Fabric `measure` includes
            // transforms; rowPageY - scrollHostPageY is therefore the natively displayed
            // row top even when Legend state believes a covered-screen write landed.
            const physicalRowTop = rowPageY - scrollHostPageY;
            const physicalScrollOffset = contentTop - physicalRowTop;
            const rawResidual = physicalRowTop - desiredTop;
            const targetOffset = clampLegendScrollOffset(
                contentTop - desiredTop,
                currentState.contentLength,
                currentState.scrollLength,
            );
            onLanding({
                basis: 'native-physical',
                currentOffset: physicalScrollOffset,
                maxOffset: Math.max(0, currentState.contentLength - currentState.scrollLength),
                rawResidual,
                residual: targetOffset - physicalScrollOffset,
                targetOffset,
                viewportLength: currentState.scrollLength,
            });
        };
        element.measureLayout(scrollHost, (_x, nextContentTop, _width, nextPhysicalHeight) => {
            contentTop = nextContentTop;
            physicalHeight = nextPhysicalHeight;
            finishMeasurement();
        }, () => {
            abandonMeasurement();
            // A detached row cannot confirm entry alignment. The existing bounded settle
            // cadence will retry after the next layout/measurement fact.
        });
        element.measure((_x, _y, _width, _height, _pageX, pageY) => {
            rowPageY = pageY;
            finishMeasurement();
        });
        scrollHost.measure((_x, _y, _width, _height, _pageX, pageY) => {
            scrollHostPageY = pageY;
            finishMeasurement();
        });
        return true;
    }, [isWebFrame, legendListRef, resolveHeldIntentIndex]);

    const writeHeldIntentResidual = React.useCallback((
        intent: LegendHeldScrollIntent,
        landing: LegendHeldIntentLanding,
    ): boolean => {
        const correctionResidual = landing.basis === 'native-physical'
            ? landing.rawResidual ?? landing.residual
            : landing.residual;
        if (Math.abs(correctionResidual) < LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX) return false;
        const previous = lastHeldIntentCorrectionRef.current;
        if (previous?.intent === intent && previous.targetOffset === landing.targetOffset) {
            if (landing.basis === 'web-dom' && typeof previous.landedOffset === 'number') {
                // Web idempotence is landed-aware: if the scroller still sits where OUR last
                // write landed (possibly clamped), re-writing is a no-op loop - skip. If an
                // external writer (Legend offset replay, browser scroll anchoring) moved it
                // away from our landed offset, that is new evidence and the held tail must
                // re-correct (USER-REALITY-DIVERGENCE symptom 3: one swallowed correction per
                // composer growth left the viewport pinned below the true bottom).
                if (landing.currentOffset === previous.landedOffset) return false;
            } else if (
                landing.basis !== 'native-physical'
                && previous.currentOffset === landing.currentOffset
            ) {
                return false;
            }
        }
        let landedOffset: number | null = null;
        pendingViewportCauseRef.current = 'command';
        if (landing.basis === 'web-dom' && webScrollableElementRef.current) {
            const write = webDomObservation.recordProgrammaticScrollTopWrite({
                element: webScrollableElementRef.current,
                targetScrollTop: landing.targetOffset,
            });
            if (!write.ok) return false;
            landedOffset = write.landedScrollTop;
        } else if (isWebFrame) {
            // DOM-less adapter harness fallback only; production web always uses the canonical
            // scroller above. Keep the keyed-index write so web contract tests do not invent DOM.
            if (intent.kind === 'index') {
                settleLegendScroll(legendListRef.current?.scrollToIndex({
                    animated: false,
                    index: resolveHeldIntentIndex(intent),
                    viewOffset: intent.viewOffset,
                    viewPosition: intent.viewPosition,
                }));
            }
        } else {
            // Native keyed entry exactness is measured from the mounted row relative to the
            // physical scroller. Apply that residual through the existing offset writer;
            // never replay the estimate-based semantic command.
            settleLegendScroll(legendListRef.current?.scrollToOffset({
                animated: false,
                offset: landing.targetOffset,
            }));
        }
        lastHeldIntentCorrectionRef.current = {
            currentOffset: landing.currentOffset,
            intent,
            landedOffset,
            targetOffset: landing.targetOffset,
        };
        // Our own landed offset is the new coherence baseline: the reader did not move, we did.
        if (landedOffset !== null && typeof landing.maxOffset === 'number' && Number.isFinite(landing.maxOffset)) {
            lastWebLandingObservationRef.current = {
                currentOffset: landedOffset,
                intent,
                scrollRange: landing.maxOffset,
            };
        }
        recordTranscriptHeldIntentLifecycle({
            ...readHeldIntentDiagnosticIdentity(intent),
            basis: landing.basis,
            currentOffset: landing.currentOffset,
            estimateBasis: landing.estimateBasis,
            event: 'residual-write',
            residual: landing.residual,
            targetOffset: landing.targetOffset,
        });
        return true;
    }, [isWebFrame, legendListRef, pendingViewportCauseRef, resolveHeldIntentIndex, webDomObservation, webScrollableElementRef]);

    const requestHeldIntentSettle = React.useCallback((
        options?: Readonly<{ deferFirstVerification?: boolean }>,
    ) => {
        const heldIntent = heldScrollIntentRef.current;
        if (!heldIntent) return;
        const intent: LegendHeldScrollIntent = heldIntent;
        nativePhysicalEntryMeasurementGenerationRef.current = {};
        const entryPlacementActive = readEntryPlacementItemId(intent) != null;
        const finishHeldIntentSettle = (
            outcome: 'settled' | 'deadline' | 'unavailable',
            clearHeldIntent = false,
        ): void => {
            finishEntryPlacement(intent, outcome);
            if (clearHeldIntent) setHeldScrollIntent(null);
            cancelScheduledHeldIntentSettle();
            tryAcknowledgeInitialPresentationSettlement();
        };
        if (entryPlacementActive) {
            lastEntryPlacementExactAlignmentRef.current = false;
        }
        const evaluateLanding = (landing: LegendHeldIntentLanding): boolean => {
            if (heldScrollIntentRef.current !== intent) return false;
            if (entryPlacementActive) {
                lastEntryPlacementExactAlignmentRef.current = false;
            }
            recordTranscriptHeldIntentLifecycle({
                ...readHeldIntentDiagnosticIdentity(intent),
                basis: landing.basis,
                currentOffset: landing.currentOffset,
                estimateBasis: landing.estimateBasis,
                event: 'landing-read',
                residual: landing.residual,
                targetOffset: landing.targetOffset,
            });
            // COHERENCE PRECONDITION — a correction is only spendable on evidence that is not
            // still in motion. Legend's own MVCP compensation (`ScrollAdjustHandler` ->
            // `scrollAdjustBy`) and the reader's momentum both move the scroller BETWEEN the
            // geometry commit and the frame this transaction reads it, and a residual measured
            // across that seam is an artifact of the seam, not a misalignment: Legend's
            // compensation for a prepend/remeasure was exact in 100% of ~4,900 sampled frames
            // (2026-07-30 above-viewport remeasure capture), yet this writer was caught
            // cancelling `scrollAdjustBy(+343)` 1 ms later and undoing a ~31,000px prepend
            // compensation outright on the same session. So require the SAME reader offset and
            // the SAME scroll range as the PREVIOUS read of this same transaction. This is a
            // precondition on evidence, never a delay or a suppression window: a genuine
            // residual survives into the very next settle frame — which the bounded cadence is
            // already polling — and is written there, while a one-frame seam artifact does not.
            const previousObservation = lastWebLandingObservationRef.current;
            const hasWebScrollRange = landing.basis === 'web-dom'
                && typeof landing.maxOffset === 'number'
                && Number.isFinite(landing.maxOffset);
            if (hasWebScrollRange) {
                lastWebLandingObservationRef.current = {
                    currentOffset: landing.currentOffset,
                    intent,
                    scrollRange: landing.maxOffset as number,
                };
            }
            // A transaction's FIRST read has nothing to disagree with; entry restore and every
            // fresh hold must still land promptly. Only an observed CHANGE withholds.
            const geometryStableSinceLastRead = !hasWebScrollRange
                || previousObservation == null
                || previousObservation.intent !== intent
                || (
                    previousObservation.currentOffset === landing.currentOffset
                    && previousObservation.scrollRange === landing.maxOffset
                );
            // A target already sitting on a physical clamp boundary with the viewport beyond
            // it is settled by the platform spring itself; corrections against the spring
            // re-launch it (S-D boundary vibration).
            if (isLegendLandingSettledByPhysicalClamp(landing)) {
                pendingLargeResidualConfirmationRef.current = null;
                const confirmationResidual = landing.basis === 'native-physical'
                    ? landing.rawResidual ?? landing.residual
                    : landing.residual;
                if (
                    entryPlacementActive
                    && landing.estimateBasis !== true
                    && Math.abs(confirmationResidual) < LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX
                ) {
                    lastEntryPlacementExactAlignmentRef.current = true;
                }
                return true;
            }
            // Estimate-derived landings (web anchor not in the DOM; native row not
            // mounted/measured) are NOT confirmation-grade:
            // mid-cascade Legend estimates can be off by thousands of px, and both writing a
            // viewport-exceeding "correction" from them and going dormant on their "aligned"
            // reads parked the live viewport ~12k px from the user's content (DR-030 cascade
            // RED 2026-07-11). Keep the bounded polling window open until the DOM can measure.
            if (intent.kind !== 'end' && landing.estimateBasis === true) {
                heldIntentSettleUntilRef.current = Math.min(
                    intent.identityExpiresAtMs,
                    Date.now() + LEGEND_HELD_INTENT_SETTLE_MS,
                );
                const withinTrackingRange = typeof landing.viewportLength === 'number'
                    && landing.viewportLength > 0
                    && Math.abs(landing.rawResidual ?? landing.residual) < landing.viewportLength;
                if (!withinTrackingRange) {
                    requestWebKeyedIdentityMaterialization(intent, resumeHeldIntentSettle);
                    return false;
                }
                if (Math.abs(landing.residual) < LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX) return false;
                if (!geometryStableSinceLastRead) return false;
                writeHeldIntentResidual(intent, landing);
                return false;
            }
            const confirmationResidual = landing.basis === 'native-physical'
                ? landing.rawResidual ?? landing.residual
                : landing.residual;
            const aligned = Math.abs(confirmationResidual) < LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX;
            if (aligned) {
                pendingLargeResidualConfirmationRef.current = null;
                if (entryPlacementActive && landing.estimateBasis !== true) {
                    lastEntryPlacementExactAlignmentRef.current = true;
                }
                return true;
            }
            // Keyed web residuals beyond the viewport act only on two agreeing consecutive
            // reads: a single read can observe scroll compensation and the DOM commit out of
            // sync during a giant cold-page commit, and writing from it clobbers the
            // compensation with a stale offset (live DR-030 write attribution).
            const requiresConfirmation = intent.kind !== 'end'
                && landing.basis === 'web-dom'
                && typeof landing.viewportLength === 'number'
                && landing.viewportLength > 0
                && Math.abs(landing.rawResidual ?? landing.residual) >= landing.viewportLength;
            if (requiresConfirmation) {
                const pending = pendingLargeResidualConfirmationRef.current;
                const confirmed = pending != null
                    && pending.intent === intent
                    && Math.abs(pending.targetOffset - landing.targetOffset)
                        <= LEGEND_HELD_INTENT_LARGE_RESIDUAL_CONFIRM_TOLERANCE_PX;
                if (!confirmed) {
                    pendingLargeResidualConfirmationRef.current = { intent, targetOffset: landing.targetOffset };
                    return false;
                }
            }
            if (!geometryStableSinceLastRead) return false;
            pendingLargeResidualConfirmationRef.current = null;
            writeHeldIntentResidual(intent, landing);
            return false;
        };
        const verifyLanding = (): boolean => {
            const currentIntent = heldScrollIntentRef.current;
            if (currentIntent !== intent) return false;
            // Live user scrolling fully suppresses correction writes (S-D vibration): the
            // corrector otherwise fights the user's own deltas frame by frame. Keep the
            // bounded window open so the same transaction resumes once input quiets.
            if (isUserScrollInputLive()) {
                heldIntentSettleUntilRef.current = intent.kind === 'end'
                    ? Date.now() + LEGEND_HELD_INTENT_SETTLE_MS
                    : Math.min(intent.identityExpiresAtMs, Date.now() + LEGEND_HELD_INTENT_SETTLE_MS);
                return false;
            }
            if (requestWebHeldEndMaterialization(intent)) return false;
            if (intent.kind === 'end') {
                if (isWebFrame) {
                    // After the one-shot final-row materialization above, Legend's semantic
                    // maintain-at-end lifecycle is the sole steady web positioning owner.
                    // Its public isAtEnd fact can remain cached while a row remeasurement has
                    // already changed DOM geometry, so DOM residual is not a settled-gap signal.
                    pendingLargeResidualConfirmationRef.current = null;
                    return true;
                }
                if (
                    legendListRef.current?.getState()?.isWithinMaintainScrollAtEndThreshold
                    === true
                ) {
                    // Stock Legend owns native item/footer/layout/data maintenance while this
                    // fact is true. The app residual is only the beyond-threshold fallback.
                    pendingLargeResidualConfirmationRef.current = null;
                    return true;
                }
            }
            if (
                entryPlacementActive
                && requestNativePhysicalEntryLanding(
                    intent,
                    nativePhysicalEntryMeasurementGenerationRef.current,
                    (landing) => {
                        if (heldScrollIntentRef.current !== intent || isUserScrollInputLive()) return;
                        evaluateLanding(landing);
                    },
                )
            ) {
                return false;
            }
            const landing = readHeldIntentLanding(intent);
            if (!landing) {
                recordTranscriptHeldIntentLifecycle({
                    ...readHeldIntentDiagnosticIdentity(intent),
                    event: 'landing-missing',
                });
                return false;
            }
            if (entryPlacementActive && !isWebFrame && intent.kind === 'index') {
                // State geometry remains the approach basis while the row/scroller cannot be
                // physically measured, but it can never confirm an entry-tagged native hold.
                return evaluateLanding({
                    ...landing,
                    estimateBasis: true,
                    rawResidual: landing.rawResidual ?? landing.residual,
                    viewportLength: landing.viewportLength
                        ?? legendListRef.current?.getState()?.scrollLength,
                });
            }
            return evaluateLanding(landing);
        };

        const monitorHeldIntentThroughLayoutSettle = (): void => {
            // Release the slot only when it is still THIS transaction's. A superseded frame
            // must not clear a successor's scheduled poll on its way out.
            if (heldIntentSettleFrameRef.current?.intent === intent) {
                heldIntentSettleFrameRef.current = null;
            }
            if (heldScrollIntentRef.current !== intent) return;
            if (Date.now() > heldIntentSettleUntilRef.current) {
                finishHeldIntentSettle(
                    lastEntryPlacementExactAlignmentRef.current ? 'settled' : 'deadline',
                );
                return;
            }
            verifyLanding();
            tryAcknowledgeInitialPresentationSettlement();
            const requestAnimationFrame = globalThis.requestAnimationFrame;
            if (typeof requestAnimationFrame !== 'function') {
                finishHeldIntentSettle('unavailable');
                return;
            }
            heldIntentSettleFrameRef.current = {
                frame: requestAnimationFrame(monitorHeldIntentThroughLayoutSettle),
                intent,
            };
        };

        function resumeHeldIntentSettle(deferFirstVerification = false): void {
            if (heldScrollIntentRef.current !== intent) return;
            const nowMs = Date.now();
            if (intent.kind !== 'end' && nowMs > intent.identityExpiresAtMs) {
                recordTranscriptHeldIntentLifecycle({
                    ...readHeldIntentDiagnosticIdentity(intent),
                    event: 'identity-expired',
                });
                finishHeldIntentSettle('deadline', true);
                return;
            }
            heldIntentSettleUntilRef.current = intent.kind === 'end'
                ? nowMs + LEGEND_HELD_INTENT_SETTLE_MS
                : Math.min(intent.identityExpiresAtMs, nowMs + LEGEND_HELD_INTENT_SETTLE_MS);
            recordTranscriptHeldIntentLifecycle({
                ...readHeldIntentDiagnosticIdentity(intent),
                event: 'settle-request',
            });
            // Most signals arrive after geometry commits and can verify synchronously.
            // Legend 3.3.3 invokes onItemSizeChanged before position/MVCP recalculation, so
            // that signal joins the already-owned settle frame and reads post-commit geometry.
            if (!deferFirstVerification) verifyLanding();
            const scheduled = heldIntentSettleFrameRef.current;
            // Already polling for THIS intent: one frame per transaction, unchanged. A frame
            // belonging to a superseded intent is not this transaction's poll and must not
            // stand in for one — it will fail its own identity check and reschedule nothing.
            if (scheduled !== null && scheduled.intent === intent) return;
            const requestAnimationFrame = globalThis.requestAnimationFrame;
            if (typeof requestAnimationFrame !== 'function') {
                finishHeldIntentSettle('unavailable');
                return;
            }
            if (scheduled !== null) {
                const cancelAnimationFrame = globalThis.cancelAnimationFrame;
                if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduled.frame);
            }
            heldIntentSettleFrameRef.current = {
                frame: requestAnimationFrame(monitorHeldIntentThroughLayoutSettle),
                intent,
            };
        }

        resumeHeldIntentSettle(options?.deferFirstVerification === true);
    }, [cancelScheduledHeldIntentSettle, finishEntryPlacement, isUserScrollInputLive, isWebFrame, legendListRef, readHeldIntentLanding, requestNativePhysicalEntryLanding, requestWebHeldEndMaterialization, requestWebKeyedIdentityMaterialization, setHeldScrollIntent, tryAcknowledgeInitialPresentationSettlement, writeHeldIntentResidual]);

    const observeInitialPresentationSettlement = React.useCallback((
        request: TranscriptInitialPresentationSettlementRequest,
    ): (() => void) => {
        if (!isWebFrame || request.dataKey !== dataKey) return () => {};
        const pending: PendingInitialPresentationSettlement = {
            deadlineAtMs: Date.now() + LEGEND_HELD_INTENT_SETTLE_MS,
            request,
        };
        pendingInitialPresentationSettlementRef.current = pending;
        if (heldScrollIntentRef.current) {
            // Reuse the renderer's existing post-layout settle frame. Legend 3.3.3
            // reports onItemSizeChanged before it schedules maintain-at-end, so the
            // callback itself is not release-grade evidence.
            requestHeldIntentSettle({ deferFirstVerification: true });
        } else {
            cancelScheduledHeldIntentSettle();
            tryAcknowledgeInitialPresentationSettlement();
        }
        return () => {
            if (pendingInitialPresentationSettlementRef.current === pending) {
                pendingInitialPresentationSettlementRef.current = null;
            }
        };
    }, [
        cancelScheduledHeldIntentSettle,
        dataKey,
        isWebFrame,
        requestHeldIntentSettle,
        tryAcknowledgeInitialPresentationSettlement,
    ]);

    const latchObservedEndIntent = React.useCallback(() => {
        setHeldScrollIntent({ kind: 'end' });
    }, [setHeldScrollIntent]);

    const latchHeldEndIntent = React.useCallback(() => {
        latchObservedEndIntent();
        heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
        lastHeldIntentCorrectionRef.current = null;
        pendingLargeResidualConfirmationRef.current = null;
        cancelScheduledHeldIntentSettle();
        requestHeldIntentSettle();
    }, [cancelScheduledHeldIntentSettle, latchObservedEndIntent, requestHeldIntentSettle]);

    const hasLiveWebHold = React.useCallback((target: TranscriptRendererWebHoldTarget): boolean => {
        const held = heldScrollIntentRef.current;
        if (target.kind === 'end') {
            // Held-'end' is the renderer's standing tail-ownership contract
            // (Legend maintain-at-end + verifyLanding materialization); while it
            // is live, driver tail writes are a second corrector reading a
            // different scrollHeight snapshot.
            return held?.kind === 'end';
        }
        // Item targets match ANCHOR holds only: they are armed exclusively by a
        // COMPLETED landing (jump/restore success paths), so their presence means
        // the landing owner exists. Index holds are armed by the unmounted-target
        // scrollToIndex BOOTSTRAP of the same jump — treating those as live would
        // make the jump defer to its own bootstrap and never write the landing.
        if (held?.kind !== 'anchor') return false;
        if (Date.now() > held.identityExpiresAtMs) return false;
        return held.anchor.itemId === target.itemId;
    }, []);

    const holdWebEntryAnchor = React.useCallback((anchor: TranscriptRendererEntryAnchorHold) => {
        if (!isWebFrame) return;
        // A completed jump/restore landing starts a new command phase. Momentum evidence from
        // the previous viewport must not authorize a later unclassified browser event.
        invalidateUserInertiaContinuation();
        const nowMs = Date.now();
        const intent: LegendHeldScrollIntent = {
            anchor,
            identityExpiresAtMs: nowMs + LEGEND_HELD_TARGET_IDENTITY_MS,
            kind: 'anchor',
        };
        setHeldScrollIntent(intent);
        heldIntentSettleUntilRef.current = nowMs + LEGEND_HELD_INTENT_SETTLE_MS;
        lastHeldIntentCorrectionRef.current = null;
        cancelScheduledHeldIntentSettle();
        requestHeldIntentSettle();
    }, [cancelScheduledHeldIntentSettle, invalidateUserInertiaContinuation, isWebFrame, requestHeldIntentSettle, setHeldScrollIntent]);

    const armVisibleAnchorHold = React.useCallback(() => {
        // App-initiated in-viewport height commit (tool/thinking expansion toggle) on NATIVE.
        //
        // Web has no arm here: Legend 3.3.3's `maintainVisibleContentPosition` keeps the
        // reader still through an expansion, an above-viewport growth, and an in-viewport
        // item replacement alike, measured against the installed package in
        // `legendListRenderer.real.integration.test.tsx` ('holds a detached reader through
        // expansion, above-viewport growth, and item replacement'). The web arm existed for
        // a re-anchoring captured on 2.0.0-beta.3 (live S-C, 2026-07-11), before the 3.3.3
        // upgrade brought the MVCP anchor lock. Native keeps its arm: its MVCP is open-loop
        // (it predicts `state.scroll` with no ground truth), and the same S-C continuation
        // committed +13k px there.
        if (isWebFrame) return;
        if (heldScrollIntentRef.current?.kind === 'end') return;
        if (hasLiveKeyedHeldIntent()) return;
        const state = legendListRef.current?.getState();
        if (state?.isWithinMaintainScrollAtEndThreshold === true) return;
        if (!state) return;
        if (!Number.isFinite(state.scroll) || !Number.isFinite(state.scrollLength)) return;
        const positionAtIndex = state.positionAtIndex;
        const sizeAtIndex = state.sizeAtIndex;
        if (typeof positionAtIndex !== 'function' || typeof sizeAtIndex !== 'function') return;
        const start = Math.max(0, Math.trunc(state.start ?? 0));
        const end = Math.max(start, Math.trunc(state.end ?? start));
        for (let legendIndex = start; legendIndex <= end && legendIndex < dataLength; legendIndex += 1) {
            const rowPosition = positionAtIndex(legendIndex);
            const rowSize = sizeAtIndex(legendIndex);
            if (!Number.isFinite(rowPosition) || !Number.isFinite(rowSize)) continue;
            if (rowPosition + rowSize <= state.scroll) continue;
            const targetItem = data[legendIndex];
            if (targetItem === undefined) return;
            setHeldScrollIntent({
                identityExpiresAtMs: Date.now() + LEGEND_HELD_TARGET_IDENTITY_MS,
                fallbackIndex: legendIndex,
                key: keyExtractor(targetItem, toSourceIndex(legendIndex)),
                kind: 'index',
                viewOffset: rowPosition - state.scroll,
                viewPosition: 0,
            });
            heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
            lastHeldIntentCorrectionRef.current = null;
            pendingLargeResidualConfirmationRef.current = null;
            cancelScheduledHeldIntentSettle();
            return;
        }
    }, [cancelScheduledHeldIntentSettle, data, dataLength, hasLiveKeyedHeldIntent, isWebFrame, keyExtractor, legendListRef, setHeldScrollIntent, toSourceIndex]);

    const scrollRendererToEnd = React.useCallback((scrollParams?: { animated?: boolean }) => {
        invalidateUserInertiaContinuation();
        suppressAutoEndLatchRef.current = false;
        pendingViewportCauseRef.current = 'command';
        setHeldScrollIntent({ kind: 'end' });
        heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
        lastHeldIntentCorrectionRef.current = null;
        pendingWebTailMaterializationKeyRef.current = null;
        cancelScheduledHeldIntentSettle();
        settleLegendScroll(legendListRef.current?.scrollToEnd(scrollParams));
    }, [cancelScheduledHeldIntentSettle, invalidateUserInertiaContinuation, legendListRef, pendingViewportCauseRef, setHeldScrollIntent, suppressAutoEndLatchRef]);

    /**
     * Latch a keyed index hold for an explicit scroll-to-index command so later measurement
     * signals keep re-verifying the commanded target.
     */
    const holdIndexTarget = React.useCallback((
        legendIndex: number,
        viewOffset: number,
        viewPosition: number,
        entryAnchor?: TranscriptRendererEntryAnchorHold,
    ) => {
        const targetItem = data[legendIndex];
        if (targetItem === undefined) return;
        setHeldScrollIntent({
            ...(entryAnchor ? { entryAnchor } : {}),
            identityExpiresAtMs: Date.now() + LEGEND_HELD_TARGET_IDENTITY_MS,
            fallbackIndex: legendIndex,
            key: keyExtractor(targetItem, toSourceIndex(legendIndex)),
            kind: 'index',
            viewOffset,
            viewPosition,
        });
        if (entryAnchor) {
            // This command is the entry transaction's one bootstrap request. Prevent layout
            // callbacks from dispatching another materialization request for the same identity.
            completedKeyedIdentityMaterializationRef.current = true;
        }
        heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
        lastHeldIntentCorrectionRef.current = null;
        cancelScheduledHeldIntentSettle();
    }, [cancelScheduledHeldIntentSettle, data, keyExtractor, setHeldScrollIntent, toSourceIndex]);

    React.useEffect(() => () => {
        cancelScheduledHeldIntentSettle();
    }, [cancelScheduledHeldIntentSettle]);

    const hasPendingHeldIntentCorrection = React.useCallback((): boolean => (
        lastHeldIntentCorrectionRef.current !== null
    ), []);

    return {
        armVisibleAnchorHold,
        beginExplicitJumpTakeover,
        cancelLegendInitialScrollPreservation,
        hasActiveEntryPlacement,
        hasHeldEndPositioningOwnership,
        hasLiveKeyedHeldIntent,
        hasLiveWebHold,
        hasPendingHeldIntentCorrection,
        heldIntentSettleUntilRef,
        heldScrollIntentRef,
        holdIndexTarget,
        holdWebEntryAnchor,
        latchHeldEndIntent,
        latchObservedEndIntent,
        observeInitialPresentationSettlement,
        releaseHeldScrollIntent,
        requestHeldIntentSettle,
        scrollRendererToEnd,
        tryAcknowledgeInitialPresentationSettlement,
    };
}
