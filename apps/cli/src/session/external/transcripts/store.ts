import type {
    ExternalSessionActivityResultV1,
    ExternalSessionFollowLeaseV1,
    ExternalSessionFollowTranscriptPathResolutionV1,
    ExternalSessionProviderStoreKeyV1,
    ExternalSessionTranscriptPageV1,
    ExternalSessionTranscriptStoreFollowRequestV1,
    ExternalSessionTranscriptStorePageRequestV1,
    ExternalSessionTranscriptStoreReadAfterRequestV1,
} from '@happier-dev/agents';
import type {
    ExternalSessionsProviderId,
    ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/protocol';

import type {
    FileBackedTranscriptSessionLease,
    FileBackedTranscriptSessionStore,
} from '@/api/session/fileBackedTranscripts/store';

export type ExternalSessionTranscriptStoreAdapter = Readonly<{
    providerId: ExternalSessionsProviderId;
    withStore<T>(
        input: ExternalSessionProviderStoreKeyV1,
        handler: (store: FileBackedTranscriptSessionStore<ExternalSessionTranscriptRawMessageV1>) => Promise<T>,
    ): Promise<T>;
    acquireStore(
        input: ExternalSessionTranscriptStoreFollowRequestV1,
    ): Promise<FileBackedTranscriptSessionLease<FileBackedTranscriptSessionStore<ExternalSessionTranscriptRawMessageV1>>>;
    resolveFollowTranscriptPath?(
        input: ExternalSessionTranscriptStoreFollowRequestV1,
    ): Promise<ExternalSessionFollowTranscriptPathResolutionV1 | null>;
    getProviderHome?(input: ExternalSessionProviderStoreKeyV1): Promise<string | null>;
}>;

export type ExternalSessionTranscriptStoreService = Readonly<{
    getActivity(input: ExternalSessionProviderStoreKeyV1): Promise<ExternalSessionActivityResultV1>;
    page(input: ExternalSessionTranscriptStorePageRequestV1): Promise<ExternalSessionTranscriptPageV1>;
    readAfter(input: ExternalSessionTranscriptStoreReadAfterRequestV1): Promise<ExternalSessionTranscriptPageV1>;
    acquireFollowLease(input: ExternalSessionTranscriptStoreFollowRequestV1): Promise<ExternalSessionFollowLeaseV1>;
    resolveFollowTranscriptPath(
        input: ExternalSessionTranscriptStoreFollowRequestV1,
    ): Promise<ExternalSessionFollowTranscriptPathResolutionV1>;
    getWorkingDirectory(input: ExternalSessionProviderStoreKeyV1): Promise<string | null>;
    getProviderHome(input: ExternalSessionProviderStoreKeyV1): Promise<string | null>;
}>;

function buildAdapterMap(adapters: readonly ExternalSessionTranscriptStoreAdapter[]) {
    const map = new Map<ExternalSessionsProviderId, ExternalSessionTranscriptStoreAdapter>();
    for (const adapter of adapters) {
        if (map.has(adapter.providerId)) {
            throw new Error(`Duplicate external-session transcript store adapter for ${adapter.providerId}`);
        }
        map.set(adapter.providerId, adapter);
    }
    return map;
}

function requireAdapter(
    adapters: ReadonlyMap<ExternalSessionsProviderId, ExternalSessionTranscriptStoreAdapter>,
    providerId: ExternalSessionsProviderId,
): ExternalSessionTranscriptStoreAdapter {
    const adapter = adapters.get(providerId);
    if (!adapter) {
        throw new Error(`Missing external-session transcript store adapter for ${providerId}`);
    }
    return adapter;
}

function normalizeActivity(value: unknown): ExternalSessionActivityResultV1 {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
    const lastActivityAtMs = typeof record?.lastActivityAtMs === 'number' && Number.isFinite(record.lastActivityAtMs)
        ? Math.trunc(record.lastActivityAtMs)
        : null;
    return {
        lastActivityAtMs,
        isRunning: false,
    };
}

export function createExternalSessionTranscriptStoreService(params: Readonly<{
    adapters: readonly ExternalSessionTranscriptStoreAdapter[];
}>): ExternalSessionTranscriptStoreService {
    const adapters = buildAdapterMap(params.adapters);

    async function withStore<T>(
        input: ExternalSessionProviderStoreKeyV1,
        handler: (store: FileBackedTranscriptSessionStore<ExternalSessionTranscriptRawMessageV1>) => Promise<T>,
    ): Promise<T> {
        return await requireAdapter(adapters, input.providerId).withStore(input, handler);
    }

    return Object.freeze({
        getActivity: async (input) => await withStore(input, async (store) => normalizeActivity(await store.getActivity())),
        page: async (input) => await withStore(input, async (store) => {
            const page = await store.pageOlder({
                direction: input.direction,
                cursor: input.cursor,
                maxBytes: input.maxBytes,
                maxItems: input.maxItems,
                allowProviderFallback: true,
            });
            return {
                items: [...page.items],
                nextCursor: page.nextCursor,
                tailCursor: page.tailCursor,
                hasMore: page.hasMore,
                truncated: page.truncated,
            };
        }),
        readAfter: async (input) => await withStore(input, async (store) => {
            const page = await store.readAfter({
                cursor: input.cursor,
                maxBytes: input.maxBytes,
                maxItems: input.maxItems,
                allowProviderFallback: true,
            });
            return {
                items: [...page.items],
                nextCursor: page.nextCursor,
                truncated: page.truncated,
            };
        }),
        acquireFollowLease: async (input) => {
            const lease = await requireAdapter(adapters, input.providerId).acquireStore(input);
            return {
                release: lease.release,
                getTailCursor: () => lease.store.getTailCursor(),
                subscribeToTranscriptUpdates: (listener) => lease.store.subscribe(async (event) => {
                    await listener({
                        items: [...event.items],
                        nextCursor: event.nextCursor,
                        truncated: event.truncated,
                    });
                }),
            };
        },
        resolveFollowTranscriptPath: async (input) => {
            const adapter = requireAdapter(adapters, input.providerId);
            if (!adapter.resolveFollowTranscriptPath) {
                throw new Error(`External-session transcript store adapter for ${input.providerId} does not support follow path resolution`);
            }
            const resolution = await adapter.resolveFollowTranscriptPath(input);
            if (!resolution) {
                throw new Error(`External-session transcript store adapter for ${input.providerId} did not resolve a follow path`);
            }
            return resolution;
        },
        getWorkingDirectory: async (input) => await withStore(input, async (store) => await store.getWorkingDirectory()),
        getProviderHome: async (input) => await requireAdapter(adapters, input.providerId).getProviderHome?.(input) ?? null,
    });
}
