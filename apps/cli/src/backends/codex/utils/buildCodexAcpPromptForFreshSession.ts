import { buildFirstTurnPromptText } from '@/agent/promptLibrary/buildFirstTurnPromptText';

export function buildCodexAcpPromptForFreshSession(args: Readonly<{
  prompt: string;
  startedFreshSession: boolean;
  systemPromptText?: string | null;
}>): string {
  return buildFirstTurnPromptText({
    isFirstTurn: args.startedFreshSession,
    userText: args.prompt,
    systemPromptText: args.systemPromptText,
  }).prompt;
}
