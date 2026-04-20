import type { RawJSONLines } from '@/backends/claude/contracts/rawJsonLines';
import { createClaudeProjectedJsonlSessionStore } from './createClaudeProjectedJsonlSessionStore';
import type {
    ClaudeJsonlSessionStoreActivity,
    ClaudeJsonlSessionStorePageOlderParams,
} from './claudeJsonlSessionStoreTypes';
import { pageClaudeRawJsonlSessionTranscript, readClaudeRawJsonlSessionMessages } from './operations';
import type { FileBackedTranscriptSessionStoreKey } from '@/api/session/fileBackedTranscripts/store';

export type ClaudeRawJsonlSessionStoreReadAfterParams = Readonly<{
    cursor: string | null;
    maxBytes: number;
    maxItems: number;
}>;

export function createClaudeRawJsonlSessionStore(
    key: FileBackedTranscriptSessionStoreKey,
) {
    return createClaudeProjectedJsonlSessionStore<
        RawJSONLines,
        ClaudeJsonlSessionStoreActivity,
        ClaudeJsonlSessionStorePageOlderParams,
        ClaudeRawJsonlSessionStoreReadAfterParams
    >({
        key,
        operations: {
            pageOlder: async (storeKey, params) => {
                const page = await pageClaudeRawJsonlSessionTranscript({
                    source: storeKey.source,
                    remoteSessionId: storeKey.remoteSessionId,
                    cursor: params?.cursor,
                    maxBytes: params?.maxBytes ?? 1024 * 1024,
                    maxItems: params?.maxItems ?? 100,
                });
                return { ...page, truncated: page.truncated === true };
            },
            readAfter: async (storeKey, params, currentTailCursor) => {
                const resolved = await import('./operations/resolveClaudeJsonlSessionFile').then(({ resolveClaudeJsonlSessionFile }) =>
                    resolveClaudeJsonlSessionFile({
                        source: storeKey.source,
                        remoteSessionId: storeKey.remoteSessionId,
                    }),
                );
                if (!resolved) {
                    return { items: [], nextCursor: null, truncated: false };
                }
                return readClaudeRawJsonlSessionMessages({
                    sessionFilePath: resolved.filePath,
                    cursor: params ? params.cursor : (currentTailCursor ?? 'tail'),
                    maxBytes: params?.maxBytes ?? 1024 * 1024,
                    maxItems: params?.maxItems ?? 100,
                });
            },
        },
        mapActivity: (activity) => ({
            lastActivityAtMs: activity.lastActivityAtMs,
            isRunning: false,
        }),
    });
}
