type VoiceAgentTurn = { role: 'user' | 'assistant'; text: string };

export function appendVoiceAgentHistoryTurn(
  history: VoiceAgentTurn[],
  params: Readonly<{
    userText: string;
    assistantText: string;
    maxTurns: number;
    maxTurnTextChars: number;
  }>,
): void {
  history.push({ role: 'user', text: clipTurnText(params.userText, 'head', params.maxTurnTextChars) });
  history.push({ role: 'assistant', text: normalizeAssistantHistoryText(params.assistantText, params.maxTurnTextChars) });
  if (history.length > params.maxTurns) {
    history.splice(0, history.length - params.maxTurns);
  }
}

function normalizeAssistantHistoryText(text: string, maxTurnTextChars: number): string {
  let normalized = String(text ?? '').trim();

  // Some backends (or faulty adapters) can echo the full prompt back as "assistant output".
  // That would cause history to balloon and re-introduce evicted turns via nested prompt text.
  // Strip our prompt scaffolding if it looks like an echo; fall back to "(no response)".
  if (normalized.includes('Initial context:') && normalized.includes('Output contract:')) {
    const lastVoiceAgentTag = normalized.lastIndexOf('\nVoice agent:');
    if (lastVoiceAgentTag >= 0) {
      normalized = normalized.slice(lastVoiceAgentTag + '\nVoice agent:'.length).trim();
    }
  }

  if (!normalized) normalized = '(no response)';
  return clipTurnText(normalized, 'tail', maxTurnTextChars);
}

function clipTurnText(text: string, strategy: 'head' | 'tail', maxTurnTextChars: number): string {
  const normalized = String(text ?? '');
  if (normalized.length <= maxTurnTextChars) return normalized;
  if (strategy === 'tail') {
    return normalized.slice(normalized.length - maxTurnTextChars);
  }
  return normalized.slice(0, maxTurnTextChars);
}
