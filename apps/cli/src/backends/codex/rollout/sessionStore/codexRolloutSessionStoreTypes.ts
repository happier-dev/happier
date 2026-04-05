import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type {
    FileBackedTranscriptPageResult,
    FileBackedTranscriptReadAfterResult,
    FileBackedTranscriptSessionStoreKey,
} from '@/api/session/fileBackedTranscripts/store';

export type CodexRolloutSessionStoreKey = FileBackedTranscriptSessionStoreKey & Readonly<{
    providerId: 'codex';
    source: DirectSessionsSource;
}>;

export type CodexRolloutSessionStoreOptions = Readonly<{
    key: CodexRolloutSessionStoreKey;
    activeServerDir: string;
    env?: NodeJS.ProcessEnv;
}>;

export type CodexRolloutSessionStorePageParams = Readonly<{
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
}>;

export type CodexRolloutSessionStoreReadAfterParams = Readonly<{
    cursor: string;
    maxBytes: number;
    maxItems: number;
}>;

export type CodexRolloutSessionStorePageResult = FileBackedTranscriptPageResult<DirectTranscriptRawMessageV1>;
export type CodexRolloutSessionStoreReadAfterResult = FileBackedTranscriptReadAfterResult<DirectTranscriptRawMessageV1>;
