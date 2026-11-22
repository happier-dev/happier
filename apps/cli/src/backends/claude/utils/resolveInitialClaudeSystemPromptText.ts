import type { NormalizedClaudeRemoteModeKind } from '../remote/normalizeClaudeRemoteMode';

export function resolveInitialClaudeSystemPromptText(args: Readonly<{
  runtimeModeKind: NormalizedClaudeRemoteModeKind;
  existingSessionId: string | null | undefined;
  defaultSystemPromptText?: string | null;
}>): string | undefined {
  // The unified terminal launcher receives the coding prompt separately from per-mode additions.
  if (args.runtimeModeKind === 'unifiedTerminal') return undefined;

  const existingSessionId = typeof args.existingSessionId === 'string' ? args.existingSessionId.trim() : '';
  if (existingSessionId) return undefined;

  const defaultSystemPromptText = typeof args.defaultSystemPromptText === 'string'
    ? args.defaultSystemPromptText.trim()
    : '';

  return defaultSystemPromptText || undefined;
}
