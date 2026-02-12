import { describe, expect, it } from 'vitest';

import { createSpawnConcurrencyGate } from './createSpawnConcurrencyGate';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSpawnConcurrencyGate', () => {
  it('limits in-flight work to the configured max', async () => {
    const gate = createSpawnConcurrencyGate(2);

    const d1 = createDeferred<void>();
    const d2 = createDeferred<void>();
    const d3 = createDeferred<void>();
    const started1 = createDeferred<void>();
    const started2 = createDeferred<void>();
    const started3 = createDeferred<void>();

    let inFlight = 0;
    let maxObserved = 0;

    const run = (d: Deferred<void>, started: Deferred<void>) =>
      gate.run(async () => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        started.resolve();
        await d.promise;
        inFlight -= 1;
      });

    const p1 = run(d1, started1);
    const p2 = run(d2, started2);
    const p3 = run(d3, started3);

    // p1 and p2 should start, p3 should queue.
    await Promise.all([started1.promise, started2.promise]);

    expect(maxObserved).toBe(2);
    expect(inFlight).toBe(2);

    let started3Observed = false;
    started3.promise.then(() => {
      started3Observed = true;
    });

    for (let i = 0; i < 10 && !started3Observed; i += 1) {
      await Promise.resolve();
    }
    expect(started3Observed).toBe(false);

    d1.resolve();

    // p3 should now be allowed to start.
    await started3.promise;
    expect(inFlight).toBeLessThanOrEqual(2);

    d2.resolve();
    d3.resolve();

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([undefined, undefined, undefined]);
    expect(maxObserved).toBe(2);
    expect(inFlight).toBe(0);
  });
});

