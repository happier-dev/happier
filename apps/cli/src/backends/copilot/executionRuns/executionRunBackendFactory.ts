import { createCopilotBackend } from '@/backends/copilot/acp/backend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';
import { permissionModeForExecutionRunPolicy } from '@/backends/executionRuns/permissionModeForExecutionRunPolicy';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return createCopilotBackend({
    cwd: opts.cwd,
    env: opts.isolation?.env,
    permissionHandler: opts.permissionHandler,
    permissionMode: permissionModeForExecutionRunPolicy(opts.permissionMode),
  });
};
