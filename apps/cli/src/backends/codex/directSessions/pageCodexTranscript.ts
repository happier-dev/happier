import type { DirectSessionsSource, DirectTranscriptRawMessageV1, DirectTranscriptTruncationReason } from '@happier-dev/protocol';

import { readCodexDirectTranscript } from './codexDirectTranscriptSource';

export async function pageCodexTranscript(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; tailCursor: string | null; hasMore: boolean; truncated?: boolean; truncationReason?: DirectTranscriptTruncationReason }>> {
  return await readCodexDirectTranscript(params);
}
