import type {
    FileBackedTranscriptPageResult,
    FileBackedTranscriptReadAfterResult,
    FileBackedTranscriptSessionStoreKey,
    FileBackedTranscriptSessionStoreLifecycleState,
    FileBackedTranscriptSubscriptionListener,
} from './fileBackedTranscriptSessionStoreTypes';

export type ResolvedTranscriptSession<TResolved = unknown> = Readonly<{
    key: FileBackedTranscriptSessionStoreKey;
    value: TResolved;
}>;

export type ResolvedTranscriptStream<TStream = unknown> = Readonly<{
    streamId: string;
    filePath: string;
    role?: string | null;
    parentStreamId?: string | null;
    sidechainId?: string | null;
    value?: TStream;
}>;

export type TranscriptMetadataSnapshot<TActivity = unknown, TPreview = string | null> = Readonly<{
    title?: string | null;
    workingDirectory?: string | null;
    activity?: TActivity | null;
    preview?: TPreview;
}>;

export type FileBackedTranscriptSessionContext<
    TResolved = unknown,
    TStream = unknown,
> = Readonly<{
    key: FileBackedTranscriptSessionStoreKey;
    resolvedSession: ResolvedTranscriptSession<TResolved> | null;
    streams: readonly ResolvedTranscriptStream<TStream>[];
}>;

export interface FileBackedTranscriptSessionAdapter<
    TItem = unknown,
    TActivity = unknown,
    TPreview = string | null,
    TResolved = unknown,
    TStream = unknown,
> {
    resolveSession(key: FileBackedTranscriptSessionStoreKey): Promise<ResolvedTranscriptSession<TResolved> | null>;
    discoverStreams(context: Readonly<{
        key: FileBackedTranscriptSessionStoreKey;
        resolvedSession: ResolvedTranscriptSession<TResolved> | null;
    }>): Promise<readonly ResolvedTranscriptStream<TStream>[]>;
    pageOlder(context: FileBackedTranscriptSessionContext<TResolved, TStream>, params?: unknown): Promise<FileBackedTranscriptPageResult<TItem>>;
    readAfter(context: FileBackedTranscriptSessionContext<TResolved, TStream>, params?: unknown): Promise<FileBackedTranscriptReadAfterResult<TItem>>;
    probeMetadata?(context: FileBackedTranscriptSessionContext<TResolved, TStream>): Promise<TranscriptMetadataSnapshot<TActivity, TPreview>>;
    getTailCursor?(context: FileBackedTranscriptSessionContext<TResolved, TStream>): string | null;
    subscribe?(context: FileBackedTranscriptSessionContext<TResolved, TStream>, listener?: FileBackedTranscriptSubscriptionListener<TItem>): () => void;
    warm?(context: FileBackedTranscriptSessionContext<TResolved, TStream>): Promise<void> | void;
    dispose?(context: FileBackedTranscriptSessionContext<TResolved, TStream>): Promise<void> | void;
    onLifecycleStateChange?(context: FileBackedTranscriptSessionContext<TResolved, TStream>, state: FileBackedTranscriptSessionStoreLifecycleState): Promise<void> | void;
}
