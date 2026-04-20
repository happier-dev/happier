import type { ExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { createDescriptorExecutionRunHostRuntime } from '@/agent/executionRuns/runtime/hostRuntime/fromDescriptor';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

import type { CreateCliExecutionRunBackendParams } from './engineRegistryTypes';

export function createDescriptorBackend(
    opts: CreateCliExecutionRunBackendParams,
    descriptor: ExecutionRunBackendDescriptor,
): ExecutionRunHostRuntime | null {
    return createDescriptorExecutionRunHostRuntime(opts, descriptor);
}
