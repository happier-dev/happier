import {
    ExternalSessionsProviderIdSchema,
    ExternalSessionsSourceSchema,
    type ExternalSessionsProviderId,
    type ExternalSessionsSource,
    type ExternalSessionTakeoverInputV1,
    type ExternalSessionTakeoverResultV1,
} from '@happier-dev/protocol';
import type {
    ExternalSessionAttachParamsV1,
    ExternalSessionAttachResultV1,
    ExternalSessionListCandidatesParamsV1,
    ExternalSessionTranscriptPageParamsV1,
    ExternalSessionTranscriptReadAfterParamsV1,
    ExternalSessionTranscriptUpdateV1,
    PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type { ExternalSessionRuntimeContextV1 } from '@happier-dev/agents';

import type { ExternalSessionProviderOps } from '@/session/external/providerOps';
import {
    resolveDefaultCandidatesLimit,
    resolveDefaultMaxBytes,
    resolveDefaultMaxItems,
} from '@/session/actions/externalSessions/actionConfiguration';

type ProviderOpsResolver = (
    providerId: ExternalSessionsProviderId,
) => ExternalSessionProviderOps | null | Promise<ExternalSessionProviderOps | null>;

type ExternalSessionsRuntimeContextOperation =
    | 'listCandidates'
    | 'pageTranscript'
    | 'readAfterTranscript'
    | 'followTranscript';

type ExternalSessionsRuntimeContextResolver = (
    request: Readonly<{
        operation: ExternalSessionsRuntimeContextOperation;
        providerId: ExternalSessionsProviderId;
        source: ExternalSessionsSource;
        remoteSessionId?: string;
    }>,
) => ExternalSessionRuntimeContextV1 | null | Promise<ExternalSessionRuntimeContextV1 | null>;

type PluginExternalSessionsAttachHandler = (
    params: ExternalSessionAttachParamsV1 & Readonly<{
        providerId: ExternalSessionsProviderId;
        source: ExternalSessionsSource;
    }>,
) => Promise<ExternalSessionAttachResultV1>;

type PluginExternalSessionsTakeoverHandler = (
    params: ExternalSessionTakeoverInputV1,
) => Promise<ExternalSessionTakeoverResultV1>;

export type PluginExternalSessionsServiceParams = Readonly<{
    defaultProviderId: string;
    resolveProviderOps: ProviderOpsResolver;
    resolveRuntimeContext?: ExternalSessionsRuntimeContextResolver;
    attach?: PluginExternalSessionsAttachHandler;
    takeover?: PluginExternalSessionsTakeoverHandler;
}>;

function normalizeBoundedInteger(
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeProviderId(raw: string | undefined, fallback: string): ExternalSessionsProviderId {
    const parsed = ExternalSessionsProviderIdSchema.safeParse(raw && raw.trim().length > 0 ? raw : fallback);
    if (!parsed.success) {
        throw new Error('invalid_provider');
    }
    return parsed.data;
}

function normalizeSource(raw: unknown): ExternalSessionsSource {
    const parsed = ExternalSessionsSourceSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error('invalid_source');
    }
    return parsed.data;
}

async function resolveValidatedProviderOps(params: Readonly<{
    providerId: ExternalSessionsProviderId;
    source: ExternalSessionsSource;
    resolveProviderOps: ProviderOpsResolver;
    resolveRuntimeContext?: ExternalSessionsRuntimeContextResolver;
    operation: ExternalSessionsRuntimeContextOperation;
    remoteSessionId?: string;
}>): Promise<Readonly<{
    ops: ExternalSessionProviderOps;
    source: ExternalSessionsSource;
    runtime: ExternalSessionRuntimeContextV1 | null;
}>> {
    const ops = await params.resolveProviderOps(params.providerId);
    if (!ops) {
        throw new Error('provider_unavailable');
    }
    const runtime = await params.resolveRuntimeContext?.({
        operation: params.operation,
        providerId: params.providerId,
        source: params.source,
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
    }) ?? null;
    const validation = await ops.validateSource({
        source: params.source,
        ...(runtime ? { runtime } : {}),
    });
    if (!validation.ok) {
        throw new Error(validation.error || 'invalid_source');
    }
    return { ops, source: validation.source, runtime };
}

function providerError(error: unknown): string {
    return error instanceof Error && error.message ? error.message : 'provider_unavailable';
}

export function createPluginExternalSessionsService(
    params: PluginExternalSessionsServiceParams,
): PluginContextV1['sessions']['external'] {
    const resolveProvider = async (
        rawProviderId: string | undefined,
        rawSource: unknown,
        operation: ExternalSessionsRuntimeContextOperation,
        remoteSessionId?: string,
    ) => {
        const providerId = normalizeProviderId(rawProviderId, params.defaultProviderId);
        const source = normalizeSource(rawSource);
        const resolved = await resolveValidatedProviderOps({
            providerId,
            source,
            resolveProviderOps: params.resolveProviderOps,
            resolveRuntimeContext: params.resolveRuntimeContext,
            operation,
            remoteSessionId,
        });
        return { providerId, ...resolved };
    };

    const service: PluginContextV1['sessions']['external'] = Object.freeze({
        listCandidates: async (request: ExternalSessionListCandidatesParamsV1 = {}) => {
            const { ops, source, runtime } = await resolveProvider(request.providerId, request.source, 'listCandidates');
            const limit = normalizeBoundedInteger(request.limit, resolveDefaultCandidatesLimit(), 1, 500);
            const result = await ops.listCandidates({
                source,
                ...(typeof request.cursor === 'string' && request.cursor.trim().length > 0 ? { cursor: request.cursor.trim() } : {}),
                limit,
                ...(typeof request.searchTerm === 'string' && request.searchTerm.trim().length > 0
                    ? { searchTerm: request.searchTerm.trim() }
                    : {}),
                ...(request.searchMode === 'fast' || request.searchMode === 'full'
                    ? { searchMode: request.searchMode }
                    : {}),
                ...(runtime ? { runtime } : {}),
            });
            return Object.freeze({
                candidates: Object.freeze([...result.candidates]),
                nextCursor: result.nextCursor ?? null,
                ...(result.searchIncomplete ? { searchIncomplete: true } : {}),
            });
        },
        attach: async (request: ExternalSessionAttachParamsV1) => {
            if (!params.attach) {
                return Object.freeze({
                    ok: false,
                    error: 'ctx.sessions.external.attach requires a host link adapter',
                });
            }
            try {
                const providerId = normalizeProviderId(request.providerId, params.defaultProviderId);
                const source = normalizeSource(request.source);
                return await params.attach({
                    ...request,
                    providerId,
                    source,
                });
            } catch (error) {
                return Object.freeze({
                    ok: false,
                    error: providerError(error),
                });
            }
        },
        takeover: async (request: ExternalSessionTakeoverInputV1) => {
            if (!params.takeover) {
                return Object.freeze({
                    ok: false as const,
                    errorCode: 'capability_unsupported' as const,
                    error: 'ctx.sessions.external.takeover requires a host takeover adapter',
                });
            }
            return await params.takeover(request);
        },
        pageTranscript: async (request: ExternalSessionTranscriptPageParamsV1) => {
            try {
                const { ops, source, runtime } = await resolveProvider(
                    request.providerId,
                    request.source,
                    'pageTranscript',
                    request.remoteSessionId,
                );
                const maxBytes = normalizeBoundedInteger(request.maxBytes, resolveDefaultMaxBytes(), 1024, 10 * 1024 * 1024);
                const maxItems = normalizeBoundedInteger(request.maxItems, resolveDefaultMaxItems(), 1, 5000);
                const result = await ops.pageTranscript({
                    source,
                    remoteSessionId: request.remoteSessionId,
                    direction: request.direction,
                    ...(typeof request.cursor === 'string' && request.cursor.trim().length > 0 ? { cursor: request.cursor.trim() } : {}),
                    maxBytes,
                    maxItems,
                    ...(runtime ? { runtime } : {}),
                });
                return {
                    ok: true as const,
                    items: result.items,
                    nextCursor: result.nextCursor,
                    tailCursor: result.tailCursor,
                    hasMore: result.hasMore,
                    truncated: result.truncated,
                };
            } catch (error) {
                return {
                    ok: false as const,
                    errorCode: 'provider_unavailable' as const,
                    error: providerError(error),
                };
            }
        },
        readAfterTranscript: async (request: ExternalSessionTranscriptReadAfterParamsV1) => {
            try {
                const { ops, source, runtime } = await resolveProvider(
                    request.providerId,
                    request.source,
                    'readAfterTranscript',
                    request.remoteSessionId,
                );
                const maxBytes = normalizeBoundedInteger(request.maxBytes, resolveDefaultMaxBytes(), 1024, 10 * 1024 * 1024);
                const maxItems = normalizeBoundedInteger(request.maxItems, resolveDefaultMaxItems(), 1, 5000);
                const result = await ops.readAfterTranscript({
                    source,
                    remoteSessionId: request.remoteSessionId,
                    cursor: request.cursor,
                    maxBytes,
                    maxItems,
                    ...(runtime ? { runtime } : {}),
                });
                return {
                    ok: true as const,
                    items: result.items,
                    nextCursor: result.nextCursor,
                    truncated: result.truncated,
                };
            } catch (error) {
                return {
                    ok: false as const,
                    errorCode: 'provider_unavailable' as const,
                    error: providerError(error),
                };
            }
        },
        followTranscript: (
            request: ExternalSessionTranscriptReadAfterParamsV1,
            onEvent: (event: ExternalSessionTranscriptUpdateV1) => void,
        ) => {
            let unsubscribed = false;
            let unsubscribeUpdates: (() => void) | null = null;
            let releaseLease: (() => Promise<void>) | null = null;

            void resolveProvider(request.providerId, request.source, 'followTranscript', request.remoteSessionId)
                .then(async ({ ops, source, runtime }) => {
                    if (!ops.acquireFollowLease) return;
                    const lease = await ops.acquireFollowLease({
                        source,
                        remoteSessionId: request.remoteSessionId,
                        reason: 'attached_view',
                        ...(runtime?.session?.sessionId ? { linkedSessionId: runtime.session.sessionId } : {}),
                        ...(runtime ? { runtime } : {}),
                    });
                    if (!lease) return;
                    releaseLease = lease.release;
                    if (unsubscribed) {
                        await lease.release().catch(() => undefined);
                        return;
                    }
                    unsubscribeUpdates = lease.subscribeToTranscriptUpdates?.((event) => {
                        onEvent({
                            items: event.items,
                            nextCursor: event.nextCursor,
                        });
                    }) ?? null;
                })
                .catch(() => undefined);

            return Object.freeze({
                unsubscribe: () => {
                    if (unsubscribed) return;
                    unsubscribed = true;
                    try {
                        unsubscribeUpdates?.();
                    } finally {
                        void releaseLease?.().catch(() => undefined);
                    }
                },
            });
        },
    });
    return service;
}
