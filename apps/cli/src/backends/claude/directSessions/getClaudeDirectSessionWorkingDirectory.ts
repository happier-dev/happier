import type { DirectSessionsSource } from '@happier-dev/protocol';

import { readClaudeJsonlSessionWorkingDirectory } from '../transcripts/sessionStore/operations/readClaudeJsonlSessionWorkingDirectory';

export async function getClaudeDirectSessionWorkingDirectory(params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  return readClaudeJsonlSessionWorkingDirectory(params);
}
