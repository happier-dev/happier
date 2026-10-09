import { describe, expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';

import { ExecutionBudgetRegistry } from './ExecutionBudgetRegistry';
import { createExecutionBudgetRegistry } from './createExecutionBudgetRegistry';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { projectMachineWorkSummary } from '@/daemon/machines/machineWorkSummary';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';

describe('createExecutionBudgetRegistry', () => {
  it('retains accepted run custody with uncapped defaults and still applies configured caps', () => {
    vi.stubEnv('HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION', '');
    vi.stubEnv('HAPPIER_ONE_SHOT_TASKS_MAX_CONCURRENT_PER_SESSION', '');
    vi.stubEnv('HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_TOTAL_PER_SESSION', '');
    vi.stubEnv('HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_BY_CLASS_JSON', '');
    try {
      reloadConfiguration();
      const uncapped = createExecutionBudgetRegistry();
      expect(uncapped?.tryAcquireExecutionRun('run-1')).toBe(true);
      expect(uncapped?.tryAcquireExecutionRun('run-2')).toBe(true);
      expect(uncapped?.getLiveWorkProducer().read()).toMatchObject({ coverage: 'complete', items: [
        { ownerRef: 'run-1', state: 'active' }, { ownerRef: 'run-2', state: 'active' },
      ] });
      vi.stubEnv('HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION', '1');
      reloadConfiguration();
      const capped = createExecutionBudgetRegistry();
      expect(capped?.tryAcquireExecutionRun('run-1')).toBe(true);
      expect(capped?.tryAcquireExecutionRun('run-2')).toBe(false);
    } finally { vi.unstubAllEnvs(); reloadConfiguration(); }
  });
});

describe('ExecutionBudgetRegistry', () => {
  it.each(['preparing', 'active'] as const)('carries admitted requester attribution through %s run custody, acquisition and settlement without Sessions or terminals', async (phase) => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null, maxConcurrentOneShotTasks: null });
    const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
    const bob = { ...target, accountId: 'bob' };
    const alice = { ...target, accountId: 'alice' };
    // Structural forward-compatible calls preserve the real owner before its optional input lands.
    const retain: (runId: string, intent?: string, attribution?: RequesterWorkAttributionV1) => () => void
      = registry.retainExecutionRunPreparation.bind(registry);
    const acquire: (runId: string, intent?: string, attribution?: RequesterWorkAttributionV1) => boolean
      = registry.tryAcquireExecutionRun.bind(registry);
    expect(acquire('custodian-run', 'review', alice)).toBe(true);
    const releasePreparation = phase === 'preparing' ? retain('requester-run', 'review', bob) : () => {};
    if (phase === 'active') expect(acquire('requester-run', 'review', bob)).toBe(true);
    const inventory = createManagedActivityInventory({ producers: [registry.getLiveWorkProducer()], now: () => 10 });
    const project = async () => projectMachineWorkSummary({ inventory: await inventory.read(), target,
      custodianAccountId: 'alice', requesterIdentities: new Map([['bob', { accountId: 'bob', displayName: 'Bob' }]]) });
    try {
      const observed = await inventory.read();
      expect(observed.items).toEqual([
        { category: 'execution_run', ownerRef: 'custodian-run', attribution: alice, state: 'active' },
        { category: 'execution_run', ownerRef: 'requester-run', attribution: bob, state: 'active' },
      ]);
      expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['execution_run'] });
      expect(await project()).toEqual({ kind: 'current', requesters: [
        { accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 },
      ] });
      expect(acquire('requester-run', 'review', bob)).toBe(true);
      releasePreparation();
      expect(await project()).toEqual({ kind: 'current', requesters: [
        { accountId: 'bob', displayName: 'Bob', sessions: 0, tasks: 1, terminals: 0 },
      ] });
      registry.releaseExecutionRun('requester-run');
      expect(await project()).toEqual({ kind: 'current', requesters: [] });
      registry.releaseExecutionRun('custodian-run');
      expect(await inventory.readDecision()).toEqual({ kind: 'idle', since: 10 });
      expect(registry.tryAcquireExecutionRun('legacy-run')).toBe(true);
      expect(await project()).toEqual({ kind: 'unavailable' });
      registry.releaseExecutionRun('legacy-run');
      expect(await project()).toEqual({ kind: 'current', requesters: [] });
    } finally { releasePreparation(); inventory.dispose(); }
  });

  it('retains the actual finite process task without imposing execution caps or borrowing another token', async () => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentOneShotTasks: 1, maxConcurrentTotal: 1 });
    registry.tryAcquireExecutionRun('running');
    let finish!: () => void;
    const task = new Promise<void>(resolve => { finish = resolve; });
    const attribution = { serverId: 'home', accountId: 'requester', machineId: 'machine', installationId: 'installation' };
    const release = registry.retainFiniteTask(task, attribution);
    expect(registry.getLiveWorkProducer().read()).toMatchObject({ coverage: 'complete', items: [
      { category: 'execution_run', ownerRef: 'running' }, { category: 'finite', ownerRef: task, attribution, state: 'active' },
    ] });
    expect((await registry.getLiveWorkProducer().read()).items[1]?.ownerRef).toBe(task);
    expect(registry.getInFlightSnapshot()).toEqual({ executionRuns: 1, oneShotTasks: 0 });
    expect(registry.tryAcquireExecutionRun('other')).toBe(false);
    finish();
    release();
    expect(registry.getLiveWorkProducer().read()).toEqual({ coverage: 'complete', items: [
      { category: 'execution_run', ownerRef: 'running', attribution: { kind: 'unknown' }, state: 'active' },
    ] });
  });

  it('retains accepted preparation in the same token without changing cap admission or releasing another preparer', () => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentOneShotTasks: 1 });
    registry.tryAcquireExecutionRun('running', 'review');
    const releaseFirst = registry.retainExecutionRunPreparation('preparing', 'review');
    const releaseSecond = registry.retainExecutionRunPreparation('preparing', 'review');
    expect(registry.getLiveWorkProducer().read()).toMatchObject({ items: [{ ownerRef: 'running' }, { ownerRef: 'preparing', state: 'active' }] });
    expect(registry.getInFlightSnapshot()).toEqual({ executionRuns: 1, oneShotTasks: 0 });
    expect(registry.tryAcquireExecutionRun('preparing', 'review')).toBe(false);
    releaseFirst();
    expect(registry.getLiveWorkProducer().read()).toMatchObject({ items: [{ ownerRef: 'running' }, { ownerRef: 'preparing' }] });
    registry.releaseExecutionRun('running');
    expect(registry.tryAcquireExecutionRun('preparing', 'review')).toBe(true);
    releaseSecond();
    expect(registry.getInFlightSnapshot()).toEqual({ executionRuns: 1, oneShotTasks: 0 });
    registry.releaseExecutionRun('preparing');
    expect(registry.getLiveWorkProducer().read()).toEqual({ coverage: 'complete', items: [] });
  });

  it('projects accepted work through release without treating a rejected acquisition as work', () => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentOneShotTasks: 1 });
    const producer = registry.getLiveWorkProducer();
    const observations: unknown[] = [];
    const unsubscribe = producer.subscribe(() => observations.push(producer.read()));
    expect(registry.tryAcquireExecutionRun('run-1', 'review')).toBe(true);
    expect(registry.tryAcquireExecutionRun('run-2', 'review')).toBe(false);
    expect(producer.read()).toEqual({ coverage: 'complete', items: [
      { category: 'execution_run', ownerRef: 'run-1', attribution: { kind: 'unknown' }, state: 'active' },
    ] });
    expect(registry.tryAcquireOneShotTask('automation-1', 'automation')).toBe(true);
    expect(producer.read()).toMatchObject({ items: [
      { category: 'execution_run', ownerRef: 'run-1' },
      { category: 'workflow_run', ownerRef: 'automation-1', state: 'active' },
    ] });
    registry.releaseExecutionRun('run-1');
    registry.releaseOneShotTask('automation-1');
    expect(observations.at(-1)).toEqual({ coverage: 'complete', items: [] });
    unsubscribe();
    registry.tryAcquireExecutionRun('run-3');
    expect(observations).toHaveLength(4);
  });

  it('enforces maxConcurrentExecutionRuns', () => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentOneShotTasks: 1 });
    expect(registry.tryAcquireExecutionRun('run1')).toBe(true);
    expect(registry.tryAcquireExecutionRun('run2')).toBe(false);
    registry.releaseExecutionRun('run1');
    expect(registry.tryAcquireExecutionRun('run2')).toBe(true);
  });

  it('allows unlimited execution runs when maxConcurrentExecutionRuns is unset', () => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: null as number | null, maxConcurrentOneShotTasks: 1 });
    expect(registry.tryAcquireExecutionRun('run1')).toBe(true);
    expect(registry.tryAcquireExecutionRun('run2')).toBe(true);
    expect(registry.getInFlightSnapshot().executionRuns).toBe(2);
  });

  it('enforces maxConcurrentOneShotTasks', () => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentOneShotTasks: 1 });
    expect(registry.tryAcquireOneShotTask('task1')).toBe(true);
    expect(registry.tryAcquireOneShotTask('task2')).toBe(false);
    registry.releaseOneShotTask('task1');
    expect(registry.tryAcquireOneShotTask('task2')).toBe(true);
  });

  it('allows unlimited one-shot tasks when maxConcurrentOneShotTasks is unset', () => {
    const registry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 1,
      maxConcurrentOneShotTasks: null as number | null,
    });

    expect(registry.tryAcquireOneShotTask('task1')).toBe(true);
    expect(registry.tryAcquireOneShotTask('task2')).toBe(true);
    expect(registry.getInFlightSnapshot().oneShotTasks).toBe(2);

    expect(registry.tryAcquireOneShotTask('automation-1', 'automation')).toBe(true);
    expect(registry.getInFlightSnapshot().oneShotTasks).toBe(3);
  });

  it('treats automation and one-shot tasks as one shared budget', () => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentOneShotTasks: 1 });

    expect(registry.tryAcquireOneShotTask('automation-1', 'automation')).toBe(true);
    expect(registry.tryAcquireOneShotTask('task-1', 'scm_commit_message')).toBe(false);
    registry.releaseOneShotTask('automation-1');
    expect(registry.tryAcquireOneShotTask('task-1', 'scm_commit_message')).toBe(true);

    expect(registry.tryAcquireOneShotTask('automation-2', 'automation')).toBe(false);
  });

  it('enforces per-class caps when configured', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible constructor shape
    const registry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 10,
      maxConcurrentOneShotTasks: 10,
      maxConcurrentByClass: {
        review: 1,
      },
    } as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible overload
    expect((registry as any).tryAcquireExecutionRun('run1', 'review')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible overload
    expect((registry as any).tryAcquireExecutionRun('run2', 'review')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible overload
    expect((registry as any).tryAcquireExecutionRun('run3', 'plan')).toBe(true);
  });

  it('enforces a global cap when configured', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible constructor shape
    const registry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 10,
      maxConcurrentOneShotTasks: 10,
      maxConcurrentTotal: 2,
    } as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible overload
    expect((registry as any).tryAcquireExecutionRun('run1', 'review')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible overload
    expect((registry as any).tryAcquireExecutionRun('run2', 'plan')).toBe(true);
    expect(registry.tryAcquireOneShotTask('task1')).toBe(false);
  });
});
