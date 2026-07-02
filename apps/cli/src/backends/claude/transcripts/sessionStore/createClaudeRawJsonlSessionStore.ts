import type { RawJSONLines } from '@happier-dev/plugins-claude/agent';
import {
    pageClaudeRawExternalSessionTranscript,
    readAfterClaudeRawExternalSessionTranscript,
} from '@happier-dev/plugins-claude/agent/surfaces/sessions/external/providerOps';
import { createClaudeProjectedJsonlSessionStore } from './createClaudeProjectedJsonlSessionStore';
import type {
    ClaudeJsonlSessionStoreActivity,
    ClaudeJsonlSessionStorePageOlderParams,
} from './claudeJsonlSessionStoreTypes';
import type { FileBackedTranscriptSessionStoreKey } from '@/api/session/fileBackedTranscripts/store';

export type ClaudeRawJsonlSessionStoreReadAfterParams = Readonly<{
    cursor: string | null;
    maxBytes: number;
    maxItems: number;
}>;

function createClaudeExternalSessionEnv(source: FileBackedTranscriptSessionStoreKey['source']): NodeJS.ProcessEnv {
    const configDir = source.kind === 'claudeConfig' && typeof source.configDir === 'string'
        ? source.configDir.trim()
        : '';
    return configDir
        ? { ...process.env, HAPPIER_CLAUDE_CONFIG_DIR: configDir }
        : process.env;
}

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
                const page = await pageClaudeRawExternalSessionTranscript({
                    source: storeKey.source,
                    env: createClaudeExternalSessionEnv(storeKey.source),
                    remoteSessionId: storeKey.remoteSessionId,
                    cursor: params?.cursor,
                    maxBytes: params?.maxBytes ?? 1024 * 1024,
                    maxItems: params?.maxItems ?? 100,
                });
                return { ...page, truncated: page.truncated === true };
            },
            readAfter: async (storeKey, params, currentTailCursor) => {
                const result = await readAfterClaudeRawExternalSessionTranscript({
                    source: storeKey.source,
                    env: createClaudeExternalSessionEnv(storeKey.source),
                    remoteSessionId: storeKey.remoteSessionId,
                    cursor: params ? params.cursor : (currentTailCursor ?? 'tail'),
                    maxBytes: params?.maxBytes ?? 1024 * 1024,
                    maxItems: params?.maxItems ?? 100,
                });
                return {
                    items: result.items,
                    nextCursor: result.nextCursor,
                    truncated: result.truncated,
                };
            },
        },
        mapActivity: (activity) => ({
            lastActivityAtMs: activity.lastActivityAtMs,
            isRunning: false,
        }),
    });
}
