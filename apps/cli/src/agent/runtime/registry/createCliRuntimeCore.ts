import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type { ResolvedBackendContribution } from '@/plugins/projection/registry/types';
import { getExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendRegistry';

import type {
  CliEngineAdapter,
  CliRuntimeCore,
  CreateCliExecutionRunBackendParams,
} from './engineRegistryTypes';
import { createDescriptorBackend } from './createDescriptorBackend';

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

export function createDescriptorBackendFromRegistry(
  opts: CreateCliExecutionRunBackendParams,
): ExecutionRunHostRuntime | null {
  const descriptor = getExecutionRunBackendDescriptor(String(opts.backendId ?? '').trim());
  if (!descriptor) {
    return null;
  }
  return createDescriptorBackend(opts, descriptor);
}

function createUnsupportedCliRuntimeCore(params: Readonly<{
  backend: ResolvedBackendContribution;
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
  backend: ResolvedBackendContribution;
}>): CliEngineAdapter {
  return Object.freeze({
    runtimeCore: createUnsupportedCliRuntimeCore({
      backend: params.backend,
    }),
  });
}

export function createDescriptorBackedCliEngineAdapter(params: Readonly<{
  backend: ResolvedBackendContribution;
}>): CliEngineAdapter {
  return Object.freeze({
    runtimeCore: Object.freeze({
      async createSessionRuntime(_sessionParams: unknown): Promise<HostSessionRuntimePlan> {
        throw createMissingBoundRuntimeCoreError(params.backend.id, 'interactive sessions');
      },
      createExecutionRunBackend(opts: CreateCliExecutionRunBackendParams): ExecutionRunHostRuntime {
        const runtime = createDescriptorBackendFromRegistry(opts);
        if (!runtime) {
          throw createMissingBoundRuntimeCoreError(params.backend.id, 'execution runs');
        }
        return runtime;
      },
    }),
  });
}
