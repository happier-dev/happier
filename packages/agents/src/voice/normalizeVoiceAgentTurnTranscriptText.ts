export function normalizeVoiceAgentTurnTranscriptText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const withoutGreetingInstruction = stripGreetingInstructionPrefix(trimmed);
  const withoutContextEnvelope = unwrapContextUpdateEnvelope(withoutGreetingInstruction);
  const cleaned = withoutContextEnvelope.trim();
  if (cleaned.length === 0) return null;
  if (cleaned.startsWith('VOICE_TOOL_RESULTS_JSON:')) return null;
  return cleaned;
}

function stripGreetingInstructionPrefix(text: string): string {
  const lines = text.split('\n');
  if (lines.length < 3) return text;
  if (lines[0]?.trim() !== 'At the start of your reply, include a short friendly greeting (one sentence).') return text;
  if (lines[1]?.trim() !== 'Then continue with your response.') return text;
  return lines.slice(2).join('\n').trim();
}

function unwrapContextUpdateEnvelope(text: string): string {
  const prefix = 'Context updates since your last voice turn:';
  if (!text.startsWith(prefix)) return text;
  const marker = '\n\nUser said:\n';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return text;
  return text.slice(markerIndex + marker.length);
}
