import { describe, expect, it, vi } from 'vitest';

import { createInferenceWarmupCoordinator } from './inferenceWarmupCoordinator';

describe('inferenceWarmupCoordinator', () => {
  it('singleflights concurrent warm calls for the same model', async () => {
    const loader = vi.fn(async () => ({ id: 'm1' }));
    const coordinator = createInferenceWarmupCoordinator();

    const [first, second] = await Promise.all([
      coordinator.warm('m1', loader),
      coordinator.warm('m1', loader),
    ]);

    expect(first).toEqual({ id: 'm1' });
    expect(second).toEqual({ id: 'm1' });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(coordinator.isWarm('m1')).toBe(true);
  });

  it('releases warm models and cancels their pending residency timer', async () => {
    const timerToken = { id: 'timer-1' } as unknown as ReturnType<typeof setTimeout>;
    let scheduledRelease: (() => void) | null = null;
    const scheduleRelease = Object.assign(
      ((handler: Parameters<typeof setTimeout>[0], __?: number) => {
        scheduledRelease = handler as () => void;
        return timerToken;
      }) as typeof setTimeout,
      { __promisify__: setTimeout.__promisify__ },
    );
    const cancelRelease = vi.fn();
    const onRelease = vi.fn(async () => {});
    const loader = vi.fn(async () => ({ id: 'm1' }));
    const coordinator = createInferenceWarmupCoordinator({
      residencyMs: 1_000,
      scheduleRelease,
      cancelRelease,
      onRelease,
    });

    await coordinator.warm('m1', loader);
    expect(coordinator.isWarm('m1')).toBe(true);

    await coordinator.release('m1');

    expect(cancelRelease).toHaveBeenCalledWith(timerToken);
    expect(onRelease).toHaveBeenCalledWith('m1', { id: 'm1' });
    expect(coordinator.isWarm('m1')).toBe(false);

    await coordinator.warm('m1', loader);
    expect(loader).toHaveBeenCalledTimes(2);

    const releaseHandler: () => void =
      scheduledRelease ??
      (() => {
        throw new Error('scheduled_release_missing');
      });
    releaseHandler();
    await Promise.resolve();

    expect(onRelease).toHaveBeenCalledWith('m1', { id: 'm1' });
    expect(coordinator.isWarm('m1')).toBe(false);
  });

  it('does not resurrect a model if release happens while warm is still in flight', async () => {
    let resolveLoader!: (value: { id: string }) => void;
    const loader = vi.fn(async () => await new Promise<{ id: string }>((resolve) => {
      resolveLoader = resolve;
    }));
    const onRelease = vi.fn(async () => {});
    const coordinator = createInferenceWarmupCoordinator({
      onRelease,
    });

    const warmPromise = coordinator.warm('m1', loader);
    await Promise.resolve();

    await coordinator.release('m1');
    resolveLoader({ id: 'm1' });
    await expect(warmPromise).resolves.toEqual({ id: 'm1' });
    await Promise.resolve();

    expect(coordinator.isWarm('m1')).toBe(false);
    expect(onRelease).toHaveBeenCalledWith('m1', { id: 'm1' });
  });
});
