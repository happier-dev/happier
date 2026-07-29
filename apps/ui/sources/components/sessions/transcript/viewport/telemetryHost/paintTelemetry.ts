import * as React from 'react';
import { Platform } from 'react-native';
import {
    getWebTranscriptDistanceFromBottom,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    hasTranscriptWarmStablePaint,
    rememberTranscriptWarmStablePaint,
} from '@/components/sessions/transcript/paint/transcriptWarmPaintCache';
import type { TranscriptViewportPlatform } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import {
    readSessionUiTelemetryNowMs,
    recordSessionOpenPaintForSessionUiTelemetry,
} from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { TranscriptPaintTelemetryState } from './useTranscriptTelemetryHost';

export type TranscriptPaintMetrics = Readonly<{
    contentHeight: number;
    distanceFromBottom: number;
    layoutHeight: number;
}>;

type ReadRef<T> = Readonly<{ current: T }>;

export function recordFirstListPaintTelemetry(params: Readonly<{
    committedMessagesCount: number;
    itemCount: number;
    platformOS: string;
    routeHydrationPending: boolean;
    sessionId: string;
    telemetryState: TranscriptPaintTelemetryState | null;
}>): boolean {
    const telemetryState = params.telemetryState;
    if (
        telemetryState &&
        telemetryState.sessionId === params.sessionId &&
        telemetryState.recorded === false &&
        syncPerformanceTelemetry.isEnabled()
    ) {
        telemetryState.recorded = true;
        syncPerformanceTelemetry.recordDuration(
            'ui.sessions.transcript.firstPaint',
            readSessionUiTelemetryNowMs() - telemetryState.startedAtMs,
            {
                committedMessages: params.committedMessagesCount,
                items: params.itemCount,
                native: params.platformOS === 'web' ? 0 : 1,
                routeHydrationPending: params.routeHydrationPending ? 1 : 0,
                web: params.platformOS === 'web' ? 1 : 0,
            },
        );
        recordSessionOpenPaintForSessionUiTelemetry({
            committedMessages: params.committedMessagesCount,
            items: params.itemCount,
            native: params.platformOS === 'web' ? 0 : 1,
            phase: 'firstPaint',
            routeHydrationPending: params.routeHydrationPending ? 1 : 0,
            sessionId: params.sessionId,
            web: params.platformOS === 'web' ? 1 : 0,
        });
        return true;
    }
    return false;
}

export function recordStablePaintTelemetry(params: Readonly<{
    clearWebStablePaintRetry: () => void;
    committedMessagesCount: number;
    firstListPaintObserved: boolean;
    isWarmKeepAliveInstance: boolean;
    itemCount: number;
    nativeMountSettleDeadlineReached: boolean;
    nativeMountSettleStable: boolean;
    nativeViewportObserved: boolean;
    paintMetrics: TranscriptPaintMetrics;
    platformOS: string;
    routeHydrationPending: boolean;
    sessionId: string;
    telemetryState: TranscriptPaintTelemetryState | null;
}>): boolean {
    const telemetryState = params.telemetryState;
    if (
        !telemetryState ||
        telemetryState.sessionId !== params.sessionId ||
        telemetryState.recorded === true ||
        !syncPerformanceTelemetry.isEnabled()
    ) {
        return false;
    }
    params.clearWebStablePaintRetry();
    telemetryState.recorded = true;
    syncPerformanceTelemetry.recordDuration(
        'ui.sessions.transcript.stablePaint',
        readSessionUiTelemetryNowMs() - telemetryState.startedAtMs,
        {
            committedMessages: params.committedMessagesCount,
            contentHeight: params.paintMetrics.contentHeight,
            distanceFromBottom: params.paintMetrics.distanceFromBottom,
            firstListPaintObserved: params.firstListPaintObserved ? 1 : 0,
            items: params.itemCount,
            layoutHeight: params.paintMetrics.layoutHeight,
            native: params.platformOS === 'web' ? 0 : 1,
            nativeMountSettleDeadlineReached: params.nativeMountSettleDeadlineReached ? 1 : 0,
            nativeMountSettleStable: params.nativeMountSettleStable ? 1 : 0,
            nativeViewportObserved: params.nativeViewportObserved ? 1 : 0,
            routeHydrationPending: params.routeHydrationPending ? 1 : 0,
            warmKeepAlive: params.isWarmKeepAliveInstance ? 1 : 0,
            web: params.platformOS === 'web' ? 1 : 0,
        },
    );
    recordSessionOpenPaintForSessionUiTelemetry({
        committedMessages: params.committedMessagesCount,
        distanceFromBottom: params.paintMetrics.distanceFromBottom,
        items: params.itemCount,
        native: params.platformOS === 'web' ? 0 : 1,
        phase: 'stablePaint',
        routeHydrationPending: params.routeHydrationPending ? 1 : 0,
        sessionId: params.sessionId,
        web: params.platformOS === 'web' ? 1 : 0,
    });
    return true;
}

