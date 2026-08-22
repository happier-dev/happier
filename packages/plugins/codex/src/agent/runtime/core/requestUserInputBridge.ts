import type { SessionPermissionsService as SessionPermissionsServiceV1 } from '@happier-dev/plugin-sdk/sessions';

import {
  looksLikeCodexApprovalRequestUserInput,
  resolveCodexApprovalQuestionChoice,
  type CodexApprovalOutcome,
} from './requestUserInputQuestions.js';

type LoggerSubset = {
  debug: (message: string, ...args: unknown[]) => void;
};

type RequestPermissionDecision = SessionPermissionsServiceV1['requestDecision'];
type PermissionDecision = Awaited<ReturnType<RequestPermissionDecision>>['decision'];

function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function decisionToApprovalOutcome(decision: PermissionDecision): CodexApprovalOutcome {
  switch (decision) {
    case 'approved_for_session':
      return 'approve_for_session';
    case 'approved_execpolicy_amendment':
    case 'approved':
      return 'approve_once';
    case 'denied':
      return 'deny';
    case 'abort':
      return 'cancel';
  }
}

/**
 * Legacy `request_user_input` bridge projection over the canonical approval
 * choice mapper. It shares one semantic owner with the app-server interaction
 * handler so a decline can never resume Codex with a positive option.
 */
export function resolveApprovalChoiceLabel(params: {
  decision: PermissionDecision;
  questions: unknown;
  logger: LoggerSubset;
}): string | null {
  const outcome = decisionToApprovalOutcome(params.decision);
  const choice = resolveCodexApprovalQuestionChoice({ questions: params.questions, outcome });
  if (!choice) {
    params.logger.debug('[Codex] request_user_input approval offers no option that can carry this decision; leaving it unanswered', {
      decision: params.decision,
      outcome,
    });
    return null;
  }
  return choice.label;
}

export function createCodexRequestUserInputBridge(opts: {
  requestPermissionDecision: RequestPermissionDecision | null;
  continueSession: (prompt: string) => Promise<void>;
  logger: LoggerSubset;
}): {
  onCodexEvent: (msg: unknown) => Promise<void>;
} {
  const toolContextByCallId = new Map<string, { toolName: string; toolInput: unknown }>();
  const inFlightToolApprovals = new Map<string, Promise<void>>();

  return {
    onCodexEvent: async (msg: unknown): Promise<void> => {
      if (!msg || typeof msg !== 'object') return;
      const message = msg as Record<string, unknown>;

      if (message.type === 'raw_response_item') {
        const item = message.item as { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown } | undefined;
        if (item?.type === 'function_call') {
          const callId = item.call_id;
          const toolName = item.name;
          if (typeof callId === 'string' && typeof toolName === 'string') {
            toolContextByCallId.set(callId, { toolName, toolInput: safeJsonParse(item.arguments) });
          }
        }
        return;
      }

      if (message.type !== 'request_user_input') return;

      const callId = message.call_id;
      if (typeof callId !== 'string' || callId.length === 0) return;
      const questions = message.questions;
      const context = toolContextByCallId.get(callId) ?? null;
      const toolName = context?.toolName ?? 'mcp_tool_call';
      if (!looksLikeCodexApprovalRequestUserInput({ toolName, questions })) return;
      if (inFlightToolApprovals.has(callId)) return;

      if (!opts.requestPermissionDecision) {
        opts.logger.debug('[Codex] request_user_input received but no permission decision service is attached');
        return;
      }
      const requestPermissionDecision = opts.requestPermissionDecision;

      const toolInputBase =
        context?.toolInput && typeof context.toolInput === 'object' && !Array.isArray(context.toolInput)
          ? context.toolInput
          : {};

      const toolInput = {
        ...(toolInputBase as Record<string, unknown>),
        requestUserInput: { questions },
      };

      const workflow = (async () => {
        try {
          const result = await requestPermissionDecision({
            toolCallId: callId,
            toolName,
            input: toolInput,
          });
          const choice = resolveApprovalChoiceLabel({ decision: result.decision, questions, logger: opts.logger });
          if (!choice) return;
          try {
            await opts.continueSession(choice);
          } catch (error) {
            opts.logger.debug('[Codex] Failed to submit request_user_input choice via continueSession (non-fatal)', error);
          }
        } catch (error) {
          opts.logger.debug('[Codex] Failed to resolve request_user_input approval (non-fatal)', error);
        }
      })();

      inFlightToolApprovals.set(callId, workflow);
      try {
        await workflow;
      } finally {
        inFlightToolApprovals.delete(callId);
        toolContextByCallId.delete(callId);
      }
    },
  };
}
