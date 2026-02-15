import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';

import { getExecutionRunBackendFactory } from '@/backends/executionRuns/executionRunBackendRegistry';

function createDenyAllPermissionHandler(): AcpPermissionHandler {
  return {
    async handleToolCall() {
      return { decision: 'denied' };
    },
  };
}

export function createExecutionRunBackend(opts: Readonly<{
  cwd: string;
  backendId: string;
  modelId?: string;
  permissionMode: string;
  start?: Readonly<{ intentInput?: unknown }> | null;
}>): AgentBackend {
  const permissionHandler = createDenyAllPermissionHandler();
  const backendId = String(opts.backendId ?? '').trim();
  const factory = getExecutionRunBackendFactory(backendId);
  if (!factory) {
    throw new Error(`Unsupported execution-run backend: ${backendId}`);
  }
  return factory({
    cwd: opts.cwd,
    backendId,
    modelId: opts.modelId,
    permissionMode: opts.permissionMode,
    permissionHandler,
    start: opts.start ?? null,
  });
}
