import { describe, expect, it } from 'vitest';

import { createInferenceConcurrencyCoordinator } from './inferenceConcurrencyCoordinator';

describe('inferenceConcurrencyCoordinator', () => {
  it('serializes work per model id', async () => {
    const coordinator = createInferenceConcurrencyCoordinator();
    const order: string[] = [];

    await Promise.all([
      coordinator.runExclusive('m1', async () => {
        order.push('first:start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('first:end');
      }),
      coordinator.runExclusive('m1', async () => {
        order.push('second:start');
        order.push('second:end');
      }),
    ]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('permits configured parallel work for the same model id', async () => {
    const coordinator = createInferenceConcurrencyCoordinator({ perModelConcurrency: 2 });
    let activeCount = 0;
    let maxActiveCount = 0;
    let releaseWork!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });

    const first = coordinator.runExclusive('m1', async () => {
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await releaseGate;
      activeCount -= 1;
    });
    const second = coordinator.runExclusive('m1', async () => {
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await releaseGate;
      activeCount -= 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseWork();
    await Promise.all([first, second]);

    expect(maxActiveCount).toBe(2);
  });

  it('runs queued lifecycle-exclusive work before later inference work for the same model id', async () => {
    const coordinator = createInferenceConcurrencyCoordinator({ perModelConcurrency: 2 });
    const order: string[] = [];
    let releaseFirstInference!: () => void;
    const firstInferenceGate = new Promise<void>((resolve) => {
      releaseFirstInference = resolve;
    });
    let releaseLifecycle!: () => void;
    const lifecycleGate = new Promise<void>((resolve) => {
      releaseLifecycle = resolve;
    });

    const firstInference = coordinator.runExclusive('m1', async () => {
      order.push('inference-1:start');
      await firstInferenceGate;
      order.push('inference-1:end');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const lifecycle = coordinator.runLifecycleExclusive('m1', async () => {
      order.push('lifecycle:start');
      await lifecycleGate;
      order.push('lifecycle:end');
    });
    const secondInference = coordinator.runExclusive('m1', async () => {
      order.push('inference-2:start');
      order.push('inference-2:end');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['inference-1:start']);

    releaseFirstInference();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['inference-1:start', 'inference-1:end', 'lifecycle:start']);

    releaseLifecycle();
    await Promise.all([firstInference, lifecycle, secondInference]);

    expect(order).toEqual([
      'inference-1:start',
      'inference-1:end',
      'lifecycle:start',
      'lifecycle:end',
      'inference-2:start',
      'inference-2:end',
    ]);
  });

  it('removes a queued inference waiter when its signal aborts', async () => {
    const coordinator = createInferenceConcurrencyCoordinator();
    const order: string[] = [];
    const controller = new AbortController();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = coordinator.runExclusive('m1', async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = coordinator.runExclusive(
      'm1',
      async () => {
        order.push('second:start');
      },
      { signal: controller.signal },
    ).catch((error) => error);

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const queuedResult = await Promise.race([
      second,
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 25)),
    ]);
    expect(queuedResult).toMatchObject({ code: 'cancelled' });

    releaseFirst();
    await first;
    expect(order).toEqual(['first:start', 'first:end']);
  });
});
