import * as React from 'react';
import { readSessionUiTelemetryNowMs } from '@/sync/runtime/performance/sessionUiTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

export type TranscriptPaintTelemetryState = {
    recorded: boolean;
    sessionId: string;
    startedAtMs: number;
};

export function useTranscriptTelemetryHost(params: Readonly<{
    platformOS: string;
    sessionId: string;
}>) {
    const firstPaintTelemetryRef = React.useRef<TranscriptPaintTelemetryState | null>(null);
    const stablePaintTelemetryRef = React.useRef<TranscriptPaintTelemetryState | null>(null);
    const [webStablePaintRetryTick, bumpWebStablePaintRetryTick] = React.useReducer(
        (value: number) => (value + 1) % 1_000_000,
        0,
    );
    const webStablePaintRetryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearWebStablePaintRetry = React.useCallback(() => {
        const timeout = webStablePaintRetryTimeoutRef.current;
        if (timeout === null) return;
        clearTimeout(timeout);
        webStablePaintRetryTimeoutRef.current = null;
    }, []);
    const scheduleWebStablePaintRetry = React.useCallback(() => {
        if (!syncPerformanceTelemetry.isEnabled()) return;
        if (params.platformOS !== 'web') return;
        if (stablePaintTelemetryRef.current?.recorded === true) return;
        if (webStablePaintRetryTimeoutRef.current !== null) return;
        webStablePaintRetryTimeoutRef.current = setTimeout(() => {
            webStablePaintRetryTimeoutRef.current = null;
            bumpWebStablePaintRetryTick();
        }, 16);
    }, [params.platformOS]);
    if (firstPaintTelemetryRef.current?.sessionId !== params.sessionId) {
        firstPaintTelemetryRef.current = {
            recorded: false,
            sessionId: params.sessionId,
            startedAtMs: readSessionUiTelemetryNowMs(),
        };
    }
    if (stablePaintTelemetryRef.current?.sessionId !== params.sessionId) {
        stablePaintTelemetryRef.current = {
            recorded: false,
            sessionId: params.sessionId,
            startedAtMs: readSessionUiTelemetryNowMs(),
        };
    }

    React.useEffect(() => clearWebStablePaintRetry, [clearWebStablePaintRetry]);

    return React.useMemo(() => ({
        clearWebStablePaintRetry,
        firstPaintTelemetryRef,
        scheduleWebStablePaintRetry,
        stablePaintTelemetryRef,
        webStablePaintRetryTick,
    }), [
        clearWebStablePaintRetry,
        scheduleWebStablePaintRetry,
        webStablePaintRetryTick,
    ]);
}
