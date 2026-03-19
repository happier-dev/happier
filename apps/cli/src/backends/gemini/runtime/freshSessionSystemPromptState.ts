export function resolveShouldPrependAppendSystemPromptOnNextFreshSessionPrompt(args: Readonly<{
  startedFreshSession: boolean;
}>): boolean {
  return args.startedFreshSession;
}
