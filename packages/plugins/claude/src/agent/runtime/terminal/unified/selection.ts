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
  settingOverride?: boolean | null;
}>): Promise<boolean> {
  if (!params.context.features.isEnabled(CLAUDE_UNIFIED_TERMINAL_FEATURE_ID)) return false;
  if (typeof params.settingOverride === 'boolean') return params.settingOverride;
  try {
    return await params.context.settings.get(CLAUDE_UNIFIED_TERMINAL_SETTING_KEY) === true;
  } catch {
    return false;
  }
}
