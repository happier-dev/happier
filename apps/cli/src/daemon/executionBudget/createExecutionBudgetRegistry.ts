import { ExecutionBudgetRegistry } from './ExecutionBudgetRegistry';

/** Tracks accepted Session and detached-daemon work without operator concurrency caps. */
export function createExecutionBudgetRegistry(): ExecutionBudgetRegistry {
    return new ExecutionBudgetRegistry();
}
