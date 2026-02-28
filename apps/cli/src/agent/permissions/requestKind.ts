export type AgentRequestKind = 'permission' | 'user_action';

export function resolveAgentRequestKind(toolName: string): AgentRequestKind {
  const normalized = typeof toolName === 'string' ? toolName.trim() : '';
  if (!normalized) return 'permission';

  // These tool calls require structured user input/decisions, not "permission" in the product sense.
  // They still ride the same request/response plumbing (id correlation + session permission RPC).
  if (
    normalized === 'AskUserQuestion' ||
    normalized === 'ask_user_question' ||
    normalized === 'ExitPlanMode' ||
    normalized === 'exit_plan_mode' ||
    normalized === 'AcpHistoryImport'
  ) {
    return 'user_action';
  }

  return 'permission';
}

