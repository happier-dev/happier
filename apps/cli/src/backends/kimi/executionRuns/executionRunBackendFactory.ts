import { createKimiBackend } from '@/backends/kimi/acp/backend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return createKimiBackend({ cwd: opts.cwd, permissionHandler: opts.permissionHandler });
};

