import { describe, expect, it } from 'vitest';

import { PushableAsyncIterable } from './PushableAsyncIterable';

describe('PushableAsyncIterable', () => {
  it('pushes and consumes values in order', async () => {
    const iterable = new PushableAsyncIterable<number>();
    const results: number[] = [];

    const consumer = (async () => {
      for await (const value of iterable) {
        results.push(value);
        if (results.length === 3) break;
      }
    })();

    iterable.push(1);
    iterable.push(2);
    iterable.push(3);

    await consumer;
    expect(results).toEqual([1, 2, 3]);
  });

  it('handles asynchronous pushing without fixed sleeps', async () => {
    const iterable = new PushableAsyncIterable<string>();
    const results: string[] = [];

    const consumer = (async () => {
      for await (const value of iterable) {
        results.push(value);
      }
    })();

    await Promise.resolve();
    iterable.push('first');
    await Promise.resolve();
    iterable.push('second');
    await Promise.resolve();
    iterable.push('third');
    iterable.end();

    await consumer;
    expect(results).toEqual(['first', 'second', 'third']);
  });

  it('propagates setError to active consumers', async () => {
    const iterable = new PushableAsyncIterable<number>();
    const error = new Error('Test error');

    const consumer = (async () => {
      const values: number[] = [];
      try {
        for await (const value of iterable) {
          values.push(value);
        }
      } catch (caught) {
        expect(caught).toBe(error);
        return values;
      }
      throw new Error('Expected iterable to throw');
    })();

    iterable.push(1);
    iterable.push(2);
    iterable.setError(error);

    await expect(consumer).resolves.toEqual([1, 2]);
  });

  it('supports external error control from consumer logic', async () => {
    const iterable = new PushableAsyncIterable<number>();

    const consumer = (async () => {
      const values: number[] = [];
      try {
        for await (const value of iterable) {
          values.push(value);
          if (value === 2) {
            iterable.setError(new Error('External abort'));
          }
        }
      } catch (caught) {
        expect((caught as Error).message).toBe('External abort');
        return values;
      }
      throw new Error('Expected iterable to throw');
    })();

    iterable.push(1);
    iterable.push(2);

    await expect(consumer).resolves.toEqual([1, 2]);
  });

  it('queues values pushed before consumer starts', async () => {
    const iterable = new PushableAsyncIterable<number>();

    iterable.push(1);
    iterable.push(2);
    iterable.push(3);
    iterable.end();

    const results: number[] = [];
    for await (const value of iterable) {
      results.push(value);
    }

    expect(results).toEqual([1, 2, 3]);
  });

  it('throws when pushing to a completed iterable', () => {
    const iterable = new PushableAsyncIterable<number>();
    iterable.end();
    expect(() => iterable.push(1)).toThrow('Cannot push to completed iterable');
  });

  it('allows only a single iterator instance', () => {
    const iterable = new PushableAsyncIterable<number>();
    iterable[Symbol.asyncIterator]();
    expect(() => iterable[Symbol.asyncIterator]()).toThrow('PushableAsyncIterable can only be iterated once');
  });

  it('reports queue and waiter state deterministically', async () => {
    const iterable = new PushableAsyncIterable<number>();

    iterable.push(1);
    iterable.push(2);
    expect(iterable.queueSize).toBe(2);
    expect(iterable.waiterCount).toBe(0);

    const iterator = iterable[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 2 });
    expect(iterable.queueSize).toBe(0);

    const pendingNext = iterator.next();
    expect(iterable.waiterCount).toBe(1);

    iterable.push(3);
    await expect(pendingNext).resolves.toEqual({ done: false, value: 3 });
    expect(iterable.waiterCount).toBe(0);

    iterable.end();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
