import { describe, expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';

import { ExecutionBudgetRegistry } from './ExecutionBudgetRegistry';
import { createExecutionBudgetRegistry } from './createExecutionBudgetRegistry';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { projectMachineWorkSummary } from '@/daemon/machines/machineWorkSummary';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';

describe('createExecutionBudgetRegistry', () => {
  it('keeps run and one-shot custody uncapped when retired operator env caps are set', async () => {
    vi.stubEnv('HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION', '1');
    vi.stubEnv('HAPPIER_ONE_SHOT_TASKS_MAX_CONCURRENT_PER_SESSION', '1');
    vi.stubEnv('HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_TOTAL_PER_SESSION', '1');
    vi.stubEnv('HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_BY_CLASS_JSON', '{"review":1,"automation":1}');
    try {
      reloadConfiguration();
      const registry = createExecutionBudgetRegistry();
      for (let index = 0; index < 100; index += 1) {
        expect(registry.tryAcquireExecutionRun('run-' + index, 'review')).toBe(true);
        expect(registry.tryAcquireOneShotTask('task-' + index, 'automation')).toBe(true);
      }
      expect(registry.getInFlightSnapshot()).toEqual({ executionRuns: 100, oneShotTasks: 100 });
      expect((await registry.getLiveWorkProducer().read()).items).toHaveLength(200);
      for (let index = 0; index < 100; index += 1) {
        registry.releaseExecutionRun('run-' + index);
        registry.releaseOneShotTask('task-' + index);
      }
      expect((await registry.getLiveWorkProducer().read()).items).toEqual([]);
    } finally { vi.unstubAllEnvs(); reloadConfiguration(); }
  });
});

describe('ExecutionBudgetRegistry', () => {
  it.each(['preparing', 'active'] as const)('carries admitted requester attribution through %s run custody, acquisition and settlement without Sessions or terminals', async (phase) => {
    const registry = new ExecutionBudgetRegistry();
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
    const registry = new ExecutionBudgetRegistry();
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
    finish();
    release();
    expect(registry.getLiveWorkProducer().read()).toEqual({ coverage: 'complete', items: [
      { category: 'execution_run', ownerRef: 'running', attribution: { kind: 'unknown' }, state: 'active' },
    ] });
  });

  it('retains accepted preparation in the same token without releasing another preparer', () => {
    const registry = new ExecutionBudgetRegistry();
    registry.tryAcquireExecutionRun('running', 'review');
    const releaseFirst = registry.retainExecutionRunPreparation('preparing', 'review');
    const releaseSecond = registry.retainExecutionRunPreparation('preparing', 'review');
    expect(registry.getLiveWorkProducer().read()).toMatchObject({ items: [{ ownerRef: 'running' }, { ownerRef: 'preparing', state: 'active' }] });
    expect(registry.getInFlightSnapshot()).toEqual({ executionRuns: 1, oneShotTasks: 0 });
    releaseFirst();
    expect(registry.getLiveWorkProducer().read()).toMatchObject({ items: [{ ownerRef: 'running' }, { ownerRef: 'preparing' }] });
    registry.releaseExecutionRun('running');
    expect(registry.tryAcquireExecutionRun('preparing', 'review')).toBe(true);
    releaseSecond();
    expect(registry.getInFlightSnapshot()).toEqual({ executionRuns: 1, oneShotTasks: 0 });
    registry.releaseExecutionRun('preparing');
    expect(registry.getLiveWorkProducer().read()).toEqual({ coverage: 'complete', items: [] });
  });

  it('projects accepted work through release without treating an invalid acquisition as work', () => {
    const registry = new ExecutionBudgetRegistry();
    const producer = registry.getLiveWorkProducer();
    const observations: unknown[] = [];
    const unsubscribe = producer.subscribe(() => observations.push(producer.read()));
    expect(registry.tryAcquireExecutionRun('run-1', 'review')).toBe(true);
    expect(registry.tryAcquireExecutionRun('', 'review')).toBe(false);
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
});
