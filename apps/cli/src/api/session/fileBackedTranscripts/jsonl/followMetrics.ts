export type JsonlFollowerResetReason = 'replaced' | 'truncated';

export type JsonlFollowerDrainSource = 'manual' | 'poll' | 'queued' | 'watcher';

export type JsonlFollowerMetricEvent =
    | Readonly<{ type: 'started' }>
    | Readonly<{ type: 'stopped' }>
    | Readonly<{ type: 'controller_started' }>
    | Readonly<{ type: 'controller_stopped' }>
    | Readonly<{ type: 'controller_disposed' }>
    | Readonly<{ type: 'watcher_wakeup' }>
    | Readonly<{ type: 'poll_wakeup' }>
    | Readonly<{ type: 'missing_file_retry_scheduled'; delayMs: number }>
    | Readonly<{ type: 'drain_requested'; source: JsonlFollowerDrainSource }>
    | Readonly<{ type: 'drain_queued' }>
    | Readonly<{ type: 'drain_started'; source: JsonlFollowerDrainSource }>
    | Readonly<{ type: 'drain_finished'; bytesRead: number; rowsEmitted: number }>
    | Readonly<{ type: 'bytes_read'; bytes: number }>
    | Readonly<{ type: 'row_emitted' }>
    | Readonly<{ type: 'file_reset'; reason: JsonlFollowerResetReason }>;

export type JsonlFollowerMetrics = Readonly<{
    onEvent: (event: JsonlFollowerMetricEvent) => void;
}>;

export function emitJsonlFollowerMetric(
    metrics: JsonlFollowerMetrics | undefined,
    event: JsonlFollowerMetricEvent,
): void {
    metrics?.onEvent(event);
}
