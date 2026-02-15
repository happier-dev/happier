import { ClaudeSdkAgentBackend } from '@/agent/claudeSdk/ClaudeSdkAgentBackend';
import type { ExecutionRunBackendFactory } from '@/backends/executionRuns/types';

export const executionRunBackendFactory: ExecutionRunBackendFactory = (opts) => {
  return new ClaudeSdkAgentBackend({
    cwd: opts.cwd,
    modelId: opts.modelId ?? 'default',
    permissionPolicy: opts.permissionMode as any,
  });
};

