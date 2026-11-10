import { randomUUID } from 'node:crypto';

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import type { AgentMessage } from '../core';
import type { AgentAcpToolNameResolver } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ToolNameContext, TransportHandler } from '../transport';
import { logger } from '@/ui/logger';
import {
  markToolCallRunningAfterPermission,
  markToolCallWaitingForPermission,
  type HandlerContext,
} from './sessionUpdateHandlers';
import type { AcpPermissionHandler } from './permissions/acpPermissionHandler';
import { createAcpNativePermissionChoices } from './permissions/permissionMapping';
import { createMcpCatalogPermissionChoiceV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { AcpClientConnectionHandlers } from './connection/types';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { LegacyAcpToolRuntime } from './toolCalls/legacy/runtime';
import { buildAcpToolNameResolverInput } from './toolCalls/toolNameResolverInput';
import { normalizeResolvedToolName } from './runtime/definition/transport';
import { isWorkflowInteractionCapacityError } from '@/agent/permissions/interactionPersistenceError';
import {
  extractPermissionInputWithFallback,
  extractPermissionToolNameHint,
  refinePermissionToolNameWithInput,
  resolvePermissionToolName,
  type PermissionRequestLike,
} from './permissions/permissionRequest';

type ExtendedRequestPermissionRequest = RequestPermissionRequest & {
  toolCall?: {
    toolCallId?: string;
    id?: string;
    kind?: string;
    toolName?: string;
    title?: string;
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
  resolveToolNameAwaitable?: (
    request: Parameters<AgentAcpToolNameResolver>[0],
  ) => Promise<ReturnType<AgentAcpToolNameResolver>>;
  createHandlerContext: () => HandlerContext;
  getToolNameContext: () => ToolNameContext;
  getActiveSessionId: () => string | null;
  beforePermissionRequest?: (sessionId: string, toolCallId: string) => Promise<void>;
  capturePermissionRequest: (sessionId: string) => Readonly<{
    scope: 'session' | 'turn';
    isCurrent: () => boolean;
    cancel: (failure?: Error) => Promise<void>;
  }>;
  emitPermissionResponse: (requestId: string, approved: boolean) => Promise<void>;
  clearTrackedToolCall: (toolCallId: string, reason: string) => void;
  incrementToolCallCountSincePrompt: () => void;
  toolCalls: LegacyAcpToolRuntime;
  lastSelectedPermissionOptionIdByToolCallId: Map<string, string>;
}>): Pick<
  AcpClientConnectionHandlers,
  'sessionUpdate' | 'requestPermission' | 'createElicitation'
> {
  const handleElicitation = params.permissionHandler?.handleElicitation?.bind(params.permissionHandler);

  return {
    sessionUpdate: async (notification: SessionNotification) => {
      await params.onSessionUpdate(notification);
    },
    ...(handleElicitation
      ? {
          createElicitation: async (
            request: CreateElicitationRequest,
            context?: Readonly<{ signal: AbortSignal }>,
          ): Promise<CreateElicitationResponse> => {
            const requestSessionId =
              request.mode === 'form' && 'sessionId' in request && typeof request.sessionId === 'string'
                ? request.sessionId
                : (params.getActiveSessionId() ?? '');
            const toolCallId = readNonBlankOpaqueIdentifier('toolCallId' in request ? request.toolCallId : null)
              ?? `acp-elicitation:${randomUUID()}`;
            try {
              await params.beforePermissionRequest?.(requestSessionId, toolCallId);
            } catch {
              return { action: 'cancel' };
            }
            const permissionRequest = params.capturePermissionRequest(requestSessionId);
            if (context?.signal.aborted || !permissionRequest.isCurrent()) {
              return { action: 'cancel' };
            }

            try {
              const response = await (context
                ? handleElicitation(request, { signal: context.signal })
                : handleElicitation(request));
              if (context?.signal.aborted || !permissionRequest.isCurrent()) {
                return { action: 'cancel' };
              }
              return response;
            } catch (error) {
              logger.debug('[AcpBackend] Error in elicitation handler:', error);
              if (!context?.signal.aborted && permissionRequest.isCurrent() && isWorkflowInteractionCapacityError(error)) {
                await permissionRequest.cancel(error).catch((cancelError: unknown) => {
                  logger.warn('[AcpBackend] Elicitation capacity cancellation failed', {
                    errorType: cancelError instanceof Error ? 'Error' : typeof cancelError,
                  });
                });
              }
              return { action: 'cancel' };
            }
          },
        }
      : {}),
    requestPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      const extendedParams = request as ExtendedRequestPermissionRequest;
      const toolCall = extendedParams.toolCall;
      const options = extendedParams.options || [];
      if (options.length === 0) return { outcome: { outcome: 'cancelled' } };
      const toolCallId = readNonBlankOpaqueIdentifier(toolCall?.toolCallId)
        ?? readNonBlankOpaqueIdentifier(toolCall?.id)
        ?? randomUUID();
      const permissionId = toolCallId;
      const upstreamChoices = createAcpNativePermissionChoices(randomUUID(), request.options);
      const requestSessionId =
        typeof (extendedParams as { sessionId?: unknown }).sessionId === 'string'
          ? String((extendedParams as { sessionId?: string }).sessionId)
          : (params.getActiveSessionId() ?? '');
      try { await params.beforePermissionRequest?.(requestSessionId, toolCallId); }
      catch {
        logger.warnLocalFile('[AcpBackend] Provider permission has no proven turn owner');
        return { outcome: { outcome: 'cancelled' } };
      }
      const permissionRequest = params.capturePermissionRequest(requestSessionId);
      const tracksForeground = permissionRequest.scope === 'turn';
      const withdraw = (): RequestPermissionResponse => {
        logger.warn('[AcpBackend] Withdrew permission request without current ownership', {
          reason: requestSessionId !== params.getActiveSessionId() ? 'session_mismatch'
            : tracksForeground ? 'inactive_turn' : 'missing_permission_handler',
        });
        return { outcome: { outcome: 'cancelled' } };
      };
      if (!permissionRequest.isCurrent()) return withdraw();
      const knownCall = tracksForeground ? params.toolCalls.readCall(toolCallId) : undefined;
      const cancelOwnedPrompt = async (failure?: Error): Promise<void> => {
        const cancelPromise = permissionRequest.cancel(failure);
        await params.emitPermissionResponse(permissionId, false);
        void cancelPromise.catch((error: unknown) => logger.warn('[AcpBackend] Permission cancellation failed', {
          errorType: error instanceof Error ? 'Error' : typeof error,
        }));
      };
      const fallbackInput = knownCall?.rawInput && typeof knownCall.rawInput === 'object' && !Array.isArray(knownCall.rawInput)
        ? knownCall.rawInput as Record<string, unknown>
        : undefined;

      let toolNameHint = extractPermissionToolNameHint(extendedParams as PermissionRequestLike);
      let input = extractPermissionInputWithFallback(
        extendedParams as PermissionRequestLike,
        fallbackInput,
      );
      const inferenceInput = buildAcpToolNameResolverInput(input, toolCall?.title, toolCall?.kind);
      toolNameHint = refinePermissionToolNameWithInput(toolNameHint, input);
      let toolName = resolvePermissionToolName({
        toolNameHint,
        mappedToolName: knownCall?.toolName,
      });

      const cachedOptionId = tracksForeground ? params.lastSelectedPermissionOptionIdByToolCallId.get(toolCallId) : undefined;
      if (cachedOptionId && options.some((opt) => opt.optionId === cachedOptionId)) {
        logger.debug(`[AcpBackend] Duplicate permission prompt for ${toolCallId}, reusing cached optionId=${cachedOptionId}`);
        return { outcome: { outcome: 'selected', optionId: cachedOptionId } };
      }

      try {
        const nativeToolName = toolCall?.toolName ?? toolCall?.kind ?? extendedParams.kind ?? toolName;
        const context = { ...(tracksForeground ? params.getToolNameContext()
          : { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }), nativeToolName };
        const projection = await params.resolveToolNameAwaitable?.({
          toolName: nativeToolName, toolCallId, input: inferenceInput, context,
        });
        const projectedInvocation = normalizeResolvedToolName(projection, toolName, nativeToolName);
        const resolved = projectedInvocation
          ?? params.transport.determineToolName?.(toolName, toolCallId, inferenceInput, context) ?? toolName;
        toolName = typeof resolved === 'string' ? resolved : resolved.toolName;
        if (typeof resolved !== 'string') input = { ...resolved.input };
      } catch (error) {
        logger.debug('[AcpBackend] Cannot resolve permission tool identity:', error);
        if (!permissionRequest.isCurrent()) return withdraw();
        await cancelOwnedPrompt();
        return { outcome: { outcome: 'cancelled' } };
      }

      // The declared transport owns host-managed MCP's revocable session grant.
      // Project its chosen native option before publication, never rank an answer afterwards.
      const sessionOptionId = params.transport.pickPermissionOptionId?.(
        request.options, 'approved_for_session', { toolCallId, toolName, input },
      );
      const sessionOption = request.options.find(option => option.optionId === sessionOptionId && option.kind === 'allow_once');
      const nativeOptionIdByChoiceId = new Map<string, string>();
      const choices: Array<typeof upstreamChoices.choices[number]> = [];
      for (const [index, choice] of upstreamChoices.choices.entries()) {
        if (choice.decision === 'approved' && sessionOptionId === null) continue;
        const hostSessionGrant = request.options[index]?.kind === 'allow_always'
          && sessionOption && sessionOption.optionId !== choice.id;
        choices.push(hostSessionGrant ? {
          ...choice, decision: 'approved_for_session', scope: 'session',
          response: { approved: true, decision: 'approved_for_session' },
        } : choice);
        nativeOptionIdByChoiceId.set(choice.id, hostSessionGrant ? sessionOption.optionId : choice.id);
      }
      const nativeChoices = { ...upstreamChoices, choices };
      if (choices.length === 0) {
        await cancelOwnedPrompt();
        return { outcome: { outcome: 'cancelled' } };
      }

      if (toolName !== (toolCall?.kind || toolCall?.toolName || extendedParams.kind || 'Unknown tool')) {
        logger.debug(`[AcpBackend] Detected tool name: ${toolName} from toolCallId: ${toolCallId}`);
      }

      if (tracksForeground) {
        params.toolCalls.observePermission({ toolCallId, toolName, input });
        markToolCallWaitingForPermission(toolCallId, params.createHandlerContext());
        if (!knownCall) params.incrementToolCallCountSincePrompt();
      }

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
        const rejectOnce = request.options.find((option) => option.kind === 'reject_once');
        params.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
        await cancelOwnedPrompt();
        return { outcome: rejectOnce
          ? { outcome: 'selected', optionId: rejectOnce.optionId }
          : { outcome: 'cancelled' } };
      }

      if (!permissionRequest.isCurrent()) return withdraw();

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

      if (params.permissionHandler) {
        try {
          const result = await params.permissionHandler.handleToolCall(
            toolCallId, toolName, input, {
              nativeChoices,
              buildNativeChoices: ({ mcpTool }) => {
                const onceOption = request.options.find(option => option.kind === 'allow_once');
                const grant = choices.find(choice => choice.id === onceOption?.optionId);
                const catalogChoice = grant ? createMcpCatalogPermissionChoiceV1({ mcpTool, grant, existingChoices: choices }) : undefined;
                if (!catalogChoice || !onceOption) return nativeChoices;
                nativeOptionIdByChoiceId.set(catalogChoice.id, onceOption.optionId);
                return { ...nativeChoices, choices: [...choices, catalogChoice] };
              },
            },
          );
          if (!permissionRequest.isCurrent()) return withdraw();
          const isApproved =
            result.decision === 'approved'
            || result.decision === 'approved_for_session'
            || result.decision === 'approved_execpolicy_amendment';

          const optionId = result.nativeChoice ? nativeOptionIdByChoiceId.get(result.nativeChoice.choiceId) : undefined;
          const outcome = optionId
            ? { outcome: 'selected' as const, optionId }
            : { outcome: 'cancelled' as const };
          if (tracksForeground && outcome.outcome === 'selected') {
            params.lastSelectedPermissionOptionIdByToolCallId.set(toolCallId, outcome.optionId);
          } else if (tracksForeground) {
            params.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
          }

          if (result.decision === 'denied' || result.decision === 'abort') {
            await cancelOwnedPrompt();
            return { outcome };
          }

          await params.emitPermissionResponse(permissionId, isApproved);
          if (!permissionRequest.isCurrent()) return withdraw();

          if (tracksForeground && isApproved) {
            markToolCallRunningAfterPermission(toolCallId, params.createHandlerContext());
          } else if (tracksForeground) {
            params.clearTrackedToolCall(toolCallId, `permission decision=${result.decision}`);
          }
          return { outcome };
        } catch (error) {
          logger.warn('[AcpBackend] Permission policy failed; request withdrawn', {
            phase: 'decision', errorType: error instanceof Error ? 'Error' : typeof error,
          });
          if (!permissionRequest.isCurrent()) return withdraw();
          await cancelOwnedPrompt(isWorkflowInteractionCapacityError(error) ? error : undefined);
          return { outcome: { outcome: 'cancelled' } };
        }
      }

      return { outcome: { outcome: 'cancelled' } };
    },
  };
}
