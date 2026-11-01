import { describe, expect, it, vi } from 'vitest';
import { createDaemonServerWorkBudget } from './createDaemonServerWorkBudget';
import { createDaemonServerWorkScheduler } from './createDaemonServerWorkScheduler';

describe('createDaemonServerWorkScheduler', () => {
  it('removes an aborted queued observation without waiting for unrelated active work', async () => {
    const budget = createDaemonServerWorkBudget({ maxConcurrentWrites: 1 });
    const scheduler = createDaemonServerWorkScheduler({ budget });
    let release: () => void = () => {};
    let ranCancelledWork = false;
    let settled = false;
    const active = budget.run({ purpose: 'other-owner' }, async () => {
      await new Promise<void>(resolve => { release = resolve; });
    });
    const controller = new AbortController();
    const queued = scheduler.enqueue({
      key: 'quota:cancelled', purpose: 'connectedServiceQuotaPersistence', kind: 'latestStateWrite',
      payload: null, payloadBytes: 0, ...{ signal: controller.signal },
      run: async () => { ranCancelledWork = true; },
    }).then(outcome => { settled = true; return outcome; });
    expect(budget.getSnapshot()).toMatchObject({ activeCount: 1, queuedCount: 1 });
    controller.abort(new Error('quota loop stopped'));
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(await queued).toEqual({ status: 'suppressed', reason: 'cancelled' });
      expect(budget.getSnapshot()).toMatchObject({ activeCount: 1, queuedCount: 0 });
      expect(ranCancelledWork).toBe(false);
      expect(scheduler.getSnapshot().purposes.connectedServiceQuotaPersistence.counters).toMatchObject({
        suppressed: 1, failed: 0, retried: 0,
      });
    } finally { release(); await active; await queued; }
    const resumed = await scheduler.enqueue({ key: 'quota:cancelled', purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite', payload: null, payloadBytes: 0, run: async () => {} });
    expect(resumed).toEqual({ status: 'written' });
  });

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

  it('reports each failed operation without a separate sampling policy', async () => {
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

    expect(logger.warn).toHaveBeenCalledTimes(2);

    now = 62_000;
    await scheduler.enqueue(failingWork);

    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});
