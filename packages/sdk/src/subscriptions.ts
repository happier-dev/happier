import { followTranscriptSourceWithFiniteActions } from '@happier-dev/agents/runtime/facets/transcriptSource';

import type { PublicActionInputById, PublicActionResultById } from './actions/generated.js';
import { HappierTransportError } from './errors.js';
import type { ActionExecute, ActionExecutionOptions } from './types.js';

/** A raw row emitted by the canonical finite `transcript.follow` Action. */
export type HappierTranscriptItem = PublicActionResultById['transcript.follow']['items'][number];

export type HappierExecutionRunStreamEvent = PublicActionResultById['execution.run.stream.read']['events'][number];

/** A direct handle for the canonical bounded execution-run stream Actions. */
export type HappierExecutionRunStream = Readonly<{
  runId: string;
  streamId: string;
  cancel: () => Promise<void>;
  [Symbol.asyncIterator]: () => AsyncIterator<HappierExecutionRunStreamEvent>;
}>;

export type FollowTranscriptOptions = Readonly<{
  cursor?: string;
  maxBytes?: number;
  maxItems?: number;
  idleTtlMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}>;

type Deferred<T> = Readonly<{
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}>;

type ExecutionRunStreamReadInput = PublicActionInputById['execution.run.stream.read'];
type ExecutionRunStreamReadResult = PublicActionResultById['execution.run.stream.read'];

const DEFAULT_STREAM_POLL_INTERVAL_MS = 250;

