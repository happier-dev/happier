import type { DirectSessionsSource } from '@happier-dev/protocol';

import { readClaudeJsonlSessionActivity } from '../transcripts/sessionStore/operations/readClaudeJsonlSessionActivity';

export async function getClaudeDirectSessionActivity(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ lastActivityAtMs: number | null }>> {
  return readClaudeJsonlSessionActivity(params);
}
