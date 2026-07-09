import { Platform } from 'react-native';
import { sync } from '@/sync/sync';
import {
    configureTranscriptViewportTelemetryFromTuning,
    transcriptViewportTelemetry,
    type TranscriptViewportTelemetryEvent,
    type TranscriptViewportTelemetryObservationReason,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptViewportMode } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export type RestoreDecisionTelemetryParams = Readonly<{
    anchorCorrectionAttempt?: number;
    anchorCorrectionTargetOffsetY?: number;
    anchorDeltaPx?: number;
    anchorIndex?: number;
    anchorItemOffsetPx?: number;
    anchorObservedItemOffsetPx?: number;
    anchorRestoreViewOffset?: number;
    contentHeight?: number;
    distanceFromBottom?: number;
    layoutHeight?: number;
    mode?: TranscriptViewportMode;
    offsetY?: number;
    programmaticWebWrite?: boolean;
    scrollable?: boolean;
    webTrigger?: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
}>;

export type ScrollObservedTelemetryParams = Readonly<{
    contentHeight?: number;
    distanceFromBottom: number;
    layoutHeight?: number;
    offsetY: number;
    rawOffsetY?: number;
    canonicalOffsetY?: number;
    reason?: TranscriptViewportTelemetryObservationReason;
}>;

export type NativeVisibleWindowTelemetryParams = Readonly<{
    canonicalOffsetY?: number;
    contentHeight?: number;
    distanceFromBottom?: number;
    layoutHeight?: number;
    rawOffsetY?: number;
}>;

export type NativeVisibleSourceRange = Readonly<{
    firstSourceIndex?: number;
    lastSourceIndex?: number;
}> | null;

export function buildRestoreDecisionTelemetryEvent(params: Readonly<{
    mode: TranscriptViewportMode;
    reason: TranscriptViewportTelemetryObservationReason;
    restore: RestoreDecisionTelemetryParams;
    webMetrics: WebTranscriptScrollMetrics | null;
    resolveWebDiagnostics: (params: Readonly<{
        flashListContentHeight?: number;
        flashListLayoutHeight?: number;
        metrics: WebTranscriptScrollMetrics | null;
        programmaticWebWrite: boolean;
        scrollable?: boolean;
        trigger: 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';
    }>) => Readonly<Record<string, unknown>>;
}>): Readonly<Record<string, unknown> & {
    mode: TranscriptViewportMode;
    type: TranscriptViewportTelemetryEvent['type'];
}> {
    const restore = params.restore;
    return {
        type: 'restore-decision',
        mode: params.mode,
        reason: params.reason,
        offsetY: restore.offsetY,
        layoutHeight: restore.layoutHeight,
        contentHeight: restore.contentHeight,
        distanceFromBottom: restore.distanceFromBottom,
        anchorIndex: restore.anchorIndex,
        anchorItemOffsetPx: restore.anchorItemOffsetPx,
        anchorObservedItemOffsetPx: restore.anchorObservedItemOffsetPx,
        anchorDeltaPx: restore.anchorDeltaPx,
        anchorCorrectionAttempt: restore.anchorCorrectionAttempt,
        anchorCorrectionTargetOffsetY: restore.anchorCorrectionTargetOffsetY,
        anchorRestoreViewOffset: restore.anchorRestoreViewOffset,
        ...(Platform.OS === 'web' ? params.resolveWebDiagnostics({
            metrics: params.webMetrics,
            flashListContentHeight: restore.contentHeight,
            flashListLayoutHeight: restore.layoutHeight,
            programmaticWebWrite: restore.programmaticWebWrite ?? false,
            scrollable: restore.scrollable,
            trigger: restore.webTrigger ?? (restore.mode === 'jump-to-bottom' ? 'jump' : 'restore'),
        }) : {}),
    };
}

export function buildScrollObservedTelemetryEvent(params: Readonly<{
    mode: TranscriptViewportMode;
    scroll: ScrollObservedTelemetryParams;
}>): Readonly<Record<string, unknown> & {
    mode: TranscriptViewportMode;
    type: TranscriptViewportTelemetryEvent['type'];
}> {
    return {
        type: 'scroll-observed',
        mode: params.mode,
        reason: params.scroll.reason ?? 'observed',
        offsetY: params.scroll.offsetY,
        rawOffsetY: params.scroll.rawOffsetY,
        canonicalOffsetY: params.scroll.canonicalOffsetY,
        layoutHeight: params.scroll.layoutHeight,
        contentHeight: params.scroll.contentHeight,
        distanceFromBottom: params.scroll.distanceFromBottom,
    };
}

export function resolveNativeVisibleWindowTelemetryEvent(params: Readonly<{
    contentHeight?: number;
    distanceFromBottom?: number;
    layoutHeight?: number;
    mode: TranscriptViewportMode;
    observedOffset: Readonly<{
        canonicalOffsetY?: number;
        distanceFromLiveTailPx?: number;
    }> | null;
    readRawOffsetY: () => number | null;
    reason: TranscriptViewportTelemetryObservationReason;
    source: NativeVisibleWindowTelemetryParams;
    visibleSourceRange: NativeVisibleSourceRange;
}>): Readonly<Record<string, unknown> & {
    mode: TranscriptViewportMode;
    type: TranscriptViewportTelemetryEvent['type'];
}> | null {
    if (Platform.OS === 'web') return null;
    configureTranscriptViewportTelemetryFromTuning(sync.getSyncTuning());
    if (!transcriptViewportTelemetry.isEnabled()) return null;
    const rawOffsetY = params.source.rawOffsetY ?? params.readRawOffsetY() ?? undefined;
    const canonicalOffsetY =
        params.source.canonicalOffsetY ?? params.observedOffset?.canonicalOffsetY;
    const distanceFromBottom =
        params.source.distanceFromBottom ?? params.observedOffset?.distanceFromLiveTailPx;
    return {
        type: 'visible-window-observed',
        mode: params.mode,
        reason: params.reason,
        rawOffsetY,
        canonicalOffsetY,
        offsetY: canonicalOffsetY,
        layoutHeight: params.layoutHeight,
        contentHeight: params.contentHeight,
        distanceFromBottom,
        firstVisibleSourceIndex: params.visibleSourceRange?.firstSourceIndex,
        lastVisibleSourceIndex: params.visibleSourceRange?.lastSourceIndex,
    };
}
