import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readAfterClaudeJsonlSessionTranscript } from '../transcripts/sessionStore/operations/readAfterClaudeJsonlSessionTranscript';

export async function readAfterClaudeTranscript(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; truncated: boolean }>> {
  return readAfterClaudeJsonlSessionTranscript(params);
}
