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
    TranscriptViewportCommand,
    TranscriptViewportMode,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { TranscriptRendererDataTarget } from '@/components/sessions/transcript/viewport/window/resolveTranscriptRenderWindowProjection';
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
    lastPinOffsetForIntentRef: { readonly current: number | null };
    webDomObservation: WebDomScrollObservation;
    lastNativeRestoreIndexCommandRef: { current: LastNativeRestoreIndexCommand | null };
    nativeMountSettleStable: boolean;
    telemetryPlatform: ReturnType<typeof resolveTranscriptViewportTelemetryPlatform>;
    resolveRendererDataTarget: (
        command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'restore-anchor' | 'jump-to-seq' }>>,
    ) => TranscriptRendererDataTarget | null;
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
}>;
