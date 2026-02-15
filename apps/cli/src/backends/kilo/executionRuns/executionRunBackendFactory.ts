import { createKiloBackend } from '@/backends/kilo/acp/backend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return createKiloBackend({
    cwd: opts.cwd,
    permissionHandler: opts.permissionHandler,
    permissionMode: opts.permissionMode as any,
  });
};

