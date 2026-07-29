import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptExplicitJumpOperationId } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import type {
    TranscriptInitialPresentationSettlementRequest,
    TranscriptRendererNativePhysicalViewportObservationRequest,
    TranscriptRendererNativePhysicalViewportObservationResult,
    TranscriptRendererScrollToIndexParams,
    TranscriptRendererEntryAnchorHold,
    TranscriptViewportInputEvidence,
} from '@/components/sessions/transcript/viewport/shell/renderer/types';

/**
 * The imperative renderer surface driven by transcript viewport owners. Optional members are
 * phase-specific capabilities and are guarded at their call sites.
 */
export type ScrollableChatListRef = Readonly<{
    scrollToIndex: (params: TranscriptRendererScrollToIndexParams) => void;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
    scrollToEnd?: (params?: { animated?: boolean }) => void;
    notifyViewportGeometryChanged?: () => void;
    notifyViewportInput?: (input: TranscriptViewportInputEvidence) => void;
    /** Whether a keyed entry placement is still owned by the renderer settle lifecycle. */
    hasActiveEntryPlacement?: () => boolean;
    observeInitialPresentationSettlement?: (
        request: TranscriptInitialPresentationSettlementRequest,
    ) => () => void;
    computeVisibleIndices?: () => { startIndex: number; endIndex: number };
    getAbsoluteLastScrollOffset?: () => number;
    getFirstVisibleIndex?: () => number;
    getLayout?: (index: number) => { x: number; y: number; width: number; height: number } | undefined;
    observeNativePhysicalViewport?: (
        request: TranscriptRendererNativePhysicalViewportObservationRequest,
    ) => TranscriptRendererNativePhysicalViewportObservationResult;
    /**
     * Web only: arms the renderer-owned bounded hold that keeps a driver-restored
     * entry anchor aligned through post-restore row remeasurement.
     */
    holdWebEntryAnchor?: (anchor: TranscriptRendererEntryAnchorHold) => void;
    /**
     * Web only: reports whether the renderer already owns the given landing target —
     * the held-'end' tail contract or a keyed anchor hold for the exact item — so command
     * re-verification and tail follow-writes do not become competing scroll writers.
     */
    hasLiveWebHold?: (target:
        | Readonly<{ kind: 'end' }>
        | Readonly<{ kind: 'item'; itemId: string }>,
    ) => boolean;
    /**
     * Web only: an explicit user navigation away from the tail revokes the
     * renderer's held-'end' intent immediately (see the shell renderer contract).
     */
    releaseWebHeldIntent?: () => void;
    /**
     * Synchronously suspends renderer/library tail ownership for one explicit target jump.
     * The captured release is operation-scoped, so stale cleanup cannot release a successor.
     */
    beginExplicitJumpTakeover?: (operationId: TranscriptExplicitJumpOperationId) => () => void;
    /**
     * Arms the renderer-owned visible-anchor hold before an app-initiated in-viewport
     * height commit. The renderer's MVCP and keyed hold retain the mounted row.
     */
    armVisibleAnchorHold?: () => void;
    /**
     * Native only: on transcript screen reveal (route pop back to the session),
     * re-observe the natively displayed offset into the renderer's scroll state so the
     * mounted window recomputes where the user is actually looking (S-E route-pop blank,
     * live capture 2026-07-11).
     */
    revalidateViewportAfterReveal?: () => void;
}>;

/**
 * The last native index-targeted restore write the command executor issued — retained so the native
 * `onScrollToIndexFailed` fallback can re-target the same restore intent.
 */
export type LastNativeRestoreIndexCommand = Readonly<{
    index: number;
    issuedAtMs: number;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    viewOffset?: number;
}>;
