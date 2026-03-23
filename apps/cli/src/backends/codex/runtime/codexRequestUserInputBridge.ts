import { looksLikeCodexApprovalRequestUserInput } from './codexRequestUserInputQuestions';

type LoggerSubset = {
  debug: (message: string, ...args: unknown[]) => void;
};

type PermissionDecision =
  | 'approved'
  | 'approved_for_session'
  | 'approved_execpolicy_amendment'
  | 'denied'
  | 'abort';

type PermissionHandlerSubset = {
  handleToolCall: (
    toolCallId: string,
    toolName: string,
    input: unknown,
  ) => Promise<{ decision: PermissionDecision }>;
};

function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function decisionToToolApprovalChoice(decision: PermissionDecision): string {
  switch (decision) {
    case 'approved_for_session':
      return 'Approve this Session';
    case 'approved_execpolicy_amendment':
    case 'approved':
      return 'Approve Once';
    case 'denied':
      return 'Deny';
    case 'abort':
      return 'Cancel';
  }
}

function resolveToolApprovalQuestionOptions(questions: unknown): string[] {
  if (!Array.isArray(questions)) return [];
  const approvalQuestion = questions.find((q) => {
    const id = (q as any)?.id;
    return typeof id === 'string' && id.startsWith('mcp_tool_call_approval_');
  }) as any ?? questions.find((q) => Array.isArray((q as any)?.options)) as any;
  const options = approvalQuestion?.options;
  if (!Array.isArray(options)) return [];
  return options
    .map((opt) => (typeof opt?.label === 'string' ? opt.label : ''))
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

export function resolveApprovalChoiceLabel(params: { decision: PermissionDecision; questions: unknown; logger: LoggerSubset }): string | null {
  const options = resolveToolApprovalQuestionOptions(params.questions);
  if (options.length === 0) return null;

  const preferred = decisionToToolApprovalChoice(params.decision);
  const direct = options.find((label) => label === preferred);
  if (direct) return direct;

  const pickFirstMatch = (re: RegExp): string | null => options.find((label) => re.test(label)) ?? null;

  if (params.decision === 'denied') {
    return pickFirstMatch(/\bdeny\b|\breject\b|\bdecline\b/i) ?? options[options.length - 1]!;
  }
  if (params.decision === 'abort') {
    return pickFirstMatch(/\bcancel\b|\babort\b|\bstop\b/i) ?? options[options.length - 1]!;
  }

  const approve =
    pickFirstMatch(/\bapprove\b/i) ??
    pickFirstMatch(/\ballow\b/i) ??
    options[0]!;

  params.logger.debug('[Codex] request_user_input approval choice label did not match expected option; falling back', {
    decision: params.decision,
    preferred,
    resolved: approve,
    options,
  });
  return approve;
}

export function createCodexRequestUserInputBridge(opts: {
  permissionHandler: PermissionHandlerSubset | null;
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
      const message: any = msg;

      if (message.type === 'raw_response_item') {
        const item = message.item;
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

      if (!opts.permissionHandler) {
        opts.logger.debug('[Codex] request_user_input received but no permissionHandler is attached');
        return;
      }
      const permissionHandler = opts.permissionHandler;

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
          const result = await permissionHandler.handleToolCall(callId, toolName, toolInput);
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
