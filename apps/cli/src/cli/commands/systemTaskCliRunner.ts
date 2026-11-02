import {
  type SystemTaskEvent,
  type SystemTaskJsonObject,
  type SystemTaskJsonValue,
  type SystemTaskResult,
  type SystemTaskSpec,
} from '@happier-dev/protocol';

export type CliSystemTasksRunnerAdapter = Readonly<{
  start: (params: Readonly<{ spec: SystemTaskSpec }>) => Promise<Readonly<{ taskId: string }>>;
  poll: (params: Readonly<{ taskId: string; cursor: number }>) => Promise<Readonly<{
    events: SystemTaskEvent[];
    nextCursor: number;
    result: SystemTaskResult | null;
    pendingPrompt: Readonly<{ kind: string; data: SystemTaskJsonObject }> | null;
  }>>;
  respond: (params: Readonly<{ taskId: string; answer: unknown }>) => Promise<SystemTaskJsonValue | void>;
  cancel?: (params: Readonly<{ taskId: string }>) => Promise<void>;
}>;

type TaskPrompt = Readonly<{ kind: string; data: SystemTaskJsonObject }>;

function cancelledError(): Error & Readonly<{ code: 'cancelled' }> {
  return Object.assign(new Error('System task execution was cancelled.'), { code: 'cancelled' as const });
}

function promptFromEvent(event: SystemTaskEvent): TaskPrompt | null {
  if (event.type !== 'prompt' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return null;
  const kind = typeof (event.data as SystemTaskJsonObject).kind === 'string'
    ? String((event.data as SystemTaskJsonObject).kind).trim()
    : '';
  return kind ? { kind, data: event.data as SystemTaskJsonObject } : null;
}

/**
 * The single CLI start/poll/respond/cancel loop for live system tasks. Command owners provide only
 * presentation and prompt policy; cursor progression, cancellation checks and task failure
 * propagation stay identical for every caller.
 */
export async function runSystemTaskToCompletion(params: Readonly<{
  runner: CliSystemTasksRunnerAdapter;
  spec: SystemTaskSpec;
  signal?: AbortSignal;
  onEvent?: (event: SystemTaskEvent) => Promise<void> | void;
  onPrompt?: (prompt: TaskPrompt, message: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}>): Promise<SystemTaskResult> {
  if (params.signal?.aborted) throw cancelledError();
  const { taskId } = await params.runner.start({ spec: params.spec });
  let cursor = 0;
  let lastPromptMessage = '';
  let cancelPromise: Promise<void> | null = null;
  const sleep = params.sleep ?? (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)));
  const requestCancellation = () => {
    cancelPromise ??= params.runner.cancel
      ? params.runner.cancel({ taskId })
      : Promise.reject(Object.assign(new Error('System task runner does not support cancellation.'), { code: 'cancellation_unavailable' }));
  };
  params.signal?.addEventListener('abort', requestCancellation, { once: true });

  try {
    if (params.signal?.aborted) requestCancellation();
    while (true) {
      if (cancelPromise) await cancelPromise;
      const snapshot = await params.runner.poll({ taskId, cursor });
      cursor = snapshot.nextCursor;
      let promptFromEvents: TaskPrompt | null = null;

      for (const event of snapshot.events) {
        if (event.type === 'prompt') {
          lastPromptMessage = event.message ?? '';
          promptFromEvents = promptFromEvent(event) ?? promptFromEvents;
        }
        await params.onEvent?.(event);
      }

      if (snapshot.result) return snapshot.result;
      const prompt = snapshot.pendingPrompt ?? promptFromEvents;
      if (prompt) {
        if (!params.onPrompt) throw Object.assign(new Error(`System task requires unsupported input: ${prompt.kind}`), { code: 'prompt_required' });
        let answer: unknown;
        try {
          answer = await params.onPrompt(prompt, lastPromptMessage);
        } catch (error) {
          // An abort can reject the local prompt before the runner finishes releasing prompt and
          // operation custody. Keep consuming the canonical task until it publishes its result.
          if (!cancelPromise) throw error;
          await cancelPromise;
          continue;
        }
        try {
          await params.runner.respond({ taskId, answer });
        } catch (error) {
          // Cancellation can settle a task while its CLI prompt is being answered. Prefer the
          // runner's terminal result over surfacing a stale-prompt error from that race.
          const settled = await params.runner.poll({ taskId, cursor });
          cursor = settled.nextCursor;
          if (settled.result) return settled.result;
          throw error;
        }
        lastPromptMessage = '';
        continue;
      }
      await sleep(params.pollIntervalMs ?? 50);
    }
  } finally {
    params.signal?.removeEventListener('abort', requestCancellation);
  }
}
