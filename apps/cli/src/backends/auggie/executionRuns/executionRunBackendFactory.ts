import { createAuggieBackend } from '@/backends/auggie/acp/backend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return createAuggieBackend({ cwd: opts.cwd, permissionHandler: opts.permissionHandler });
};

