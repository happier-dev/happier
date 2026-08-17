export function summarizePiConnectedServiceActiveProfiles(params: Readonly<{
  openaiCodexProfileId: string | null;
  openaiProfileId: string | null;
  claudeSubscriptionProfileId: string | null;
  anthropicProfileId: string | null;
}>): Partial<Record<string, string>> {
  const summary: Partial<Record<string, string>> = {};
  if (params.openaiCodexProfileId) summary['openai-codex'] = params.openaiCodexProfileId;
  if (params.openaiProfileId) summary.openai = params.openaiProfileId;
  if (params.claudeSubscriptionProfileId) summary['claude-subscription'] = params.claudeSubscriptionProfileId;
  if (params.anthropicProfileId) summary.anthropic = params.anthropicProfileId;
  return summary;
}
