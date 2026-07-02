import type { ConnectedServiceId, ConnectedServiceProfileId } from '@happier-dev/protocol';

export function summarizePiConnectedServiceActiveProfiles(params: Readonly<{
  openaiCodexProfileId: ConnectedServiceProfileId | null;
  openaiProfileId: ConnectedServiceProfileId | null;
  claudeSubscriptionProfileId: ConnectedServiceProfileId | null;
  anthropicProfileId: ConnectedServiceProfileId | null;
}>): Partial<Record<ConnectedServiceId, ConnectedServiceProfileId>> {
  const summary: Partial<Record<ConnectedServiceId, ConnectedServiceProfileId>> = {};
  if (params.openaiCodexProfileId) summary['openai-codex'] = params.openaiCodexProfileId;
  if (params.openaiProfileId) summary.openai = params.openaiProfileId;
  if (params.claudeSubscriptionProfileId) summary['claude-subscription'] = params.claudeSubscriptionProfileId;
  if (params.anthropicProfileId) summary.anthropic = params.anthropicProfileId;
  return summary;
}
