import type { AgentTerminalHostService, TerminalHostHandle } from '@happier-dev/plugin-sdk/agents/runtime';

/**
 * Claude owns the native queued-input Escape semantics. The terminal host declares whether its
 * interrupt delivers that exact key to the live Agent; Claude never decides by host kind.
 */
export function isClaudeUnifiedPendingInputInterruptAndRunEnabled(
  terminalHost: Pick<AgentTerminalHostService, 'interruptSendsEscape'>,
  handle: TerminalHostHandle,
): boolean {
  return terminalHost.interruptSendsEscape(handle);
}