export async function startExecutionRunStream(params: Readonly<{
  runId: string;
  start: () => Promise<PublicActionResultById['execution.run.stream.start']>;
  read: (
    input: Readonly<Pick<ExecutionRunStreamReadInput, 'runId' | 'streamId' | 'cursor'>>,
    signal: AbortSignal,
  ) => Promise<ExecutionRunStreamReadResult>;
  cancel: (input: Readonly<Pick<ExecutionRunStreamReadInput, 'runId' | 'streamId'>>) => Promise<void>;
  closeSignal: AbortSignal;
  registerCloseCleanup?: (cleanup: () => Promise<void>) => () => void;
  signal?: AbortSignal;
}>): Promise<HappierExecutionRunStream> {
  const started = await params.start();
  const controller = new AbortController();
  const signal = params.signal === undefined
    ? AbortSignal.any([params.closeSignal, controller.signal])
    : AbortSignal.any([params.closeSignal, controller.signal, params.signal]);
  let cursor = 0;
  let events: readonly HappierExecutionRunStreamEvent[] = [];
  let terminal = false;
  let cancelled = false;
  let cancelPromise: Promise<void> | undefined;
  let terminalCleanupPromise: Promise<void> | undefined;
  let unregisterCloseCleanup: (() => void) | undefined;

  const removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  const cancel = (): Promise<void> => {
    if (cancelPromise !== undefined) return cancelPromise;
    cancelled = true;
    cancelPromise = Promise.resolve()
      .then(async () => {
        await params.cancel({ runId: params.runId, streamId: started.streamId });
      })
      .finally(() => {
        removeAbortListener();
        unregisterCloseCleanup?.();
      });
    controller.abort();
    return cancelPromise;
  };
  const onAbort = () => {
    void cancel().catch(() => undefined);
  };
  unregisterCloseCleanup = params.registerCloseCleanup?.(cancel);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  const pullNext = async (): Promise<IteratorResult<HappierExecutionRunStreamEvent>> => {
    if (cancelled) {
      await terminalCleanupPromise;
      return { done: true, value: undefined };
    }

    while (true) {
      if (cancelled) {
        await terminalCleanupPromise;
        return { done: true, value: undefined };
      }

      const event = events[0];
      if (event !== undefined) {
        events = events.slice(1);
        if (terminal && events.length === 0) {
          terminalCleanupPromise ??= cancel();
          void terminalCleanupPromise.catch(() => undefined);
        }
        return { done: false, value: event };
      }
      if (terminal) {
        await cancel();
        return { done: true, value: undefined };
      }

      try {
        const page = await params.read({
          runId: params.runId,
          streamId: started.streamId,
          cursor,
        }, signal);
        // The stream id is the response's correlation key, not merely a
        // schema-valid string. Keep the started identity authoritative and
        // reject before adopting any foreign cursor/events/terminal state.
        if (page.streamId !== started.streamId) {
          throw new HappierTransportError(
            'The execution-run stream response has a mismatched stream id.',
            {
              code: 'execution_run_stream_id_mismatch',
              details: {
                expectedStreamId: started.streamId,
                receivedStreamId: page.streamId,
              },
            },
          );
        }
        cursor = page.nextCursor;
        events = page.events;
        terminal = page.done;
        if (!terminal && events.length === 0) {
          await waitForPoll(DEFAULT_STREAM_POLL_INTERVAL_MS, signal);
        }
      } catch (error) {
        await cancel().catch(() => undefined);
        throw error;
      }
    }
  };

  let nextTail = Promise.resolve();
  const iterator: AsyncIterator<HappierExecutionRunStreamEvent> = {
    next(): Promise<IteratorResult<HappierExecutionRunStreamEvent>> {
      const result = nextTail.then(pullNext);
      nextTail = result.then(() => undefined, () => undefined);
      return result;
    },
    async return(): Promise<IteratorResult<HappierExecutionRunStreamEvent>> {
      await cancel();
      return { done: true, value: undefined };
    },
  };

  return Object.freeze({
    runId: params.runId,
    streamId: started.streamId,
    cancel,
    [Symbol.asyncIterator]: () => iterator,
  });
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => finish();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sessionIsActive(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const session = (value as { session?: unknown }).session;
  return session !== null
    && typeof session === 'object'
    && (session as { active?: unknown }).active === true;
}

export function createTranscriptIterable(params: Readonly<{
  execute: ActionExecute;
  release: (input: Readonly<{ sessionId: string; leaseId: string }>) => Promise<void>;
  sessionId: string;
  closeSignal: AbortSignal;
  registerCloseCleanup?: (cleanup: () => Promise<void>) => () => void;
  options?: FollowTranscriptOptions;
}>): AsyncIterable<HappierTranscriptItem> {
  const iteratorController = new AbortController();
  const signal = params.options?.signal === undefined
    ? AbortSignal.any([params.closeSignal, iteratorController.signal])
    : AbortSignal.any([params.closeSignal, iteratorController.signal, params.options.signal]);
  const values: HappierTranscriptItem[] = [];
  const waiters: Deferred<HappierTranscriptItem>[] = [];
  let complete = false;
  let failure: unknown;
  let runner: Promise<void> | undefined;
  let resolveConsumerDemand: (() => void) | undefined;

  const notifyConsumerDemand = () => {
    const resolve = resolveConsumerDemand;
    resolveConsumerDemand = undefined;
    resolve?.();
  };
  const waitForConsumerDemand = (): Promise<void> => {
    if (signal.aborted || (values.length === 0 && waiters.length > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        signal.removeEventListener('abort', finish);
        if (resolveConsumerDemand === finish) resolveConsumerDemand = undefined;
        resolve();
      };
      resolveConsumerDemand = finish;
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted || (values.length === 0 && waiters.length > 0)) finish();
    });
  };

  const emit = (value: HappierTranscriptItem) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else values.push(value);
  };
  const settle = () => {
    complete = true;
    for (const waiter of waiters.splice(0)) {
      if (failure === undefined) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(failure);
    }
  };
  const start = () => {
    if (runner) return runner;
    if (signal.aborted) {
      runner = Promise.resolve();
      settle();
      return runner;
    }
    const leaseId = globalThis.crypto.randomUUID();
    const unregisterCloseCleanup = params.registerCloseCleanup?.(async () => {
      iteratorController.abort();
      await runner;
    });
    runner = followTranscriptSourceWithFiniteActions<HappierTranscriptItem>({
      initialCursor: params.options?.cursor ?? 'tail',
      leaseId,
      follow: async ({ cursor, leaseId: activeLeaseId }) => params.execute('transcript.follow', {
        sessionId: params.sessionId,
        cursor,
        leaseId: activeLeaseId,
        ...(params.options?.maxBytes === undefined ? {} : { maxBytes: params.options.maxBytes }),
        ...(params.options?.maxItems === undefined ? {} : { maxItems: params.options.maxItems }),
        ...(params.options?.idleTtlMs === undefined ? {} : { idleTtlMs: params.options.idleTtlMs }),
      }, { signal }),
      release: async ({ leaseId: activeLeaseId }) => {
        await params.release({
          sessionId: params.sessionId,
          leaseId: activeLeaseId,
        });
      },
      isSessionActive: async () => sessionIsActive(await params.execute(
        'session.status.get',
        { sessionId: params.sessionId },
        { signal },
      )),
      waitForNextPoll: async () => waitForPoll(
        params.options?.pollIntervalMs ?? DEFAULT_STREAM_POLL_INTERVAL_MS,
        signal,
      ),
      shouldContinue: () => !signal.aborted,
      onItems: async ({ items }) => {
        for (const item of items) emit(item);
        await waitForConsumerDemand();
      },
    }).then(
      () => settle(),
      (error) => {
        failure = error;
        settle();
      },
    ).finally(() => unregisterCloseCleanup?.());
    return runner;
  };

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<HappierTranscriptItem>> {
          start();
          const value = values.shift();
          if (value !== undefined) {
            return Promise.resolve({ done: false, value });
          }
          if (complete) {
            return failure === undefined
              ? Promise.resolve({ done: true, value: undefined })
              : Promise.reject(failure);
          }
          return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
            notifyConsumerDemand();
          });
        },
        async return(): Promise<IteratorResult<HappierTranscriptItem>> {
          iteratorController.abort();
          await start();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
