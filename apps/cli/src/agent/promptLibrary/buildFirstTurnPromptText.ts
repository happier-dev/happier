export function buildFirstTurnPromptText(args: Readonly<{
  isFirstTurn: boolean;
  userText: string;
  appendSystemPrompt?: string | null;
  fallbackAppendSystemPrompt?: string | null;
}>): { prompt: string; nextIsFirstTurn: boolean } {
  if (!args.isFirstTurn) {
    return { prompt: args.userText, nextIsFirstTurn: false };
  }

  const appendSystemPromptSource = args.appendSystemPrompt === undefined
    ? args.fallbackAppendSystemPrompt
    : args.appendSystemPrompt;
  const append = typeof appendSystemPromptSource === 'string' ? appendSystemPromptSource.trim() : '';
  if (!append) {
    return { prompt: args.userText, nextIsFirstTurn: true };
  }

  return {
    prompt: `${append}\n\n${args.userText}`,
    nextIsFirstTurn: false,
  };
}
