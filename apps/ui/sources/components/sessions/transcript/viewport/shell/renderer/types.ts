import type * as React from 'react';
import type { FlatListProps, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import type { WebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import type { WebScrollMovementFact } from '@/components/sessions/transcript/scroll/resolveWebGenuineScrollMovement';
import type { TranscriptExplicitJumpOperationId } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import type { TranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import type { WebTranscriptKeyboardVerticalDirection } from '@/components/sessions/transcript/viewport/lifecycle/webTranscriptKeyboardOwner';
import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

export type TranscriptListRendererOrientation = 'standard' | 'frame-resolved';

export type TranscriptRendererNativePhysicalViewportCapture = Readonly<{
    capturedAtMs: number;
    dataKey: string;
    /** Index in the shell/source data order, not Legend's chronological projection. */
    itemIndex: number;
    itemKey: string;
    /** Physical row top relative to the native scroll host. */
    itemOffsetPx: number;
    /** Physical distance from the viewport bottom to the content bottom. */
    offsetY: number;
}>;

export type TranscriptRendererNativePhysicalViewportObservationResult =
    | Readonly<{
        capture: TranscriptRendererNativePhysicalViewportCapture;
        status: 'captured';
    }>
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'unavailable' }>;

export type TranscriptRendererNativePhysicalViewportObservationRequest = Readonly<{
    focusOffsetPx: number;
    /**
     * Supplying a completion callback authorizes one asynchronous Fabric observation.
     * Without it the renderer may return only a still-current completed fact.
     */
    onComplete?: (capture: TranscriptRendererNativePhysicalViewportCapture | null) => void;
}>;

export type TranscriptInitialPresentationSettlementRequest = Readonly<{
    dataKey: string;
    revision: number;
    onSettled: () => void;
}>;

/**
 * A renderer's visible window in SOURCE index space — the same order as the
 * `data` the shell handed it, on every platform.
 */
export type TranscriptRendererVisibleSourceIndexRange = Readonly<{
    startIndex: number;
    endIndex: number;
}>;

export type TranscriptListShellRef<TItem = unknown> = Readonly<{
    scrollToIndex: (params: TranscriptRendererScrollToIndexParams) => void | Promise<void>;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => void | Promise<void>;
    scrollToEnd?: (params?: { animated?: boolean }) => void | Promise<void>;
    notifyViewportGeometryChanged?: () => void;
    notifyViewportInput?: (input: TranscriptViewportInputEvidence) => void;
    /** Whether a keyed entry placement is still owned by the renderer settle lifecycle. */
    hasActiveEntryPlacement?: () => boolean;
    observeInitialPresentationSettlement?: (
        request: TranscriptInitialPresentationSettlementRequest,
    ) => () => void;
    computeVisibleIndices?: () => { startIndex: number; endIndex: number };
    /**
     * The ONE navigation-visibility reader: the renderer's visible SOURCE index
     * window, or `null` when the renderer has no measurement yet.
     *
     * `computeVisibleIndices` cannot express "unmeasured" — a renderer without
     * state answers `{0, 0}`, which is indistinguishable from genuinely viewing
     * row 0 and transiently drags the navigation anchor to the first turn. Every
     * consumer that must not act on a guess reads THIS instead.
     */
    readVisibleSourceIndexRange?: () => TranscriptRendererVisibleSourceIndexRange | null;
    getAbsoluteLastScrollOffset?: () => number;
    getFirstVisibleIndex?: () => number;
    getLayout?: (index: number) => { x: number; y: number; width: number; height: number } | undefined;
    /**
     * Native only: reads or requests one renderer-owned atomic physical viewport fact.
     * The caller consumes it read-only and never measures Fabric nodes itself.
     */
    observeNativePhysicalViewport?: (
        request: TranscriptRendererNativePhysicalViewportObservationRequest,
    ) => TranscriptRendererNativePhysicalViewportObservationResult;
    /** Web renderer scroll element used by the shared document keyboard-input owner. */
    getScrollableNode?: () => unknown;
    /**
     * Web only: after a successful entry-anchor restore write, the driver arms a
     * bounded renderer-owned hold that re-aligns the restored anchor when Legend's later row
     * remeasurement displaces it (estimate-heavy re-entry windows shift by thousands of px
     * seconds after the restore). Cancelled by user wheel/scroll, explicit renderer commands,
     * session identity change, or expiry.
     */
    holdWebEntryAnchor?: (anchor: TranscriptRendererEntryAnchorHold) => void;
    /**
     * Whether the renderer currently owns the given landing target through a
     * live held scroll intent — the held-'end' tail contract or a keyed anchor
     * hold for a specific item. Command writers consult it so a landing already
     * owned by the renderer hold is not re-written by app-side verify/follow
     * loops (two landing verifiers oscillate the viewport; live captures
     * 2026-07-22: nav-rail jump fight, session-open pin fight).
     */
    hasLiveWebHold?: (target: TranscriptRendererWebHoldTarget) => boolean;
    /**
     * Web only: an explicit user navigation away from the tail (jump-to-seq
     * dispatch) revokes the renderer's held-'end' intent immediately — an
     * out-of-window jump pages content in for seconds before any landing write,
     * and a surviving held tail re-pins to the bottom through every prepend
     * (live capture 2026-07-23). The landing arms the keyed hold as the new owner.
     */
    releaseWebHeldIntent?: () => void;
    /**
     * Synchronously suspends renderer/library tail ownership for one explicit target jump.
     * The captured release is operation-scoped, so stale cleanup cannot release a successor.
     */
    beginExplicitJumpTakeover?: (operationId: TranscriptExplicitJumpOperationId) => () => void;
    /**
     * NATIVE renderer-owned visible-anchor hold for app-initiated in-viewport height commits
     * (tool/thinking expansion toggles): installs a keyed index hold on the first visible row
     * before the commit. Native Legend predicts `state.scroll` open-loop with no ground truth,
     * and the S-C continuation committed +13k px there with no hold armed (live, 2026-07-11).
     *
     * NO-OP ON WEB. Legend 3.3.3's `maintainVisibleContentPosition` holds the reader through
     * an expansion, an above-viewport growth, and an in-viewport item replacement alike,
     * measured against the installed package in `legendListRenderer.real.integration.test.tsx`
     * ('holds a detached reader through expansion, above-viewport growth, and item
     * replacement'). The web arm existed for a re-anchoring captured on 2.0.0-beta.3, before
     * the 3.3.3 upgrade brought the MVCP anchor lock.
     *
     * Also a no-op while tail-following (the held-'end'/maintain machinery owns the pinned
     * case).
     */
    armVisibleAnchorHold?: () => void;
    /**
     * Native only: after the transcript screen is revealed again (route pop over the
     * session screen), re-observe the natively displayed offset into Legend state. A write
     * issued while the screen was covered can fail to become native truth, and with no
     * scroll event on reveal Legend keeps computing its mounted window for the believed
     * offset — the S-E persistent blank region (live capture 2026-07-11) that only the
     * user's first swipe healed. Compares the transformed page positions of the native
     * Fabric content and scroll hosts and, when the resulting displayed offset disagrees
     * with Legend state, replays it through Legend so the window recomputes where the user
     * is actually looking. No-op on web and for renderers without Legend-owned state.
     */
    revalidateViewportAfterReveal?: () => void;
}>;

export type TranscriptRendererWebHoldTarget =
    | Readonly<{ kind: 'end' }>
    | Readonly<{ kind: 'item'; itemId: string }>;

export type TranscriptRendererEntryAnchorHold = Readonly<{
    kind: 'message' | 'toolGroup' | 'item';
    itemId: string;
    messageId: string | null;
    itemOffsetPx: number;
    reason?: TranscriptViewportTelemetryScrollReason;
}>;

export type TranscriptRendererScrollToIndexParams = Readonly<{
    index: number;
    animated?: boolean;
    viewOffset?: number;
    viewPosition?: number;
    context?: Readonly<{
        anchor: TranscriptRendererEntryAnchorHold;
        kind: 'entry-placement';
    }>;
}>;

export type TranscriptRendererEntryPlacementEvent =
    | Readonly<{
        dataKey: string;
        itemId: string;
        platform: 'native' | 'web';
        type: 'started';
    }>
    | Readonly<{
        dataKey: string;
        itemId: string;
        outcome: 'settled' | 'deadline' | 'preempted' | 'superseded' | 'unavailable';
        platform: 'native' | 'web';
        type: 'finished';
    }>;

export type TranscriptRendererAtEndState = Readonly<{
    isAtEnd: boolean;
    /** Canonical semantic follow decision: Legend's maintain-at-end threshold contract. */
    isFollowing: boolean;
    isNearEnd: boolean;
    isWithinMaintainScrollAtEndThreshold: boolean;
}>;

export type TranscriptViewportMutationCause = 'user' | 'layout' | 'command';

type TranscriptViewportVerticalDirection = WebTranscriptKeyboardVerticalDirection;

export type TranscriptViewportInputEvidence =
    | Readonly<{
        kind: 'keyboard';
        verticalDirection: TranscriptViewportVerticalDirection;
    }>
    | Readonly<{
        kind: 'touch';
        /**
         * Semantic content direction derived from browser touch coordinates. Missing
         * direction is conservative takeover evidence because the user's intent is unknown.
         */
        verticalDirection?: TranscriptViewportVerticalDirection;
    }>
    | Readonly<{
        kind: 'wheel' | 'drag';
    }>;

type TranscriptListShellInteractionHandler = (event: unknown) => void;

export type TranscriptListShellPlatformInteractionProps = Readonly<{
    onMouseDown?: TranscriptListShellInteractionHandler;
    onKeyDown?: TranscriptListShellInteractionHandler;
    onPointerDown?: TranscriptListShellInteractionHandler;
    onTouchCancel?: TranscriptListShellInteractionHandler;
    onTouchEnd?: TranscriptListShellInteractionHandler;
    onTouchMove?: TranscriptListShellInteractionHandler;
    onTouchStart?: TranscriptListShellInteractionHandler;
    onWheel?: TranscriptListShellInteractionHandler;
}>;

export type TranscriptListRendererProps<TItem> = Readonly<{
    data: readonly TItem[];
    /**
     * Logical transcript dataset identity (the session id). REQUIRED: the renderer uses
     * dataKey changes to reset layout/held-intent/readiness baselines when a mounted
     * surface switches logical sessions; an omitting surface silently inherits the
     * previous session's scroll/held state (live audit finding AUD-003, 2026-07-12).
     */
    dataKey: string;
    extraData?: unknown;
    keyExtractor: NonNullable<FlatListProps<TItem>['keyExtractor']>;
    getItemType?: (item: TItem, index: number, extraData?: unknown) => string | number | undefined;
    /**
     * Size estimate for rows the renderer has not measured yet. Serving the app's
     * own prior EXACT measurements collapses first-visit estimate error — the root
     * of the estimate-vs-measured relayout oscillation (legend-list#492; live
     * captures 2026-07-22/23). Return undefined to fall back to the renderer's own
     * average/scalar estimate.
    */
    getEstimatedItemSize?: (item: TItem, index: number, extraData?: unknown) => number | undefined;
    /**
     * Primitive validity token for the renderer's measured size of this semantic item.
     * Changing it invalidates only that item's cached size.
     */
    getItemSizeVersion?: (item: TItem, index: number, extraData?: unknown) => React.Key | undefined;
    renderItem: NonNullable<FlatListProps<TItem>['renderItem']>;
    frame: TranscriptListShellFrame;
    /**
     * The mounted transcript's single web DOM write/observation owner. Renderer-held
     * residuals use this same instance as the outer ingress classifier so their trusted
     * browser echoes cannot acquire user, preemption, or persistence authority.
     */
    webDomObservation: WebDomScrollObservation;
    platformInteractionProps?: TranscriptListShellPlatformInteractionProps;
    onLoad?: (info: { elapsedTimeInMs: number }) => void;
    onCommitLayoutEffect?: () => void;
    onLayout?: FlatListProps<TItem>['onLayout'];
    onContentSizeChange?: FlatListProps<TItem>['onContentSizeChange'];
    onScroll?: (
        event: NativeSyntheticEvent<NativeScrollEvent>,
        webMovementFact?: WebScrollMovementFact,
    ) => void;
    onViewableItemsChanged?: FlatListProps<TItem>['onViewableItemsChanged'];
    viewabilityConfig?: FlatListProps<TItem>['viewabilityConfig'];
    onScrollBeginDrag?: FlatListProps<TItem>['onScrollBeginDrag'];
    onScrollEndDrag?: FlatListProps<TItem>['onScrollEndDrag'];
    onMomentumScrollBegin?: FlatListProps<TItem>['onMomentumScrollBegin'];
    onMomentumScrollEnd?: FlatListProps<TItem>['onMomentumScrollEnd'];
    onRendererAtEndChange?: (
        state: TranscriptRendererAtEndState,
        context: Readonly<{ cause: TranscriptViewportMutationCause }>,
    ) => void;
    onEntryPlacementEvent?: (event: TranscriptRendererEntryPlacementEvent) => void;
    onScrollToIndexFailed?: FlatListProps<TItem>['onScrollToIndexFailed'];
    onStartReachedThreshold?: number;
    onStartReached?: () => void;
    onEndReachedThreshold?: FlatListProps<TItem>['onEndReachedThreshold'];
    onEndReached?: FlatListProps<TItem>['onEndReached'];
    header?: React.ReactNode;
    footer?: React.ReactNode;
}>;

export type TranscriptListShellProps<TItem> = TranscriptListRendererProps<TItem> & Readonly<{
    olderLoadOverlay?: React.ReactNode;
    catchUpOverlay?: React.ReactNode;
}>;

export type TranscriptListRendererComponent = <TItem>(
    props: TranscriptListRendererProps<TItem> & React.RefAttributes<TranscriptListShellRef<TItem>>,
) => React.ReactElement;

export type TranscriptListRenderer = Readonly<{
    kind: 'legendList';
    orientation: TranscriptListRendererOrientation;
    Component: TranscriptListRendererComponent;
}>;
