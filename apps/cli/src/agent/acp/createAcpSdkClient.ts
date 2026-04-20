import { randomUUID } from 'node:crypto';

import type {
  Client,
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

export function createAcpSdkClient(params: Readonly<{
  onSessionUpdate: (notification: SessionNotification) => void;
  transport: TransportHandler;
  emit: (message: AgentMessage) => void;
  permissionHandler?: AcpPermissionHandler;
  createHandlerContext: () => HandlerContext;
  getToolNameContext: () => ToolNameContext;
  getActiveSessionId: () => string | null;
  cancel: (sessionId: string) => Promise<void>;
  respondToPermission: (requestId: string, approved: boolean) => Promise<void>;
  clearTrackedToolCall: (toolCallId: string, reason: string) => void;
  incrementToolCallCountSincePrompt: () => void;
  toolCallIdToNameMap: Map<string, string>;
  toolCallIdToInputMap: Map<string, Record<string, unknown>>;
  lastSelectedPermissionOptionIdByToolCallId: Map<string, string>;
}>): Pick<Client, 'sessionUpdate' | 'requestPermission'> {
  return {
    sessionUpdate: async (notification: SessionNotification) => {
      params.onSessionUpdate(notification);
    },
    requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      const extendedParams = request as ExtendedRequestPermissionRequest;
      const toolCall = extendedParams.toolCall;
      const options = extendedParams.options || [];
      const toolCallId =
        (typeof toolCall?.toolCallId === 'string' && toolCall.toolCallId.trim().length > 0)
          ? toolCall.toolCallId.trim()
          : (typeof toolCall?.id === 'string' && toolCall.id.trim().length > 0)
            ? toolCall.id.trim()
            : randomUUID();
      const permissionId = toolCallId;

      let toolNameHint = extractPermissionToolNameHint(extendedParams as PermissionRequestLike);
      const input = extractPermissionInputWithFallback(
        extendedParams as PermissionRequestLike,
        toolCallId,
        params.toolCallIdToInputMap,
      );
      toolNameHint = refinePermissionToolNameWithInput(toolNameHint, input);
      let toolName = resolvePermissionToolName({
        toolNameHint,
        toolCallId,
        toolCallIdToNameMap: params.toolCallIdToNameMap,
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

      const cachedToolName = params.toolCallIdToNameMap.get(toolCallId);
      if (!cachedToolName || shouldReplaceCachedPermissionToolName(cachedToolName, toolName)) {
        params.toolCallIdToNameMap.set(toolCallId, toolName);
      }
      if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length > 0) {
        if (!params.toolCallIdToInputMap.has(toolCallId)) {
          params.toolCallIdToInputMap.set(toolCallId, input);
        }
      }
      markToolCallWaitingForPermission(toolCallId, params.createHandlerContext());
      params.incrementToolCallCountSincePrompt();

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

      const immediateDecision = params.permissionHandler?.getImmediateDecision?.(
        toolCallId,
        toolName,
        input,
      ) ?? null;

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
          const result = await params.permissionHandler.handleToolCall(toolCallId, toolName, input);
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

          await params.respondToPermission(permissionId, isApproved);

          if (result.decision === 'denied' || result.decision === 'abort') {
            const requestSessionId =
              typeof (extendedParams as { sessionId?: unknown }).sessionId === 'string'
                ? String((extendedParams as { sessionId?: string }).sessionId)
                : (params.getActiveSessionId() ?? '');
            void params.cancel(requestSessionId);
            params.clearTrackedToolCall(toolCallId, `permission decision=${result.decision}`);
            return { outcome };
          }

          if (isApproved) {
            markToolCallRunningAfterPermission(toolCallId, params.createHandlerContext());
          } else {
            params.clearTrackedToolCall(toolCallId, `permission decision=${result.decision}`);
          }
          return { outcome };
        } catch (error) {
          logger.debug('[AcpBackend] Error in permission handler:', error);
          params.clearTrackedToolCall(toolCallId, 'permission handler error');
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
