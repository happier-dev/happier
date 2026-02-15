import { createGeminiBackend } from '@/backends/gemini/acp/backend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return createGeminiBackend({ cwd: opts.cwd, permissionHandler: opts.permissionHandler }).backend;
};

