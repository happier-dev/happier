import {
    configureTranscriptViewportTelemetryFromTuning,
    type TranscriptViewportTelemetryTuning,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import { deriveNativeTranscriptVisibleAnchorFacts } from '@/components/sessions/transcript/viewport/visibility/nativeTranscriptVisibleAnchorFacts';
import { getTranscriptNavigationVisibilityStore } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import type { TranscriptNavigationRuntimeAnchor } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationRuntimeAnchors';
import type { TranscriptListOrientation } from '@/components/sessions/transcript/listOrientation';
import type { NativeVisibleWindowSnapshot } from './nativeVisibleWindow';

export type NativeViewableTranscriptItem = Readonly<{
    index?: number | null;
    isViewable?: boolean;
    item?: { id: string } | null;
}>;

export function resolveNativeViewabilityTelemetry(params: Readonly<{
    info: Readonly<{ viewableItems?: readonly NativeViewableTranscriptItem[] }>;
    itemCount: number;
    layoutHeight: number;
    listOrientation: TranscriptListOrientation;
    runtimeAnchors: readonly TranscriptNavigationRuntimeAnchor[];
    sessionId: string;
    syncTuning: TranscriptViewportTelemetryTuning;
}>): Readonly<{
    observeBlankRecovery: boolean;
    snapshot: NativeVisibleWindowSnapshot;
}> | null {
    const viewableItems = Array.isArray(params.info.viewableItems) ? params.info.viewableItems : [];
    const visibilityStore = getTranscriptNavigationVisibilityStore(params.sessionId);
    if (params.runtimeAnchors.length > 0 && visibilityStore.hasSubscribers()) {
        visibilityStore.set(deriveNativeTranscriptVisibleAnchorFacts({
            anchors: params.runtimeAnchors,
            itemCount: params.itemCount,
            orientation: params.listOrientation,
            preferUserTurnAnchor: true,
            viewableItems,
        }));
    } else if (visibilityStore.hasSubscribers()) {
        visibilityStore.set(null);
    }
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
