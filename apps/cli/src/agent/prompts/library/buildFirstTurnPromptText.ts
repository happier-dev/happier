export function buildFirstTurnPromptText(args: Readonly<{
  isFirstTurn: boolean;
  userText: string;
  systemPromptText?: string | null;
}>): { prompt: string; nextIsFirstTurn: boolean } {
  if (!args.isFirstTurn) {
    return { prompt: args.userText, nextIsFirstTurn: false };
  }

  const systemPromptText = typeof args.systemPromptText === 'string' ? args.systemPromptText.trim() : '';
  if (!systemPromptText) {
    return { prompt: args.userText, nextIsFirstTurn: true };
  }

  return {
    prompt: `${systemPromptText}\n\n${args.userText}`,
    nextIsFirstTurn: false,
  };
}
