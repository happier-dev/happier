import { randomUUID } from 'node:crypto';

import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';

const EXECUTION_RUN_PERMISSION_REQUEST_PREFIX = 'execution-run:';

export function isExecutionRunPermissionRequestId(requestId: string): boolean {
  return requestId.startsWith(EXECUTION_RUN_PERMISSION_REQUEST_PREFIX);
}

export function createRunScopedExecutionPermissionHandler(params: Readonly<{
  runId: string;
  handler: AcpPermissionHandler;
}>): Readonly<{
  handler: AcpPermissionHandler;
  dispose: (reason: string) => void;
}> {
  const runId = String(params.runId ?? '').trim();
  if (!runId) throw new Error('Execution-run permission scope requires a non-blank runId');
  // Each wrapper belongs to one backend/controller occurrence. A resumable run can construct a
  // successor backend with the same run id, and providers may reuse their request ids after load.
  // Keep those occurrences distinct so the session coordinator cannot replay a retired decision.
  const controllerOccurrenceId = randomUUID();
  const prefix = `${EXECUTION_RUN_PERMISSION_REQUEST_PREFIX}${encodeURIComponent(runId)}:${encodeURIComponent(controllerOccurrenceId)}:`;
  const pendingRequestIds = new Set<string>();
  const scopedRequestId = (requestId: string) => `${prefix}${encodeURIComponent(requestId)}`;

  return {
    handler: {
      async handleToolCall(toolCallId, toolName, input, context) {
        const requestId = scopedRequestId(toolCallId);
        pendingRequestIds.add(requestId);
        try {
          return await params.handler.handleToolCall(requestId, toolName, input, context);
        } finally {
          pendingRequestIds.delete(requestId);
        }
      },
      cancelPendingRequest(requestId, reason) {
        const scopedId = scopedRequestId(requestId);
        const cancelled = params.handler.cancelPendingRequest?.(scopedId, reason) ?? false;
        if (cancelled) pendingRequestIds.delete(scopedId);
        return cancelled;
      },
    },
    dispose(reason) {
      for (const requestId of pendingRequestIds) {
        params.handler.cancelPendingRequest?.(requestId, reason);
      }
      pendingRequestIds.clear();
    },
  };
}
