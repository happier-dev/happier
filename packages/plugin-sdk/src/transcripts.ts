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

export interface TranscriptsRuntimeServiceV1 {
    append(turn: unknown): Promise<void>;
    defineSource<TItem = unknown>(definition: TranscriptSourceDefinitionV1<TItem>): Promise<TranscriptSourceHandleV1>;
}
