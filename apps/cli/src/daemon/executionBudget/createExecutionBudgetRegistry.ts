import { configuration } from '@/configuration';
import { ExecutionBudgetRegistry } from './ExecutionBudgetRegistry';

/** One custody/configuration owner for Session and detached daemon execution budgets, including uncapped work. */
export function createExecutionBudgetRegistry(): ExecutionBudgetRegistry {
    return new ExecutionBudgetRegistry({
        maxConcurrentExecutionRuns: configuration.executionRunsMaxConcurrentPerSession,
        maxConcurrentOneShotTasks: configuration.oneShotTasksMaxConcurrentPerSession,
        ...(typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
            ? { maxConcurrentTotal: configuration.executionBudgetMaxConcurrentTotalPerSession }
            : {}),
        ...(configuration.executionBudgetMaxConcurrentByClass
            && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0
            ? { maxConcurrentByClass: configuration.executionBudgetMaxConcurrentByClass }
            : {}),
    });
}
