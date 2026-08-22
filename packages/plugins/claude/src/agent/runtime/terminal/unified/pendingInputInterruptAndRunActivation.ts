import type { TerminalHostKind } from '@happier-dev/plugin-sdk/agents/runtime';

/**
 * Claude owns the native queued-input Escape semantics. Supported terminal-host adapters own
 * transport of that exact key to their live pane; Windows remains closed until its distinct
 * console transport is proven.
 */
export function isClaudeUnifiedPendingInputInterruptAndRunEnabled(
  hostKind: TerminalHostKind,
): boolean {
  return hostKind === 'tmux' || hostKind === 'zellij';
}
