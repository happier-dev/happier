type AbortRecentlyRequestedChecker = (withinMs: number) => boolean;

function getErrorLikeFields(reason: unknown): { message?: string; stack?: string } {
  if (!reason || typeof reason !== 'object') {
    return {};
  }

  const err = reason as { message?: unknown; stack?: unknown };
  const message = typeof err.message === 'string' ? err.message : undefined;
  const stack = typeof err.stack === 'string' ? err.stack : undefined;
  return { message, stack };
}

function isClaudeAgentSdkOperationAborted(reason: unknown): boolean {
  const { message, stack } = getErrorLikeFields(reason);
  if (typeof message !== 'string' || message.trim() !== 'Operation aborted') {
    return false;
  }

  if (typeof stack !== 'string' || stack.length === 0) {
    return false;
  }

  // Defensive: only suppress when the error clearly originates from the Claude Agent SDK.
  return stack.includes('@anthropic-ai/claude-agent-sdk');
}

export function createClaudeShouldTerminateOnUnhandledRejection(params: Readonly<{
  abortWasRequestedRecently: AbortRecentlyRequestedChecker;
  ignoreWindowMs: number;
}>): (reason: unknown) => boolean {
  const windowMs = Number.isFinite(params.ignoreWindowMs) ? Math.max(0, Math.trunc(params.ignoreWindowMs)) : 0;

  return (reason: unknown) => {
    if (windowMs === 0) return true;
    if (!params.abortWasRequestedRecently(windowMs)) return true;
    if (!isClaudeAgentSdkOperationAborted(reason)) return true;
    return false;
  };
}
