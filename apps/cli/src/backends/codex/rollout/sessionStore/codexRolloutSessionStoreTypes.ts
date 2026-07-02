import type { ExternalSessionsSource, ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type {
    FileBackedTranscriptPageResult,
    FileBackedTranscriptReadAfterResult,
    FileBackedTranscriptSessionStoreKey,
} from '@/api/session/fileBackedTranscripts/store';

export type CodexRolloutSessionStoreKey = FileBackedTranscriptSessionStoreKey & Readonly<{
    providerId: 'codex';
    source: ExternalSessionsSource;
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
    allowProviderFallback?: boolean;
}>;

export type CodexRolloutSessionStoreReadAfterParams = Readonly<{
    cursor: string;
    maxBytes: number;
    maxItems: number;
    allowProviderFallback?: boolean;
}>;

export type CodexRolloutSessionStorePageResult = FileBackedTranscriptPageResult<ExternalSessionTranscriptRawMessageV1>;
export type CodexRolloutSessionStoreReadAfterResult = FileBackedTranscriptReadAfterResult<ExternalSessionTranscriptRawMessageV1>;