export function useTranscriptPaintTelemetry(params: Readonly<{
    clearWebStablePaintRetry: () => void;
    committedMessagesCount: number;
    firstListPaintObserved: boolean;
    firstPaintTelemetryRef: ReadRef<TranscriptPaintTelemetryState | null>;
    isWarmKeepAliveInstanceProp: boolean;
    itemCount: number;
    lastPinOffsetForIntentRef: ReadRef<number | null>;
    latestCommittedActivityKey: string | null;
    listDataRef: ReadRef<readonly unknown[]>;
    nativeMountSettleDeadlineReached: boolean;
    nativeMountSettleStable: boolean;
    observeMountSettleMetrics: (params: Readonly<{ nowMs: number }>) => void;
    platformOS: string;
    readViewportContentMetrics: () => Readonly<{ contentHeight: number; layoutHeight: number }> | null;
    recordMountSettleFirstListPaint: (params: Readonly<{ nowMs: number; sessionId: string }>) => void;
    recordNativeVisibleWindowTelemetry: () => void;
    releaseNativePaintForIssuedEntryRestore: () => void;
    resolveWebScrollMetrics: () => WebTranscriptScrollMetrics | null;
    routeHydrationPending: boolean;
    sessionId: string;
    setFirstListPaintObserved: (value: boolean) => void;
    stablePaintTelemetryRef: ReadRef<TranscriptPaintTelemetryState | null>;
    telemetryPlatform: TranscriptViewportPlatform;
}>) {
    const {
        clearWebStablePaintRetry,
        committedMessagesCount,
        firstListPaintObserved,
        firstPaintTelemetryRef,
        isWarmKeepAliveInstanceProp,
        itemCount,
        lastPinOffsetForIntentRef,
        latestCommittedActivityKey,
        listDataRef,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        observeMountSettleMetrics,
        platformOS,
        readViewportContentMetrics,
        recordMountSettleFirstListPaint,
        recordNativeVisibleWindowTelemetry,
        releaseNativePaintForIssuedEntryRestore,
        resolveWebScrollMetrics,
        routeHydrationPending,
        sessionId,
        setFirstListPaintObserved,
        stablePaintTelemetryRef,
        telemetryPlatform,
    } = params;
    const resolveEffectiveListPaintMetrics = React.useCallback((): TranscriptPaintMetrics | null => {
        if (platformOS === 'web') {
            const webMetrics = resolveWebScrollMetrics();
            if (webMetrics && webMetrics.clientHeight > 0 && webMetrics.scrollHeight > 0) {
                return {
                    contentHeight: Math.max(0, Math.trunc(webMetrics.scrollHeight)),
                    distanceFromBottom: Math.max(0, Math.trunc(getWebTranscriptDistanceFromBottom(webMetrics))),
                    layoutHeight: Math.max(0, Math.trunc(webMetrics.clientHeight)),
                };
            }
        }

        const measuredMetrics = readViewportContentMetrics();
        if (measuredMetrics && measuredMetrics.contentHeight > 0) {
            const distanceFromBottom =
                typeof lastPinOffsetForIntentRef.current === 'number' &&
                Number.isFinite(lastPinOffsetForIntentRef.current)
                    ? Math.max(0, Math.trunc(lastPinOffsetForIntentRef.current))
                    : 0;
            return {
                contentHeight: Math.max(0, Math.trunc(measuredMetrics.contentHeight)),
                distanceFromBottom,
                layoutHeight: Math.max(0, Math.trunc(measuredMetrics.layoutHeight)),
            };
        }

        return null;
    }, [lastPinOffsetForIntentRef, platformOS, readViewportContentMetrics, resolveWebScrollMetrics]);

    const hasWarmStablePaint = hasTranscriptWarmStablePaint({
        committedMessagesCount,
        items: itemCount,
        latestCommittedActivityKey,
        platform: telemetryPlatform,
        routeHydrationPending,
        sessionId,
    });
    const isWarmKeepAliveInstance = isWarmKeepAliveInstanceProp || hasWarmStablePaint;

    const recordFirstListPaint = React.useCallback(() => {
        setFirstListPaintObserved(true);
        const nowMs = Date.now();
        recordFirstListPaintTelemetry({
            committedMessagesCount,
            itemCount: listDataRef.current.length,
            platformOS,
            routeHydrationPending,
            sessionId,
            telemetryState: firstPaintTelemetryRef.current,
        });
        recordMountSettleFirstListPaint({
            sessionId,
            nowMs,
        });
        observeMountSettleMetrics({ nowMs });
        releaseNativePaintForIssuedEntryRestore();
    }, [
        committedMessagesCount,
        firstPaintTelemetryRef,
        listDataRef,
        observeMountSettleMetrics,
        platformOS,
        recordMountSettleFirstListPaint,
        releaseNativePaintForIssuedEntryRestore,
        routeHydrationPending,
        sessionId,
        setFirstListPaintObserved,
    ]);

    const handleListLoad = React.useCallback(() => {
        recordFirstListPaint();
        recordNativeVisibleWindowTelemetry();
    }, [recordFirstListPaint, recordNativeVisibleWindowTelemetry]);

    const recordStablePaint = React.useCallback((
        paintMetrics: TranscriptPaintMetrics,
        options: Readonly<{ nativeViewportObserved?: boolean }> = {},
    ): boolean => {
        if (options.nativeViewportObserved === true) {
            rememberTranscriptWarmStablePaint({
                committedMessagesCount,
                items: itemCount,
                latestCommittedActivityKey,
                platform: telemetryPlatform,
                routeHydrationPending,
                sessionId,
            });
        }
        return recordStablePaintTelemetry({
            clearWebStablePaintRetry,
            committedMessagesCount,
            firstListPaintObserved,
            isWarmKeepAliveInstance,
            itemCount,
            nativeMountSettleDeadlineReached,
            nativeMountSettleStable,
            nativeViewportObserved: options.nativeViewportObserved === true,
            paintMetrics,
            platformOS,
            routeHydrationPending,
            sessionId,
            telemetryState: stablePaintTelemetryRef.current,
        });
    }, [
        clearWebStablePaintRetry,
        committedMessagesCount,
        firstListPaintObserved,
        isWarmKeepAliveInstance,
        itemCount,
        latestCommittedActivityKey,
        nativeMountSettleDeadlineReached,
        nativeMountSettleStable,
        platformOS,
        routeHydrationPending,
        sessionId,
        stablePaintTelemetryRef,
        telemetryPlatform,
    ]);

    return React.useMemo(() => ({
        handleListLoad,
        isWarmKeepAliveInstance,
        recordFirstListPaint,
        recordStablePaintTelemetry: recordStablePaint,
        resolveEffectiveListPaintMetrics,
    }), [
        handleListLoad,
        isWarmKeepAliveInstance,
        recordFirstListPaint,
        recordStablePaint,
        resolveEffectiveListPaintMetrics,
    ]);
}

