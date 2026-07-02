import type { ConnectedServiceId, ConnectedServiceProfileId } from '@happier-dev/protocol';

export function summarizeOhMyPiConnectedServiceActiveProfiles(params: Readonly<{
  openaiCodexProfileId: ConnectedServiceProfileId | null;
  openaiProfileId: ConnectedServiceProfileId | null;
  claudeSubscriptionProfileId: ConnectedServiceProfileId | null;
  anthropicProfileId: ConnectedServiceProfileId | null;
  geminiProfileId: ConnectedServiceProfileId | null;
}>): Partial<Record<ConnectedServiceId, ConnectedServiceProfileId>> {
  const summary: Partial<Record<ConnectedServiceId, ConnectedServiceProfileId>> = {};
  if (params.openaiCodexProfileId) summary['openai-codex'] = params.openaiCodexProfileId;
  if (params.openaiProfileId) summary.openai = params.openaiProfileId;
  if (params.claudeSubscriptionProfileId) summary['claude-subscription'] = params.claudeSubscriptionProfileId;
  if (params.anthropicProfileId) summary.anthropic = params.anthropicProfileId;
  if (params.geminiProfileId) summary.gemini = params.geminiProfileId;
  return summary;
}
