import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
import type { ResolvedBackendContribution } from '@/extensions/registry/types';
import { getExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendRegistry';

import type {
  CliEngineAdapter,
  CliRuntimeBindings,
  CreateCliExecutionRunBackendParams,
} from './engineRegistryTypes';
import { createDescriptorBackend } from './createDescriptorBackend';

export class MissingBoundCliBindingsError extends Error {
  constructor(backendId: string, surface: 'interactive sessions' | 'execution runs') {
    super(`Backend '${backendId}' is missing bound host bindings for ${surface}`);
    this.name = 'MissingBoundCliBindingsError';
  }
}

export function isMissingBoundCliBindingsError(error: unknown): error is MissingBoundCliBindingsError {
  return error instanceof MissingBoundCliBindingsError;
}

function createMissingBoundBindingsError(backendId: string, surface: 'interactive sessions' | 'execution runs'): Error {
  return new MissingBoundCliBindingsError(backendId, surface);
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

function createUnsupportedCliBindingRuntime(params: Readonly<{
  backend: ResolvedBackendContribution;
}>): CliRuntimeBindings {
  return Object.freeze({
    async createSessionRuntime(_sessionParams: unknown): Promise<HostSessionRuntimePlan> {
      throw createMissingBoundBindingsError(params.backend.id, 'interactive sessions');
    },
    createExecutionRunBackend(_opts: CreateCliExecutionRunBackendParams): ExecutionRunHostRuntime {
      throw createMissingBoundBindingsError(params.backend.id, 'execution runs');
    },
  });
}

export function createMissingCliEngineAdapter(params: Readonly<{
  backend: ResolvedBackendContribution;
}>): CliEngineAdapter {
  return Object.freeze({
    bindings: createUnsupportedCliBindingRuntime({
      backend: params.backend,
    }),
  });
}
