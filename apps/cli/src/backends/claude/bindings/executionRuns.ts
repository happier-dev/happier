import { createDescriptorBackend } from '@/agent/runtime/registry/createDescriptorBackend';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';

import { executionRunBackendFactory, resolveIsolation } from '../executionRuns/executionRunBackendFactory';

export function createClaudeExecutionRunBinding(opts: CreateCliExecutionRunBackendParams) {
  const backend = createDescriptorBackend(opts, {
    factory: executionRunBackendFactory,
    resolveIsolation,
  });
  if (!backend) {
    throw new Error(`Unsupported execution-run backend: ${opts.backendId}`);
  }
  return backend;
}
