import { createExecutionRunHostBackendFromTurnOperations } from '@happier-dev/plugin-sdk/internal/runtime/executionRun';
import type { InternalExecutionRunTurnOperationsInputV1 } from '@happier-dev/plugin-sdk/internal/runtime/executionRun';

import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';

export function createExecutionRunHostRuntimeFromRuntimeTurnOperations(
    operations: RuntimeTurnOperations,
): ExecutionRunHostRuntime {
    return createExecutionRunHostBackendFromTurnOperations({
        createOperations: () => operations as unknown as InternalExecutionRunTurnOperationsInputV1,
    }) as unknown as ExecutionRunHostRuntime;
}
