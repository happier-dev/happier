import type { FileBackedTranscriptSessionAdapter, FileBackedTranscriptSessionContext } from './fileBackedTranscriptSessionAdapterTypes';
import type {
    FileBackedTranscriptSessionStore,
    FileBackedTranscriptSessionStoreKey,
    FileBackedTranscriptSessionStoreLifecycleState,
    FileBackedTranscriptSubscriptionListener,
} from './fileBackedTranscriptSessionStoreTypes';
import type { TranscriptMetadataSnapshot } from './fileBackedTranscriptSessionAdapterTypes';

export function createFileBackedTranscriptSessionStore<
    TItem = unknown,
    TActivity = unknown,
    TPreview = string | null,
    TResolved = unknown,
    TStream = unknown,
>(params: Readonly<{
    key: FileBackedTranscriptSessionStoreKey;
    adapter: FileBackedTranscriptSessionAdapter<TItem, TActivity, TPreview, TResolved, TStream>;
}>): FileBackedTranscriptSessionStore<TItem, TActivity, TPreview> {
    let resolvedContextPromise: Promise<FileBackedTranscriptSessionContext<TResolved, TStream>> | null = null;
    let resolvedContext: FileBackedTranscriptSessionContext<TResolved, TStream> | null = null;

    const resolveContext = async (): Promise<FileBackedTranscriptSessionContext<TResolved, TStream>> => {
        if (!resolvedContextPromise) {
            resolvedContextPromise = (async () => {
                const resolvedSession = await params.adapter.resolveSession(params.key);
                const streams = await params.adapter.discoverStreams({
                    key: params.key,
                    resolvedSession,
                });
                resolvedContext = {
                    key: params.key,
                    resolvedSession,
                    streams,
                };
                return resolvedContext;
            })();
        }
        return resolvedContextPromise;
    };

    const readMetadata = async () => {
        const context = await resolveContext();
        return (params.adapter.probeMetadata?.(context) ?? {}) as TranscriptMetadataSnapshot<TActivity, TPreview>;
    };

    const applyLifecycle = async (state: FileBackedTranscriptSessionStoreLifecycleState): Promise<void> => {
        const context = await resolveContext();
        await params.adapter.onLifecycleStateChange?.(context, state);
    };

    return {
        warm: async () => {
            const context = await resolveContext();
            await params.adapter.warm?.(context);
        },
        dispose: async () => {
            const context = await resolveContext();
            await params.adapter.dispose?.(context);
        },
        setLifecycleState: applyLifecycle,
        pageOlder: async (pageParams?: unknown) => {
            const context = await resolveContext();
            return params.adapter.pageOlder(context, pageParams);
        },
        readAfter: async (readAfterParams?: unknown) => {
            const context = await resolveContext();
            return params.adapter.readAfter(context, readAfterParams);
        },
        getTailCursor: () => {
            if (!resolvedContext) {
                return null;
            }
            return params.adapter.getTailCursor?.(resolvedContext) ?? null;
        },
        subscribe: (listener?: FileBackedTranscriptSubscriptionListener<TItem>) => {
            let unsubscribe: (() => void) | null = null;
            void resolveContext().then((context) => {
                unsubscribe = params.adapter.subscribe?.(context, listener) ?? null;
            });
            return () => {
                unsubscribe?.();
            };
        },
        getTitle: async () => {
            const metadata = await readMetadata();
            return metadata.title ?? null;
        },
        getWorkingDirectory: async () => {
            const metadata = await readMetadata();
            return metadata.workingDirectory ?? null;
        },
        getActivity: async () => {
            const metadata = await readMetadata();
            return (metadata.activity ?? null) as TActivity | null;
        },
        getPreview: async () => {
            const metadata = await readMetadata();
            return (metadata.preview ?? null) as TPreview;
        },
    };
}
