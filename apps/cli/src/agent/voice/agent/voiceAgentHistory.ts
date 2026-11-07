import type { VoiceAgentTurn } from './voiceAgentTypes';
import { estimateTokensV1 } from '@happier-dev/protocol/capabilities/estimateTokensV1';

/** Fit reference history only; never clip the current input or required instructions. */
export function fitVoiceAgentHistoryPrompt(params: Readonly<{
  history: readonly VoiceAgentTurn[];
  contextWindowTokens: number | undefined;
  render: (history: readonly VoiceAgentTurn[]) => string;
}>): Readonly<{ prompt: string; omittedTurns: number }> {
  const prompt = params.render(params.history);
  const window = params.contextWindowTokens;
  if (window === undefined || estimateTokensV1(prompt) <= window) return { prompt, omittedTurns: 0 };
  // A user/assistant pair is indivisible; a context update is its own whole record.
  const starts = params.history.flatMap((turn, index) => index === 0 || turn.role !== 'assistant' ? [index] : []);
  starts.push(params.history.length);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokensV1(params.render(params.history.slice(starts[middle]))) <= window) high = middle;
    else low = middle + 1;
  }
  // Required instructions alone may exceed the window. The provider owns that refusal.
  return { prompt: params.render(params.history.slice(starts[low])), omittedTurns: low };
}

/** Retain accepted context intact; replay fitting belongs to the selected model. */
export function appendVoiceAgentHistoryContext(
  history: VoiceAgentTurn[],
  params: Readonly<{ text: string }>,
): void {
  history.push({ role: 'context', text: params.text });
}

export function appendVoiceAgentHistoryTurn(
  history: VoiceAgentTurn[],
  params: Readonly<{
    userText: string;
    assistantText: string;
  }>,
): void {
  history.push({ role: 'user', text: params.userText });
  history.push({ role: 'assistant', text: params.assistantText });
}
