import { createProjectedJsonlSessionStore } from '../../../../api/session/fileBackedTranscripts/jsonl/createProjectedJsonlSessionStore';
import type {
  FileBackedTranscriptPageResult,
  FileBackedTranscriptReadAfterResult,
  FileBackedTranscriptSessionStore,
  FileBackedTranscriptSessionStoreKey,
} from '../../../../api/session/fileBackedTranscripts/store';

import { readClaudeJsonlSessionActivity } from './operations/readClaudeJsonlSessionActivity';
import { readClaudeJsonlSessionTitle } from './operations/readClaudeJsonlSessionTitle';
import { readClaudeJsonlSessionWorkingDirectory } from './operations/readClaudeJsonlSessionWorkingDirectory';
import { resolveClaudeJsonlSessionFile } from './operations/resolveClaudeJsonlSessionFile';

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

export function createClaudeProjectedJsonlSessionStore<TItem, TActivity, TPageParams, TReadAfterParams>(params: Readonly<{
    key: FileBackedTranscriptSessionStoreKey;
    operations: ClaudeProjectedJsonlSessionStoreOperations<TItem, TPageParams, TReadAfterParams>;
    mapActivity: (value: Awaited<ReturnType<typeof readClaudeJsonlSessionActivity>>) => TActivity;
}>): FileBackedTranscriptSessionStore<TItem, TActivity, string | null> {
    return createProjectedJsonlSessionStore({
        key: params.key,
        operations: {
            resolveFile: async (key) => resolveClaudeJsonlSessionFile({
                source: key.source,
                remoteSessionId: key.remoteSessionId,
            }),
            pageOlder: params.operations.pageOlder,
            readAfter: params.operations.readAfter,
            getTitle: async (key) => {
                const resolved = await resolveClaudeJsonlSessionFile({
                    source: key.source,
                    remoteSessionId: key.remoteSessionId,
                });
                if (!resolved) return null;
                return readClaudeJsonlSessionTitle(resolved.filePath);
            },
            getWorkingDirectory: async (key) => readClaudeJsonlSessionWorkingDirectory({
                source: key.source,
                remoteSessionId: key.remoteSessionId,
            }),
            getActivity: async (key) => {
                const activity = await readClaudeJsonlSessionActivity({
                    source: key.source,
                    remoteSessionId: key.remoteSessionId,
                });
                return params.mapActivity(activity);
            },
            followPollIntervalMs: 250,
        },
    });
}
