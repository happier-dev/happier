export function normalizeVoiceAgentTurnTranscriptText(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  return trimmed.replace(/\s+/g, ' ');
}
