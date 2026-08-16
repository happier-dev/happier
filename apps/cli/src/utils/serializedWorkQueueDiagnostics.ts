export type SerializedWorkDiagnosticValue = string | number | boolean | null;

export type SerializedWorkDiagnosticContext = Readonly<{
  operation: string;
  details?: Readonly<Record<string, SerializedWorkDiagnosticValue>>;
}>;

export type SerializedWorkQueueDiagnosticReport = Readonly<{
  phase: 'slow';
  queueName: string;
  reason: 'active_duration' | 'queue_wait';
  sequence: number;
  operation: string;
  details: Readonly<Record<string, SerializedWorkDiagnosticValue>>;
  activeForMs: number;
  queuedForMs: number;
  depth: number;
  peakDepth: number;
}> | Readonly<{
  phase: 'recovered';
  queueName: string;
  incidentForMs: number;
  peakDepth: number;
}>;

type TrackedWork = Readonly<{
  run<T>(work: () => Promise<T>): Promise<T>;
}>;

/**
 * Slow-path-only observability for promise-tail queues.
 *
 * The queue remains owned by the caller. This helper observes enqueue/start/finish and emits at
 * most one slow report plus one recovery report for a continuous incident. It intentionally does
 * not log normal work or retain payloads.
 */
export function createSerializedWorkQueueDiagnostics(params: Readonly<{
  queueName: string;
  slowAfterMs: number;
  report: (report: SerializedWorkQueueDiagnosticReport) => void;
}>): Readonly<{
  track(context: SerializedWorkDiagnosticContext): TrackedWork;
}> {
  let nextSequence = 0;
  let depth = 0;
  let peakDepth = 0;
  let queueEpisodeStartedAtMs: number | null = null;
  let incidentStartedAtMs: number | null = null;

  const emit = (report: SerializedWorkQueueDiagnosticReport): void => {
    try {
      params.report(report);
    } catch {
      // Diagnostics must never change queue execution or process liveness.
    }
  };

  const reportSlowOnce = (input: Readonly<{
    reason: 'active_duration' | 'queue_wait';
    sequence: number;
    context: SerializedWorkDiagnosticContext;
    activeForMs: number;
    queuedForMs: number;
  }>): void => {
    if (incidentStartedAtMs !== null) return;
    incidentStartedAtMs = Date.now();
    emit({
      phase: 'slow',
      queueName: params.queueName,
      reason: input.reason,
      sequence: input.sequence,
      operation: input.context.operation,
      details: input.context.details ?? {},
      activeForMs: input.activeForMs,
      queuedForMs: input.queuedForMs,
      depth,
      peakDepth,
    });
  };

  return Object.freeze({
    track(context): TrackedWork {
      const sequence = ++nextSequence;
      const queuedAtMs = Date.now();
      if (depth === 0) queueEpisodeStartedAtMs = queuedAtMs;
      depth += 1;
      peakDepth = Math.max(peakDepth, depth);

      return Object.freeze({
        async run<T>(work: () => Promise<T>): Promise<T> {
          const startedAtMs = Date.now();
          const queuedForMs = Math.max(0, startedAtMs - queuedAtMs);
          if (queuedForMs >= params.slowAfterMs) {
            reportSlowOnce({
              reason: 'queue_wait',
              sequence,
              context,
              activeForMs: 0,
              queuedForMs,
            });
          }

          const slowTimer = setTimeout(() => {
            reportSlowOnce({
              reason: 'active_duration',
              sequence,
              context,
              activeForMs: Math.max(0, Date.now() - startedAtMs),
              queuedForMs,
            });
          }, params.slowAfterMs);
          slowTimer.unref?.();

          try {
            return await work();
          } finally {
            clearTimeout(slowTimer);
            depth = Math.max(0, depth - 1);
            if (depth === 0) {
              if (incidentStartedAtMs !== null) {
                emit({
                  phase: 'recovered',
                  queueName: params.queueName,
                  incidentForMs: Math.max(
                    0,
                    Date.now() - (queueEpisodeStartedAtMs ?? incidentStartedAtMs),
                  ),
                  peakDepth,
                });
              }
              queueEpisodeStartedAtMs = null;
              incidentStartedAtMs = null;
              peakDepth = 0;
            }
          }
        },
      });
    },
  });
}
