import type {
    TranscriptViewportTelemetryBottomFollowMode,
    TranscriptViewportTelemetryLayoutCacheClearReason,
    TranscriptViewportTelemetryLayoutCacheClearState,
    TranscriptViewportTelemetryListOrientation,
    TranscriptViewportTelemetryNativeBlankWindowSignature,
    TranscriptViewportTelemetryScrollToIndexFailureState,
    TranscriptViewportTelemetryTransactionState,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import { readFiniteTelemetryNumber, readTelemetryBoolean } from './readTelemetryPrimitive';
import type { NativeVisibleWindowSnapshot } from './nativeVisibleWindow';

export function resolveNativeTelemetryDiagnostics(params: Readonly<{
    bottomFollowMode: TranscriptViewportTelemetryBottomFollowMode;
    contentHeight?: number;
    dragSessionTrusted: boolean;
    entryRestoreState: TranscriptViewportTelemetryTransactionState;
    eventContentHeight?: number;
    eventLayoutHeight?: number;
    fullItemCount: number;
    isAtRawBottom?: boolean;
    layoutHeight?: number;
    listDataLength: number;
    nativeMomentumActive: boolean;
    orientation: TranscriptViewportTelemetryListOrientation;
    observedOffset: Readonly<{
        canonicalOffsetY?: number;
        distanceFromLiveTailPx?: number;
        isAtRawLiveTail?: boolean;
    }> | null;
    prependState: TranscriptViewportTelemetryTransactionState;
    rawOffsetY?: number;
    refContentHeight?: number;
    refLayoutHeight?: number;
    source: Readonly<Record<string, unknown>>;
    visibleSnapshot: NativeVisibleWindowSnapshot;
}>): Record<string, unknown> {
    const canonicalOffsetY =
        readFiniteTelemetryNumber(params.source.canonicalOffsetY)
        ?? params.observedOffset?.canonicalOffsetY
        ?? readFiniteTelemetryNumber(params.source.offsetY);
    const distanceFromBottom =
        readFiniteTelemetryNumber(params.source.distanceFromBottom)
        ?? params.observedOffset?.distanceFromLiveTailPx;
    const isAtRawBottom =
        readTelemetryBoolean(params.source.isAtRawBottom)
        ?? params.observedOffset?.isAtRawLiveTail;
    const nativeBlankWindowSignature: TranscriptViewportTelemetryNativeBlankWindowSignature | undefined =
        params.visibleSnapshot.hasVisibleRows === false &&
        params.listDataLength > 0 &&
        params.layoutHeight !== undefined &&
        params.contentHeight !== undefined &&
        params.layoutHeight > 0 &&
        params.contentHeight > params.layoutHeight &&
        params.visibleSnapshot.blankAreaPx > 0
            ? 'empty-visible-window'
            : undefined;
    const layoutCacheClearState: TranscriptViewportTelemetryLayoutCacheClearState = 'idle';
    const layoutCacheClearReason: TranscriptViewportTelemetryLayoutCacheClearReason = 'none';
    const scrollToIndexFailureState: TranscriptViewportTelemetryScrollToIndexFailureState = 'none';

    return {
        orientation: params.orientation,
        ...(params.rawOffsetY !== undefined ? { rawOffsetY: params.rawOffsetY } : {}),
        ...(canonicalOffsetY !== undefined ? { canonicalOffsetY } : {}),
        ...(params.layoutHeight !== undefined ? { layoutHeight: params.layoutHeight } : {}),
        ...(params.contentHeight !== undefined ? { contentHeight: params.contentHeight } : {}),
        ...(params.eventLayoutHeight !== undefined ? { eventLayoutHeight: params.eventLayoutHeight } : {}),
        ...(params.eventContentHeight !== undefined ? { eventContentHeight: params.eventContentHeight } : {}),
        ...(params.refLayoutHeight !== undefined ? { refLayoutHeight: params.refLayoutHeight } : {}),
        ...(params.refContentHeight !== undefined ? { refContentHeight: params.refContentHeight } : {}),
        ...(distanceFromBottom !== undefined ? { distanceFromBottom } : {}),
        bottomFollowMode: params.bottomFollowMode,
        dragSessionTrusted: params.dragSessionTrusted,
        nativeMomentumActive: params.nativeMomentumActive,
        ...(isAtRawBottom !== undefined ? { isAtRawBottom } : {}),
        hasVisibleRows: params.visibleSnapshot.hasVisibleRows,
        ...(params.visibleSnapshot.firstVisibleItemId ? { firstVisibleItemId: params.visibleSnapshot.firstVisibleItemId } : {}),
        ...(params.visibleSnapshot.lastVisibleItemId ? { lastVisibleItemId: params.visibleSnapshot.lastVisibleItemId } : {}),
        ...(params.visibleSnapshot.firstVisibleRenderedIndex !== undefined
            ? { firstVisibleRenderedIndex: params.visibleSnapshot.firstVisibleRenderedIndex }
            : {}),
        ...(params.visibleSnapshot.visibleRangeReadStatus
            ? { visibleRangeReadStatus: params.visibleSnapshot.visibleRangeReadStatus }
            : {}),
        ...(params.visibleSnapshot.visibleRenderedStartIndex !== undefined
            ? { visibleRenderedStartIndex: params.visibleSnapshot.visibleRenderedStartIndex }
            : {}),
        ...(params.visibleSnapshot.visibleRenderedEndIndex !== undefined
            ? { visibleRenderedEndIndex: params.visibleSnapshot.visibleRenderedEndIndex }
            : {}),
        ...(params.visibleSnapshot.visibleWindowStale ? { visibleWindowStale: true } : {}),
        ...(params.visibleSnapshot.lastKnownFirstVisibleItemId ? { lastKnownFirstVisibleItemId: params.visibleSnapshot.lastKnownFirstVisibleItemId } : {}),
        ...(params.visibleSnapshot.lastKnownLastVisibleItemId ? { lastKnownLastVisibleItemId: params.visibleSnapshot.lastKnownLastVisibleItemId } : {}),
        blankAreaPx: params.visibleSnapshot.blankAreaPx,
        blankAreaSource: params.visibleSnapshot.blankAreaSource,
        visibleWindowSource: params.visibleSnapshot.visibleWindowSource,
        ...(nativeBlankWindowSignature ? { nativeBlankWindowSignature } : {}),
        listDataLength: params.listDataLength,
        fullItemCount: params.fullItemCount,
        entryRestoreState: params.entryRestoreState,
        prependState: params.prependState,
        layoutCacheClearState,
        layoutCacheClearReason,
        scrollToIndexFailureState,
    };
}
