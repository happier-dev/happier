import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { pageClaudeJsonlSessionTranscript } from '../transcripts/sessionStore/operations/pageClaudeJsonlSessionTranscript';

export async function pageClaudeTranscript(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; tailCursor: string | null; hasMore: boolean; truncated?: boolean }>> {
  if (params.direction !== 'older') {
    return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
  }
  return pageClaudeJsonlSessionTranscript(params);
}
