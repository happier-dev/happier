import { createGeminiBackend } from '@/backends/gemini/acp/backend';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { createSimpleExecutionRunBackendFactory } from '@/backends/shared/createSimpleExecutionRunBackendFactory';

export const executionRunBackendFactory: ExecutionRunBackendFactory = createSimpleExecutionRunBackendFactory(
  (opts) => createGeminiBackend(opts as any).backend,
);
