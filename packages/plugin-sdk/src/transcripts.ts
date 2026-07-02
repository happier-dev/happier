export type TranscriptSourcePageV1<TItem = unknown> = Readonly<{
    items: readonly TItem[];
    nextCursor: string | null;
    tailCursor: string | null;
    hasMore: boolean;
    truncated: boolean;
}>;

export type TranscriptSourceReadAfterV1<TItem = unknown> = Readonly<{
    items: readonly TItem[];
    nextCursor: string | null;
    truncated: boolean;
}>;

export type TranscriptSourceFollowUpdateV1<TItem = unknown> = Readonly<{
    items: readonly TItem[];
    nextCursor: string | null;
    truncated: boolean;
}>;

export type TranscriptSourceFollowLeaseV1<TItem = unknown> = Readonly<{
    release(): Promise<void>;
    subscribeToTranscriptUpdates?(
        listener: (update: TranscriptSourceFollowUpdateV1<TItem>) => void | Promise<void>,
    ): () => void;
    getTailCursor?(): string | null;
}>;

export type TranscriptSourceDefinitionV1<TItem = unknown> = Readonly<{
    id: string;
    page(params: Readonly<{
        direction: 'older' | 'newer';
        cursor?: string;
        maxBytes: number;
        maxItems: number;
    }>): Promise<TranscriptSourcePageV1<TItem>>;
    readAfter(params: Readonly<{
        cursor: string;
        maxBytes: number;
        maxItems: number;
    }>): Promise<TranscriptSourceReadAfterV1<TItem>>;
    acquireFollowLease?(params: Readonly<{ reason: string }>): Promise<TranscriptSourceFollowLeaseV1<TItem> | null>;
}>;

export type TranscriptSourceHandleV1 = Readonly<{
    id: string;
    dispose(): Promise<void>;
}>;

export type TranscriptFileFollowStrategyV1 = 'poll';

export type TranscriptFileFollowStartAtV1 = 'beginning' | 'end';

export type TranscriptFileFollowLineV1 = Readonly<{
    line: string;
    sourcePath: string;
    sequence: number;
}>;

export type TranscriptFileFollowPolicyInputV1 = Readonly<{
    pollIntervalMs?: number;
    missingFileRetryIntervalMs?: number;
    maxDrainRowsPerTick?: number;
    maxDrainBytesPerTick?: number;
}>;

export type TranscriptFileFollowInputV1 = Readonly<{
    path: string;
    startAt: TranscriptFileFollowStartAtV1;
    strategy?: TranscriptFileFollowStrategyV1;
    policy?: TranscriptFileFollowPolicyInputV1;
    signal?: AbortSignal;
    onLine(line: TranscriptFileFollowLineV1): void | Promise<void>;
    onError?(error: unknown): void | Promise<void>;
}>;

export type TranscriptFileFollowCloseOptionsV1 = Readonly<{
    finalDrain?: boolean;
    drainTimeoutMs?: number;
}>;

export type TranscriptFileFollowDrainOptionsV1 = Readonly<{
    timeoutMs?: number;
}>;

export type TranscriptFileFollowHandleV1 = Readonly<{
    id: string;
    drainNow(options?: TranscriptFileFollowDrainOptionsV1): Promise<void>;
    close(options?: TranscriptFileFollowCloseOptionsV1): Promise<void>;
}>;

export interface TranscriptFileFollowRuntimeServiceV1 {
    follow(input: TranscriptFileFollowInputV1): Promise<TranscriptFileFollowHandleV1>;
}

export interface TranscriptsRuntimeServiceV1 {
    append(turn: unknown): Promise<void>;
    defineSource<TItem = unknown>(definition: TranscriptSourceDefinitionV1<TItem>): Promise<TranscriptSourceHandleV1>;
    readonly fileFollow: TranscriptFileFollowRuntimeServiceV1;
}
