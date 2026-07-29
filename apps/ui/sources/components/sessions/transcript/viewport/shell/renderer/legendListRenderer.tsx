import {
    observeTranscriptPhysicalScrollMethods,
    observeTranscriptRevealVisibility,
    recordTranscriptScrollSample,
} from '@/components/sessions/transcript/viewport/driver/transcriptViewportWriteDiagnostics';
import * as React from 'react';
import { View, type LayoutChangeEvent, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import {
    LegendList,
    type LegendListProps,
    type LegendListRef,
} from '@legendapp/list/react-native';

import { TranscriptLayoutCommitObserver } from './TranscriptLayoutCommitObserver';
import {
    resolveWebTranscriptScrollMetrics,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import type { WebScrollMovementFact } from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';

import type {
    TranscriptRendererAtEndState,
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
import {
    readLegendAtEndState,
    resolveLegendNativeAtEndPublicationCause,
    resolveLegendRendererAtEndStateFromWebMetrics,
} from './legend/atEnd';
import {
    readDataVersion,
    readTouchVerticalCoordinate,
    readWheelDeltaY,
    shouldProjectChronologicalIndex,
    toLegendData,
    toLegendIndex,
    toLegendSlot,
    toSourceIndex,
    toSourceViewabilityTokens,
} from './legend/dataProjection';
import type { TouchVerticalCoordinate } from './legend/dataProjection';
import {
    LEGEND_HELD_TARGET_IDENTITY_MS,
    LEGEND_USER_INPUT_DETACH_WINDOW_MS,
    LEGEND_USER_MOMENTUM_CHAIN_WINDOW_MS,
    LEGEND_USER_SCROLL_INERTIA_CONTINUATION_MS,
    LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS,
    settleLegendScroll,
} from './legend/heldIntent';
import { useLegendHeldIntent } from './legend/useLegendHeldIntent';
import { useLegendRevealRevalidation } from './legend/useLegendRevealRevalidation';

export { resolveLegendRendererAtEndStateFromWebMetrics } from './legend/atEnd';

const LEGEND_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
// The measurement runtime models ordinary transcript rows around 168-240px and
// handles giant markdown rows with per-row measured floors, so this is only a
// first-render hint. It intentionally stays below the giant-row outliers.
const LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX = 240;
// Identity host wrapper: @legendapp/list does not forward nativeID/testID to any
// rendered node (verified against the 3.3.0 dist). The web viewport ownership stack
// resolves its scroll container via document.getElementById(nativeID) and then
// descends to the scrollable, so the adapter must own the identity on a wrapper
// View that is an ancestor of the Legend scroller.
const LEGEND_IDENTITY_HOST_STYLE = { flex: 1, minHeight: 0 } as const;

type LegendNativePhysicalMeasureNode = Readonly<{
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
}>;

function LegendListTranscriptRendererInner<TItem>(
    props: TranscriptListRendererProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const legendListRef = React.useRef<LegendListRef | null>(null);
    const identityHostRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const visualBottomSlotHostRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const latestNativePhysicalViewportCaptureRef =
        React.useRef<TranscriptRendererNativePhysicalViewportCapture | null>(null);
    const nativePhysicalViewportObservationRef = React.useRef<object | null>(null);
    const pendingViewportCauseRef = React.useRef<TranscriptViewportMutationCause>('layout');
    const webTailDetachedIntentRef = React.useRef(false);
    const webScrollbarDragCleanupRef = React.useRef<(() => void) | null>(null);
    const lastUserInteractionAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    // SCROLL-INTENT evidence only (wheel/drag/keyboard/momentum) — a bare tap records general
    // interaction (write suppression, hold release at touch) but must NOT classify later
    // offset movement as a user detach: an expansion commit keeps moving the offset for
    // seconds after the toggling tap, and detach-releasing there strands the armed hold
    // (live native S-C re-run 2026-07-11 09:03).
    const lastUserScrollIntentAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    // S-D user-scroll-live evidence: an active drag, user fling momentum (chained off a drag
    // release or a previous user momentum phase), or wheel/touch/keyboard input within the
    // suppression margin. While live, verifyLanding never writes residual corrections.
    const userDragActiveRef = React.useRef(false);
    const userMomentumActiveRef = React.useRef(false);
    const lastDragEndAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const lastUserMomentumEndAtMsRef = React.useRef(Number.NEGATIVE_INFINITY);
    const webTouchVerticalCoordinateRef = React.useRef<TouchVerticalCoordinate | null>(null);
    const lastViewportHeightRef = React.useRef<number | null>(null);
    const lastVisualBottomSlotHeightRef = React.useRef<number | null>(null);
    const hasCommittedVisualBottomSlotRef = React.useRef(false);
    const previousVisualBottomSlotRef = React.useRef<React.ReactNode>(null);
    const hasCommittedHeldTailDataRevisionRef = React.useRef(false);
    const lastObservedScrollOffsetRef = React.useRef<number | null>(null);
    // Native keeps its renderer-local drag/momentum continuation because it has no DOM
    // observation owner. Web continuation belongs to the mounted WebDom observation below.
    // Last CLASSIFIED native user scroll movement (time + direction): a trackpad-inertia tail
    // continues emitting genuine scroll events after per-event classification lapses, and
    // the detached reading-anchor re-arm must keep re-capturing through that tail or the
    // hold's baseline goes stale by the inertia distance and the quiet-resume correction
    // yanks the viewport back 50-200px (live report 2026-07-23).
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
        advanceMovementEpoch();
        lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
    }, [advanceMovementEpoch]);
    const webScrollableElementRef = React.useRef<HTMLElement | null>(null);
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
    React.useEffect(() => () => {
        invalidateNativePhysicalViewportCapture();
    }, [invalidateNativePhysicalViewportCapture]);
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
        return metrics;
    }, [isWebFrame, props.frame.rendererOptions.identity.nativeID]);

    const isUserScrollInputLive = React.useCallback((): boolean => {
        if (userDragActiveRef.current || userMomentumActiveRef.current) return true;
        return Date.now() - lastUserInteractionAtMsRef.current <= LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS;
    }, []);

    const resolveSourceIndex = React.useCallback((legendIndex: number): number => (
        toSourceIndex(legendIndex, dataLength, projectChronologicalIndex)
    ), [dataLength, projectChronologicalIndex]);

    const {
        armVisibleAnchorHold,
        armWebVisibleAnchorHold,
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
    } = useLegendHeldIntent({
        data,
        dataKey: props.dataKey,
        dataLength,
        initialPlacementAtEnd: props.frame.rendererOptions.initialPlacement.atEnd,
        invalidateUserInertiaContinuation,
        isUserScrollInputLive,
        isWebFrame,
        keyExtractor: props.keyExtractor,
        legendListRef,
        onEntryPlacementEvent: props.onEntryPlacementEvent,
        pendingViewportCauseRef,
        readWebScrollMetrics,
        suppressAutoEndLatchRef,
        toSourceIndex: resolveSourceIndex,
        webScrollableElementRef,
        webDomObservation: props.webDomObservation,
        webTailDetachedIntentRef,
    });

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
        heldScrollIntentRef,
        isWebFrame,
        latchHeldEndIntent,
        props.frame.rendererOptions.continuousFollow.endThresholdRatio,
        readWebScrollMetrics,
        suppressAutoEndLatchRef,
    ]);

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
                latchObservedEndIntent();
            }
        }
        // A keyed anchor/index hold remains the semantic viewport truth until the
        // canonical scroll callback classifies a genuine bottomward arrival and
        // atomically replaces it with held-'end'. Legend invokes threshold listeners
        // before that public callback, so withhold following without updating either
        // baseline; the callback must still classify and publish the same arrival.
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
            : resolveLegendNativeAtEndPublicationCause({
                dragOrMomentumLive: userDragActiveRef.current || userMomentumActiveRef.current,
                isFollowing: state.isFollowing,
                offsetMoved,
                pendingCause,
                scrollIntentAgeMs: Date.now() - lastUserScrollIntentAtMsRef.current,
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
    }, [hasLiveKeyedHeldIntent, heldScrollIntentRef, isWebFrame, latchObservedEndIntent, props.onRendererAtEndChange, readRendererAtEndObservation]);

    const revalidateViewportAfterReveal = useLegendRevealRevalidation({
        isWebFrame,
        legendListRef,
        pendingViewportCauseRef,
        requestHeldIntentSettle,
    });

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
        if (!isWebFrame) return;
        const element = readWebScrollMetrics()?.element;
        if (!element) return;
        // Opt-in rare-defect probe (no-op unless happier.debug.viewportWrites=1).
        const disposePhysicalWrites = observeTranscriptPhysicalScrollMethods(element);
        const disposeRevealVisibility = observeTranscriptRevealVisibility(element);
        return () => {
            disposePhysicalWrites?.();
            disposeRevealVisibility?.();
        };
    }, [isWebFrame, readWebScrollMetrics]);

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
                    isUserInputActive: userDragActiveRef.current || userMomentumActiveRef.current,
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
            && !hasPendingHeldIntentCorrection();
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
        const topEdgeCaptureThresholdPx = Math.max(
            4,
            (webScrollableElementRef.current?.clientHeight ?? 0) * Math.max(0, props.onStartReachedThreshold ?? 0),
        );
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
        if (webUserMovedAwayFromTail) {
            // Release the PRE-MOVEMENT target before the detached capture below installs the
            // user's current rest-position baseline. Releasing after capture deletes the new
            // baseline from this same event and leaves later row remeasures unowned.
            releaseHeldScrollIntent();
        }
        if (isWebFrame && (
            webTailDetachedIntentRef.current
            || nextScrollOffset <= topEdgeCaptureThresholdPx
        )) {
            // The generic host scroll-ingress owner can start pagination before Legend emits its
            // own onStartReached callback. Refresh the renderer fallback before forwarding that
            // top-edge observation. Detached web scrolls also keep a current renderer-owned
            // baseline so appends below the viewport can repair Legend row-remeasure residuals.
            // Only USER-caused movement may re-baseline a live keyed hold: Legend MVCP replay,
            // estimate corrections, and this adapter's own residual writes emit non-user scroll
            // events during a prepend/measurement burst, and re-capturing there adopts displaced
            // geometry as the new baseline and freezes the displacement (live DR-030: the held
            // transaction settled 61px off after "correcting" to a mid-burst recapture).
            if (isClassifiedUserMovement || !hasLiveKeyedHeldIntent()) {
                armWebVisibleAnchorHold();
            }
        }
        const keyedLandingDisplacedByRenderer = isWebFrame
            && offsetMoved
            && !isClassifiedUserMovement
            && hasLiveKeyedHeldIntent();
        if (keyedLandingDisplacedByRenderer) {
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
            // Native has no WebDom movement fact and retains its evidence window. Web
            // non-user movement is an external rollback and must reassert the live hold.
            if (
                !isWebFrame
                && Date.now() - lastUserScrollIntentAtMsRef.current <= LEGEND_USER_INPUT_DETACH_WINDOW_MS
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
            // A classified USER movement landing bottomward inside the maintain threshold
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
        tryAcknowledgeInitialPresentationSettlement();
        if (webMovementFact) {
            props.onScroll?.(event, webMovementFact);
        } else {
            props.onScroll?.(event);
        }
        if (pendingViewportCauseRef.current === cause) pendingViewportCauseRef.current = 'layout';
    }, [armWebVisibleAnchorHold, emitRendererAtEndState, hasLiveKeyedHeldIntent, hasPendingHeldIntentCorrection, heldIntentSettleUntilRef, invalidateNativePhysicalViewportCapture, isWebFrame, latchHeldEndIntent, props.frame.rendererOptions.continuousFollow.endThresholdRatio, props.onScroll, props.onStartReachedThreshold, props.webDomObservation, readRendererAtEndState, readWebScrollMetrics, releaseHeldScrollIntent, requestHeldIntentSettle, tryAcknowledgeInitialPresentationSettlement]);

    const handleLegendWheel = React.useCallback((event: unknown) => {
        invalidateNativePhysicalViewportCapture();
        lastUserInteractionAtMsRef.current = Date.now();
        lastUserScrollIntentAtMsRef.current = Date.now();
        if (isWebFrame) {
            pendingViewportCauseRef.current = 'user';
            // A bottomward wheel while holding the tail is follow-affirming input, not a
            // detach. At the bottom clamp it produces NO scroll event and NO at-end state
            // change, so a release here would leave the tail permanently unowned (nothing
            // re-latches) and the next giant streaming commit would exceed Legend's maintain
            // threshold with no corrector (live S-K, 2026-07-11). Upward wheels and wheels
            // over a keyed hold release exactly as before.
            const deltaY = readWheelDeltaY(event);
            props.webDomObservation.recordUserScrollInput({
                direction:
                    typeof deltaY !== 'number' || deltaY === 0
                        ? null
                        : deltaY > 0 ? 1 : -1,
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
    }, [affirmWebHeldEndFromTowardEndInput, cancelLegendInitialScrollPreservation, invalidateNativePhysicalViewportCapture, isWebFrame, props.platformInteractionProps, props.webDomObservation, releaseHeldScrollIntent]);

    const handleLegendScrollBeginDrag = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        invalidateNativePhysicalViewportCapture();
        lastUserInteractionAtMsRef.current = Date.now();
        lastUserScrollIntentAtMsRef.current = Date.now();
        pendingViewportCauseRef.current = 'user';
        userDragActiveRef.current = true;
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
    }, [cancelLegendInitialScrollPreservation, invalidateNativePhysicalViewportCapture, isWebFrame, props.onScrollBeginDrag, props.webDomObservation, releaseHeldScrollIntent]);

    const handleLegendScrollEndDrag = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (userDragActiveRef.current) {
            userDragActiveRef.current = false;
            lastDragEndAtMsRef.current = Date.now();
            lastUserInteractionAtMsRef.current = Date.now();
            lastUserScrollIntentAtMsRef.current = Date.now();
        }
        props.onScrollEndDrag?.(event);
    }, [props.onScrollEndDrag]);

    const handleLegendMomentumScrollBegin = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const nowMs = Date.now();
        if (
            nowMs - lastDragEndAtMsRef.current <= LEGEND_USER_MOMENTUM_CHAIN_WINDOW_MS
            || nowMs - lastUserMomentumEndAtMsRef.current <= LEGEND_USER_MOMENTUM_CHAIN_WINDOW_MS
        ) {
            userMomentumActiveRef.current = true;
        }
        props.onMomentumScrollBegin?.(event);
    }, [props.onMomentumScrollBegin]);

    const handleLegendMomentumScrollEnd = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (userMomentumActiveRef.current) {
            userMomentumActiveRef.current = false;
            lastUserMomentumEndAtMsRef.current = Date.now();
            lastUserInteractionAtMsRef.current = Date.now();
            lastUserScrollIntentAtMsRef.current = Date.now();
        }
        props.onMomentumScrollEnd?.(event);
    }, [props.onMomentumScrollEnd]);

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
        lastUserScrollIntentAtMsRef.current = Date.now();
        pendingViewportCauseRef.current = 'user';
        if (isWebFrame) {
            const verticalDirection =
                input.kind === 'keyboard' || input.kind === 'touch'
                    ? input.verticalDirection
                    : undefined;
            props.webDomObservation.recordUserScrollInput({
                direction:
                    verticalDirection === 'toward-end'
                        ? 1
                        : verticalDirection === 'toward-start' ? -1 : null,
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
    }, [affirmWebHeldEndFromTowardEndInput, cancelLegendInitialScrollPreservation, invalidateNativePhysicalViewportCapture, isWebFrame, props.webDomObservation, releaseHeldScrollIntent]);
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

    /**
     * Legend answers its mounted window from list state. Before that state exists
     * there is NO measurement — reporting `{0, 0}` here would be indistinguishable
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
        // measurement" freezes navigation on the pre-jump anchor with rows still
        // mounted. The buffered band comes from the same calculation and is the
        // nearest rendered content, so it answers for those frames.
        //
        // Bound: this covers Legend's cached-range recalculation, which rewrites
        // only the no-buffer window and leaves the band intact. Its FULL
        // recalculation rewrites both, and only assigns `endBuffered` once it has
        // found a no-buffer start — so a viewport intersecting no row there leaves
        // no band either and this still reports unmeasured. Verified against the
        // installed @legendapp/list 3.3.3.
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
        armVisibleAnchorHold,
        beginExplicitJumpTakeover,
        hasActiveEntryPlacement,
        hasLiveWebHold,
        observeInitialPresentationSettlement,
        releaseWebHeldIntent: () => {
            invalidateUserInertiaContinuation();
            // Mark the explicit navigation takeover before releasing the tail owner.
            // Passive web observations are independently barred from reacquiring end;
            // genuine user movement or an explicit tail command clears this shared
            // lifecycle guard.
            suppressAutoEndLatchRef.current = true;
            releaseHeldScrollIntent();
        },
        notifyViewportGeometryChanged: () => {
            advanceMovementEpoch();
            requestHeldIntentSettle();
        },
        observeNativePhysicalViewport,
        revalidateViewportAfterReveal,
        notifyViewportInput,
        computeVisibleIndices: () => {
            const state = legendListRef.current?.getState();
            if (!state) return { startIndex: 0, endIndex: 0 };
            const startIndex = toSourceIndex(state.start, dataLength, projectChronologicalIndex);
            const endIndex = toSourceIndex(state.end, dataLength, projectChronologicalIndex);
            return {
                startIndex: Math.min(startIndex, endIndex),
                endIndex: Math.max(startIndex, endIndex),
            };
        },
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
        scrollToEnd: (params) => {
            invalidateNativePhysicalViewportCapture();
            scrollRendererToEnd(params);
        },
        scrollToIndex: (params) => {
            invalidateNativePhysicalViewportCapture();
            invalidateUserInertiaContinuation();
            const { context, ...legendParams } = params;
            const legendIndex = toLegendIndex(params.index, dataLength, projectChronologicalIndex);
            holdIndexTarget(
                legendIndex,
                params.viewOffset ?? 0,
                params.viewPosition ?? 0,
                context?.kind === 'entry-placement' ? context.anchor : undefined,
            );
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
    }), [advanceMovementEpoch, armVisibleAnchorHold, beginExplicitJumpTakeover, dataLength, hasActiveEntryPlacement, hasLiveWebHold, holdIndexTarget, holdWebEntryAnchor, invalidateNativePhysicalViewportCapture, invalidateUserInertiaContinuation, notifyViewportInput, observeInitialPresentationSettlement, observeNativePhysicalViewport, projectChronologicalIndex, readVisibleSourceIndexRange, readWebScrollMetrics, requestHeldIntentSettle, revalidateViewportAfterReveal, scrollRendererToEnd]);

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
        // The reached-edge capture must not replace a live keyed hold either: Legend can emit
        // onStartReached from its own replay-driven scroll while a prepend burst is in flight,
        // and the existing hold carries the pre-commit baseline.
        // The live hold's IDENTITY is refreshed, though: a reader DWELLING at the top
        // outlives the 10s identity window, and the prepend this trigger is about to
        // load would then land against an expired, unenforceable hold — the viewport
        // stays at the top edge showing the new content instead of the reader's rows
        // (live report 2026-07-23). Refreshing expiry adopts no geometry, so the
        // DR-030 mid-burst recapture hazard stays excluded.
        const held = heldScrollIntentRef.current;
        let captured: boolean;
        if (held && held.kind !== 'end') {
            heldScrollIntentRef.current = { ...held, identityExpiresAtMs: Date.now() + LEGEND_HELD_TARGET_IDENTITY_MS };
            captured = true;
        } else {
            captured = armWebVisibleAnchorHold();
        }
        props.onStartReached?.();
        return captured;
    }, [armWebVisibleAnchorHold, heldScrollIntentRef, props.onStartReached]);

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
        const offsetX = typeof press.offsetX === 'number' ? press.offsetX : null;
        const offsetY = typeof press.offsetY === 'number' ? press.offsetY : null;
        return (offsetX !== null && offsetX >= element.clientWidth)
            || (offsetY !== null && offsetY >= element.clientHeight);
    }, [isWebFrame]);
    const endWebScrollbarDrag = React.useCallback(() => {
        const cleanup = webScrollbarDragCleanupRef.current;
        webScrollbarDragCleanupRef.current = null;
        cleanup?.();
        if (!userDragActiveRef.current) return;
        userDragActiveRef.current = false;
        lastDragEndAtMsRef.current = Date.now();
        lastUserInteractionAtMsRef.current = Date.now();
        lastUserScrollIntentAtMsRef.current = Date.now();
    }, []);
    const beginWebScrollbarDrag = React.useCallback(() => {
        lastUserInteractionAtMsRef.current = Date.now();
        lastUserScrollIntentAtMsRef.current = Date.now();
        pendingViewportCauseRef.current = 'user';
        props.webDomObservation.recordUserScrollInput({
            direction: null,
            nowMs: Date.now(),
        });
        userDragActiveRef.current = true;
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
    }, [cancelLegendInitialScrollPreservation, endWebScrollbarDrag, props.webDomObservation]);
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
        // Shell header/footer are FRAME LIST-SPACE slots. On
        // newest-first frames the shell `header` slot (data-start) appears at the VISUAL
        // BOTTOM — that is where callers put the composer keyboard-inset spacer. This adapter
        // re-projects data to chronological standard space, so the slots must be re-projected
        // with it: header -> visual bottom (ListFooterComponent), footer -> visual top
        // (ListHeaderComponent). Without this, the inset spacer renders at the top and the
        // last row lays out under the floating composer (native occlusion, live-measured
        // ~130pt on 2026-07-08). Oldest-first frames already are standard space: no swap.
        ListFooterComponent: legendVisualBottomSlot,
        ListHeaderComponent: toLegendSlot(projectChronologicalIndex ? props.footer : props.header),
        // Legend evaluates `withinPhysicalThreshold || isMaintainingScrollAtEnd()` — an OR, so
        // a false predicate cannot veto maintenance while the viewport is still near the tail.
        // The outer gate is therefore the only thing that can withhold maintenance from a
        // detached reader, a keyed restore or a post-jump landing: omit maintenance entirely
        // until held-end is the live positioning owner. Inside that gate the predicate is what
        // keeps follow library-owned on BOTH platforms after a late measurement pushes the
        // viewport past the threshold; without it native silently dropped follow and the app
        // had to reposition a frame later (the visible send jiggle).
        maintainScrollAtEnd: hasHeldEndPositioningOwnership()
            ? {
                animated: false,
                isMaintainingScrollAtEnd: () => heldScrollIntentRef.current?.kind === 'end',
            }
            : false,
        maintainScrollAtEndThreshold: props.frame.rendererOptions.continuousFollow.endThresholdRatio,
        maintainVisibleContentPosition: { data: true, size: true },
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
            {/* Layout-commit signalling for the viewport ownership stack. The same commit signal
                drives synthesized content size, held-intent settlement, and finally the shell
                callback, after the child layout effects for this commit have run. */}
            <TranscriptLayoutCommitObserver
                onCommitLayoutEffect={() => {
                    invalidateNativePhysicalViewportCapture();
                    emitSynthesizedContentSize();
                    requestHeldIntentSettle();
                    props.onCommitLayoutEffect?.();
                }}
            >
                <LegendList
                    ref={legendListRef}
                    {...legendProps}
                />
            </TranscriptLayoutCommitObserver>
        </View>
    );
}

const LegendListTranscriptRenderer = React.forwardRef(LegendListTranscriptRendererInner) as TranscriptListRenderer['Component'];

export const legendListRenderer: TranscriptListRenderer = {
    kind: 'legendList',
    orientation: 'standard',
    Component: LegendListTranscriptRenderer,
};
