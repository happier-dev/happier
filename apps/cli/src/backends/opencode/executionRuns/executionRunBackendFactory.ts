import { createOpenCodeBackend } from '@/backends/opencode/acp/backend';
import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return createOpenCodeBackend({
    cwd: opts.cwd,
    env: opts.isolation?.env,
    permissionHandler: opts.permissionHandler,
    permissionMode: permissionModeForExecutionRunPolicy(opts.permissionMode),
  });
};
