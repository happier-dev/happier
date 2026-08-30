import * as React from 'react';
import { View, type LayoutChangeEvent, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import {
    disposeTranscriptViewportElementObservers,
    ensureTranscriptViewportElementObservers,
    isTranscriptViewportDiagnosticsEnabled,
    recordTranscriptHeldIntentLifecycle,
    recordTranscriptScrollSample,
} from '@/components/sessions/transcript/viewport/driver/transcriptViewportWriteDiagnostics';
import {
    LegendList,
    type LegendListProps,
    type LegendListRef,
    type LegendListState,
} from '@legendapp/list/react-native';

import { LayoutCommitObserver } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import {
    resolveWebTranscriptScrollMetrics,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { resolveWebTranscriptViewportAnchorAlignment } from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import type { TranscriptExplicitJumpOperationId } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import {
    clampLegendScrollOffset,
    isLegendLandingSettledByPhysicalClamp,
    isPlacementHeldIntent,
    LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX,
    LEGEND_HELD_INTENT_LARGE_RESIDUAL_CONFIRM_TOLERANCE_PX,
    LEGEND_HELD_INTENT_SETTLE_MS,
    LEGEND_HELD_TARGET_IDENTITY_MS,
    LEGEND_USER_INPUT_DETACH_WINDOW_MS,
    LEGEND_USER_MOMENTUM_CHAIN_WINDOW_MS,
    LEGEND_USER_SCROLL_INERTIA_CONTINUATION_MS,
    LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS,
    resolveLegendStateHeldIntentLanding,
    settleLegendScroll,
    type LegendHeldIntentLanding,
    type LegendHeldScrollIntent,
} from './legend/heldIntent';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import type { WebScrollMovementFact } from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import type {
    TranscriptRendererAtEndState,
    TranscriptRendererEntryAnchorHold,
    TranscriptRendererNativePhysicalViewportCapture,
    TranscriptRendererNativePhysicalViewportObservationRequest,
    TranscriptRendererNativePhysicalViewportObservationResult,
    TranscriptRendererVisibleSourceIndexRange,
    TranscriptViewportInputEvidence,
    TranscriptViewportMutationCause,
    TranscriptListRenderer,
    TranscriptListRendererProps,
    TranscriptListShellRef,
} from './types';

const LEGEND_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
// Compile-time constant: only its identity churned, and it is read on every Legend render.
const LEGEND_MAINTAIN_VISIBLE_CONTENT_POSITION = { data: true, size: true } as const;
/**
 * The live shape of `maintainScrollAtEnd`. Unlike its sibling above it cannot be a module
 * constant: `isMaintainingScrollAtEnd` reads the INSTANCE's held-intent ref, so the object is
 * built once per mount instead (`maintainScrollAtEndOptionRef`) and the render only chooses
 * between it and `false`.
 */
type LegendMaintainScrollAtEndOption = Readonly<{
    animated: false;
    isMaintainingScrollAtEnd: () => boolean;
}>;
// Last-resort scalar, NOT a calibrated row height. Legend resolves a row size as
// measured -> getEstimatedItemSize (the app's measurement runtime, wired below) ->
// per-type average -> this scalar, so it only reaches rows none of those can answer.
// The number itself is known to be wrong for real content: the live reopen capture of
// 2026-07-23 measured a flat 240px scalar undercounting a real transcript by 53%
// (see measurement/estimateTranscriptRowHeightFromCache.ts). It stays below the giant
// markdown outliers on purpose — per-row measured floors, not this value, are what
// keep tall rows from collapsing.
const LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX = 240;
// Identity host wrapper: @legendapp/list does not forward nativeID/testID to any
// rendered node (verified against the 3.3.0 dist). The web viewport ownership stack
// resolves its scroll container via document.getElementById(nativeID) and then
// descends to the scrollable, so the adapter must own the identity on a wrapper
// View that is an ancestor of the Legend scroller.
const LEGEND_IDENTITY_HOST_STYLE = { flex: 1, minHeight: 0 } as const;



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

type LegendNativePhysicalMeasureNode = Readonly<{
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






function toLegendData<TItem>(data: readonly TItem[], dataOrder: TranscriptListRendererProps<TItem>['frame']['dataOrder']): readonly TItem[] {
    if (dataOrder === 'newest-first') {
        return [...data].reverse();
    }
    return data;
}

function shouldProjectChronologicalIndex<TItem>(props: TranscriptListRendererProps<TItem>): boolean {
    return props.frame.dataOrder === 'newest-first';
}

function toLegendIndex(sourceIndex: number, dataLength: number, projectChronologicalIndex: boolean): number {
    if (!projectChronologicalIndex) return sourceIndex;
    return Math.max(0, dataLength - 1 - sourceIndex);
}

function toSourceIndex(legendIndex: number, dataLength: number, projectChronologicalIndex: boolean): number {
    if (!projectChronologicalIndex) return legendIndex;
    return Math.max(0, dataLength - 1 - legendIndex);
}

function toSourceViewabilityTokens<TItem, TToken extends Readonly<{ index: number; item: TItem }>>(
    tokens: readonly TToken[],
    sourceData: readonly TItem[],
    projectChronologicalIndex: boolean,
): TToken[] {
    return tokens.map((token) => {
        const sourceIndex = toSourceIndex(token.index, sourceData.length, projectChronologicalIndex);
        const sourceItem = sourceData[sourceIndex];
        return {
            ...token,
            index: sourceIndex,
            item: sourceItem === undefined ? token.item : sourceItem,
        };
    });
}

function readDataVersion(extraData: unknown): React.Key | undefined {
    return typeof extraData === 'string' || typeof extraData === 'number' ? extraData : undefined;
}

function readWheelDeltaY(event: unknown): number | null {
    if (!event || typeof event !== 'object') return null;
    const direct = (event as { deltaY?: unknown }).deltaY;
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    const nativeEvent = (event as { nativeEvent?: unknown }).nativeEvent;
    if (!nativeEvent || typeof nativeEvent !== 'object') return null;
    const nested = (nativeEvent as { deltaY?: unknown }).deltaY;
    return typeof nested === 'number' && Number.isFinite(nested) ? nested : null;
}

type TouchVerticalCoordinate = Readonly<{
    axis: 'client' | 'page';
    value: number;
}>;

function readTouchVerticalCoordinate(event: unknown): TouchVerticalCoordinate | null {
    const direct = event && typeof event === 'object'
        ? event as Record<string, unknown>
        : null;
    const nativeEvent = direct?.nativeEvent && typeof direct.nativeEvent === 'object'
        ? direct.nativeEvent as Record<string, unknown>
        : null;
    const firstTouch = (value: unknown): Record<string, unknown> | null => {
        if (!value || typeof value !== 'object') return null;
        const touch = (value as { 0?: unknown })[0];
        return touch && typeof touch === 'object' ? touch as Record<string, unknown> : null;
    };
    const candidates = [
        direct,
        nativeEvent,
        firstTouch(direct?.touches),
        firstTouch(nativeEvent?.touches),
        firstTouch(direct?.changedTouches),
        firstTouch(nativeEvent?.changedTouches),
    ];
    for (const candidate of candidates) {
        const clientY = candidate?.clientY;
        if (typeof clientY === 'number' && Number.isFinite(clientY)) {
            return { axis: 'client', value: clientY };
        }
    }
    for (const candidate of candidates) {
        const pageY = candidate?.pageY;
        if (typeof pageY === 'number' && Number.isFinite(pageY)) {
            return { axis: 'page', value: pageY };
        }
    }
    return null;
}

function toLegendSlot(node: React.ReactNode): React.ReactElement | null {
    return React.isValidElement(node) ? node : null;
}

function readLegendAtEndState(state: LegendListState | undefined): TranscriptRendererAtEndState | null {
    if (!state) return null;
    return {
        isAtEnd: state.isAtEnd === true,
        isFollowing: state.isWithinMaintainScrollAtEndThreshold === true,
        isNearEnd: state.isNearEnd === true,
        isWithinMaintainScrollAtEndThreshold: state.isWithinMaintainScrollAtEndThreshold === true,
    };
}

export function resolveLegendRendererAtEndStateFromWebMetrics(params: Readonly<{
    metrics: Pick<WebTranscriptScrollMetrics, 'clientHeight' | 'scrollHeight' | 'scrollTop'>;
    maintainScrollAtEndThreshold: number;
}>): TranscriptRendererAtEndState {
    const distanceFromBottom = Math.max(
        0,
        params.metrics.scrollHeight - params.metrics.clientHeight - params.metrics.scrollTop,
    );
    const thresholdRatio = Number.isFinite(params.maintainScrollAtEndThreshold)
        ? Math.max(0, params.maintainScrollAtEndThreshold)
        : 0;
    const thresholdPx = thresholdRatio * Math.max(0, params.metrics.clientHeight);
    return {
        isAtEnd: distanceFromBottom <= 1,
        isFollowing: distanceFromBottom <= thresholdPx,
        isNearEnd: distanceFromBottom <= thresholdPx,
        isWithinMaintainScrollAtEndThreshold: distanceFromBottom <= thresholdPx,
    };
}

function LegendListTranscriptRendererInner<TItem>(
    props: TranscriptListRendererProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const legendListRef = React.useRef<LegendListRef | null>(null);
    const identityHostRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const visualBottomSlotHostRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const heldScrollIntentRef = React.useRef<LegendHeldScrollIntent | null>(
        props.frame.rendererOptions.initialPlacement.atEnd ? { kind: 'end' } : null,
    );
    const nativePhysicalEntryMeasurementRef = React.useRef<Readonly<{
        element: LegendNativePhysicalEntryElement;
        generation: object;
        intent: LegendHeldScrollIntent;
        scrollHost: LegendNativePhysicalScrollHost;
    }> | null>(null);
    const nativePhysicalEntryMeasurementGenerationRef = React.useRef<object>({});
    const latestNativePhysicalViewportCaptureRef =
        React.useRef<TranscriptRendererNativePhysicalViewportCapture | null>(null);
    const nativePhysicalViewportObservationRef = React.useRef<object | null>(null);
    const explicitJumpTakeoverOperationRef = React.useRef<TranscriptExplicitJumpOperationId | null>(null);
    // Native prop: `react-native-unistyles` installs `nativeProps_DEPRECATED` stickily, so a fresh
    // object here deep-copies on every commit of a styled family. Built once per mount because the
    // predicate closes over `heldScrollIntentRef` only — a ref, so it is already stable and reads
    // the live intent at call time. `useRef` rather than `useMemo`: identity is guaranteed for the
    // instance's lifetime, and React may discard a memo.
    const maintainScrollAtEndOptionRef = React.useRef<LegendMaintainScrollAtEndOption | null>(null);
    if (maintainScrollAtEndOptionRef.current === null) {
        maintainScrollAtEndOptionRef.current = {
            animated: false,
            isMaintainingScrollAtEnd: () => heldScrollIntentRef.current?.kind === 'end',
        };
    }
    const maintainScrollAtEndOption = maintainScrollAtEndOptionRef.current;
    const [, renderPositioningPhase] = React.useReducer((revision: number) => revision + 1, 0);
    const pendingViewportCauseRef = React.useRef<TranscriptViewportMutationCause>('layout');
    const webScrollbarDragCleanupRef = React.useRef<(() => void) | null>(null);
    const lastUserInteractionAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    // SCROLL-INTENT evidence only (wheel/drag/keyboard/momentum) — a bare tap records general
    // interaction (write suppression, hold release at touch) but must NOT classify later
    // offset movement as a user detach: an expansion commit keeps moving the offset for
    // seconds after the toggling tap, and detach-releasing there strands the armed hold
    // (live native S-C re-run 2026-07-11 09:03).
    //
    // The scroll-intent timestamp AND the S-D drag/momentum liveness bits both live in the ONE
    // owner the host also reads (`viewport/driver/userScrollIntentOwner`). They used to be a
    // renderer-private ref with the same name as the host's plus two private booleans, so the
    // host's auto-pin guard could not see a web scrollbar drag at all and the renderer could not
    // see host-side keyboard/pointer intent. While live, verifyLanding never writes residuals.
    const userScrollIntent = props.webDomObservation.userScrollIntent;
    const lastDragEndAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const lastUserMomentumEndAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const webTouchVerticalCoordinateRef = React.useRef<TouchVerticalCoordinate | null>(null);
    const lastViewportHeightRef = React.useRef<number | null>(null);
    const lastVisualBottomSlotHeightRef = React.useRef<number | null>(null);
    const hasCommittedVisualBottomSlotRef = React.useRef(false);
    const previousVisualBottomSlotRef = React.useRef<React.ReactNode>(null);
    const hasCommittedHeldTailDataRevisionRef = React.useRef(false);
    const lastObservedScrollOffsetRef = React.useRef<number | null>(null);
    const webScrollableElementRef = React.useRef<HTMLElement | null>(null);
    const onEntryPlacementEventRef = React.useRef(props.onEntryPlacementEvent);
    useCommittedTranscriptRef(onEntryPlacementEventRef, props.onEntryPlacementEvent);
    const activeEntryPlacementItemIdRef = React.useRef<string | null>(null);
    const finishedEntryPlacementItemIdRef = React.useRef<string | null>(null);
    const lastEntryPlacementExactAlignmentRef = React.useRef(false);
    const viewportRevealMeasurementGenerationRef = React.useRef<object | null>(null);
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
        props.frame.rendererOptions.initialPlacement.atEnd
            ? Date.now() + LEGEND_HELD_INTENT_SETTLE_MS
            : 0,
    );
    const lastHeldIntentCorrectionRef = React.useRef<Readonly<{
        currentOffset: number;
        intent: LegendHeldScrollIntent;
        targetOffset: number;
        /** Offset read back right after a web-dom write (clamp-aware); null for other bases. */
        landedOffset: number | null;
    }> | null>(null);
    // Native keeps its renderer-local drag/momentum continuation because it has no DOM
    // observation owner. Web continuation belongs to the mounted WebDom observation below.
    const nativeMovementEpochRef = React.useRef(0);
    const lastClassifiedNativeUserScrollRef = React.useRef<Readonly<{
        atMs: number;
        direction: 1 | -1;
        epoch: number;
    }> | null>(null);
    const advanceMovementEpoch = React.useCallback(() => {
        nativeMovementEpochRef.current += 1;
        lastClassifiedNativeUserScrollRef.current = null;
        props.webDomObservation.invalidateUserMovementAuthority();
    }, [props.webDomObservation]);
    const invalidateUserInertiaContinuation = React.useCallback(() => {
        // A command boundary ends the prior gesture as continuation authority. Preserve live
        // drag/momentum suppression itself: an explicit command issued mid-fling must not let
        // the held corrector fight the still-active native gesture.
        advanceMovementEpoch();
        userScrollIntent.revokeInputEvidence();
    }, [advanceMovementEpoch, userScrollIntent]);
    const pendingLargeResidualConfirmationRef = React.useRef<Readonly<{
        intent: LegendHeldScrollIntent;
        targetOffset: number;
    }> | null>(null);
    // The geometry the PREVIOUS landing read of the live transaction observed. A correction
    // may only be spent on evidence that is no longer in motion (see the coherence precondition
    // in `evaluateLanding`); the app's own landed write rebases it on web, so correcting once
    // never disqualifies the next correction.
    const lastLandingObservationRef = React.useRef<Readonly<{
        currentOffset: number;
        intent: LegendHeldScrollIntent;
        scrollRange: number;
    }> | null>(null);
    const pendingWebTailMaterializationKeyRef = React.useRef<string | null>(null);
    // One materialization scroll EVER per DATASET identity (`dataKey`): after a successful
    // mount, the measured residual owner re-mounts a flapped-out tail by scrolling — a second
    // imperative tail command re-enters Legend's estimate-target retry machinery and closes a
    // materialize↔correct loop (live capture 2026-07-23: 255 re-fired scrollToIndex vs
    // the measured-bottom corrections, oscillating the reopened viewport for minutes).
    // Keying this on the tail ROW identity plus `dataLength` re-armed it on every hydration
    // wave, which is how one cold open still issued 16 placement commands (2026-07-30).
    const completedWebTailMaterializationKeyRef = React.useRef<string | null>(null);
    const completedKeyedIdentityMaterializationRef = React.useRef(false);
    const lastPublishedAtEndStateRef = React.useRef<TranscriptRendererAtEndState | null>(null);
    const lastPublishedAtEndCauseRef = React.useRef<TranscriptViewportMutationCause | null>(null);
    const lastEmittedContentHeightRef = React.useRef<number | null>(null);
    // While true, physically-at-end observations must NOT auto-latch a held-'end' intent:
    // a detached-anchor entry mounts over the previous session's still-at-end geometry, and an
    // auto-latch there drags the entry-anchor restore back to the tail. Cleared by real scroll
    // movement or an explicit renderer command.
    const suppressAutoEndLatchRef = React.useRef(
        !props.frame.rendererOptions.initialPlacement.atEnd,
    );
    const isWebFrame = props.frame.platform === 'web';
    // Read once per transcript (the hook shares one process-wide platform subscription) and
    // published through a committed ref so the tail command owner keeps a stable identity —
    // the imperative handle is identity-sensitive.
    const reduceMotionRef = React.useRef(false);
    useCommittedTranscriptRef(reduceMotionRef, useReducedMotionPreference());
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
        // A terminal presentation outcome is also the terminal authority boundary for this
        // entry-specific hold. Release it before notifying the presentation owner so a
        // placeholder reveal cannot be followed by a late size/layout residual write from the
        // same lifecycle. Non-entry reading/navigation holds retain their independent deadline.
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
            dataKey: props.dataKey,
            itemId,
            outcome,
            platform: props.frame.platform,
            type: 'finished',
        });
    }, [props.dataKey, props.frame.platform]);
    const startEntryPlacement = React.useCallback((intent: LegendHeldScrollIntent | null) => {
        const itemId = readEntryPlacementItemId(intent);
        if (itemId == null) return;
        if (
            activeEntryPlacementItemIdRef.current === itemId
            && finishedEntryPlacementItemIdRef.current !== itemId
        ) {
            // Index bootstrap -> exact anchor is one placement, not a successor.
            lastEntryPlacementExactAlignmentRef.current = false;
            return;
        }
        if (finishedEntryPlacementItemIdRef.current === itemId) return;
        activeEntryPlacementItemIdRef.current = itemId;
        finishedEntryPlacementItemIdRef.current = null;
        lastEntryPlacementExactAlignmentRef.current = false;
        onEntryPlacementEventRef.current?.({
            dataKey: props.dataKey,
            itemId,
            platform: props.frame.platform,
            type: 'started',
        });
    }, [props.dataKey, props.frame.platform]);

    const setHeldScrollIntent = React.useCallback((intent: LegendHeldScrollIntent | null) => {
        const previousIntent = heldScrollIntentRef.current;
        const previousEntryItemId = readEntryPlacementItemId(previousIntent);
        const nextEntryItemId = readEntryPlacementItemId(intent);
        if (previousEntryItemId != null && previousEntryItemId !== nextEntryItemId) {
            finishEntryPlacement(previousIntent, 'superseded');
        }
        if (
            previousEntryItemId == null &&
            nextEntryItemId != null &&
            finishedEntryPlacementItemIdRef.current === nextEntryItemId
        ) {
            // A cleared predecessor followed by the same persisted row is a fresh entry
            // lifecycle (for example a same-session warm reopen), not the index->anchor
            // continuation of the still-live predecessor hold.
            activeEntryPlacementItemIdRef.current = null;
            finishedEntryPlacementItemIdRef.current = null;
        }
        const previousHeldEndOwnership = previousIntent?.kind === 'end';
        const nextHeldEndOwnership = intent?.kind === 'end';
        if (previousIntent !== intent) {
            completedKeyedIdentityMaterializationRef.current = false;
            if (intent) {
                recordTranscriptHeldIntentLifecycle({
                    ...readHeldIntentDiagnosticIdentity(intent),
                    event: 'hold-set',
                });
            } else if (
                previousIntent
                && heldScrollIntentRef.current === previousIntent
            ) {
                // finishEntryPlacement owns terminal entry release diagnostics and clears
                // the live ref before this generic transition continues.
                recordTranscriptHeldIntentLifecycle({
                    ...readHeldIntentDiagnosticIdentity(previousIntent),
                    event: 'hold-release',
                });
            }
        }
        heldScrollIntentRef.current = intent;
        startEntryPlacement(intent);
        if (previousHeldEndOwnership !== nextHeldEndOwnership) {
            renderPositioningPhase();
        }
    }, [finishEntryPlacement, startEntryPlacement]);
    const data = React.useMemo(() => toLegendData(props.data, props.frame.dataOrder), [props.data, props.frame.dataOrder]);
    const dataLength = data.length;
    const projectChronologicalIndex = shouldProjectChronologicalIndex(props);
    const legendDataVersion = readDataVersion(props.extraData);
    const nativePhysicalViewportIdentity = React.useMemo(() => ({
        data,
        dataKey: props.dataKey,
        dataLength,
        keyExtractor: props.keyExtractor,
        projectChronologicalIndex,
        sourceData: props.data,
    }), [
        data,
        dataLength,
        projectChronologicalIndex,
        props.dataKey,
        props.data,
        props.keyExtractor,
    ]);
    const nativePhysicalViewportIdentityRef = React.useRef(nativePhysicalViewportIdentity);
    nativePhysicalViewportIdentityRef.current = nativePhysicalViewportIdentity;
    const invalidateNativePhysicalViewportCapture = React.useCallback(() => {
        latestNativePhysicalViewportCaptureRef.current = null;
        nativePhysicalViewportObservationRef.current = null;
    }, []);
    const observeNativePhysicalViewport = React.useCallback((
        request: TranscriptRendererNativePhysicalViewportObservationRequest,
    ): TranscriptRendererNativePhysicalViewportObservationResult => {
        if (isWebFrame) return { status: 'unavailable' };

        const identity = nativePhysicalViewportIdentityRef.current;
        const latest = latestNativePhysicalViewportCaptureRef.current;
        if (latest) {
            const currentItem = identity.sourceData[latest.itemIndex];
            if (
                latest.dataKey === identity.dataKey
                && currentItem !== undefined
                && identity.keyExtractor(currentItem, latest.itemIndex) === latest.itemKey
            ) {
                return { capture: latest, status: 'captured' };
            }
            invalidateNativePhysicalViewportCapture();
        }
        if (!request.onComplete) return { status: 'unavailable' };

        const legendRef = legendListRef.current;
        const state = legendRef?.getState();
        const scroller = legendRef?.getNativeScrollRef?.() as unknown as Readonly<{
            getInnerViewRef?: () => unknown;
            getNativeScrollRef?: () => unknown;
        }> | null | undefined;
        const contentHost = scroller?.getInnerViewRef?.() as
            | LegendNativePhysicalMeasureNode
            | null
            | undefined;
        const scrollHost = scroller?.getNativeScrollRef?.() as
            | LegendNativePhysicalMeasureNode
            | null
            | undefined;
        const startBuffered = state?.startBuffered ?? state?.start;
        const endBuffered = state?.endBuffered ?? state?.end;
        if (
            !legendRef
            || !state
            || typeof state.elementAtIndex !== 'function'
            || typeof contentHost?.measure !== 'function'
            || typeof scrollHost?.measure !== 'function'
            || !Number.isFinite(startBuffered)
            || !Number.isFinite(endBuffered)
        ) {
            return { status: 'unavailable' };
        }

        const firstLegendIndex = Math.max(
            0,
            Math.min(identity.dataLength - 1, Math.trunc(startBuffered as number)),
        );
        const lastLegendIndex = Math.max(
            firstLegendIndex,
            Math.min(identity.dataLength - 1, Math.trunc(endBuffered as number)),
        );
        const candidates: Array<Readonly<{
            element: LegendNativePhysicalMeasureNode;
            item: TItem;
            itemKey: string;
            legendIndex: number;
            sourceIndex: number;
        }>> = [];
        for (let legendIndex = firstLegendIndex; legendIndex <= lastLegendIndex; legendIndex += 1) {
            const item = identity.data[legendIndex];
            const sourceIndex = toSourceIndex(
                legendIndex,
                identity.dataLength,
                identity.projectChronologicalIndex,
            );
            const element = state.elementAtIndex(legendIndex) as unknown as
                | LegendNativePhysicalMeasureNode
                | null
                | undefined;
            if (
                item === undefined
                || typeof element?.measure !== 'function'
                || sourceIndex < 0
                || sourceIndex >= identity.sourceData.length
            ) {
                continue;
            }
            candidates.push({
                element,
                item,
                itemKey: identity.keyExtractor(item, sourceIndex),
                legendIndex,
                sourceIndex,
            });
        }
        if (candidates.length === 0) return { status: 'unavailable' };

        const observation = {};
        nativePhysicalViewportObservationRef.current = observation;
        latestNativePhysicalViewportCaptureRef.current = null;
        let remainingMeasurements = candidates.length + 2;
        let contentMeasurement: Readonly<{ height: number; pageY: number }> | null = null;
        let hostMeasurement: Readonly<{ height: number; pageY: number }> | null = null;
        const measuredRows: Array<Readonly<{
            candidate: (typeof candidates)[number];
            height: number;
            pageY: number;
        }>> = [];
        const finishMeasurement = (): void => {
            remainingMeasurements -= 1;
            if (remainingMeasurements > 0) return;
            if (
                nativePhysicalViewportObservationRef.current !== observation
                || nativePhysicalViewportIdentityRef.current !== identity
                || legendListRef.current !== legendRef
                || contentMeasurement == null
                || hostMeasurement == null
            ) {
                return;
            }
            const currentScroller = legendRef.getNativeScrollRef?.() as unknown as Readonly<{
                getInnerViewRef?: () => unknown;
                getNativeScrollRef?: () => unknown;
            }> | null | undefined;
            if (
                currentScroller?.getInnerViewRef?.() !== contentHost
                || currentScroller?.getNativeScrollRef?.() !== scrollHost
                || !Number.isFinite(contentMeasurement.height)
                || !Number.isFinite(contentMeasurement.pageY)
                || !Number.isFinite(hostMeasurement.height)
                || !Number.isFinite(hostMeasurement.pageY)
                || hostMeasurement.height < 0
            ) {
                nativePhysicalViewportObservationRef.current = null;
                request.onComplete?.(null);
                return;
            }
            const currentState = legendRef.getState();
            const currentRows = measuredRows.filter(({ candidate, height, pageY }) => (
                currentState.elementAtIndex?.(candidate.legendIndex) === candidate.element
                && identity.data[candidate.legendIndex] === candidate.item
                && identity.sourceData[candidate.sourceIndex] === candidate.item
                && identity.keyExtractor(candidate.item, candidate.sourceIndex) === candidate.itemKey
                && Number.isFinite(height)
                && height >= 0
                && Number.isFinite(pageY)
            ));
            const focusPageY = hostMeasurement.pageY + Math.max(
                0,
                Math.min(request.focusOffsetPx, hostMeasurement.height),
            );
            let selected = currentRows.find(({ height, pageY }) => (
                pageY <= focusPageY && pageY + height >= focusPageY
            ));
            if (!selected) {
                selected = currentRows.reduce<(typeof currentRows)[number] | undefined>((nearest, row) => {
                    const distance = focusPageY < row.pageY
                        ? row.pageY - focusPageY
                        : focusPageY - (row.pageY + row.height);
                    if (!nearest) return row;
                    const nearestDistance = focusPageY < nearest.pageY
                        ? nearest.pageY - focusPageY
                        : focusPageY - (nearest.pageY + nearest.height);
                    return distance < nearestDistance ? row : nearest;
                }, undefined);
            }
            if (!selected) {
                nativePhysicalViewportObservationRef.current = null;
                request.onComplete?.(null);
                return;
            }
            const displayedOffset = hostMeasurement.pageY - contentMeasurement.pageY;
            const capture: TranscriptRendererNativePhysicalViewportCapture = {
                capturedAtMs: Date.now(),
                dataKey: identity.dataKey,
                itemIndex: selected.candidate.sourceIndex,
                itemKey: selected.candidate.itemKey,
                itemOffsetPx: selected.pageY - hostMeasurement.pageY,
                offsetY: Math.max(
                    0,
                    Math.round(
                        contentMeasurement.height
                        - hostMeasurement.height
                        - displayedOffset,
                    ),
                ),
            };
            nativePhysicalViewportObservationRef.current = null;
            latestNativePhysicalViewportCaptureRef.current = capture;
            request.onComplete?.(capture);
        };
        contentHost.measure((_x, _y, _width, height, _pageX, pageY) => {
            contentMeasurement = { height, pageY };
            finishMeasurement();
        });
        scrollHost.measure((_x, _y, _width, height, _pageX, pageY) => {
            hostMeasurement = { height, pageY };
            finishMeasurement();
        });
        for (const candidate of candidates) {
            candidate.element.measure((_x, _y, _width, height, _pageX, pageY) => {
                measuredRows.push({ candidate, height, pageY });
                finishMeasurement();
            });
        }
        return { status: 'pending' };
    }, [invalidateNativePhysicalViewportCapture, isWebFrame]);
    const heldTailDataRevision = dataLength === 0
        ? `0:${String(legendDataVersion ?? '')}`
        : [
            dataLength,
            props.keyExtractor(data[0], toSourceIndex(0, dataLength, projectChronologicalIndex)),
            props.keyExtractor(data[dataLength - 1], toSourceIndex(dataLength - 1, dataLength, projectChronologicalIndex)),
            legendDataVersion ?? '',
        ].join(':');
    // @legendapp/list has NO onContentSizeChange support (zero occurrences in the 3.x dist) —
    // forwarding the shell prop is a silent no-op. The session-open chain depends on the signal
    // (onContentSizeChange -> setListContentHeight -> sessionOpenLatch leaves 'awaiting-layout'
    // -> initial fill settles -> older pagination's 'fill-not-done' suspension clears), so the
    // adapter synthesizes it from Legend's own measured state: on every adapter layout commit
    // (data/extraData changes incl. prepends) and on Legend-internal item remeasures
    // (onItemSizeChanged), deduped by the last emitted size.
    const onContentSizeChangeRef = React.useRef(props.onContentSizeChange);
    // Publish before child layout callbacks, but never from an abandoned same-session render.
    useCommittedTranscriptRef(onContentSizeChangeRef, props.onContentSizeChange);
    const emitSynthesizedContentSize = React.useCallback(() => {
        const emit = onContentSizeChangeRef.current;
        if (!emit) return;
        const height = legendListRef.current?.getState().contentLength;
        if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
        if (lastEmittedContentHeightRef.current === height) return;
        lastEmittedContentHeightRef.current = height;
        // Width is not part of Legend's public state surface and no transcript consumer reads
        // it (the shell handler is `(_, h) => ...`), so the synthesized signal reports 0.
        emit(0, height);
    }, []);

    const readWebScrollMetrics = React.useCallback((): WebTranscriptScrollMetrics | null => {
        if (!isWebFrame || typeof document === 'undefined' || typeof window === 'undefined') return null;
        const nativeID = props.frame.rendererOptions.identity.nativeID;
        const directLegendNode = nativeID ? null : legendListRef.current?.getScrollableNode?.();
        const root = nativeID
            ? document.getElementById(nativeID)
            : typeof HTMLElement !== 'undefined' && directLegendNode instanceof HTMLElement
                ? directLegendNode
                : null;
        const metrics = resolveWebTranscriptScrollMetrics({
            root,
            cachedElement: webScrollableElementRef.current,
            win: window,
            minOverflowPx: 0,
            allowRootFallback: true,
        });
        if (metrics) webScrollableElementRef.current = metrics.element;
        // Opt-in rare-defect probe (no-op unless happier.debug.viewportWrites=1). Armed HERE,
        // at the canonical scroller resolution, because a mount-time effect could not re-arm:
        // the transcript does not overflow yet at mount, so the resolver falls back past the
        // transcript root onto an ancestor (live: the 384px left rail) or onto the root itself,
        // and the ring then certified an unrelated element's silence as the transcript's.
        // Legend's own scrollable node is the earliest TRUE identity of the transcript scroller
        // — it is the element Legend writes to and it does not wait for transient overflow — so
        // it is preferred, and the containment check keeps that preference honest.
        if (isTranscriptViewportDiagnosticsEnabled()) {
            const legendNode = directLegendNode ?? legendListRef.current?.getScrollableNode?.();
            const legendScrollElement = typeof HTMLElement !== 'undefined' && legendNode instanceof HTMLElement
                ? legendNode
                : null;
            ensureTranscriptViewportElementObservers({
                element: legendScrollElement ?? metrics?.element ?? null,
                transcriptRoot: root,
            });
        }
        return metrics;
    }, [isWebFrame, props.frame.rendererOptions.identity.nativeID]);

    const readRendererAtEndObservation = React.useCallback((): Readonly<{
        state: TranscriptRendererAtEndState;
        contentScrollable: boolean;
    }> | null => {
        const metrics = readWebScrollMetrics();
        if (metrics) {
            return {
                state: resolveLegendRendererAtEndStateFromWebMetrics({
                    metrics,
                    maintainScrollAtEndThreshold: props.frame.rendererOptions.continuousFollow.endThresholdRatio,
                }),
                contentScrollable: metrics.scrollHeight > metrics.clientHeight + 1,
            };
        }
        const legendState = legendListRef.current?.getState();
        const state = readLegendAtEndState(legendState);
        if (!state) return null;
        const contentLength = legendState?.contentLength;
        const scrollLength = legendState?.scrollLength;
        return {
            state,
            contentScrollable:
                typeof contentLength === 'number' && Number.isFinite(contentLength)
                && typeof scrollLength === 'number' && Number.isFinite(scrollLength)
                    ? contentLength > scrollLength + 1
                    : true,
        };
    }, [
        props.frame.rendererOptions.continuousFollow.endThresholdRatio,
        readWebScrollMetrics,
    ]);

    const readRendererAtEndState = React.useCallback((): TranscriptRendererAtEndState | null => {
        return readRendererAtEndObservation()?.state ?? null;
    }, [readRendererAtEndObservation]);

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

    // Native semantic cause classification for at-end publications (S-I, 2026-07-11).
    // Web scroll-driven publications consume the exact WebDom movement fact instead.
    // The previous one-shot pending-cause consumption misattributed every flip that did not
    // land exactly on the first post-input scroll event: a Chromium smooth-scroll continuation
    // reaching the tail published 'layout' (the live-tail intent never reached sync and a
    // stale persisted detached anchor survived — S-G), a mid-drag threshold exit published
    // 'layout' (wantsPinned stayed true and the native older-load follow gate never opened —
    // S-I), and a NEVER-consumed 'user' (wheel at the clamp produces no scroll event) leaked
    // into a growth-driven follow-loss flip minutes later (false user detach during a giant
    // streaming commit — S-K). Classification is evidence-windowed instead:
    // - 'command' pending stays authoritative (one-shot, consumed by its own scroll event);
    // - a flip without physical offset movement is renderer/layout-caused geometry, never user;
    // - a flip INTO following counts as user within the full input-detach evidence window
    //   (physically reaching the tail within seconds of user scroll input IS the user's tail
    //   arrival — misattribution is harmless because it only re-affirms live-tail intent);
    // - a flip OUT of following (detach — deletes/creates persistence state) needs strict
    //   evidence: a live drag/momentum phase, the fresh one-shot 'user', or input within the
    //   tight write-suppression margin (smooth-scroll continuation of a genuine wheel detach).
    const resolveNativeAtEndPublicationCause = React.useCallback((params: Readonly<{
        isFollowing: boolean;
        offsetMoved: boolean;
        pendingCause: TranscriptViewportMutationCause;
    }>): TranscriptViewportMutationCause => {
        if (params.pendingCause === 'command') return 'command';
        if (!params.offsetMoved) return 'layout';
        const nowMs = Date.now();
        const dragOrMomentumLive = userScrollIntent.isGestureActive();
        const scrollIntentAgeMs = nowMs - userScrollIntent.lastInputAtMs();
        const evidenceLive = dragOrMomentumLive || scrollIntentAgeMs <= LEGEND_USER_INPUT_DETACH_WINDOW_MS;
        if (!evidenceLive) return 'layout';
        if (params.isFollowing) return 'user';
        if (dragOrMomentumLive || params.pendingCause === 'user') return 'user';
        return scrollIntentAgeMs <= LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS ? 'user' : 'layout';
    }, []);

    const isUserScrollInputLive = React.useCallback((): boolean => {
        if (userScrollIntent.isGestureActive()) return true;
        return Date.now() - lastUserInteractionAtMsRef.current <= LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS;
    }, [userScrollIntent]);

    const emitRendererAtEndState = React.useCallback((
        context?: Readonly<{
            offsetMoved?: boolean;
            pendingCause?: TranscriptViewportMutationCause;
            webMovementFact?: WebScrollMovementFact;
        }>,
    ) => {
        const observation = readRendererAtEndObservation();
        if (!observation) return;
        const state = observation.state;
        // Native may latch held-'end' from a quiet SCROLLABLE at-end observation.
        // Web passive layout/state-listener observations never carry user authority:
        // web acquisition comes from an explicit toward-end clamp input or the canonical
        // downward movement fact in handleLegendScroll.
        // Underfilled mount
        // geometry (fresh session entry before the initial fill) is physically "at end" but
        // carries no tail intent; latching there re-created the re-entry scroll war against
        // detached entry-anchor restores (USER-REALITY-DIVERGENCE RC-4).
        // And only from QUIET input (same S-D principle the settle corrector enforces):
        // user viewport input (keyboard/wheel/drag) releases the held target BEFORE the
        // browser applies its default movement, and a still-at-end observation landing in
        // that window re-acquired the tail and snapped the viewport back over the user's
        // takeover (live AUD-002, 2026-07-12: trusted PageUp detached 277px, the settle
        // returned it to the tail ~118ms later). Explicit command latches are unaffected.
        if (
            !isWebFrame
            && state.isAtEnd
            && observation.contentScrollable
            && !suppressAutoEndLatchRef.current
            && !isUserScrollInputLive()
        ) {
            if (!hasLiveKeyedHeldIntent() && heldScrollIntentRef.current?.kind !== 'end') {
                setHeldScrollIntent({ kind: 'end' });
            }
        }
        // A keyed anchor/index hold is the semantic viewport truth until the canonical
        // scroll callback classifies a genuine bottomward arrival and atomically replaces
        // it with held-'end'. Legend invokes threshold listeners before that public callback;
        // publishing following here would let lifecycle/sync adopt the tail while the
        // renderer still owns the detached keyed target. Return before touching either the
        // scroll baseline or publication baseline so the callback can classify and publish
        // the same arrival after the ownership transfer.
        if (state.isFollowing && hasLiveKeyedHeldIntent()) return;
        const webScroll = webScrollableElementRef.current?.scrollTop;
        const currentOffset = isWebFrame && typeof webScroll === 'number' && Number.isFinite(webScroll)
            ? webScroll
            : legendListRef.current?.getState().scroll;
        const offsetMoved = context?.offsetMoved ?? (
            !isWebFrame
            && lastObservedScrollOffsetRef.current !== null
            && typeof currentOffset === 'number'
            && Number.isFinite(currentOffset)
            && Math.abs(currentOffset - lastObservedScrollOffsetRef.current) >= 1
        );
        if (
            !isWebFrame
            && lastObservedScrollOffsetRef.current === null
            && typeof currentOffset === 'number'
            && Number.isFinite(currentOffset)
        ) {
            lastObservedScrollOffsetRef.current = currentOffset;
        }
        const pendingCause = context?.pendingCause ?? 'layout';
        const cause = isWebFrame
            ? context?.webMovementFact?.atEndPublicationCause
                ?? (pendingCause === 'command' ? 'command' : 'layout')
            : resolveNativeAtEndPublicationCause({
                isFollowing: state.isFollowing,
                offsetMoved,
                pendingCause,
            });
        const emit = props.onRendererAtEndChange;
        if (!emit) return;
        // Publish CHANGES only: geometry ticks (ResizeObserver, layout commits, state
        // listeners) re-observe identical facts at high frequency during streaming, and each
        // redundant publication cascaded into app/sync work (RC-1 storm).
        const lastPublished = lastPublishedAtEndStateRef.current;
        if (
            lastPublished
            && lastPublished.isAtEnd === state.isAtEnd
            && lastPublished.isNearEnd === state.isNearEnd
            && lastPublished.isWithinMaintainScrollAtEndThreshold === state.isWithinMaintainScrollAtEndThreshold
            && lastPublishedAtEndCauseRef.current === cause
        ) {
            return;
        }
        lastPublishedAtEndStateRef.current = state;
        lastPublishedAtEndCauseRef.current = cause;
        emit(state, { cause });
    }, [hasLiveKeyedHeldIntent, isUserScrollInputLive, isWebFrame, props.onRendererAtEndChange, readRendererAtEndObservation, resolveNativeAtEndPublicationCause, setHeldScrollIntent]);

    const cancelScheduledHeldIntentSettle = React.useCallback(() => {
        const cancelAnimationFrame = globalThis.cancelAnimationFrame;
        if (typeof cancelAnimationFrame === 'function' && heldIntentSettleFrameRef.current !== null) {
            cancelAnimationFrame(heldIntentSettleFrameRef.current.frame);
        }
        heldIntentSettleFrameRef.current = null;
    }, []);

    React.useEffect(() => {
        if (!isWebFrame) return;
        // Arming follows `readWebScrollMetrics` (see there); this effect only opens the probe
        // on mount and tears it down on unmount.
        readWebScrollMetrics();
        return () => disposeTranscriptViewportElementObservers();
    }, [isWebFrame, readWebScrollMetrics]);

    const releaseHeldScrollIntent = React.useCallback((
        outcome: 'preempted' | 'superseded' = 'preempted',
    ) => {
        finishEntryPlacement(heldScrollIntentRef.current, outcome);
        setHeldScrollIntent(null);
        heldIntentSettleUntilRef.current = 0;
        lastHeldIntentCorrectionRef.current = null;
        pendingLargeResidualConfirmationRef.current = null;
        pendingWebTailMaterializationKeyRef.current = null;
        cancelScheduledHeldIntentSettle();
    }, [
        cancelScheduledHeldIntentSettle,
        finishEntryPlacement,
        setHeldScrollIntent,
    ]);
    const cancelLegendInitialScrollPreservation = React.useCallback(() => {
        legendListRef.current?.cancelInitialScrollPreservation();
    }, []);

    // IDENTITY AMPLIFICATION — the two resolvers below are the root of the held-intent callback
    // chain (`readHeldIntentLanding`/`writeHeldIntentResidual` -> `requestHeldIntentSettle` -> the
    // dataset layout effect). Taking `props.keyExtractor` as a DEPENDENCY made a caller that
    // renders an inline arrow re-open a full LEGEND_HELD_INTENT_SETTLE_MS window of per-frame
    // polling on every commit — 94 `requestAnimationFrame` calls for a commit that changed nothing
    // (`legendIdleFrameCost.fabric.native.real.integration.test.tsx`). Both resolvers run only from
    // post-commit paths (frames, layout/scroll callbacks, imperative commands), so the COMMITTED
    // value is the correct one to read and the renderer stops converting caller prop-identity
    // churn into scroll-corrector work. Data-driven invalidation is unchanged: `data`,
    // `dataLength` and `projectChronologicalIndex` remain dependencies.
    const keyExtractorRef = React.useRef(props.keyExtractor);
    useCommittedTranscriptRef(keyExtractorRef, props.keyExtractor);

    const resolveHeldIntentIndex = React.useCallback((intent: Extract<LegendHeldScrollIntent, { kind: 'index' }>): number => {
        const currentIndex = data.findIndex((item, index) => (
            keyExtractorRef.current(item, toSourceIndex(index, dataLength, projectChronologicalIndex)) === intent.key
        ));
        return currentIndex >= 0 ? currentIndex : intent.fallbackIndex;
    }, [data, dataLength, projectChronologicalIndex]);

    const resolveAnchorHoldDataIndex = React.useCallback((itemId: string): number => {
        return data.findIndex((item, index) => (
            keyExtractorRef.current(item, toSourceIndex(index, dataLength, projectChronologicalIndex)) === itemId
        ));
    }, [data, dataLength, projectChronologicalIndex]);

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
        // truncated DOM is already physically at *that DOM's* bottom. scrollHeight therefore
        // cannot prove held-end settlement until the actual final data index is materialized.
        // Target the tail through Legend once; after it mounts, Legend's maintain-at-end
        // lifecycle owns final alignment. This is not an offscreen keep-alive and does not
        // widen the virtualization window for detached readers.
        //
        // COMMANDED BY INTENT, NOT BY A FROZEN INDEX, AND KEYED TO THE DATASET IDENTITY.
        // The previous form was keyed `${dataLength}:${keyExtractor(tail)}` and issued
        // `scrollToIndex({ index: dataLength - 1 })`. Both halves failed on a multi-wave
        // open (measured live on web, session cms4aenky5lnktm72sfmya6uk, cold route load,
        // reproduced twice: 16 scrollToIndex commands per open, 8 of them landing at
        // scrollTop 0 while maxScroll was ~1936):
        //   - `dataLength` in the key RE-ARMED the "one materialization EVER" guard the
        //     comment above claims on every hydration wave (324 -> 2291 -> 2253 -> 12241px);
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
        const materializationKey = props.dataKey;
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
    }, [dataLength, isWebFrame, props.dataKey]);

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
    }, [readWebScrollMetrics, resolveAnchorHoldDataIndex, resolveHeldIntentIndex]);

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
    }, [isWebFrame, resolveHeldIntentIndex]);

    const writeHeldIntentResidual = React.useCallback((
        intent: LegendHeldScrollIntent,
        landing: LegendHeldIntentLanding,
    ): boolean => {
        const correctionResidual = landing.basis === 'native-physical'
            ? landing.rawResidual ?? landing.residual
            : landing.residual;
        if (Math.abs(correctionResidual) < LEGEND_HELD_INTENT_ALIGNMENT_EPSILON_PX) return false;
        const previous = lastHeldIntentCorrectionRef.current;
        if (previous?.intent === intent) {
            const targetUnchanged = previous.targetOffset === landing.targetOffset;
            if (landing.basis === 'web-dom' && typeof previous.landedOffset === 'number') {
                // Web idempotence is landed-aware: if the scroller still sits where OUR last
                // write landed (possibly clamped), re-writing is a no-op loop - skip. If an
                // external writer (Legend offset replay, browser scroll anchoring) moved it
                // away from our landed offset, that is new evidence and the held keyed target
                // must re-correct.
                if (targetUnchanged && landing.currentOffset === previous.landedOffset) return false;
            } else if (
                landing.basis !== 'native-physical'
                && previous.currentOffset === landing.currentOffset
                // ONE TAIL WRITE PER OBSERVED MOVEMENT — the native twin of the landed-offset
                // guard above. A native write has no synchronously readable landing, so the
                // only evidence that our previous correction reached the scroller is
                // `state.scroll` moving off the offset we corrected FROM. Until it does, the
                // transaction is reading its own un-applied write.
                //
                // For a held-'end' transaction a MOVED TARGET is not independent evidence: the
                // target IS the tail, and the write already in flight already commands the
                // tail. Legend advances `state.scroll` optimistically inside `requestAdjust`
                // and then discards the reconciling native scroll observations
                // (`ignoreScrollFromMVCP`, cleared by a 100ms timeout a stalled JS thread
                // cannot run), so through a content mutation the offset stands still while
                // `contentLength` walks the tail a few px per commit — and target equality,
                // the only guard here before, never fires. Measured on the send crossover
                // (UNIT M, 2026-08-01, S11): scrollToOffset(101360.5) then
                // scrollToOffset(101352.5) 79ms later, both spent on state.scroll 101142.666,
                // one of three writers issuing eleven writes in 3.4s for one send.
                //
                // A KEYED hold keeps target-equality semantics: its destination is a row
                // identity whose measured position genuinely relocates (expansion cascade,
                // late row measurement), and that relocation is new evidence even while our
                // own write is unobserved.
                //
                // This is a precondition on evidence, never a delay or suppression window:
                // nothing is scheduled, and the first settle frame in which the scroller has
                // actually moved corrects the remainder against the geometry it then reports.
                && (targetUnchanged || intent.kind === 'end')
            ) {
                return false;
            }
        }
        let landedOffset: number | null = null;
        pendingViewportCauseRef.current = 'command';
        if (landing.basis === 'web-dom' && webScrollableElementRef.current) {
            const write = props.webDomObservation.recordProgrammaticScrollTopWrite({
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
            lastLandingObservationRef.current = {
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
    }, [isWebFrame, props.webDomObservation, resolveHeldIntentIndex]);
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
            const previousObservation = lastLandingObservationRef.current;
            // NATIVE HELD-'END' JOINS THE SAME PRECONDITION (Rank 2, 2026-08-02). Web never
            // reaches this evaluation for an 'end' intent — `verifyLanding` hands the tail to
            // Legend's maintain-at-end lifecycle unconditionally — so the guard above was
            // web-keyed by accident of reachability, not by design. On native the SAME branch is
            // reachable the moment an MVCP excursion pushes `isWithinMaintainScrollAtEndThreshold`
            // false, and BOTH numbers this transaction reads are mid-transaction there:
            // `currentOffset` is `state.scroll`, which Legend advances optimistically inside
            // `requestAdjust` and then declines to reconcile while `ignoreScrollFromMVCP` is
            // armed, and `maxOffset` is `contentLength - scrollLength`, which walks every commit.
            // Measured (UNIT M, 2026-08-01, send S11): the corrector wrote absolute offsets from
            // single in-motion reads while Legend's own compensation was mid-flight — three
            // writers, eleven writes, 3.4s, for one send.
            //
            // This closes the half of that hazard the one-write-per-observed-movement guard in
            // `writeHeldIntentResidual` cannot see: that guard only withholds while our own write
            // is UNOBSERVED (`currentOffset` unchanged). Through a crossover `state.scroll` is
            // swinging (M: -188.25 then +182.00 in two frames), so it reads as "observed
            // movement" on nearly every settle frame and authorizes a fresh absolute write each
            // time. The two rules compose: one write per observed movement, and none at all while
            // the geometry that movement is measured in is still moving.
            const isNativeTailLanding = !isWebFrame && intent.kind === 'end';
            const hasComparableScrollRange = (landing.basis === 'web-dom' || isNativeTailLanding)
                && typeof landing.maxOffset === 'number'
                && Number.isFinite(landing.maxOffset);
            if (hasComparableScrollRange) {
                lastLandingObservationRef.current = {
                    currentOffset: landing.currentOffset,
                    intent,
                    scrollRange: landing.maxOffset as number,
                };
            }
            const comparableObservation = hasComparableScrollRange
                && previousObservation != null
                && previousObservation.intent === intent
                ? previousObservation
                : null;
            // A transaction's FIRST read has nothing to disagree with; entry restore and every
            // fresh hold must still land promptly. Only an observed CHANGE withholds. That
            // exemption is deliberate and load-bearing on native too — nine live-captured
            // scenarios (session-open footer race, giant-row remeasure, far jump-to-bottom
            // repair, fling resume, clamp boundary) depend on the beyond-threshold fallback
            // landing on the read that first observes the gap.
            const geometryStableSinceLastRead = !hasComparableScrollRange
                || comparableObservation === null
                || (
                    comparableObservation.currentOffset === landing.currentOffset
                    && comparableObservation.scrollRange === landing.maxOffset
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
            // Every fresh measurement/layout/materialization signal opens one bounded active
            // polling window. Keyed identity outlives quiet polling so later evidence can
            // resume it, but never beyond the shared absolute identity deadline.
            heldIntentSettleUntilRef.current = intent.kind === 'end'
                ? nowMs + LEGEND_HELD_INTENT_SETTLE_MS
                : Math.min(intent.identityExpiresAtMs, nowMs + LEGEND_HELD_INTENT_SETTLE_MS);
            recordTranscriptHeldIntentLifecycle({
                ...readHeldIntentDiagnosticIdentity(intent),
                event: 'settle-request',
            });

            // Most settle signals arrive after their geometry commit and can verify
            // synchronously. Legend's item-size callback is different: 3.3.3 invokes it
            // before its position/MVCP recalculation, so that signal joins the already-owned
            // settle frame and reads only post-commit geometry.
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
    }, [cancelScheduledHeldIntentSettle, finishEntryPlacement, isUserScrollInputLive, isWebFrame, readHeldIntentLanding, requestNativePhysicalEntryLanding, requestWebHeldEndMaterialization, requestWebKeyedIdentityMaterialization, setHeldScrollIntent, writeHeldIntentResidual]);

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
        // upgrade in `be54fc371` brought the MVCP anchor lock. Native keeps its arm: its MVCP
        // is open-loop (it predicts `state.scroll` with no ground truth), and the same S-C
        // continuation committed +13k px there.
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
                key: props.keyExtractor(
                    targetItem,
                    toSourceIndex(legendIndex, dataLength, projectChronologicalIndex),
                ),
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
    }, [cancelScheduledHeldIntentSettle, data, dataLength, hasLiveKeyedHeldIntent, isWebFrame, projectChronologicalIndex, props.keyExtractor, setHeldScrollIntent]);

    // S-E route-pop desync (live native capture 2026-07-11): a scroll write issued while the
    // transcript screen was covered by a pushed route can fail to become native truth, and no
    // scroll event arrives on reveal — Legend keeps computing its mounted window for the
    // believed offset while the native view displays another, leaving a persistent blank
    // region that only the user's first swipe (the first real native event) healed. On
    // reveal, compare the transformed page positions of Legend's content and its Fabric
    // scroll host. Unlike measureLayout, `measure` includes the ScrollView content transform,
    // so hostPageY - contentPageY is the natively displayed offset. When it disagrees with
    // Legend state, replay it through Legend's own scroll command: the native write is a
    // no-op (the view is already there) and Legend re-runs its window calculation for the
    // offset the user is actually looking at.
    const revalidateViewportAfterReveal = React.useCallback(() => {
        if (isWebFrame) return;
        const legendRef = legendListRef.current;
        if (!legendRef) return;
        const scroller = legendRef.getNativeScrollRef?.() as unknown as Readonly<{
            getInnerViewRef?: () => unknown;
            getNativeScrollRef?: () => unknown;
        }> | null | undefined;
        const innerRef = scroller?.getInnerViewRef?.() as Readonly<{
            measure?: (
                onSuccess: (
                    x: number,
                    y: number,
                    width: number,
                    height: number,
                    pageX: number,
                    pageY: number,
                ) => void,
            ) => void;
        }> | null | undefined;
        const scrollHost = scroller?.getNativeScrollRef?.() as Readonly<{
            measure?: (
                onSuccess: (
                    x: number,
                    y: number,
                    width: number,
                    height: number,
                    pageX: number,
                    pageY: number,
                ) => void,
            ) => void;
        }> | null | undefined;
        if (
            typeof innerRef?.measure !== 'function'
            || typeof scrollHost?.measure !== 'function'
        ) {
            return;
        }
        const generation = {};
        viewportRevealMeasurementGenerationRef.current = generation;
        let contentPageY: number | null = null;
        let hostPageY: number | null = null;
        const finishMeasurement = (): void => {
            const currentScroller = legendListRef.current?.getNativeScrollRef?.() as unknown as Readonly<{
                getInnerViewRef?: () => unknown;
                getNativeScrollRef?: () => unknown;
            }> | null | undefined;
            if (
                viewportRevealMeasurementGenerationRef.current !== generation
                || legendListRef.current !== legendRef
                || currentScroller?.getInnerViewRef?.() !== innerRef
                || currentScroller?.getNativeScrollRef?.() !== scrollHost
                || contentPageY == null
                || hostPageY == null
            ) {
                return;
            }
            viewportRevealMeasurementGenerationRef.current = null;
            const displayedOffset = hostPageY - contentPageY;
            if (!Number.isFinite(displayedOffset)) return;
            const state = legendListRef.current?.getState();
            const believedOffset = state?.scroll;
            if (typeof believedOffset !== 'number' || !Number.isFinite(believedOffset)) return;
            if (Math.abs(displayedOffset - believedOffset) < 1) return;
            pendingViewportCauseRef.current = 'layout';
            settleLegendScroll(legendListRef.current?.scrollToOffset({
                animated: false,
                offset: Math.max(0, displayedOffset),
            }));
            // A live held intent re-verifies against the re-observed geometry instead of
            // treating the replayed offset as an external rollback.
            requestHeldIntentSettle();
        };
        innerRef.measure((_x, _y, _width, _height, _pageX, pageY) => {
            contentPageY = pageY;
            finishMeasurement();
        });
        scrollHost.measure((_x, _y, _width, _height, _pageX, pageY) => {
            hostPageY = pageY;
            finishMeasurement();
        });
    }, [isWebFrame, requestHeldIntentSettle]);

    const scrollRendererToEnd = React.useCallback((params?: { animated?: boolean }) => {
        invalidateUserInertiaContinuation();
        suppressAutoEndLatchRef.current = false;
        pendingViewportCauseRef.current = 'command';
        setHeldScrollIntent({ kind: 'end' });
        heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
        lastHeldIntentCorrectionRef.current = null;
        pendingWebTailMaterializationKeyRef.current = null;
        cancelScheduledHeldIntentSettle();
        // This is the ONLY tail write that can arrive animated. Steady end-maintenance is
        // Legend-owned and pinned to `animated: false`, and every corrective pin-bottom
        // reaches this owner unanimated (the drivers pass `command.animated ?? false`; only
        // the discrete `jump-to-bottom` command resolves to `animated: true`). So honoring the
        // OS reduced-motion preference here makes exactly the discrete, user-initiated
        // transition instant and cannot turn a correction into motion.
        settleLegendScroll(legendListRef.current?.scrollToEnd(
            params?.animated === true && reduceMotionRef.current
                ? { ...params, animated: false }
                : params,
        ));
    }, [cancelScheduledHeldIntentSettle, invalidateUserInertiaContinuation, setHeldScrollIntent]);

    const latchHeldEndIntent = React.useCallback(() => {
        setHeldScrollIntent({ kind: 'end' });
        heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
        lastHeldIntentCorrectionRef.current = null;
        pendingLargeResidualConfirmationRef.current = null;
        cancelScheduledHeldIntentSettle();
        requestHeldIntentSettle();
    }, [cancelScheduledHeldIntentSettle, requestHeldIntentSettle, setHeldScrollIntent]);

    const affirmWebHeldEndFromTowardEndInput = React.useCallback((): boolean => {
        if (!isWebFrame) return false;
        const heldIntent = heldScrollIntentRef.current;
        // A keyed hold remains the explicit owner and keeps its existing takeover behavior.
        if (heldIntent !== null && heldIntent.kind !== 'end') return false;
        const metrics = readWebScrollMetrics();
        if (
            !metrics
            || resolveLegendRendererAtEndStateFromWebMetrics({
                metrics,
                maintainScrollAtEndThreshold:
                    props.frame.rendererOptions.continuousFollow.endThresholdRatio,
            }).isAtEnd !== true
        ) {
            return false;
        }
        if (heldIntent?.kind === 'end') return true;
        // At the bottom clamp no scroll event can carry a movement fact. Direct toward-end
        // input plus current exact DOM geometry is the canonical acquisition boundary for
        // this otherwise unobservable case. Cached Legend state is not authority here.
        suppressAutoEndLatchRef.current = false;
        latchHeldEndIntent();
        return true;
    }, [
        isWebFrame,
        latchHeldEndIntent,
        props.frame.rendererOptions.continuousFollow.endThresholdRatio,
        readWebScrollMetrics,
    ]);

    React.useEffect(() => () => {
        cancelScheduledHeldIntentSettle();
        invalidateNativePhysicalViewportCapture();
    }, [cancelScheduledHeldIntentSettle, invalidateNativePhysicalViewportCapture]);

    const recordViewportHeight = React.useCallback((nextHeight: number) => {
        const previousHeight = lastViewportHeightRef.current;
        lastViewportHeightRef.current = nextHeight;
        if (previousHeight === null || Math.abs(previousHeight - nextHeight) < 1) return;
        advanceMovementEpoch();
        requestHeldIntentSettle();
    }, [advanceMovementEpoch, requestHeldIntentSettle]);

    const recordVisualBottomSlotHeight = React.useCallback((nextHeight: number) => {
        const previousHeight = lastVisualBottomSlotHeightRef.current;
        lastVisualBottomSlotHeightRef.current = nextHeight;
        if (previousHeight === null || Math.abs(previousHeight - nextHeight) < 1) return;
        advanceMovementEpoch();
        requestHeldIntentSettle();
    }, [advanceMovementEpoch, requestHeldIntentSettle]);

    const handleLegendLayout = React.useCallback((event: LayoutChangeEvent) => {
        invalidateNativePhysicalViewportCapture();
        props.onLayout?.(event);
        recordViewportHeight(event.nativeEvent.layout.height);
    }, [invalidateNativePhysicalViewportCapture, props.onLayout, recordViewportHeight]);

    const handleVisualBottomSlotLayout = React.useCallback((event: LayoutChangeEvent) => {
        recordVisualBottomSlotHeight(event.nativeEvent.layout.height);
    }, [recordVisualBottomSlotHeight]);

    React.useEffect(() => {
        if (!isWebFrame) return undefined;
        const ResizeObserverCtor = globalThis.ResizeObserver;
        if (typeof ResizeObserverCtor !== 'function') return undefined;
        const nativeID = props.frame.rendererOptions.identity.nativeID;
        const identityHost = (
            typeof document !== 'undefined' && nativeID
                ? document.getElementById(nativeID)
                : null
        ) ?? identityHostRef.current as unknown as Element | null;
        const visualBottomSlotHost = visualBottomSlotHostRef.current as unknown as Element | null;
        if (!identityHost && !visualBottomSlotHost) return undefined;
        const observer = new ResizeObserverCtor((entries) => {
            for (const entry of entries) {
                if (entry.target === identityHost) {
                    recordViewportHeight(entry.contentRect.height);
                }
                if (entry.target === visualBottomSlotHost) {
                    recordVisualBottomSlotHeight(entry.contentRect.height);
                }
            }
            emitRendererAtEndState();
        });
        if (identityHost) observer.observe(identityHost);
        if (visualBottomSlotHost) observer.observe(visualBottomSlotHost);
        return () => observer.disconnect();
    }, [emitRendererAtEndState, isWebFrame, props.frame.rendererOptions.identity.nativeID, recordViewportHeight, recordVisualBottomSlotHeight]);

    const handleLegendScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        invalidateNativePhysicalViewportCapture();
        const cause = pendingViewportCauseRef.current;
        const state = readRendererAtEndState();
        const webScroll = webScrollableElementRef.current?.scrollTop;
        const nextScrollOffset = isWebFrame && typeof webScroll === 'number' && Number.isFinite(webScroll)
            ? webScroll
            : event.nativeEvent.contentOffset.y;
        // Opt-in diagnostics sample (no-op unless the operator opened the channel). Native
        // has no DOM scroller to intercept, so this observed offset is its only record of
        // viewport movement.
        recordTranscriptScrollSample({
            cause: cause ?? null,
            offset: nextScrollOffset,
            platform: isWebFrame ? 'web' : 'native',
        });
        const webMovementFact: WebScrollMovementFact | undefined = (() => {
            if (!isWebFrame) return undefined;
            const metrics = readWebScrollMetrics();
            if (!metrics) {
                return {
                    atEndPublicationCause: cause === 'command' ? 'command' : 'layout',
                    direction: null,
                    downwardIntent: false,
                    isGenuineUserMovement: false,
                    movedSinceLastObservation: false,
                    upwardIntent: false,
                };
            }
            return props.webDomObservation.observeGenuineScrollMovement({
                distanceFromBottom: Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop),
                fallbackObservedScrollTop: heldScrollIntentRef.current?.kind === 'end'
                    ? Math.max(0, metrics.scrollHeight - metrics.clientHeight)
                    : null,
                isTrusted: (event.nativeEvent as NativeScrollEvent & { isTrusted?: boolean }).isTrusted === true,
                metrics,
                pinThresholdPx:
                    metrics.clientHeight * props.frame.rendererOptions.continuousFollow.endThresholdRatio,
                semanticContext: {
                    atEndNonUserCause: cause === 'command' ? 'command' : 'layout',
                    // Per-frame ATTRIBUTION takes the unrevocable physical fact only (an open
                    // drag/momentum phase). The bounded post-input continuation is owned below by
                    // `pendingUserInput`, which a committed geometry/command boundary revokes —
                    // attribution must stay revocable, liveness must not.
                    isUserInputActive: userScrollIntent.isGestureActive(),
                    nowMs: Date.now(),
                },
                sustainFrames: 2,
            });
        })();
        const previousNativeScrollOffset = isWebFrame ? null : lastObservedScrollOffsetRef.current;
        if (!isWebFrame) lastObservedScrollOffsetRef.current = nextScrollOffset;
        const nativeMovementDirection: 1 | -1 | null =
            previousNativeScrollOffset === null || nextScrollOffset === previousNativeScrollOffset
                ? null
                : nextScrollOffset > previousNativeScrollOffset ? 1 : -1;
        const lastClassifiedNative = lastClassifiedNativeUserScrollRef.current;
        const isNativeUserInertiaContinuation = !isWebFrame
            && cause !== 'user'
            && cause !== 'command'
            && nativeMovementDirection !== null
            && lastClassifiedNative !== null
            && lastClassifiedNative.epoch === nativeMovementEpochRef.current
            && lastClassifiedNative.direction === nativeMovementDirection
            && Date.now() - lastClassifiedNative.atMs <= LEGEND_USER_SCROLL_INERTIA_CONTINUATION_MS
            && lastHeldIntentCorrectionRef.current === null;
        const isNativeClassifiedUserMovement = !isWebFrame
            && (
                (cause === 'user' && nativeMovementDirection !== null)
                || isNativeUserInertiaContinuation
            );
        if (isNativeClassifiedUserMovement && nativeMovementDirection !== null) {
            lastClassifiedNativeUserScrollRef.current = {
                atMs: Date.now(),
                direction: nativeMovementDirection,
                epoch: nativeMovementEpochRef.current,
            };
        }
        const movementDirection = webMovementFact?.direction ?? nativeMovementDirection;
        const isClassifiedUserMovement =
            webMovementFact?.isGenuineUserMovement ?? isNativeClassifiedUserMovement;
        const offsetMoved =
            webMovementFact?.movedSinceLastObservation
            ?? (
                previousNativeScrollOffset !== null
                && Math.abs(previousNativeScrollOffset - nextScrollOffset) >= 1
            );
        if (offsetMoved && isClassifiedUserMovement) {
            // Only genuine USER movement clears the inherited auto-latch suppression
            // guard. Passive web acquisition is independently excluded above; keeping
            // this transition user-owned preserves the remaining native quiet-end latch
            // without granting programmatic jump/prepend/restore movement user authority.
            suppressAutoEndLatchRef.current = false;
        }
        // The settle window covers programmatic held-tail writes on BOTH platforms: their own
        // scroll events must not be classified as user detachment while the transaction runs.
        const heldIntentSettleInFlight = Date.now() <= heldIntentSettleUntilRef.current;
        const movedAwayFromTail = offsetMoved
            && state
            && !state.isAtEnd
            && !state.isNearEnd
            && !state.isWithinMaintainScrollAtEndThreshold;
        const webUserMovedAwayFromTail =
            movedAwayFromTail
            && isWebFrame
            && isClassifiedUserMovement;
        // Does live user input EXPLAIN this movement? Liveness alone is not enough: at the top
        // clamp an upward wheel produces no movement while estimate churn pushes the offset DOWN,
        // and treating that as the reader's abandons the anchor they are reading (live S-D). So it
        // takes an open drag/momentum phase (a thumb drag has no direction until it moves) or raw
        // input asking for THIS direction. When it does hold, it outranks classification for the
        // release decision on every platform: a frame the movement classifier could not attribute
        // is still the reader's while their gesture is live, and re-asserting a hold there is the
        // corrector fighting live input — the mechanism behind the late (>1s post-gesture)
        // unbounded-magnitude write measured on 2026-07-30.
        const userScrollInputExplainsMovement =
            userScrollIntent.isLive(Date.now())
            && (
                userScrollIntent.isGestureActive()
                || (movementDirection !== null && userScrollIntent.lastInputDirection() === movementDirection)
            );
        // READER TAKEOVER ENDS A PLACEMENT MANDATE — and it is a lifecycle fact of the hold,
        // not a side effect of the wheel/keyboard/touch handlers. A driver-armed placement hold
        // (jump landing, `restore-anchor`, entry restore) writes an ABSOLUTE target for its
        // full 10s identity window, and `finishHeldIntentSettle` clears only `entry-restore`
        // (`readEntryPlacementItemId`), so a jump hold is released today purely as a byproduct
        // of an input handler firing — or of `movedAwayFromTail`, which is false for a jump
        // that landed inside the tail thresholds. A web scrollbar-band drag records intent and
        // never calls a release handler at all, so it fell through both (A1 §2, 2026-08-06).
        // The driver named where the row must sit for as long as the READER had not moved it;
        // once they have, the mandate is void and Legend's `maintainVisibleContentPosition`
        // keeps them where they stopped.
        const readerTookOverPlacementHold =
            isWebFrame
            && offsetMoved
            && (isClassifiedUserMovement || userScrollInputExplainsMovement)
            && hasLiveKeyedHeldIntent()
            && isPlacementHeldIntent(heldScrollIntentRef.current);
        if (webUserMovedAwayFromTail || readerTookOverPlacementHold) {
            releaseHeldScrollIntent();
        }
        const keyedLandingDisplacedByRenderer = isWebFrame
            && offsetMoved
            && !isClassifiedUserMovement
            && !userScrollInputExplainsMovement
            && hasLiveKeyedHeldIntent();
        if (movedAwayFromTail && !webUserMovedAwayFromTail && userScrollInputExplainsMovement) {
            // Web could NEVER reach a release branch before this (`!isWebFrame &&` guarded the
            // only one), so every unattributed frame re-asserted the hold and re-opened the
            // 1500ms settle window. Web now has a better liveness fact than native had when that
            // fork was written, so both platforms release from the same fact.
            releaseHeldScrollIntent();
        } else if (keyedLandingDisplacedByRenderer) {
            // A keyed target can be displaced to the physical end of a target-window slice
            // after its active settle cadence goes quiet. In that state the tail-derived facts
            // below are all true, so "moved away from tail" cannot wake the still-live keyed
            // owner even though DOM truth reports a residual. Legend's own non-user scroll is
            // fresh displacement evidence: resume the existing bounded transaction from it.
            requestHeldIntentSettle();
        } else if (!webUserMovedAwayFromTail && movedAwayFromTail && heldIntentSettleInFlight) {
            // Chromium can emit one final scroll-anchor correction after both the layout
            // notification and the scheduled frame retry. That correction is not a user
            // detach: the interaction wrappers below cancel the held intent first for a
            // real wheel/drag. Reassert from the same renderer-owned tail target.
            requestHeldIntentSettle();
        } else if (
            !webUserMovedAwayFromTail
            && movedAwayFromTail
            && !heldIntentSettleInFlight
        ) {
            // Live input already released above. What remains is STALE evidence, and only native
            // keeps a loose window for it: it has no per-frame movement fact, so a fling whose
            // momentum phase RN never reported still has to count as the reader's. Web has the
            // movement fact plus the liveness fact and needs no stale fallback.
            if (
                !isWebFrame
                && Date.now() - userScrollIntent.lastInputAtMs() <= LEGEND_USER_INPUT_DETACH_WINDOW_MS
            ) {
                releaseHeldScrollIntent();
            } else {
                // This is an external offset rollback (Legend's internal maintain/adjust
                // path replaying a stale basis), not a user detach. Releasing here is
                // symptom 3's terminal mechanism - the held tail must be re-asserted.
                requestHeldIntentSettle();
            }
        } else if (
            offsetMoved
            && isClassifiedUserMovement
            && movementDirection === 1
            && state?.isWithinMaintainScrollAtEndThreshold === true
            && heldScrollIntentRef.current?.kind !== 'end'
        ) {
            // A semantically classified USER movement (direct input or its bounded inertia
            // continuation) landing bottomward inside the maintain threshold
            // is a genuine return to the live tail and must re-latch the durable held
            // 'end' intent HERE, REPLACING any keyed reading-anchor hold (the detached
            // branch above re-arms one on this very event, so a keyed-hold guard would
            // make this unreachable — live report 2026-07-22: the surviving anchor hold
            // restored the old position while growth pinned the tail, a two-owner fight
            // that dropped follow a few lines after re-pinning and jiggled the viewport).
            // Passive web at-end observations cannot own this arrival. This canonical
            // downward fact does; upward movement inside the threshold stays a detach
            // start and never latches. Mirrors the jump-to-bottom replacement (scrollToEnd).
            latchHeldEndIntent();
        }
        emitRendererAtEndState({ offsetMoved, pendingCause: cause, webMovementFact });
        if (webMovementFact) {
            props.onScroll?.(event, webMovementFact);
        } else {
            props.onScroll?.(event);
        }
        if (pendingViewportCauseRef.current === cause) pendingViewportCauseRef.current = 'layout';
    }, [emitRendererAtEndState, hasLiveKeyedHeldIntent, invalidateNativePhysicalViewportCapture, isWebFrame, latchHeldEndIntent, props.frame.rendererOptions.continuousFollow.endThresholdRatio, props.onScroll, props.onStartReachedThreshold, props.webDomObservation, readRendererAtEndState, readWebScrollMetrics, releaseHeldScrollIntent, requestHeldIntentSettle, userScrollIntent]);

    const handleLegendWheel = React.useCallback((event: unknown) => {
        invalidateNativePhysicalViewportCapture();
        lastUserInteractionAtMsRef.current = Date.now();
        if (!isWebFrame) userScrollIntent.recordInput({ atMs: Date.now() });
        if (isWebFrame) {
            pendingViewportCauseRef.current = 'user';
            // A bottomward wheel while holding the tail is follow-affirming input, not a
            // detach. At the bottom clamp it produces NO scroll event and NO at-end state
            // change, so a release here would leave the tail permanently unowned (nothing
            // re-latches) and the next giant streaming commit would exceed Legend's maintain
            // threshold with no corrector (live S-K, 2026-07-11). Upward wheels and wheels
            // over a keyed hold release exactly as before.
            const deltaY = readWheelDeltaY(event);
            const wheelDirection: -1 | 1 | null =
                typeof deltaY !== 'number' || deltaY === 0 ? null : deltaY > 0 ? 1 : -1;
            userScrollIntent.recordInput({ atMs: Date.now(), direction: wheelDirection });
            props.webDomObservation.recordUserScrollInput({
                direction: wheelDirection,
                nowMs: Date.now(),
            });
            const followAffirming =
                typeof deltaY === 'number'
                && deltaY > 0
                && affirmWebHeldEndFromTowardEndInput();
            if (!followAffirming) {
                cancelLegendInitialScrollPreservation();
                releaseHeldScrollIntent();
            }
        }
        props.platformInteractionProps?.onWheel?.(event);
    }, [affirmWebHeldEndFromTowardEndInput, cancelLegendInitialScrollPreservation, invalidateNativePhysicalViewportCapture, isWebFrame, props.platformInteractionProps, props.webDomObservation, releaseHeldScrollIntent, userScrollIntent]);

    const handleLegendScrollBeginDrag = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        invalidateNativePhysicalViewportCapture();
        lastUserInteractionAtMsRef.current = Date.now();
        pendingViewportCauseRef.current = 'user';
        userScrollIntent.setGestureActive({ active: true, atMs: Date.now(), gesture: 'drag' });
        if (isWebFrame) {
            props.webDomObservation.recordUserScrollInput({
                direction: null,
                nowMs: Date.now(),
            });
        }
        if (!isWebFrame) {
            // A genuine native drag is the analog of the web wheel release: it overrides
            // any held-tail intent and cancels the in-flight settle window so the user's drag
            // detaches normally. Ending the drag at the tail re-latches through the next
            // at-end observation.
            cancelLegendInitialScrollPreservation();
            releaseHeldScrollIntent();
        }
        props.onScrollBeginDrag?.(event);
    }, [cancelLegendInitialScrollPreservation, invalidateNativePhysicalViewportCapture, isWebFrame, props.onScrollBeginDrag, props.webDomObservation, releaseHeldScrollIntent, userScrollIntent]);

    const handleLegendScrollEndDrag = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (userScrollIntent.isGestureActive()) {
            lastDragEndAtMsRef.current = Date.now();
            lastUserInteractionAtMsRef.current = Date.now();
            userScrollIntent.setGestureActive({ active: false, atMs: Date.now(), gesture: 'drag' });
        }
        props.onScrollEndDrag?.(event);
    }, [props.onScrollEndDrag, userScrollIntent]);

    const handleLegendMomentumScrollBegin = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const nowMs = Date.now();
        if (
            nowMs - lastDragEndAtMsRef.current <= LEGEND_USER_MOMENTUM_CHAIN_WINDOW_MS
            || nowMs - lastUserMomentumEndAtMsRef.current <= LEGEND_USER_MOMENTUM_CHAIN_WINDOW_MS
        ) {
            userScrollIntent.setGestureActive({ active: true, atMs: nowMs, gesture: 'momentum' });
        }
        props.onMomentumScrollBegin?.(event);
    }, [props.onMomentumScrollBegin, userScrollIntent]);

    const handleLegendMomentumScrollEnd = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (userScrollIntent.isGestureActive()) {
            lastUserMomentumEndAtMsRef.current = Date.now();
            lastUserInteractionAtMsRef.current = Date.now();
            userScrollIntent.setGestureActive({ active: false, atMs: Date.now(), gesture: 'momentum' });
        }
        props.onMomentumScrollEnd?.(event);
    }, [props.onMomentumScrollEnd, userScrollIntent]);

    const handleLegendTouchStart = React.useCallback((event: unknown) => {
        if (isWebFrame) {
            webTouchVerticalCoordinateRef.current = readTouchVerticalCoordinate(event);
        } else {
            lastUserInteractionAtMsRef.current = Date.now();
        }
        props.platformInteractionProps?.onTouchStart?.(event);
    }, [isWebFrame, props.platformInteractionProps]);

    React.useLayoutEffect(() => {
        emitRendererAtEndState();
        const state = legendListRef.current?.getState();
        if (!state || typeof state.listen !== 'function') return undefined;
        const unlisten = [
            state.listen('isAtEnd', () => emitRendererAtEndState({ pendingCause: pendingViewportCauseRef.current })),
            state.listen('isNearEnd', () => emitRendererAtEndState({ pendingCause: pendingViewportCauseRef.current })),
            state.listen('isWithinMaintainScrollAtEndThreshold', () => emitRendererAtEndState({ pendingCause: pendingViewportCauseRef.current })),
        ];
        return () => {
            for (const dispose of unlisten) dispose();
        };
    }, [
        emitRendererAtEndState,
        props.onRendererAtEndChange,
    ]);

    const notifyViewportInput = React.useCallback((input: TranscriptViewportInputEvidence) => {
        invalidateNativePhysicalViewportCapture();
        lastUserInteractionAtMsRef.current = Date.now();
        pendingViewportCauseRef.current = 'user';
        const verticalDirection =
            input.kind === 'keyboard' || input.kind === 'touch'
                ? input.verticalDirection
                : undefined;
        const inputDirection: -1 | 1 | null =
            verticalDirection === 'toward-end'
                ? 1
                : verticalDirection === 'toward-start' ? -1 : null;
        userScrollIntent.recordInput({ atMs: Date.now(), direction: inputDirection });
        if (isWebFrame) {
            props.webDomObservation.recordUserScrollInput({
                direction: inputDirection,
                nowMs: Date.now(),
            });
        }
        const isTowardEndInput =
            (input.kind === 'keyboard' || input.kind === 'touch')
            && input.verticalDirection === 'toward-end';
        const followAffirmingHeldEndInput =
            isTowardEndInput
            && (
                isWebFrame
                    ? affirmWebHeldEndFromTowardEndInput()
                    : heldScrollIntentRef.current?.kind === 'end'
            );
        if (!followAffirmingHeldEndInput) {
            cancelLegendInitialScrollPreservation();
            releaseHeldScrollIntent();
        }
    }, [affirmWebHeldEndFromTowardEndInput, cancelLegendInitialScrollPreservation, invalidateNativePhysicalViewportCapture, isWebFrame, props.webDomObservation, releaseHeldScrollIntent, userScrollIntent]);
    const handleLegendTouchMove = React.useCallback((event: unknown) => {
        const previousCoordinate = webTouchVerticalCoordinateRef.current;
        const currentCoordinate = readTouchVerticalCoordinate(event);
        if (currentCoordinate) {
            webTouchVerticalCoordinateRef.current = currentCoordinate;
        }
        const verticalDirection = previousCoordinate
            && currentCoordinate
            && previousCoordinate.axis === currentCoordinate.axis
            && previousCoordinate.value !== currentCoordinate.value
            ? currentCoordinate.value < previousCoordinate.value
                ? 'toward-end'
                : 'toward-start'
            : undefined;
        notifyViewportInput({ kind: 'touch', verticalDirection });
        props.platformInteractionProps?.onTouchMove?.(event);
    }, [notifyViewportInput, props.platformInteractionProps]);

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
        releaseHeldScrollIntent('superseded');
        // Releasing held-end ownership schedules the phase render. Other prior intents already
        // keep maintenance disabled, but publish the explicit takeover phase synchronously.
        if (!hadHeldEndOwnership) renderPositioningPhase();
        return releaseOperation;
    }, [cancelLegendInitialScrollPreservation, invalidateUserInertiaContinuation, releaseHeldScrollIntent]);

    /**
     * Legend answers its mounted window from list state. Before that state exists
     * there is NO measurement — reporting `{0,0}` here would be indistinguishable
     * from the reader genuinely sitting on the first row, which drags the
     * navigation anchor to the top of the transcript for a frame.
     */
    const readVisibleSourceIndexRange = React.useCallback((): TranscriptRendererVisibleSourceIndexRange | null => {
        const state = legendListRef.current?.getState();
        if (!state) return null;
        // `start`/`end` are Legend's NO-BUFFER window, and it sets them to null
        // whenever its last calculation found no row intersecting the viewport —
        // the viewport parked in an allocation gap or past the measured content
        // end, which is what a target-window replace can leave behind. That is a
        // measured answer, not an unmeasured frame, and nothing recomputes it
        // without a further scroll/data/size event: treating it as "no
        // measurement" froze navigation on the pre-jump anchor with rows still
        // mounted. The buffered band comes from the same calculation and is the
        // nearest rendered content, so it answers for those frames.
        //
        // Bound: this covers Legend's cached-range recalculation, which rewrites
        // only the no-buffer window and leaves the band intact. Its FULL
        // recalculation rewrites both, and only assigns `endBuffered` once it has
        // found a no-buffer start — so a viewport intersecting no row there leaves
        // no band either and this still reports unmeasured. Verified against the
        // installed @legendapp/list 3.3.3; no live capture attributes the reported
        // incident to that state, so it is deliberately NOT answered by a guessed
        // range here.
        const start = Number.isFinite(state.start) ? state.start : state.startBuffered;
        const end = Number.isFinite(state.end) ? state.end : state.endBuffered;
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        const startIndex = toSourceIndex(start, dataLength, projectChronologicalIndex);
        const endIndex = toSourceIndex(end, dataLength, projectChronologicalIndex);
        return {
            startIndex: Math.min(startIndex, endIndex),
            endIndex: Math.max(startIndex, endIndex),
        };
    }, [dataLength, projectChronologicalIndex]);

    React.useImperativeHandle(ref, (): TranscriptListShellRef<TItem> => ({
        transcriptViewportCommandSpace: 'standard',
        clearLayoutCacheOnUpdate: () => {
            // Intentional no-op. The app-side structural invalidation (expand/collapse ->
            // 'clear-layout-cache') is the FlashList-era whole-list re-stack; Legend's own
            // per-item measurement pipeline (onItemSizeChanged) absorbs row re-flow. Clearing
            // Legend's size caches here rebuilt the entire list from the 240px estimate on
            // EVERY tool toggle: the offset clamped to 0 (spuriously firing top-edge
            // pagination), the coordinate space re-based, and the viewport parked hours from
            // the user's content (live native S-C root cause, 2026-07-11).
        },
        armVisibleAnchorHold,
        beginExplicitJumpTakeover,
        notifyViewportGeometryChanged: () => {
            advanceMovementEpoch();
            requestHeldIntentSettle();
        },
        observeNativePhysicalViewport,
        revalidateViewportAfterReveal,
        notifyViewportInput,
        computeVisibleIndices: () => readVisibleSourceIndexRange() ?? { startIndex: 0, endIndex: 0 },
        readVisibleSourceIndexRange,
        getAbsoluteLastScrollOffset: () => {
            return legendListRef.current?.getState().scroll ?? 0;
        },
        getFirstVisibleIndex: () => {
            const start = legendListRef.current?.getState().start ?? 0;
            return toSourceIndex(start, dataLength, projectChronologicalIndex);
        },
        getScrollableNode: () => (
            legendListRef.current?.getScrollableNode?.()
            ?? readWebScrollMetrics()?.element
            ?? null
        ),
        getLayout: (index) => {
            const state = legendListRef.current?.getState();
            const legendIndex = toLegendIndex(index, dataLength, projectChronologicalIndex);
            const y = state?.positionAtIndex?.(legendIndex);
            const height = state?.sizeAtIndex?.(legendIndex);
            if (typeof y !== 'number' || typeof height !== 'number') return undefined;
            if (!Number.isFinite(y) || !Number.isFinite(height)) return undefined;
            return { x: 0, y, width: 0, height };
        },
        holdWebEntryAnchor,
        hasActiveEntryPlacement: () => {
            const itemId = activeEntryPlacementItemIdRef.current;
            return itemId != null
                && finishedEntryPlacementItemIdRef.current !== itemId
                && readEntryPlacementItemId(heldScrollIntentRef.current) === itemId;
        },
        releaseWebHeldIntent: () => {
            invalidateUserInertiaContinuation();
            // Mark the explicit navigation takeover before releasing the tail owner.
            // Passive web observations are independently barred from reacquiring end;
            // genuine user movement or an explicit tail command clears this shared
            // lifecycle guard.
            suppressAutoEndLatchRef.current = true;
            releaseHeldScrollIntent();
        },
        hasLiveWebHold: (target) => {
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
            return target.itemId === undefined || held.anchor.itemId === target.itemId;
        },
        scrollToEnd: (params) => {
            invalidateNativePhysicalViewportCapture();
            scrollRendererToEnd(params);
        },
        scrollToIndex: (params) => {
            invalidateNativePhysicalViewportCapture();
            invalidateUserInertiaContinuation();
            const { context, ...legendParams } = params;
            const legendIndex = toLegendIndex(params.index, dataLength, projectChronologicalIndex);
            const targetItem = data[legendIndex];
            if (targetItem !== undefined) {
                setHeldScrollIntent({
                    ...(context?.kind === 'entry-placement'
                        ? { entryAnchor: context.anchor }
                        : {}),
                    identityExpiresAtMs: Date.now() + LEGEND_HELD_TARGET_IDENTITY_MS,
                    fallbackIndex: legendIndex,
                    key: props.keyExtractor(
                        targetItem,
                        toSourceIndex(legendIndex, dataLength, projectChronologicalIndex),
                    ),
                    kind: 'index',
                    viewOffset: legendParams.viewOffset ?? 0,
                    viewPosition: legendParams.viewPosition ?? 0,
                });
                if (context?.kind === 'entry-placement') {
                    // This semantic call IS the one bootstrap for the entry identity. Mark it
                    // consumed so size/layout callbacks cannot dispatch a second Legend
                    // materialization request while the same promise is pending.
                    completedKeyedIdentityMaterializationRef.current = true;
                }
                heldIntentSettleUntilRef.current = Date.now() + LEGEND_HELD_INTENT_SETTLE_MS;
                lastHeldIntentCorrectionRef.current = null;
                cancelScheduledHeldIntentSettle();
            }
            pendingViewportCauseRef.current = 'command';
            settleLegendScroll(legendListRef.current?.scrollToIndex({
                ...legendParams,
                index: legendIndex,
            }), requestHeldIntentSettle);
        },
        scrollToOffset: (params) => {
            invalidateNativePhysicalViewportCapture();
            invalidateUserInertiaContinuation();
            pendingViewportCauseRef.current = 'command';
            settleLegendScroll(legendListRef.current?.scrollToOffset(params));
        },
    }), [advanceMovementEpoch, armVisibleAnchorHold, beginExplicitJumpTakeover, cancelScheduledHeldIntentSettle, data, dataLength, holdWebEntryAnchor, invalidateNativePhysicalViewportCapture, invalidateUserInertiaContinuation, notifyViewportInput, observeNativePhysicalViewport, projectChronologicalIndex, props.keyExtractor, readVisibleSourceIndexRange, readWebScrollMetrics, releaseHeldScrollIntent, requestHeldIntentSettle, revalidateViewportAfterReveal, scrollRendererToEnd, setHeldScrollIntent]);

    const renderItem: LegendListProps<TItem>['renderItem'] = (info) => props.renderItem({
        item: info.item,
        index: toSourceIndex(info.index, dataLength, projectChronologicalIndex),
        separators: {
            highlight: () => undefined,
            unhighlight: () => undefined,
            updateProps: () => undefined,
        },
    });
    const handleLegendViewableItemsChanged: LegendListProps<TItem>['onViewableItemsChanged'] =
        props.onViewableItemsChanged
            ? (info) => props.onViewableItemsChanged?.({
                viewableItems: toSourceViewabilityTokens(
                    info.viewableItems,
                    props.data,
                    projectChronologicalIndex,
                ),
                changed: toSourceViewabilityTokens(
                    info.changed,
                    props.data,
                    projectChronologicalIndex,
                ),
            })
            : undefined;

    const handleLegendStartReached = React.useCallback(() => {
        // A live PLACEMENT hold keeps its identity through the prepend this trigger loads: a
        // reader dwelling at the top outlives the 10s identity window, and the prepend would
        // then land against an expired, unenforceable landing mandate (live report
        // 2026-07-23). Refreshing expiry adopts no geometry.
        //
        // The refresh REPLACES the intent object, and every corrector baseline keys on it by
        // reference, so it must never carry a stabilization hold: doing so turned the
        // misalignment the hold had already adopted back into a fresh residual and wrote the
        // reader backwards. There is no stabilization hold to carry any more — Legend's MVCP
        // owns the prepend (measured: a 600px prepend holds a detached reader's anchor within
        // 1px, `legendListRenderer.real.integration.test.tsx`).
        const held = heldScrollIntentRef.current;
        if (held !== null && held.kind !== 'end') {
            heldScrollIntentRef.current = { ...held, identityExpiresAtMs: Date.now() + LEGEND_HELD_TARGET_IDENTITY_MS };
        }
        props.onStartReached?.();
    }, [props.onStartReached]);

    const handleLegendItemSizeChanged = React.useCallback(() => {
        invalidateNativePhysicalViewportCapture();
        advanceMovementEpoch();
        emitSynthesizedContentSize();
        requestHeldIntentSettle({ deferFirstVerification: true });
    }, [advanceMovementEpoch, emitSynthesizedContentSize, invalidateNativePhysicalViewportCapture, requestHeldIntentSettle]);
    React.useLayoutEffect(() => {
        if (!hasCommittedHeldTailDataRevisionRef.current) {
            hasCommittedHeldTailDataRevisionRef.current = true;
            // The WebDom observation is mounted above keyed renderer/session shells on some
            // surfaces. A new renderer mount is therefore itself a logical movement epoch even
            // though there is no initial held target to settle.
            advanceMovementEpoch();
            return;
        }
        advanceMovementEpoch();
        requestHeldIntentSettle();
    }, [advanceMovementEpoch, heldTailDataRevision, props.data, props.dataKey, props.extraData, requestHeldIntentSettle]);
    const visualBottomSlot = toLegendSlot(projectChronologicalIndex ? props.header : props.footer);
    React.useLayoutEffect(() => {
        if (!hasCommittedVisualBottomSlotRef.current) {
            hasCommittedVisualBottomSlotRef.current = true;
            previousVisualBottomSlotRef.current = visualBottomSlot;
            return;
        }
        const changed = previousVisualBottomSlotRef.current !== visualBottomSlot;
        previousVisualBottomSlotRef.current = visualBottomSlot;
        if (changed) {
            advanceMovementEpoch();
            requestHeldIntentSettle();
        }
    }, [advanceMovementEpoch, requestHeldIntentSettle, visualBottomSlot]);
    const legendVisualBottomSlot = React.useMemo<LegendListProps<TItem>['ListFooterComponent']>(() => (
        visualBottomSlot ? (
            <View ref={visualBottomSlotHostRef} onLayout={handleVisualBottomSlotLayout}>
                {visualBottomSlot}
            </View>
        ) : null
    ), [handleVisualBottomSlotLayout, visualBottomSlot]);

    const recordUserInteraction = React.useCallback(() => {
        lastUserInteractionAtMsRef.current = Date.now();
    }, []);
    // A web scrollbar drag carries no wheel/keyboard/touch evidence — only a pointer
    // press on the scroller itself (content presses target a descendant) with its
    // offset inside the scrollbar band beyond the client box. Without classifying it,
    // the drag's scroll movement reads as an external rollback and the held tail
    // drags the user back to the bottom (live capture 2026-07-20).
    const isWebScrollbarBandPress = React.useCallback((event: unknown): boolean => {
        if (!isWebFrame) return false;
        const element = webScrollableElementRef.current;
        if (!element) return false;
        const candidate = (event as { nativeEvent?: unknown } | null)?.nativeEvent ?? event;
        const press = candidate as { offsetX?: unknown; offsetY?: unknown; target?: unknown } | null;
        if (!press || press.target !== element) return false;
        // "Beyond the client box" is only meaningful against a box that was MEASURED. An
        // unmeasured axis reads 0 (collapsed/hidden pane, pre-layout frame), and `offset >= 0`
        // is true for every press — which turned an ordinary press on the scroller into a
        // scrollbar drag: gesture active, user scroll input recorded, initial-scroll
        // preservation cancelled, and the corrector suppressed until pointerup.
        const isBeyondMeasuredExtent = (offset: unknown, contentExtent: number): boolean => (
            typeof offset === 'number'
            && Number.isFinite(contentExtent)
            && contentExtent > 0
            && offset >= contentExtent
        );
        return isBeyondMeasuredExtent(press.offsetX, element.clientWidth)
            || isBeyondMeasuredExtent(press.offsetY, element.clientHeight);
    }, [isWebFrame]);
    const endWebScrollbarDrag = React.useCallback(() => {
        const cleanup = webScrollbarDragCleanupRef.current;
        webScrollbarDragCleanupRef.current = null;
        cleanup?.();
        if (!userScrollIntent.isGestureActive()) return;
        lastDragEndAtMsRef.current = Date.now();
        lastUserInteractionAtMsRef.current = Date.now();
        userScrollIntent.setGestureActive({ active: false, atMs: Date.now(), gesture: 'drag' });
    }, [userScrollIntent]);
    const beginWebScrollbarDrag = React.useCallback(() => {
        lastUserInteractionAtMsRef.current = Date.now();
        pendingViewportCauseRef.current = 'user';
        props.webDomObservation.recordUserScrollInput({
            direction: null,
            nowMs: Date.now(),
        });
        userScrollIntent.setGestureActive({ active: true, atMs: Date.now(), gesture: 'drag' });
        cancelLegendInitialScrollPreservation();
        if (webScrollbarDragCleanupRef.current) return;
        const listenerHost = globalThis.window ?? globalThis;
        if (typeof listenerHost.addEventListener !== 'function') return;
        const onRelease = () => endWebScrollbarDrag();
        listenerHost.addEventListener('pointerup', onRelease);
        listenerHost.addEventListener('pointercancel', onRelease);
        listenerHost.addEventListener('mouseup', onRelease);
        webScrollbarDragCleanupRef.current = () => {
            listenerHost.removeEventListener('pointerup', onRelease);
            listenerHost.removeEventListener('pointercancel', onRelease);
            listenerHost.removeEventListener('mouseup', onRelease);
        };
    }, [cancelLegendInitialScrollPreservation, endWebScrollbarDrag, props.webDomObservation, userScrollIntent]);
    React.useEffect(() => () => {
        webScrollbarDragCleanupRef.current?.();
        webScrollbarDragCleanupRef.current = null;
    }, []);
    const handleLegendMouseDown = React.useCallback((event: unknown) => {
        recordUserInteraction();
        if (isWebScrollbarBandPress(event)) beginWebScrollbarDrag();
        props.platformInteractionProps?.onMouseDown?.(event);
    }, [beginWebScrollbarDrag, isWebScrollbarBandPress, props.platformInteractionProps, recordUserInteraction]);
    const handleLegendPointerDown = React.useCallback((event: unknown) => {
        recordUserInteraction();
        if (isWebScrollbarBandPress(event)) beginWebScrollbarDrag();
        props.platformInteractionProps?.onPointerDown?.(event);
    }, [beginWebScrollbarDrag, isWebScrollbarBandPress, props.platformInteractionProps, recordUserInteraction]);
    const legendPlatformInteractionProps = {
        ...props.platformInteractionProps,
        onMouseDown: isWebFrame ? handleLegendMouseDown : props.platformInteractionProps?.onMouseDown,
        onPointerDown: isWebFrame ? handleLegendPointerDown : props.platformInteractionProps?.onPointerDown,
        onTouchMove: isWebFrame ? handleLegendTouchMove : props.platformInteractionProps?.onTouchMove,
        onTouchStart: handleLegendTouchStart,
        onWheel: isWebFrame ? handleLegendWheel : props.platformInteractionProps?.onWheel,
    };
    const legendProps: LegendListProps<TItem> = {
        ...legendPlatformInteractionProps,
        style: LEGEND_LIST_STYLE,
        alignItemsAtEnd: true,
        data,
        dataKey: props.dataKey,
        dataVersion: legendDataVersion,
        estimatedItemSize: LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX,
        extraData: props.extraData,
        getItemType: props.getItemType
            ? (item, index) => {
                const type = props.getItemType?.(
                    item,
                    toSourceIndex(index, dataLength, projectChronologicalIndex),
                    props.extraData,
                );
                return typeof type === 'number' ? String(type) : type;
            }
            : undefined,
        getEstimatedItemSize: props.getEstimatedItemSize
            ? (item, index) => props.getEstimatedItemSize?.(
                item,
                toSourceIndex(index, dataLength, projectChronologicalIndex),
                props.extraData,
            )
            : undefined,
        getItemSizeVersion: props.getItemSizeVersion
            ? (item, index) => props.getItemSizeVersion?.(
                item,
                toSourceIndex(index, dataLength, projectChronologicalIndex),
                props.extraData,
            )
            : undefined,
        // Continuous tail maintenance belongs to Legend, but initial placement must respect the
        // app-owned discrete entry intent. A released/anchored entry starts away from the tail so
        // entry restore can consume its saved anchor before any at-end observation clears it.
        initialScrollAtEnd: props.frame.rendererOptions.initialPlacement.atEnd,
        keyExtractor: (item, index) => props.keyExtractor(
            item,
            toSourceIndex(index, dataLength, projectChronologicalIndex),
        ),
        keyboardDismissMode: props.frame.rendererOptions.interaction.keyboardDismissMode,
        keyboardShouldPersistTaps: props.frame.rendererOptions.interaction.keyboardShouldPersistTaps,
        // Shell header/footer are FRAME LIST-SPACE slots (FlashList semantics). On newest-first
        // frames FlashList renders inverted, so the shell `header` slot (data-start) appears at
        // the VISUAL BOTTOM — that is where callers put the composer keyboard-inset spacer and
        // hot tail. This adapter re-projects data to chronological standard space, so the slots
        // must be re-projected with it: header -> visual bottom (ListFooterComponent), footer ->
        // visual top (ListHeaderComponent). Without this, the inset spacer renders at the top and
        // the last row lays out under the floating composer (native occlusion, live-measured
        // ~130pt on 2026-07-08). Oldest-first frames already are standard space: no swap.
        ListFooterComponent: legendVisualBottomSlot,
        ListHeaderComponent: toLegendSlot(projectChronologicalIndex ? props.footer : props.header),
        // Legend evaluates `withinPhysicalThreshold || isMaintainingScrollAtEnd()` — an OR, so
        // a false predicate cannot veto maintenance while the viewport is still near the tail.
        // The outer gate is therefore the only thing that can withhold maintenance from a
        // detached reader, a keyed restore or a post-jump landing: omit maintenance entirely
        // until held-end is the live positioning owner. Inside that gate the predicate is what
        // keeps follow library-owned on BOTH platforms after a late measurement pushes the
        // viewport past the threshold; without it native fell back to the app's residual
        // corrector, which repositions a frame later (the visible send jiggle).
        maintainScrollAtEnd: explicitJumpTakeoverOperationRef.current === null
            && heldScrollIntentRef.current?.kind === 'end'
            ? maintainScrollAtEndOption
            : false,
        maintainScrollAtEndThreshold: props.frame.rendererOptions.continuousFollow.endThresholdRatio,
        maintainVisibleContentPosition: LEGEND_MAINTAIN_VISIBLE_CONTENT_POSITION,
        onEndReached: props.onEndReached,
        onEndReachedThreshold: props.onEndReachedThreshold,
        onItemSizeChanged: handleLegendItemSizeChanged,
        onLoad: (info) => {
            emitSynthesizedContentSize();
            requestHeldIntentSettle();
            props.onLoad?.(info);
        },
        onMomentumScrollBegin: handleLegendMomentumScrollBegin,
        onMomentumScrollEnd: handleLegendMomentumScrollEnd,
        onScroll: handleLegendScroll,
        onScrollBeginDrag: handleLegendScrollBeginDrag,
        onScrollEndDrag: handleLegendScrollEndDrag,
        onStartReached: handleLegendStartReached,
        onStartReachedThreshold: props.onStartReachedThreshold,
        onViewableItemsChanged: handleLegendViewableItemsChanged,
        // Transcript rows still carry row-local transient UI state (hover/copy/fork affordances)
        // in addition to keyed host expansion state. Keep remount-on-reuse semantics until a
        // recycling-specific row-state audit proves every transient is key-safe.
        recycleItems: false,
        renderItem,
        scrollEventThrottle: props.frame.rendererOptions.interaction.scrollEventThrottle,
        viewabilityConfig: props.viewabilityConfig,
    };

    return (
        <View
            ref={identityHostRef}
            nativeID={props.frame.rendererOptions.identity.nativeID}
            onLayout={handleLegendLayout}
            testID={props.frame.rendererOptions.identity.testID}
            style={LEGEND_IDENTITY_HOST_STYLE}
        >
            {/* Layout-commit signalling for the viewport ownership stack. FlashList exposes this
                natively via its LayoutCommitObserver; Legend has no equivalent, so the adapter
                reuses the shared observer (falls back to a useLayoutEffect-per-commit shim).
                The same commit signal drives the synthesized onContentSizeChange emission. */}
            <LayoutCommitObserver
                onCommitLayoutEffect={() => {
                    invalidateNativePhysicalViewportCapture();
                    // IDLE FRAME COST, MEASURED AND DELIBERATELY LEFT — this observer is a
                    // `useLayoutEffect` with no dependency array
                    // (`@shopify/flash-list/.../LayoutCommitObserver.js`), so it fires on EVERY
                    // commit of this subtree, including one that changed no row, no size and no
                    // layout. The `end` hold is durable by design (`finishHeldIntentSettle` closes
                    // the window, never the intent), so this settle request re-opens a full
                    // LEGEND_HELD_INTENT_SETTLE_MS window of per-frame polling for every such
                    // commit: 94 `requestAnimationFrame` calls, against 0 at true rest
                    // (`legendIdleFrameCost.fabric.native.real.integration.test.tsx`).
                    //
                    // Gating it on a moved content height was tried and reverted: an open settle
                    // window is ALSO the fact `handleLegendScroll` reads (`heldIntentSettleInFlight`)
                    // to tell a renderer/layout offset rollback from a reader detach, so closing
                    // these windows made a bare touch plus content growth release the tail hold
                    // ('does not let a bare native touch reuse recent drag evidence for a later
                    // layout detach', legendListRenderer.test.tsx). Cheapening this poll requires
                    // giving that classifier its own liveness fact first; it is not a free change.
                    emitSynthesizedContentSize();
                    requestHeldIntentSettle();
                    props.onCommitLayoutEffect?.();
                }}
            >
                <LegendList
                    ref={legendListRef}
                    {...legendProps}
                />
            </LayoutCommitObserver>
        </View>
    );
}

const LegendListTranscriptRenderer = React.forwardRef(LegendListTranscriptRendererInner) as TranscriptListRenderer['Component'];

export const legendListRenderer: TranscriptListRenderer = {
    kind: 'legendList',
    orientation: 'standard',
    Component: LegendListTranscriptRenderer,
};
