import { createKiloBackend } from '@/backends/kilo/acp/backend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';
import { permissionModeForExecutionRunPolicy } from '@/backends/executionRuns/permissionModeForExecutionRunPolicy';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return createKiloBackend({
    cwd: opts.cwd,
    env: opts.isolation?.env,
    permissionHandler: opts.permissionHandler,
    permissionMode: permissionModeForExecutionRunPolicy(opts.permissionMode),
  });
};
