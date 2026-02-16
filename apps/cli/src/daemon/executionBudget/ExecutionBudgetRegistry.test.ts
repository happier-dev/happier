import { describe, expect, it } from 'vitest';

import { ExecutionBudgetRegistry } from './ExecutionBudgetRegistry';

describe('ExecutionBudgetRegistry', () => {
  it('enforces maxConcurrentExecutionRuns', () => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentEphemeralTasks: 1 });
    expect(registry.tryAcquireExecutionRun('run1')).toBe(true);
    expect(registry.tryAcquireExecutionRun('run2')).toBe(false);
    registry.releaseExecutionRun('run1');
    expect(registry.tryAcquireExecutionRun('run2')).toBe(true);
  });

  it('enforces maxConcurrentEphemeralTasks', () => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentEphemeralTasks: 1 });
    expect(registry.tryAcquireEphemeralTask('task1')).toBe(true);
    expect(registry.tryAcquireEphemeralTask('task2')).toBe(false);
    registry.releaseEphemeralTask('task1');
    expect(registry.tryAcquireEphemeralTask('task2')).toBe(true);
  });

  it('treats automation and ephemeral tasks as one shared budget', () => {
    const registry = new ExecutionBudgetRegistry({ maxConcurrentExecutionRuns: 1, maxConcurrentEphemeralTasks: 1 });

    expect(registry.tryAcquireEphemeralTask('automation-1', 'automation')).toBe(true);
    expect(registry.tryAcquireEphemeralTask('task-1', 'ephemeral_task')).toBe(false);
    registry.releaseEphemeralTask('automation-1');
    expect(registry.tryAcquireEphemeralTask('task-1', 'ephemeral_task')).toBe(true);

    expect(registry.tryAcquireEphemeralTask('automation-2', 'automation')).toBe(false);
  });

  it('enforces per-class caps when configured', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible constructor shape
    const registry = new ExecutionBudgetRegistry({
      maxConcurrentExecutionRuns: 10,
      maxConcurrentEphemeralTasks: 10,
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
      maxConcurrentEphemeralTasks: 10,
      maxConcurrentTotal: 2,
    } as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible overload
    expect((registry as any).tryAcquireExecutionRun('run1', 'review')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible overload
    expect((registry as any).tryAcquireExecutionRun('run2', 'plan')).toBe(true);
    expect(registry.tryAcquireEphemeralTask('task1')).toBe(false);
  });
});
