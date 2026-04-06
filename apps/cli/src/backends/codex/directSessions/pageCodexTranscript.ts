import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { withCodexRolloutSessionStore } from '../rollout/sessionStore/codexRolloutSessionStoreRegistry';

export async function pageCodexTranscript(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{
  items: DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  tailCursor: string | null;
  hasMore: boolean;
  truncated?: boolean;
}>> {
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
      const page = await store.pageOlder({
        direction: params.direction,
        cursor: params.cursor,
        maxBytes: params.maxBytes,
        maxItems: params.maxItems,
      });
      return {
        items: Array.from(page.items as readonly DirectTranscriptRawMessageV1[]),
        nextCursor: page.nextCursor,
        tailCursor: page.tailCursor,
        hasMore: page.hasMore,
        truncated: page.truncated,
      };
    },
  );
}
