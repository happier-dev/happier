import { createCodexAcpBackend } from '@/backends/codex/acp/backend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return createCodexAcpBackend({
    cwd: opts.cwd,
    permissionHandler: opts.permissionHandler,
    permissionMode: opts.permissionMode as any,
  }).backend;
};

