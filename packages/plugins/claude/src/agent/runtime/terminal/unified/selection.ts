import type { RuntimeDescriptorV1, TerminalHostKind } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

export const CLAUDE_UNIFIED_TERMINAL_FEATURE_ID = 'agents.claude.unifiedTerminal';
export const CLAUDE_UNIFIED_TERMINAL_SETTING_KEY = 'claudeUnifiedTerminalEnabled';

type ClaudeUnifiedTerminalSelectionContext = Readonly<{
  features: Readonly<{ isEnabled(featureId: string): boolean }>;
  settings: Readonly<{ get(key: string): Promise<unknown> }>;
}>;

/**
 * The feature decision is the admission boundary; the account setting is read only after that
 * boundary admits the capability. Missing, malformed, or unavailable settings fail closed.
 * `settingOverride` exists only for the retained V1 carrier, whose launch metadata already carries
 * the canonical setting snapshot. Native AgentRuntime callers must use the settings service.
 */
export async function isClaudeUnifiedTerminalSelected(params: Readonly<{
  context: ClaudeUnifiedTerminalSelectionContext;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  settingOverride?: boolean | null;
  /** The terminal host the Session asked for, before a descriptor captured the selection. */
  requestedHost?: string;
  /** Observes which input decided the selection (it is otherwise invisible in a running Session). */
  onDecision?: (decision: Readonly<{ selected: boolean; reason: ClaudeUnifiedTerminalSelectionReason }>) => void;
}>): Promise<boolean> {
  const decide = (selected: boolean, reason: ClaudeUnifiedTerminalSelectionReason) => {
    params.onDecision?.({ selected, reason });
    return selected;
  };
  const captured = readClaudeTerminalRuntimeSelection(params.runtimeDescriptorV1);
  const featureEnabled = params.context.features.isEnabled(CLAUDE_UNIFIED_TERMINAL_FEATURE_ID);
  if (captured) {
    if (captured.mode === 'unifiedTerminal' && !featureEnabled) {
      throw new PluginError({
        code: 'claude_unified_terminal_unavailable', retryable: false,
        message: 'The selected Claude unified terminal capability is unavailable.',
      });
    }
    return decide(captured.mode === 'unifiedTerminal', 'captured_descriptor');
  }
  if (!featureEnabled) return decide(false, 'feature_disabled');
  // A Windows hidden-console Session runs its TUI in the Session holder's ConPTY, so it survives
  // its runner (HOLDER-PTY A2 b). Inside the fail-closed feature only; local mode stays available.
  if (params.requestedHost === 'windows_console') return decide(true, 'windows_hidden_console_default');
  if (typeof params.settingOverride === 'boolean') return decide(params.settingOverride, 'setting_override');
  try {
    return decide(await params.context.settings.get(CLAUDE_UNIFIED_TERMINAL_SETTING_KEY) === true, 'account_setting');
  } catch {
    return decide(false, 'setting_unavailable');
  }
}

export type ClaudeUnifiedTerminalSelectionReason =
  | 'captured_descriptor' | 'feature_disabled' | 'windows_hidden_console_default' | 'setting_override' | 'account_setting'
  | 'setting_unavailable';

/** The selected Claude owner writes this intent; the opener and native host consume it. */
export function readClaudeTerminalRuntimeSelection(descriptor: RuntimeDescriptorV1 | undefined): Readonly<{
  mode: 'agentSdk' | 'unifiedTerminal';
  host?: TerminalHostKind;
}> | null {
  if (descriptor?.v !== 1 || descriptor.agentId !== 'claude') return null;
  const mode = descriptor.agent.backendMode;
  if (mode !== 'agentSdk' && mode !== 'unifiedTerminal') return null;
  const host = descriptor.agent.terminalHostKind;
  return {
    mode,
    ...(host === 'herdr' || host === 'tmux' || host === 'zellij' || host === 'windows_console' ? { host } : {}),
  };
}