export function useTranscriptPaintTelemetryEffects(params: Readonly<{
    firstListPaintObserved: boolean;
    isLoaded: boolean;
    isWarmKeepAliveInstance: boolean;
    itemCount: number;
    listContentHeight: number;
    listLayoutHeight: number;
    nativeEntryRestorePaintReleased: boolean;
    nativeFirstPaintReleasedWithoutListLoad: boolean;
    nativeMountSettleDeadlineReached: boolean;
    nativeMountSettleStable: boolean;
    nativeViewportPaintObserved: boolean;
    nativeViewportPaintObservedRef: ReadRef<boolean>;
    pinThresholdPx: number;
    recordFirstListPaint: () => void;
    recordStablePaintTelemetry: (
        paintMetrics: TranscriptPaintMetrics,
        options?: Readonly<{ nativeViewportObserved?: boolean }>,
    ) => boolean;
    resolveEffectiveListPaintMetrics: () => TranscriptPaintMetrics | null;
    routeHydrationPending: boolean;
    scheduleWebStablePaintRetry: () => void;
    sessionEntryViewportRef: ReadRef<Readonly<{ shouldFollowBottom?: boolean }> | null>;
    sessionId: string;
    showFirstPaintPlaceholder: boolean;
    showRouteHydrationFirstPaintPlaceholder: boolean;
    webStablePaintRetryTick: number;
}>) {
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (params.firstListPaintObserved) return;
        if (!params.isLoaded) return;
        if (params.itemCount <= 0) return;
        if (params.showRouteHydrationFirstPaintPlaceholder) return;
        if (!params.resolveEffectiveListPaintMetrics()) return;

        params.recordFirstListPaint();
    }, [
        params.firstListPaintObserved,
        params.isLoaded,
        params.itemCount,
        params.listContentHeight,
        params.listLayoutHeight,
        params.recordFirstListPaint,
        params.resolveEffectiveListPaintMetrics,
        params.showRouteHydrationFirstPaintPlaceholder,
    ]);

    React.useEffect(() => {
        if (!params.isLoaded) return;
        if (params.itemCount <= 0) return;
        if (params.showFirstPaintPlaceholder) return;
        if (
            !params.firstListPaintObserved &&
            !params.isWarmKeepAliveInstance &&
            !params.nativeFirstPaintReleasedWithoutListLoad &&
            !params.nativeEntryRestorePaintReleased &&
            !params.nativeViewportPaintObserved &&
            !params.nativeViewportPaintObservedRef.current
        ) {
            return;
        }
        const paintMetrics = params.resolveEffectiveListPaintMetrics();
        if (!paintMetrics) {
            params.scheduleWebStablePaintRetry();
            return;
        }
        if (
            Platform.OS === 'web' &&
            params.sessionEntryViewportRef.current?.shouldFollowBottom !== false &&
            paintMetrics.distanceFromBottom > params.pinThresholdPx
        ) {
            params.scheduleWebStablePaintRetry();
            return;
        }
        params.recordStablePaintTelemetry(paintMetrics, {
            nativeViewportObserved: params.nativeViewportPaintObserved || params.nativeViewportPaintObservedRef.current,
        });
    }, [
        params.firstListPaintObserved,
        params.isLoaded,
        params.isWarmKeepAliveInstance,
        params.itemCount,
        params.listContentHeight,
        params.listLayoutHeight,
        params.nativeEntryRestorePaintReleased,
        params.nativeFirstPaintReleasedWithoutListLoad,
        params.nativeMountSettleDeadlineReached,
        params.nativeMountSettleStable,
        params.nativeViewportPaintObserved,
        params.pinThresholdPx,
        params.recordStablePaintTelemetry,
        params.resolveEffectiveListPaintMetrics,
        params.routeHydrationPending,
        params.scheduleWebStablePaintRetry,
        params.sessionId,
        params.showFirstPaintPlaceholder,
        params.webStablePaintRetryTick,
    ]);
}
