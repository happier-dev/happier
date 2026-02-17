import { createOpenCodeBackend } from '@/backends/opencode/acp/backend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return createOpenCodeBackend({
    cwd: opts.cwd,
    env: opts.isolation?.env,
    permissionHandler: opts.permissionHandler,
    permissionMode: opts.permissionMode as any,
  });
};
