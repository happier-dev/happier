import {
    configureTranscriptViewportTelemetryFromTuning,
    type TranscriptViewportTelemetryTuning,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { NativeVisibleWindowSnapshot } from './nativeVisibleWindow';

export type NativeViewableTranscriptItem = Readonly<{
    index?: number | null;
    isViewable?: boolean;
    item?: { id: string } | null;
}>;

/**
 * Viewability telemetry only. Navigation visibility is NOT derived here: it is
 * published from the renderer's visible index window by the one visibility
 * owner, and viewability is merely one of the triggers that asks it to re-run
 * (it fires on layout-only changes that never produce a scroll event).
 */
export function resolveNativeViewabilityTelemetry(params: Readonly<{
    info: Readonly<{ viewableItems?: readonly NativeViewableTranscriptItem[] }>;
    itemCount: number;
    layoutHeight: number;
    syncTuning: TranscriptViewportTelemetryTuning;
}>): Readonly<{
    observeBlankRecovery: boolean;
    snapshot: NativeVisibleWindowSnapshot;
}> | null {
    const viewableItems = Array.isArray(params.info.viewableItems) ? params.info.viewableItems : [];
    configureTranscriptViewportTelemetryFromTuning(params.syncTuning);
    const visibleItems = viewableItems
        .filter((item) => item.isViewable !== false)
        .sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
    const first = visibleItems[0];
    const last = visibleItems[visibleItems.length - 1];
    const blankAreaPx =
        visibleItems.length === 0 &&
        params.itemCount > 0 &&
        Number.isFinite(params.layoutHeight) &&
        params.layoutHeight > 0
            ? Math.max(0, Math.trunc(params.layoutHeight))
            : 0;
    return {
        observeBlankRecovery: blankAreaPx > 0,
        snapshot: {
            blankAreaPx,
            blankAreaSource: blankAreaPx > 0 ? 'index-estimate' : 'none',
            firstVisibleItemId: first?.item?.id,
            hasVisibleRows: visibleItems.length > 0,
            lastVisibleItemId: last?.item?.id,
            visibleWindowSource: 'viewability-callback',
        },
    };
}
