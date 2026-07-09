import type {
    TranscriptViewportTelemetryEvent,
    TranscriptViewportTelemetryObservationReason,
    resolveTranscriptViewportTelemetryPlatform,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type {
    LastNativeRestoreIndexCommand,
    ScrollableChatListRef,
} from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type {
    TranscriptViewportAnchorIdentity,
    TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { TranscriptJumpTargetRole } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { WebDomScrollObservation } from './webDomObservation';

export type TranscriptViewportDriverWriteResult =
    | Readonly<{ ok: true; landedScrollTop: number; targetScrollTop: number }>
    | Readonly<{ ok: false; reason: 'invalid_geometry' | 'not_found' | 'write_failed' }>;

export type WebDomTranscriptItemAlignment =
    | Readonly<{ kind: 'center' }>
    | Readonly<{ kind: 'top-with-item-offset'; itemOffsetPx: number }>;

export type WebDomMeasuredItemLayout = Readonly<{
    height: number;
    y: number;
}>;

export type TranscriptViewportListDataItem = Readonly<{ id?: string }>;

export type TranscriptViewportListData = Readonly<{
    length: number;
    [index: number]: TranscriptViewportListDataItem | undefined;
}>;

export type TranscriptViewportDriverDeps = Readonly<{
    listRef: { readonly current: ScrollableChatListRef | null };
    listContentHeightRef: { readonly current: number };
    listLayoutHeightRef: { readonly current: number };
    listDataRef: { readonly current: TranscriptViewportListData };
    itemsRef: { readonly current: TranscriptViewportListData };
    composerInsetHeightRef: { readonly current: number };
    nativeHotTailHeightRef: { readonly current: number };
    lastPinOffsetForIntentRef: { readonly current: number | null };
    lastNativePinOffsetRef: { readonly current: number | null };
    webDomObservation: WebDomScrollObservation;
    lastNativeRestoreIndexCommandRef: { current: LastNativeRestoreIndexCommand | null };
    nativeMountSettleStable: boolean;
    telemetryPlatform: ReturnType<typeof resolveTranscriptViewportTelemetryPlatform>;
    shouldUseNativeHotColdSplit: boolean;
    /**
     * Live web hot/cold facts (ref-read at command time). Jump/restore commands can run inside
     * long async flows (window materialization + landing settle); captured boolean/count values
     * go stale when the window re-slices mid-flight and remap the write into the wrong index
     * space. `hotCount > 0` means the web hot/cold split is active.
     */
    webHotColdCountsRef: { readonly current: Readonly<{ coldCount: number; hotCount: number }> };
    clearWebPrependRangeReserve: () => void;
    resolveRestoreAnchorIndex: (anchor: TranscriptViewportAnchorIdentity) => number | null;
    resolveJumpToSeqIndex: (
        seq: number,
        routeMessageId?: string | null,
        transcriptBlockIndex?: number | null,
        role?: TranscriptJumpTargetRole | null,
    ) => number | null;
    resolveWebScrollMetrics: () => WebTranscriptScrollMetrics | null;
    recordViewportTelemetryEvent: (
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ) => void;
    recordRestoreDecisionTelemetry: (
        reason: TranscriptViewportTelemetryObservationReason,
        params?: Readonly<{ mode?: TranscriptViewportMode; contentHeight?: number; layoutHeight?: number }>,
    ) => void;
    resolveWebViewportTelemetryDiagnostics: (params: Readonly<{
        metrics: WebTranscriptScrollMetrics | null;
        programmaticWebWrite: boolean;
        scrollable: boolean | undefined;
        trigger: 'prepend-restore' | 'jump' | 'restore';
    }>) => Record<string, unknown>;
    resolveInvertedBottomPinCarveTelemetryFields: () => Record<string, unknown>;
}>;
