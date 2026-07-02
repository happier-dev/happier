import * as React from 'react';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

export type SyncPerformanceReactProfilerRender = Readonly<{
    id: string;
    phase: 'mount' | 'update' | 'nested-update';
    actualDuration: number;
    baseDuration: number;
    startTime: number;
    commitTime: number;
}>;

function sanitizeProfilerId(id: string): string {
    const trimmed = id.trim();
    return trimmed.replace(/[^a-zA-Z0-9_.-]+/g, '.').replace(/^\.+|\.+$/g, '') || 'unknown';
}

function finiteNonNegative(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function recordReactProfilerRenderTelemetry(render: SyncPerformanceReactProfilerRender): void {
    if (!syncPerformanceTelemetry.isEnabled()) return;
    const eventName = `ui.react.render.${sanitizeProfilerId(render.id)}`;
    const actualDuration = finiteNonNegative(render.actualDuration);
    const baseDuration = finiteNonNegative(render.baseDuration);
    const commitLagMs = finiteNonNegative(render.commitTime - render.startTime);
    syncPerformanceTelemetry.recordDuration(eventName, actualDuration, {
        actualDurationMs: actualDuration,
        baseDurationMs: baseDuration,
        commitLagMs,
        mount: render.phase === 'mount' ? 1 : 0,
        update: render.phase === 'update' ? 1 : 0,
        nestedUpdate: render.phase === 'nested-update' ? 1 : 0,
    });
}

export function SyncPerformanceReactProfiler(props: Readonly<{
    id: string;
    children: React.ReactNode;
    enabled?: boolean;
}>): React.ReactElement {
    const onRender = React.useCallback<React.ProfilerOnRenderCallback>((
        id,
        phase,
        actualDuration,
        baseDuration,
        startTime,
        commitTime,
    ) => {
        recordReactProfilerRenderTelemetry({
            id,
            phase,
            actualDuration,
            baseDuration,
            startTime,
            commitTime,
        });
    }, []);

    if (props.enabled === false || !syncPerformanceTelemetry.isEnabled()) {
        return <>{props.children}</>;
    }

    return (
        <React.Profiler id={props.id} onRender={onRender}>
            {props.children}
        </React.Profiler>
    );
}
