import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import type {
    ExternalSessionActivityResultV1,
    ExternalSessionCandidateHostAdapterV1,
    ExternalSessionProviderStoreKeyV1,
    ExternalSessionRuntimeHostAdapterParamsV1,
    ExternalSessionTranscriptRawMessageV1,
    ExternalSessionTranscriptStoreAdapterV1,
    ExternalSessionTranscriptStoreFollowRequestV1,
} from '@happier-dev/plugin-sdk/sessions';
import type { ExternalSessionsProviderId } from '@happier-dev/protocol';

import type {
    ExternalSessionRuntimeHostAdapterParams,
    ExternalSessionRuntimeHostAdapters,
} from '@/agent/catalog/types';
import type {
    FileBackedTranscriptSessionLease,
    FileBackedTranscriptSessionStore,
    FileBackedTranscriptSessionStoreLifecycleState,
} from '@/api/session/fileBackedTranscripts/store';
import type { ExternalSessionCandidateHostAdapter } from '@/session/external/candidates/host';
import type { ExternalSessionTranscriptStoreAdapter } from '@/session/external/transcripts/store';

import type { ExternalSessionsContribution } from './providerRuntimeContribution';

type ExternalSessionTranscriptStorePageParams = Readonly<{
    direction?: unknown;
    cursor?: unknown;
    maxBytes?: unknown;
    maxItems?: unknown;
}>;

type ExternalSessionTranscriptStoreReadAfterParams = Readonly<{
    cursor?: unknown;
    maxBytes?: unknown;
    maxItems?: unknown;
}>;

type ServiceBackedTranscriptStore =
    FileBackedTranscriptSessionStore<
        ExternalSessionTranscriptRawMessageV1,
        ExternalSessionActivityResultV1,
        string | null
    >;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readFunction<T>(value: unknown): T | null {
    return typeof value === 'function' ? value as T : null;
}

