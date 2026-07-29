import { randomUUID } from 'node:crypto';

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import type { AgentMessage } from '../core';
import type { ToolNameContext, TransportHandler } from '../transport';
import { logger } from '@/ui/logger';
import {
  markToolCallRunningAfterPermission,
  markToolCallWaitingForPermission,
  type HandlerContext,
} from './sessionUpdateHandlers';
import type { AcpPermissionHandler } from './permissions/acpPermissionHandler';
import { pickPermissionOutcome } from './permissions/permissionMapping';
import type { AcpClientConnectionHandlers } from './connection/types';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import type { LegacyAcpToolRuntime } from './toolCalls/legacy/runtime';
import {
  extractPermissionInputWithFallback,
  extractPermissionToolNameHint,
  refinePermissionToolNameWithInput,
  resolvePermissionToolName,
  shouldReplaceCachedPermissionToolName,
  type PermissionRequestLike,
} from './permissions/permissionRequest';

type ExtendedRequestPermissionRequest = RequestPermissionRequest & {
  toolCall?: {
    toolCallId?: string;
    id?: string;
    kind?: string;
    toolName?: string;
    rawInput?: Record<string, unknown>;
    input?: Record<string, unknown>;
    arguments?: Record<string, unknown>;
    content?: Record<string, unknown>;
  };
  kind?: string;
  rawInput?: Record<string, unknown>;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  content?: Record<string, unknown>;
  options?: Array<{
    optionId?: string;
    name?: string;
    kind?: string;
  }>;
};

