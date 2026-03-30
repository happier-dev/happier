export function resolveInitialClaudeSystemPromptText(args: Readonly<{
  existingSessionId: string | null | undefined;
  defaultSystemPromptText?: string | null;
}>): string | undefined {
  const existingSessionId = typeof args.existingSessionId === 'string' ? args.existingSessionId.trim() : '';
  if (existingSessionId) return undefined;

  const defaultSystemPromptText = typeof args.defaultSystemPromptText === 'string'
    ? args.defaultSystemPromptText.trim()
    : '';

  return defaultSystemPromptText || undefined;
}
