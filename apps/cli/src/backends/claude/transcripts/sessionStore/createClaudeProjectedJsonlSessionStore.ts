import type { BackendSurfaceResultV1 } from '@happier-dev/agents';
import type { ExternalSessionsSource } from '@happier-dev/protocol';
import {
    createClaudeExternalSessionSurface,
    readClaudeExternalSessionTitle,
    readClaudeExternalSessionWorkingDirectory,
    resolveClaudeExternalSessionJsonlFile,
} from '@happier-dev/plugins-claude/agent/surfaces/sessions/external/providerOps';

import { createProjectedJsonlSessionStore } from '../../../../api/session/fileBackedTranscripts/jsonl/createProjectedJsonlSessionStore';
import { DEFAULT_JSONL_FOLLOW_POLICY } from '../../../../api/session/fileBackedTranscripts/jsonl/followPolicy';
import type {
  FileBackedTranscriptPageResult,
  FileBackedTranscriptReadAfterResult,
  FileBackedTranscriptSessionStore,
  FileBackedTranscriptSessionStoreKey,
} from '../../../../api/session/fileBackedTranscripts/store';

type ClaudeProjectedJsonlSessionStoreOperations<TItem, TPageParams, TReadAfterParams> = Readonly<{
    pageOlder: (
        key: FileBackedTranscriptSessionStoreKey,
        params: TPageParams | undefined,
    ) => Promise<FileBackedTranscriptPageResult<TItem>>;
    readAfter: (
        key: FileBackedTranscriptSessionStoreKey,
        params: TReadAfterParams | undefined,
        currentTailCursor: string | null,
    ) => Promise<FileBackedTranscriptReadAfterResult<TItem>>;
}>;

type ClaudeExternalSessionActivity = Readonly<{
    lastActivityAtMs: number | null;
    isRunning: boolean;
}>;

function unwrapClaudeExternalSessionResult<T>(result: BackendSurfaceResultV1<T, string>): T {
    if (result.ok) return result.value;
    throw new Error(result.message ?? `Claude external-session operation failed: ${result.code}`);
}

function createClaudeExternalSessionEnv(source: ExternalSessionsSource): NodeJS.ProcessEnv {
    const configDir = source.kind === 'claudeConfig' && typeof source.configDir === 'string'
        ? source.configDir.trim()
        : '';
    return configDir
        ? { ...process.env, HAPPIER_CLAUDE_CONFIG_DIR: configDir }
        : process.env;
}

export function createClaudeProjectedJsonlSessionStore<TItem, TActivity, TPageParams, TReadAfterParams>(params: Readonly<{
    key: FileBackedTranscriptSessionStoreKey;
    operations: ClaudeProjectedJsonlSessionStoreOperations<TItem, TPageParams, TReadAfterParams>;
    mapActivity: (value: ClaudeExternalSessionActivity) => TActivity;
}>): FileBackedTranscriptSessionStore<TItem, TActivity, string | null> {
    return createProjectedJsonlSessionStore({
        key: params.key,
        operations: {
            resolveFile: async (key) => resolveClaudeExternalSessionJsonlFile({
                source: key.source,
                env: createClaudeExternalSessionEnv(key.source),
                remoteSessionId: key.remoteSessionId,
            }),
            pageOlder: params.operations.pageOlder,
            readAfter: params.operations.readAfter,
            getTitle: async (key) => {
                const resolved = await resolveClaudeExternalSessionJsonlFile({
                    source: key.source,
                    env: createClaudeExternalSessionEnv(key.source),
                    remoteSessionId: key.remoteSessionId,
                });
                if (!resolved) return null;
                return readClaudeExternalSessionTitle(resolved.filePath);
            },
            getWorkingDirectory: async (key) => readClaudeExternalSessionWorkingDirectory({
                source: key.source,
                env: createClaudeExternalSessionEnv(key.source),
                remoteSessionId: key.remoteSessionId,
            }),
            getActivity: async (key) => {
                const surface = createClaudeExternalSessionSurface({
                    env: createClaudeExternalSessionEnv(key.source),
                });
                if (!surface.getActivity) {
                    throw new Error('Claude external-session activity surface is unavailable');
                }
                const activity = unwrapClaudeExternalSessionResult(await surface.getActivity({
                    source: key.source,
                    providerSessionId: key.remoteSessionId,
                }));
                return params.mapActivity(activity);
            },
            followPollIntervalMs: DEFAULT_JSONL_FOLLOW_POLICY.activeBurstPollIntervalMs,
        },
    });
}