export function createAcpClientHandlers(params: Readonly<{
  onSessionUpdate: (notification: SessionNotification) => void | Promise<void>;
  transport: TransportHandler;
  emit: (message: AgentMessage) => void;
  permissionHandler?: AcpPermissionHandler;
  createHandlerContext: () => HandlerContext;
  getToolNameContext: () => ToolNameContext;
  getActiveSessionId: () => string | null;
  cancel: (sessionId: string) => Promise<void>;
  emitPermissionResponse: (requestId: string, approved: boolean) => Promise<void>;
  clearTrackedToolCall: (toolCallId: string, reason: string) => void;
  incrementToolCallCountSincePrompt: () => void;
  toolCalls: LegacyAcpToolRuntime;
  lastSelectedPermissionOptionIdByToolCallId: Map<string, string>;
}>): Pick<AcpClientConnectionHandlers, 'sessionUpdate' | 'requestPermission'> {
  return {
    sessionUpdate: async (notification: SessionNotification) => {
      await params.onSessionUpdate(notification);
    },
    requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      const extendedParams = request as ExtendedRequestPermissionRequest;
      const toolCall = extendedParams.toolCall;
      const options = extendedParams.options || [];
      const toolCallId = readNonBlankOpaqueIdentifier(toolCall?.toolCallId)
        ?? readNonBlankOpaqueIdentifier(toolCall?.id)
        ?? randomUUID();
      const permissionId = toolCallId;
      const knownCall = params.toolCalls.readCall(toolCallId);
      const requestSessionId =
        typeof (extendedParams as { sessionId?: unknown }).sessionId === 'string'
          ? String((extendedParams as { sessionId?: string }).sessionId)
          : (params.getActiveSessionId() ?? '');
      const cancelAndTerminalize = async (reason: string): Promise<void> => {
        const cancelPromise = params.cancel(requestSessionId);
        await params.emitPermissionResponse(permissionId, false);
        void cancelPromise.catch((error) => logger.debug('[AcpBackend] Permission cancellation failed:', error));
        params.clearTrackedToolCall(toolCallId, reason);
      };
      const fallbackInput = knownCall?.rawInput && typeof knownCall.rawInput === 'object' && !Array.isArray(knownCall.rawInput)
        ? knownCall.rawInput as Record<string, unknown>
        : undefined;

      let toolNameHint = extractPermissionToolNameHint(extendedParams as PermissionRequestLike);
      const input = extractPermissionInputWithFallback(
        extendedParams as PermissionRequestLike,
        fallbackInput,
      );
      toolNameHint = refinePermissionToolNameWithInput(toolNameHint, input);
      let toolName = resolvePermissionToolName({
        toolNameHint,
        mappedToolName: knownCall?.toolName,
      });

      const cachedOptionId = params.lastSelectedPermissionOptionIdByToolCallId.get(toolCallId);
      if (cachedOptionId && options.some((opt) => opt.optionId === cachedOptionId)) {
        logger.debug(`[AcpBackend] Duplicate permission prompt for ${toolCallId}, reusing cached optionId=${cachedOptionId}`);
        return { outcome: { outcome: 'selected', optionId: cachedOptionId } };
      }

      toolName = params.transport.determineToolName?.(toolName, toolCallId, input, params.getToolNameContext()) ?? toolName;

      if (toolName !== (toolCall?.kind || toolCall?.toolName || extendedParams.kind || 'Unknown tool')) {
        logger.debug(`[AcpBackend] Detected tool name: ${toolName} from toolCallId: ${toolCallId}`);
      }

      if (knownCall && shouldReplaceCachedPermissionToolName(knownCall.toolName, toolName)) {
        toolName = params.transport.determineToolName?.(toolName, toolCallId, input, params.getToolNameContext()) ?? toolName;
      }
      params.toolCalls.observePermission({ toolCallId, toolName, input });
      markToolCallWaitingForPermission(toolCallId, params.createHandlerContext());
      if (!knownCall) params.incrementToolCallCountSincePrompt();

      const inputKeys = input && typeof input === 'object' && !Array.isArray(input)
        ? Object.keys(input as Record<string, unknown>)
        : [];
      logger.debug(`[AcpBackend] Permission request: tool=${toolName}, toolCallId=${toolCallId}, inputKeys=${inputKeys.join(',')}`);
      logger.debug(`[AcpBackend] Permission request params structure:`, JSON.stringify({
        hasToolCall: !!toolCall,
        toolCallToolCallId: toolCall?.toolCallId,
        toolCallKind: toolCall?.kind,
        toolCallToolName: toolCall?.toolName,
        toolCallId: toolCall?.id,
        paramsKind: extendedParams.kind,
        options: options.map((opt) => ({ optionId: opt.optionId, kind: opt.kind, name: opt.name })),
        paramsKeys: Object.keys(request),
      }, null, 2));

      if (!params.permissionHandler) {
        const outcome = pickPermissionOutcome(options, 'denied');
        params.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
        await cancelAndTerminalize('permission handler missing');
        return { outcome };
      }

      let prePromptDecision: Awaited<ReturnType<NonNullable<AcpPermissionHandler['resolvePrePromptDecision']>>> = null;
      let immediateDecision: Awaited<ReturnType<AcpPermissionHandler['handleToolCall']>> | null = null;
      try {
        prePromptDecision = await (params.permissionHandler.resolvePrePromptDecision?.(
          toolCallId,
          toolName,
          input,
        ) ?? Promise.resolve(null));
        immediateDecision = prePromptDecision ?? params.permissionHandler.getImmediateDecision?.(
          toolCallId,
          toolName,
          input,
        ) ?? null;
      } catch (error) {
        logger.debug('[AcpBackend] Error resolving immediate permission decision:', error);
        await cancelAndTerminalize('permission decision hook error');
        return { outcome: { outcome: 'cancelled' } };
      }

      if (!immediateDecision) {
        params.emit({
          type: 'permission-request',
          id: permissionId,
          reason: toolName,
          payload: {
            ...request,
            permissionId,
            toolCallId,
            toolName,
            input,
            options: options.map((opt) => ({
              id: opt.optionId,
              name: opt.name,
              kind: opt.kind,
            })),
          },
        });
      }

      if (params.permissionHandler) {
        try {
          const result = prePromptDecision ?? await params.permissionHandler.handleToolCall(toolCallId, toolName, input);
          const isApproved =
            result.decision === 'approved'
            || result.decision === 'approved_for_session'
            || result.decision === 'approved_execpolicy_amendment';

          const resolvedDecision = String(result.decision);
          const overrideOptionId = params.transport.pickPermissionOptionId?.(
            options,
            resolvedDecision,
            { toolCallId, toolName, input },
          );
          const outcome = (() => {
            if (overrideOptionId === null) return { outcome: 'cancelled' as const };
            if (typeof overrideOptionId === 'string' && overrideOptionId.trim().length > 0) {
              if (options.some((opt) => opt.optionId === overrideOptionId)) {
                return { outcome: 'selected' as const, optionId: overrideOptionId };
              }
              logger.debug('[AcpBackend] Transport returned unknown permission optionId override; falling back to default mapping', {
                toolCallId,
                toolName,
                optionId: overrideOptionId,
              });
            }
            return pickPermissionOutcome(options, resolvedDecision);
          })();
          if (outcome.outcome === 'selected') {
            params.lastSelectedPermissionOptionIdByToolCallId.set(toolCallId, outcome.optionId);
          } else {
            params.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
          }

          if (result.decision === 'denied' || result.decision === 'abort') {
            await cancelAndTerminalize(`permission decision=${result.decision}`);
            return { outcome };
          }

          await params.emitPermissionResponse(permissionId, isApproved);

          if (isApproved) {
            markToolCallRunningAfterPermission(toolCallId, params.createHandlerContext());
          } else {
            params.clearTrackedToolCall(toolCallId, `permission decision=${result.decision}`);
          }
          return { outcome };
        } catch (error) {
          logger.debug('[AcpBackend] Error in permission handler:', error);
          await cancelAndTerminalize('permission handler error');
          return { outcome: { outcome: 'cancelled' } };
        }
      }

      const outcome = pickPermissionOutcome(options, 'approved');
      if (outcome.outcome === 'selected') {
        params.lastSelectedPermissionOptionIdByToolCallId.set(toolCallId, outcome.optionId);
      } else {
        params.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
      }
      markToolCallRunningAfterPermission(toolCallId, params.createHandlerContext());
      return { outcome };
    },
  };
}
