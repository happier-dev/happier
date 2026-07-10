import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type { ResolvedAgentRuntimeContribution } from '@/plugins/projection/registry/types';

import type {
  CliEngineAdapter,
  CliRuntimeCore,
  CreateCliExecutionRunBackendParams,
} from './engineRegistryTypes';

export class MissingBoundCliRuntimeCoreError extends Error {
  constructor(backendId: string, surface: 'interactive sessions' | 'execution runs') {
    super(`Backend '${backendId}' is missing bound host runtimeCore for ${surface}`);
    this.name = 'MissingBoundCliRuntimeCoreError';
  }
}

export function isMissingBoundCliRuntimeCoreError(error: unknown): error is MissingBoundCliRuntimeCoreError {
  return error instanceof MissingBoundCliRuntimeCoreError;
}

function createMissingBoundRuntimeCoreError(backendId: string, surface: 'interactive sessions' | 'execution runs'): Error {
  return new MissingBoundCliRuntimeCoreError(backendId, surface);
}

function createUnsupportedCliRuntimeCore(params: Readonly<{
  backend: ResolvedAgentRuntimeContribution;
}>): CliRuntimeCore {
  return Object.freeze({
    async createSessionRuntime(_sessionParams: unknown): Promise<HostSessionRuntimePlan> {
      throw createMissingBoundRuntimeCoreError(params.backend.id, 'interactive sessions');
    },
    createExecutionRunBackend(_opts: CreateCliExecutionRunBackendParams): ExecutionRunHostRuntime {
      throw createMissingBoundRuntimeCoreError(params.backend.id, 'execution runs');
    },
  });
}

export function createMissingCliEngineAdapter(params: Readonly<{
  backend: ResolvedAgentRuntimeContribution;
}>): CliEngineAdapter {
  return Object.freeze({
    runtimeCore: createUnsupportedCliRuntimeCore({
      backend: params.backend,
    }),
  });
}
