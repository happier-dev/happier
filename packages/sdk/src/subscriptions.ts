import { followTranscriptSourceWithFiniteActions } from '@happier-dev/agents/runtime/facets/transcriptSource';

import type { PublicActionResultById } from './actions/generated.js';
import type { ActionExecute, ActionExecutionOptions } from './types.js';

/** A raw row emitted by the canonical finite `transcript.follow` Action. */
export type HappierTranscriptItem = PublicActionResultById['transcript.follow']['items'][number];

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
    const leaseId = globalThis.crypto.randomUUID();
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
      waitForNextPoll: async () => waitForPoll(params.options?.pollIntervalMs ?? 250, signal),
      shouldContinue: () => !signal.aborted,
      onItems: ({ items }) => {
        for (const item of items) emit(item);
      },
    }).then(
      () => settle(),
      (error) => {
        failure = error;
        settle();
      },
    );
    return runner;
  };

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<HappierTranscriptItem>> {
          start();
          const value = values.shift();
          if (value !== undefined) return Promise.resolve({ done: false, value });
          if (complete) {
            return failure === undefined
              ? Promise.resolve({ done: true, value: undefined })
              : Promise.reject(failure);
          }
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
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
