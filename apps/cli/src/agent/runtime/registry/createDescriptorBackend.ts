import type { ExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { createDescriptorExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/hostRuntime/descriptor';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

import type { CreateCliExecutionRunBackendParams } from './engineRegistryTypes';

export function createDescriptorBackend(
    opts: CreateCliExecutionRunBackendParams,
    descriptor: ExecutionRunBackendDescriptor,
): ExecutionRunHostRuntime | null {
    return createDescriptorExecutionRunHostRuntime(opts, descriptor);
}
