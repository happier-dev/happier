import type { BackendSurfaceResultV1 } from '@happier-dev/agents';
import type { ExternalSessionsSource, ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';
import { createClaudeExternalSessionSurface } from '@happier-dev/plugins-claude/agent/surfaces/sessions/external/providerOps';
import type { FileBackedTranscriptSessionStore, FileBackedTranscriptSessionStoreKey } from '@/api/session/fileBackedTranscripts/store';

import type {
    ClaudeJsonlSessionStoreActivity,
    ClaudeJsonlSessionStorePageOlderParams,
    ClaudeJsonlSessionStoreReadAfterParams,
} from './claudeJsonlSessionStoreTypes';
import { createClaudeProjectedJsonlSessionStore } from './createClaudeProjectedJsonlSessionStore';

function unwrapClaudeExternalSessionResult<T>(result: BackendSurfaceResultV1<T, string>): T {
    if (result.ok) return result.value;
    throw new Error(result.message ?? `Claude external-session transcript operation failed: ${result.code}`);
}

function createClaudeExternalSessionEnv(source: ExternalSessionsSource): NodeJS.ProcessEnv {
    const configDir = source.kind === 'claudeConfig' && typeof source.configDir === 'string'
        ? source.configDir.trim()
        : '';
    return configDir
        ? { ...process.env, HAPPIER_CLAUDE_CONFIG_DIR: configDir }
        : process.env;
}

export function createClaudeJsonlSessionStore(key: FileBackedTranscriptSessionStoreKey): FileBackedTranscriptSessionStore<
    ExternalSessionTranscriptRawMessageV1,
    ClaudeJsonlSessionStoreActivity,
    string | null
> {
    return createClaudeProjectedJsonlSessionStore<
        ExternalSessionTranscriptRawMessageV1,
        ClaudeJsonlSessionStoreActivity,
        ClaudeJsonlSessionStorePageOlderParams,
        ClaudeJsonlSessionStoreReadAfterParams
    >({
        key,
        operations: {
            pageOlder: async (storeKey, params) => {
                const surface = createClaudeExternalSessionSurface({
                    env: createClaudeExternalSessionEnv(storeKey.source),
                });
                const page = unwrapClaudeExternalSessionResult(await surface.pageTranscript({
                    source: storeKey.source,
                    providerSessionId: storeKey.remoteSessionId,
                    direction: 'older',
                    cursor: params?.cursor,
                    maxBytes: params?.maxBytes ?? 1024 * 1024,
                    maxItems: params?.maxItems ?? 100,
                }));
                return {
                    items: page.items,
                    nextCursor: page.nextCursor,
                    tailCursor: page.tailCursor ?? null,
                    hasMore: page.hasMore === true,
                    truncated: page.truncated === true,
                };
            },
            readAfter: async (storeKey, params, currentTailCursor) => {
                const surface = createClaudeExternalSessionSurface({
                    env: createClaudeExternalSessionEnv(storeKey.source),
                });
                if (!surface.readAfterTranscript) {
                    throw new Error('Claude external-session transcript read-after surface is unavailable');
                }
                const page = unwrapClaudeExternalSessionResult(await surface.readAfterTranscript({
                    source: storeKey.source,
                    providerSessionId: storeKey.remoteSessionId,
                    cursor: params?.cursor ?? currentTailCursor ?? 'tail',
                    maxBytes: params?.maxBytes ?? 1024 * 1024,
                    maxItems: params?.maxItems ?? 100,
                }));
                return {
                    items: page.items,
                    nextCursor: page.nextCursor,
                    truncated: page.truncated === true,
                };
            },
        },
        mapActivity: (activity) => ({
            lastActivityAtMs: activity.lastActivityAtMs,
            isRunning: false,
        }),
    });
}
