import { buildFirstTurnPromptText } from '@/agent/promptLibrary/buildFirstTurnPromptText';

export function buildGeminiPromptForMessage(args: Readonly<{
  isFirstMessage: boolean;
  userText: string;
  systemPromptText?: string | null;
}>): { prompt: string; nextIsFirstMessage: boolean } {
  const result = buildFirstTurnPromptText({
    isFirstTurn: args.isFirstMessage,
    userText: args.userText,
    systemPromptText: args.systemPromptText,
  });

  return {
    prompt: result.prompt,
    nextIsFirstMessage: result.nextIsFirstTurn,
  };
}
