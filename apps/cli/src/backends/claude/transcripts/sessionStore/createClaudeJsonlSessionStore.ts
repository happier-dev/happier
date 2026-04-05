import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';
import type { FileBackedTranscriptSessionStore, FileBackedTranscriptSessionStoreKey } from '@/api/session/fileBackedTranscripts/store';

import type {
    ClaudeJsonlSessionStoreActivity,
    ClaudeJsonlSessionStorePageOlderParams,
    ClaudeJsonlSessionStoreReadAfterParams,
} from './claudeJsonlSessionStoreTypes';
import { createClaudeProjectedJsonlSessionStore } from './createClaudeProjectedJsonlSessionStore';
import { pageClaudeJsonlSessionTranscript } from './operations/pageClaudeJsonlSessionTranscript';
import { readAfterClaudeJsonlSessionTranscript } from './operations/readAfterClaudeJsonlSessionTranscript';

export function createClaudeJsonlSessionStore(key: FileBackedTranscriptSessionStoreKey): FileBackedTranscriptSessionStore<
    DirectTranscriptRawMessageV1,
    ClaudeJsonlSessionStoreActivity,
    string | null
> {
    return createClaudeProjectedJsonlSessionStore<
        DirectTranscriptRawMessageV1,
        ClaudeJsonlSessionStoreActivity,
        ClaudeJsonlSessionStorePageOlderParams,
        ClaudeJsonlSessionStoreReadAfterParams
    >({
        key,
        operations: {
            pageOlder: async (storeKey, params) => {
                const page = await pageClaudeJsonlSessionTranscript({
                    source: storeKey.source,
                    remoteSessionId: storeKey.remoteSessionId,
                    cursor: params?.cursor,
                    maxBytes: params?.maxBytes ?? 1024 * 1024,
                    maxItems: params?.maxItems ?? 100,
                });
                return { ...page, truncated: page.truncated === true };
            },
            readAfter: async (storeKey, params, currentTailCursor) =>
                readAfterClaudeJsonlSessionTranscript({
                    source: storeKey.source,
                    remoteSessionId: storeKey.remoteSessionId,
                    cursor: params?.cursor ?? currentTailCursor ?? 'tail',
                    maxBytes: params?.maxBytes ?? 1024 * 1024,
                    maxItems: params?.maxItems ?? 100,
                }),
        },
        mapActivity: (activity) => ({
            lastActivityAtMs: activity.lastActivityAtMs,
            isRunning: false,
        }),
    });
}
