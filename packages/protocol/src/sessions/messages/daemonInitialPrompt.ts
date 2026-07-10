export function buildDaemonInitialPromptLocalId(sessionId: unknown): string | null {
  if (typeof sessionId !== 'string') {
    return null;
  }
  const normalizedSessionId = sessionId.trim();
  if (normalizedSessionId.length === 0) {
    return null;
  }
  return `daemon-initial-prompt:${normalizedSessionId}`;
}
