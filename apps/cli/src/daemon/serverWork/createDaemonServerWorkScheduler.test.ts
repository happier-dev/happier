import { describe, expect, it, vi } from 'vitest';

describe('createDaemonServerWorkScheduler', () => {
  it('applies the background write budget and records purpose counters', async () => {
    const budgetMod = await import('./createDaemonServerWorkBudget').catch(() => null);
    const schedulerMod = await import('./createDaemonServerWorkScheduler').catch(() => null);
    expect(budgetMod?.createDaemonServerWorkBudget).toBeTypeOf('function');
    expect(schedulerMod?.createDaemonServerWorkScheduler).toBeTypeOf('function');
    if (!budgetMod || !schedulerMod) return;

    const budget = budgetMod.createDaemonServerWorkBudget({ maxConcurrentWrites: 1 });
    const scheduler = schedulerMod.createDaemonServerWorkScheduler({ budget, now: () => 1_000 });
    const outcome = await scheduler.enqueue({
      key: 'quota:work',
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      payload: { ok: true },
      payloadBytes: 12,
      run: async () => {},
    });

    expect(outcome).toEqual({ status: 'written' });
    expect(scheduler.getSnapshot().purposes.connectedServiceQuotaPersistence.counters).toMatchObject({
      accepted: 1,
      written: 1,
      failed: 0,
    });
  });

  it('defers background work when the gate is closed', async () => {
    const budgetMod = await import('./createDaemonServerWorkBudget').catch(() => null);
    const schedulerMod = await import('./createDaemonServerWorkScheduler').catch(() => null);
    expect(budgetMod?.createDaemonServerWorkBudget).toBeTypeOf('function');
    expect(schedulerMod?.createDaemonServerWorkScheduler).toBeTypeOf('function');
    if (!budgetMod || !schedulerMod) return;

    const scheduler = schedulerMod.createDaemonServerWorkScheduler({
      budget: budgetMod.createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }),
      gate: () => ({ status: 'deferred', reason: 'offline' }),
    });

    const outcome = await scheduler.enqueue({
      key: 'quota:work',
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      payload: null,
      payloadBytes: 0,
      run: async () => {
        throw new Error('should not run');
      },
    });

    expect(outcome).toEqual({ status: 'deferred', reason: 'offline', retryAfterMs: undefined });
  });

  it('samples repeated failure logs for the same key and reason', async () => {
    const budgetMod = await import('./createDaemonServerWorkBudget').catch(() => null);
    const schedulerMod = await import('./createDaemonServerWorkScheduler').catch(() => null);
    expect(budgetMod?.createDaemonServerWorkBudget).toBeTypeOf('function');
    expect(schedulerMod?.createDaemonServerWorkScheduler).toBeTypeOf('function');
    if (!budgetMod || !schedulerMod) return;

    let now = 1_000;
    const logger = { warn: vi.fn() };
    const scheduler = schedulerMod.createDaemonServerWorkScheduler({
      budget: budgetMod.createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }),
      logger,
      now: () => now,
    });

    const failingWork = {
      key: 'quota:work',
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      payload: null,
      payloadBytes: 0,
      run: async () => {
        throw { response: { status: 500 } };
      },
    };

    await scheduler.enqueue(failingWork);
    await scheduler.enqueue(failingWork);

    expect(logger.warn).toHaveBeenCalledTimes(1);

    now = 62_000;
    await scheduler.enqueue(failingWork);

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
