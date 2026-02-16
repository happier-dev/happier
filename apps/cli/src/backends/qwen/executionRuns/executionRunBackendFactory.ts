import { createQwenBackend } from '@/backends/qwen/acp/backend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return createQwenBackend({ cwd: opts.cwd, env: opts.isolation?.env, permissionHandler: opts.permissionHandler });
};