function readPositiveIntegerOrDefault(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : fallback;
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function readTranscriptDirection(value: unknown): 'older' | 'newer' {
    return value === 'newer' ? 'newer' : 'older';
}

function isLegacyExternalSessionTranscriptStoreAdapter(
    value: unknown,
): value is ExternalSessionTranscriptStoreAdapter {
    return isRecord(value)
        && typeof value.withStore === 'function'
        && typeof value.acquireStore === 'function';
}

function isPublicExternalSessionTranscriptStoreAdapter(
    value: unknown,
): value is ExternalSessionTranscriptStoreAdapterV1 {
    return isRecord(value)
        && typeof value.providerId === 'string'
        && typeof value.getActivity === 'function'
        && typeof value.page === 'function'
        && typeof value.readAfter === 'function'
        && typeof value.acquireFollowLease === 'function'
        && typeof value.resolveFollowTranscriptPath === 'function'
        && typeof value.getWorkingDirectory === 'function'
        && typeof value.getProviderHome === 'function';
}

function normalizeExternalSessionProviderId(providerId: string): ExternalSessionsProviderId {
    return providerId as ExternalSessionsProviderId;
}

function normalizeExternalSessionProviderStoreKey(
    service: ExternalSessionTranscriptStoreAdapterV1,
    input: ExternalSessionProviderStoreKeyV1,
): ExternalSessionProviderStoreKeyV1 {
    return {
        providerId: normalizeExternalSessionProviderId(service.providerId),
        source: input.source,
        providerSessionId: input.providerSessionId,
    };
}

function normalizeExternalSessionFollowRequest(
    service: ExternalSessionTranscriptStoreAdapterV1,
    input: ExternalSessionTranscriptStoreFollowRequestV1,
): ExternalSessionTranscriptStoreFollowRequestV1 {
    const key = normalizeExternalSessionProviderStoreKey(service, input);
    return {
        ...key,
        reason: input.reason,
        ...(input.linkedSessionId !== undefined ? { linkedSessionId: input.linkedSessionId } : {}),
    };
}

function createFileBackedLeaseKey(input: ExternalSessionProviderStoreKeyV1) {
    return {
        providerId: input.providerId,
        source: input.source,
        remoteSessionId: input.providerSessionId,
    };
}

function createServiceBackedTranscriptStore(params: Readonly<{
    service: ExternalSessionTranscriptStoreAdapterV1;
    key: ExternalSessionProviderStoreKeyV1;
    release?: () => Promise<void>;
    getLeaseTailCursor?: () => string | null;
    subscribeToLeaseUpdates?: (
        listener: Parameters<ServiceBackedTranscriptStore['subscribe']>[0],
    ) => (() => void);
}>): ServiceBackedTranscriptStore {
    const key = normalizeExternalSessionProviderStoreKey(params.service, params.key);
    let released = false;
    let tailCursor = params.getLeaseTailCursor?.() ?? null;

    async function releaseOnce(): Promise<void> {
        if (released) return;
        released = true;
        await params.release?.();
    }

    return Object.freeze({
        warm: async () => undefined,
        dispose: releaseOnce,
        setLifecycleState: async (state: FileBackedTranscriptSessionStoreLifecycleState) => {
            if (state === 'disposed') {
                await releaseOnce();
            }
        },
        pageOlder: async (pageParams?: ExternalSessionTranscriptStorePageParams) => {
            const cursor = readOptionalString(pageParams?.cursor);
            const page = await params.service.page({
                ...key,
                direction: readTranscriptDirection(pageParams?.direction),
                ...(cursor !== undefined ? { cursor } : {}),
                maxBytes: readPositiveIntegerOrDefault(pageParams?.maxBytes, 1024 * 1024),
                maxItems: readPositiveIntegerOrDefault(pageParams?.maxItems, 100),
            });
            tailCursor = page.tailCursor ?? tailCursor;
            return {
                items: [...page.items],
                nextCursor: page.nextCursor ?? null,
                hasMore: page.hasMore === true,
                tailCursor: page.tailCursor ?? null,
                truncated: page.truncated === true,
            };
        },
        readAfter: async (readParams?: ExternalSessionTranscriptStoreReadAfterParams) => {
            const cursor = readOptionalString(readParams?.cursor) ?? tailCursor ?? 'tail';
            const page = await params.service.readAfter({
                ...key,
                cursor,
                maxBytes: readPositiveIntegerOrDefault(readParams?.maxBytes, 1024 * 1024),
                maxItems: readPositiveIntegerOrDefault(readParams?.maxItems, 100),
            });
            tailCursor = page.nextCursor ?? page.tailCursor ?? tailCursor;
            return {
                items: [...page.items],
                nextCursor: page.nextCursor ?? null,
                truncated: page.truncated === true,
            };
        },
        getTailCursor: () => params.getLeaseTailCursor?.() ?? tailCursor,
        subscribe: (listener: Parameters<ServiceBackedTranscriptStore['subscribe']>[0]) => (
            params.subscribeToLeaseUpdates?.(listener) ?? (() => undefined)
        ),
        getTitle: async () => null,
        getWorkingDirectory: async () => await params.service.getWorkingDirectory(key),
        getActivity: async () => await params.service.getActivity(key),
        getPreview: async () => null,
    });
}

function createServiceBackedTranscriptStoreAdapter(
    service: ExternalSessionTranscriptStoreAdapterV1,
): ExternalSessionTranscriptStoreAdapter {
    return Object.freeze({
        providerId: normalizeExternalSessionProviderId(service.providerId),
        withStore: async (input, handler) => {
            const store = createServiceBackedTranscriptStore({ service, key: input });
            try {
                await store.warm();
                return await handler(store);
            } finally {
                await store.dispose();
            }
        },
        acquireStore: async (input): Promise<FileBackedTranscriptSessionLease<ServiceBackedTranscriptStore>> => {
            const serviceKey = normalizeExternalSessionProviderStoreKey(service, input);
            const followRequest = normalizeExternalSessionFollowRequest(service, input);
            const lease = await service.acquireFollowLease(followRequest);
            const subscribeToTranscriptUpdates = lease.subscribeToTranscriptUpdates;
            const store = createServiceBackedTranscriptStore({
                service,
                key: serviceKey,
                release: lease.release,
                ...(lease.getTailCursor ? { getLeaseTailCursor: lease.getTailCursor } : {}),
                ...(subscribeToTranscriptUpdates
                    ? {
                        subscribeToLeaseUpdates: (listener: Parameters<ServiceBackedTranscriptStore['subscribe']>[0]) => (
                            listener
                                ? subscribeToTranscriptUpdates(async (event) => {
                                    await listener({
                                        items: [...event.items],
                                        fromCursor: event.fromCursor ?? null,
                                        nextCursor: event.nextCursor ?? null,
                                        truncated: event.truncated === true,
                                    });
                                })
                                : (() => undefined)
                        ),
                    }
                    : {}),
            });
            await store.warm();
            return {
                key: createFileBackedLeaseKey(serviceKey),
                store,
                release: store.dispose,
            };
        },
        resolveFollowTranscriptPath: async (input) => await service.resolveFollowTranscriptPath(
            normalizeExternalSessionFollowRequest(service, input),
        ),
        getProviderHome: async (input) => await service.getProviderHome(
            normalizeExternalSessionProviderStoreKey(service, input),
        ),
    });
}

function normalizeExternalSessionTranscriptStoreAdapter(
    adapter: ExternalSessionTranscriptStoreAdapter | ExternalSessionTranscriptStoreAdapterV1,
): ExternalSessionTranscriptStoreAdapter {
    if (isLegacyExternalSessionTranscriptStoreAdapter(adapter)) return adapter;
    if (isPublicExternalSessionTranscriptStoreAdapter(adapter)) {
        return createServiceBackedTranscriptStoreAdapter(adapter);
    }
    throw new Error('Invalid external-session transcript store adapter contribution');
}

function normalizeExternalSessionCandidateHostAdapter(
    adapter: ExternalSessionCandidateHostAdapter | ExternalSessionCandidateHostAdapterV1,
): ExternalSessionCandidateHostAdapter {
    return adapter as ExternalSessionCandidateHostAdapter;
}

export function readExternalSessionsContribution(value: unknown): ExternalSessionsContribution | null {
    if (!isRecord(value)) return null;
    const createTranscriptStoreAdapter = readFunction<ExternalSessionsContribution['createTranscriptStoreAdapter']>(
        value.createTranscriptStoreAdapter,
    );
    const createCandidateHostAdapter = readFunction<ExternalSessionsContribution['createCandidateHostAdapter']>(
        value.createCandidateHostAdapter,
    );
    return createTranscriptStoreAdapter || createCandidateHostAdapter
        ? {
            ...(createTranscriptStoreAdapter ? { createTranscriptStoreAdapter } : {}),
            ...(createCandidateHostAdapter ? { createCandidateHostAdapter } : {}),
        }
        : null;
}

export async function createExternalSessionRuntimeHostAdapters(params: Readonly<{
    externalSessions: ExternalSessionsContribution;
    adapterParams: ExternalSessionRuntimeHostAdapterParams;
    exec: ExecRuntimeServiceV1;
}>): Promise<ExternalSessionRuntimeHostAdapters> {
    const publicAdapterParams: ExternalSessionRuntimeHostAdapterParamsV1 = {
        ...params.adapterParams,
        exec: params.exec,
    };
    const transcriptStore = params.externalSessions.createTranscriptStoreAdapter?.(publicAdapterParams);
    const candidateHost = params.externalSessions.createCandidateHostAdapter?.(publicAdapterParams);
    return {
        transcriptStores: transcriptStore
            ? [normalizeExternalSessionTranscriptStoreAdapter(transcriptStore)]
            : [],
        candidateHosts: candidateHost
            ? [normalizeExternalSessionCandidateHostAdapter(candidateHost)]
            : [],
    };
}
