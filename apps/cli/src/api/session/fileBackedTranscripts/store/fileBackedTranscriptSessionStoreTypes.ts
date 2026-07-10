import type { ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';

export type FileBackedTranscriptSessionStoreLifecycleState =
    | 'hot_attached'
    | 'warm_detached'
    | 'cold_idle'
    | 'disposed';

export type FileBackedTranscriptSessionStoreKey = Readonly<{
    agentId: ExternalSessionsAgentId;
    source: ExternalSessionsSource;
    remoteSessionId: string;
}>;

export type FileBackedTranscriptPageResult<TItem = unknown> = Readonly<{
    items: readonly TItem[];
    nextCursor: string | null;
    hasMore: boolean;
    tailCursor: string | null;
    truncated: boolean;
}>;

export type FileBackedTranscriptReadAfterResult<TItem = unknown> = Readonly<{
    items: readonly TItem[];
    nextCursor: string | null;
    truncated: boolean;
}>;

export type FileBackedTranscriptSubscriptionListener<TItem = unknown> = (event: Readonly<{
    items: readonly TItem[];
    fromCursor?: string | null;
    nextCursor: string | null;
    truncated: boolean;
}>) => void | Promise<void>;

export interface FileBackedTranscriptSessionStore<TItem = unknown, TActivity = unknown, TPreview = string | null> {
    warm(): Promise<void>;
    dispose(): Promise<void>;
    setLifecycleState(state: FileBackedTranscriptSessionStoreLifecycleState): Promise<void>;
    pageOlder(params?: unknown): Promise<FileBackedTranscriptPageResult<TItem>>;
    readAfter(params?: unknown): Promise<FileBackedTranscriptReadAfterResult<TItem>>;
    getTailCursor(): string | null;
    subscribe(listener?: FileBackedTranscriptSubscriptionListener<TItem>): () => void;
    getTitle(): Promise<string | null>;
    getWorkingDirectory(): Promise<string | null>;
    getActivity(): Promise<TActivity | null>;
    getPreview(): Promise<TPreview>;
}

export type FileBackedTranscriptSessionStoreFactory<TStore extends FileBackedTranscriptSessionStore = FileBackedTranscriptSessionStore> = (
    key: FileBackedTranscriptSessionStoreKey,
) => Promise<TStore>;

export type FileBackedTranscriptSessionLease<TStore extends FileBackedTranscriptSessionStore = FileBackedTranscriptSessionStore> = Readonly<{
    key: FileBackedTranscriptSessionStoreKey;
    store: TStore;
    release: () => Promise<void>;
}>;
