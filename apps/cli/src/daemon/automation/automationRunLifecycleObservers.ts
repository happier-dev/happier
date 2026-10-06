import { ExecutionRunWaitResultSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { AutomationRunLifecycleSource, AutomationRunLifecycleOccurrenceEvidenceV1 } from '@happier-dev/protocol';

type Source = Extract<AutomationRunLifecycleSource, { kind: 'execution_run' }>;

/** Composes the existing event-backed Run wait, including its retained baseline/reconnect read. */
export function createAutomationRunLifecycleObservers(deps: Readonly<{
  wait: (source: Source, signal: AbortSignal) => Promise<unknown>;
  report: (occurrence: AutomationRunLifecycleOccurrenceEvidenceV1, signal: AbortSignal) => Promise<void>;
  onError: (error: unknown, source: Source) => void;
}>) {
  const observers = new Map<string, AbortController>();
  const clear = () => {
    for (const controller of observers.values()) controller.abort();
    observers.clear();
  };
  return {
    clear,
    replace(sources: readonly Source[]) {
      const current = new Map(sources.map(source => [JSON.stringify(source), source]));
      for (const [key, controller] of observers) {
        if (current.has(key)) continue;
        controller.abort();
        observers.delete(key);
      }
      for (const [key, source] of current) {
        if (observers.has(key)) continue;
        const controller = new AbortController();
        observers.set(key, controller);
        void (async () => {
          try {
            while (!controller.signal.aborted) {
              const result = ExecutionRunWaitResultSchema.parse(await deps.wait(source, controller.signal));
              if (controller.signal.aborted) return;
              if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
              // Only the canonical wait's observation timeout reopens its event subscription.
              if (result.status === 'running') continue;
              if (result.result.run.runId !== source.runId) throw new Error('execution_run_source_mismatch');
              const finishedAt = result.result.run.finishedAtMs;
              if (finishedAt === undefined) throw new Error('execution_run_terminal_fact_unavailable');
              await deps.report({ v: 1, kind: 'runLifecycle', source, condition: 'terminal',
                sourceRevision: finishedAt, occurredAt: finishedAt }, controller.signal);
              return;
            }
          } catch (error) {
            if (controller.signal.aborted) return;
            // Incumbent assignment refresh/reconnect retries from the retained terminal owner.
            if (observers.get(key) === controller) observers.delete(key);
            deps.onError(error, source);
          }
        })();
      }
    },
  };
}
