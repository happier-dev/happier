import { afterEach, describe, expect, it, vi } from 'vitest';

import { startExecutionRunStream } from './subscriptions.js';

type StreamEvent = Readonly<{ t: 'delta'; textDelta: string }>;

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('execution-run subscriptions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serializes concurrent next calls through one cursor read', async () => {
    const firstPage = deferred<Readonly<{
      streamId: string;
      events: StreamEvent[];
      nextCursor: number;
      done: boolean;
    }>>();
    const cursors: number[] = [];
    const cancel = vi.fn(async () => undefined);
    const stream = await startExecutionRunStream({
      runId: 'run-1',
      start: async () => ({ streamId: 'stream-1' }),
      read: async (input) => {
        cursors.push(input.cursor);
        return await firstPage.promise;
      },
      cancel,
      closeSignal: new AbortController().signal,
    });
    const iterator = stream[Symbol.asyncIterator]();

    const first = iterator.next();
    const second = iterator.next();
    await Promise.resolve();
    expect(cursors).toEqual([0]);

    firstPage.resolve({
      streamId: 'stream-1',
      events: [
        { t: 'delta', textDelta: 'first' },
        { t: 'delta', textDelta: 'second' },
      ],
      nextCursor: 1,
      done: false,
    });

    await expect(first).resolves.toEqual({
      done: false,
      value: { t: 'delta', textDelta: 'first' },
    });
    await expect(second).resolves.toEqual({
      done: false,
      value: { t: 'delta', textDelta: 'second' },
    });
    expect(cursors).toEqual([0]);
    await iterator.return?.();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('paces an empty nonterminal page before pulling again', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const stream = await startExecutionRunStream({
      runId: 'run-1',
      start: async () => ({ streamId: 'stream-1' }),
      read: async () => {
        reads += 1;
        return reads === 1
          ? { streamId: 'stream-1', events: [], nextCursor: 0, done: false }
          : {
              streamId: 'stream-1',
              events: [{ t: 'delta' as const, textDelta: 'ready' }],
              nextCursor: 1,
              done: true,
            };
      },
      cancel: async () => undefined,
      closeSignal: new AbortController().signal,
    });
    const iterator = stream[Symbol.asyncIterator]();

    const next = iterator.next();
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(1);

    await vi.runAllTimersAsync();
    await expect(next).resolves.toEqual({
      done: false,
      value: { t: 'delta', textDelta: 'ready' },
    });
    expect(reads).toBe(2);
  });

  it('aborts an empty-page wait and cancels without another read', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancel = vi.fn(async () => undefined);
    let reads = 0;
    const stream = await startExecutionRunStream({
      runId: 'run-1',
      start: async () => ({ streamId: 'stream-1' }),
      read: async () => {
        reads += 1;
        return { streamId: 'stream-1', events: [], nextCursor: 0, done: false };
      },
      cancel,
      closeSignal: new AbortController().signal,
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();

    const next = iterator.next();
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(1);

    controller.abort(new Error('stop polling'));
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(reads).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('returns while concurrent next calls share one pending read', async () => {
    const page = deferred<Readonly<{
      streamId: string;
      events: StreamEvent[];
      nextCursor: number;
      done: boolean;
    }>>();
    const cancel = vi.fn(async () => undefined);
    let reads = 0;
    const stream = await startExecutionRunStream({
      runId: 'run-1',
      start: async () => ({ streamId: 'stream-1' }),
      read: async () => {
        reads += 1;
        return await page.promise;
      },
      cancel,
      closeSignal: new AbortController().signal,
    });
    const iterator = stream[Symbol.asyncIterator]();

    const first = iterator.next();
    const second = iterator.next();
    await Promise.resolve();
    expect(reads).toBe(1);

    await iterator.return?.();
    page.resolve({
      streamId: 'stream-1',
      events: [{ t: 'delta', textDelta: 'late' }],
      nextCursor: 1,
      done: false,
    });

    await expect(first).resolves.toEqual({ done: true, value: undefined });
    await expect(second).resolves.toEqual({ done: true, value: undefined });
    expect(reads).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
