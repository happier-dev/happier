import type { DirectSessionsSource } from '@happier-dev/protocol';

import { resolveClaudeJsonlSessionFile } from '../transcripts/sessionStore/operations/resolveClaudeJsonlSessionFile';

export async function resolveClaudeDirectSessionFile(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
}>): Promise<Awaited<ReturnType<typeof resolveClaudeJsonlSessionFile>>> {
  return resolveClaudeJsonlSessionFile(params);
}
