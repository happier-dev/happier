import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { withCodexRolloutSessionStore } from '../rollout/sessionStore/codexRolloutSessionStoreRegistry';

export async function readAfterCodexTranscript(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; truncated: boolean }>> {
  return withCodexRolloutSessionStore(
    {
      activeServerDir: params.activeServerDir,
      env: params.env,
      key: {
        providerId: 'codex',
        source: params.source,
        remoteSessionId: params.remoteSessionId,
      },
    },
    async (store) => {
      const read = await store.readAfter({
        cursor: params.cursor,
        maxBytes: params.maxBytes,
        maxItems: params.maxItems,
      });
      return {
        items: Array.from(read.items as readonly DirectTranscriptRawMessageV1[]),
        nextCursor: read.nextCursor,
        truncated: read.truncated,
      };
    },
  );
}
