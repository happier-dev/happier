import { describe, expect, it } from 'vitest';

import { ExecutionBudgetRegistry } from './ExecutionBudgetRegistry';

describe('ExecutionBudgetRegistry', () => {
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
