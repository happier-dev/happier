import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { ExecutionRunPermissionInteractionMode } from './executionRunPermissionInteractionPolicy';
import { createExecutionRunPermissionHandler } from './executionRunPermissionDecision';
import { parseMcpToolWireNameV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { AcpPermissionCallContext } from '@/agent/acp/permissions/acpPermissionHandler';
import { isAgentStructuredQuestionRequest, isHostOccurrenceQuestion } from '@/agent/permissions/requestKind';
import { buildRunScopedExecutionPermissionRequestId, readRunScopedExecutionPermissionRequestIdentity } from '@happier-dev/protocol/execution/runs/runPrimitives';

export { buildRunScopedExecutionPermissionRequestId };

export function readRunScopedExecutionProviderRequestId(params: Readonly<{
  runId: string;
  controllerOccurrenceId: string;
  requestId: string;
}>): string | null {
  const runId = String(params.runId ?? '').trim();
  const controllerOccurrenceId = String(params.controllerOccurrenceId ?? '').trim();
  const identity = readRunScopedExecutionPermissionRequestIdentity(params.requestId);
  return runId && controllerOccurrenceId && identity?.runId === runId && identity.controllerOccurrenceId === controllerOccurrenceId
    ? identity.providerRequestId : null;
}

export function createRunScopedExecutionPermissionHandler(params: Readonly<{
  runId: string;
  controllerOccurrenceId: string;
  handler: AcpPermissionHandler;
  toolPolicy?: Omit<Parameters<typeof createExecutionRunPermissionHandler>[0], 'publishPendingRequest'>;
  mcpToolPolicy?: NonNullable<AcpPermissionCallContext['mcpToolPolicy']>;
  onPendingRequestAborted?: (request: Readonly<{
    requestId: string;
    reason: string;
  }>) => void | Promise<void>;
  readInteractionMode?: () => ExecutionRunPermissionInteractionMode;
}>): Readonly<{
  handler: AcpPermissionHandler;
  respondToPermissionRequest: (providerRequestId: string, approved: boolean) => boolean;
  dispose: (reason: string) => Promise<void>;
}> {
  const runId = String(params.runId ?? '').trim();
  if (!runId) throw new Error('Execution-run permission scope requires a non-blank runId');
  const controllerOccurrenceId = String(params.controllerOccurrenceId ?? '').trim();
  if (!controllerOccurrenceId) throw new Error('Execution-run permission scope requires a controller occurrence id');
  const abortPendingRequestAndFlush = params.handler.abortPendingRequestAndFlush;
  if (typeof abortPendingRequestAndFlush !== 'function') {
    throw new Error('Execution-run permission scope requires exact permission cancellation support');
  }
  const pendingRequestIds = new Set<string>();
  const toolPolicy = params.toolPolicy ? createExecutionRunPermissionHandler(params.toolPolicy) : null;
  const cleanupRequestIds = new Set<string>();
  const abortingRequestIds = new Set<string>();
  const scopedRequestId = (requestId: string) => buildRunScopedExecutionPermissionRequestId({
    runId,
    controllerOccurrenceId,
    providerRequestId: requestId,
  });
  const mcpContext = (toolName: string, context: AcpPermissionCallContext | undefined): AcpPermissionCallContext | undefined => {
    const policy = params.mcpToolPolicy ?? (params.toolPolicy?.getMcpToolContext
      ? { permissionMode: params.toolPolicy.permissionMode, readContext: params.toolPolicy.getMcpToolContext } : undefined);
    const current = policy?.readContext();
    return policy && current && parseMcpToolWireNameV1(toolName, new Set(Object.keys(current.mcpServerIdentities)))
      ? { ...context, mcpToolPolicy: policy } : context;
  };
  const readImmediate: NonNullable<AcpPermissionHandler['getImmediateDecision']> = (toolCallId, toolName, input, context) => {
    if (isAgentStructuredQuestionRequest({ toolName, source: context?.source })) return null;
    const inherited = params.handler.getImmediateDecision?.(toolCallId, toolName, input, mcpContext(toolName, context)) ?? null;
    if (inherited?.decision === 'denied' || inherited?.decision === 'abort') return inherited;
    return toolPolicy?.getImmediateDecision(toolCallId, toolName, input, context) ?? inherited;
  };

  const abortExact = async (requestId: string, reason: string, options?: Readonly<{ preserveQuestions?: boolean }>): Promise<void> => {
    if (!pendingRequestIds.has(requestId) && !cleanupRequestIds.has(requestId)) return;
    cleanupRequestIds.add(requestId);
    abortingRequestIds.add(requestId);
    try {
      await abortPendingRequestAndFlush.call(params.handler, requestId, reason, options);
      await params.onPendingRequestAborted?.({ requestId, reason });
      pendingRequestIds.delete(requestId);
      cleanupRequestIds.delete(requestId);
    } finally {
      abortingRequestIds.delete(requestId);
    }
  };

  return {
    handler: {
      ...(params.handler.resolvePrePromptDecision
        ? {
            resolvePrePromptDecision: async (toolCallId, toolName, input) =>
              readImmediate(scopedRequestId(toolCallId), toolName, input)
              ?? await params.handler.resolvePrePromptDecision!(scopedRequestId(toolCallId), toolName, input),
          }
        : {}),
      ...(params.handler.getImmediateDecision || params.toolPolicy
        ? {
            getImmediateDecision: (toolCallId, toolName, input, context) =>
              readImmediate(scopedRequestId(toolCallId), toolName, input, context),
          }
        : {}),
      async handleToolCall(toolCallId, toolName, input, context) {
        const requestId = scopedRequestId(toolCallId);
        const question = isAgentStructuredQuestionRequest({ toolName, source: context?.source });
        const immediate = readImmediate(requestId, toolName, input, context);
        if (immediate) return immediate;
        // Startup questions have no admitted executable turn. Keep their exact
        // Run scope, but let the Session question owner collect the person's answer.
        const interactionMode = isHostOccurrenceQuestion(toolName, context) ? undefined : params.readInteractionMode?.();
        if (interactionMode === 'interaction_unavailable'
          || (question && (interactionMode === 'deterministic' || interactionMode === 'fail_closed'))) {
          throw Object.assign(
            new Error('Execution-run permission interaction target is unavailable'),
            { code: 'execution_run_interaction_unavailable' },
          );
        }
        if (interactionMode === 'deterministic' || interactionMode === 'fail_closed') {
          return { decision: 'denied' };
        }
        pendingRequestIds.add(requestId);
        try {
          return await params.handler.handleToolCall(requestId, toolName, input, mcpContext(toolName, context));
        } finally {
          if (!abortingRequestIds.has(requestId)) pendingRequestIds.delete(requestId);
        }
      },
      async abortPendingRequestAndFlush(toolCallId, reason, options) {
        await abortExact(scopedRequestId(toolCallId), reason, options);
      },
      async abortPendingRequestsAndFlush(reason, options) {
        await Promise.all([...new Set([...pendingRequestIds, ...cleanupRequestIds])].map(async (requestId) => {
          await abortExact(requestId, reason, options);
        }));
      },
    },
    respondToPermissionRequest(providerRequestId, approved) {
      const requestId = scopedRequestId(providerRequestId);
      if (!pendingRequestIds.has(requestId)) return false;
      const responder = (params.handler as AcpPermissionHandler & Readonly<{
        respondToPermissionRequest?: (requestId: string, approved: boolean) => boolean;
      }>).respondToPermissionRequest;
      if (!responder) return false;
      return responder(requestId, approved);
    },
    async dispose(reason) {
      await Promise.all([...new Set([...pendingRequestIds, ...cleanupRequestIds])].map(async (requestId) => {
        await abortExact(requestId, reason);
      }));
    },
  };
}
