import {
    SessionWorkStateItemV1Schema,
    buildDeterministicSessionWorkStateItemId,
    mergeSessionWorkStateV1,
    readSessionWorkStateV1FromMetadata,
    resolveSessionWorkStatePrimaryItemId,
    writeSessionWorkStateV1ToMetadata,
    type SessionWorkStateItemKindV1,
    type SessionWorkStateTruncationV1,
    type SessionWorkStateV1,
} from '@happier-dev/protocol';
import type {
    WorkStatePublisher,
    WorkStateService,
    WorkStateItem,
    WorkStateTruncation,
} from '@happier-dev/plugin-sdk/sessions/work-state';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import { deterministicStringify } from '@/utils/deterministicJson';

const MAX_ITEMS_PER_SOURCE = 100;
const MAX_SOURCE_JSON_BYTES = 256 * 1024;
const SOURCE_PREFIX_MARKER = '__happier_source_prefix__';

type WorkStateSourceDeclaration = Readonly<{
    id: string;
    itemKinds: readonly SessionWorkStateItemKindV1[];
}>;

type PublisherState = {
    sourceSequence: number;
    fingerprint: string | null;
    revision: string;
    queue: Promise<void>;
};

function diagnostic(code: string, message?: string) {
    return {
        code,
        severity: 'error' as const,
        ...(message ? { message } : {}),
    };
}

function qualifiedSourceFamily(params: Readonly<{
    pluginId: string;
    contributionId: string;
    declaredSourceId: string;
}>): string {
    return `plugin-agent/${params.pluginId}/${params.contributionId}/${params.declaredSourceId}`;
}

function qualifiedItemId(params: Readonly<{
    kind: SessionWorkStateItemKindV1;
    sourceFamily: string;
    localId: string;
}>): string {
    return buildDeterministicSessionWorkStateItemId({
        kind: params.kind,
        sourceFamily: params.sourceFamily,
        stableParts: [params.localId],
    });
}

function ownedItemPrefix(kind: SessionWorkStateItemKindV1, sourceFamily: string): string {
    const marked = buildDeterministicSessionWorkStateItemId({
        kind,
        sourceFamily,
        stableParts: [SOURCE_PREFIX_MARKER],
    });
    return marked.slice(0, -SOURCE_PREFIX_MARKER.length);
}

function normalizeTruncation(
    truncation: WorkStateTruncation | undefined,
): SessionWorkStateTruncationV1 | undefined {
    if (!truncation) return undefined;
    if (truncation.reason === 'itemLimit') {
        return { reason: 'item_limit', omittedCount: truncation.omittedCount };
    }
    return {
        reason: 'provider_limit',
        ...(truncation.omittedCount === undefined ? {} : { omittedCount: truncation.omittedCount }),
        // The durable V1 display schema has one provider-limited bucket. Preserve the
        // public source-local reason as passthrough data instead of erasing byte-limit truth.
        sourceReason: truncation.reason,
    };
}

function normalizeItem(params: Readonly<{
    item: WorkStateItem;
    agentId: string;
    sourceFamily: string;
}>): SessionWorkStateV1['items'][number] | null {
    const item = params.item;
    const localId = item.localId.trim();
    if (!localId) return null;
    const parsed = SessionWorkStateItemV1Schema.safeParse({
        id: qualifiedItemId({ kind: item.kind, sourceFamily: params.sourceFamily, localId }),
        kind: item.kind,
        origin: item.origin,
        status: item.status,
        ...(item.statusReason ? { statusReason: item.statusReason } : {}),
        title: item.title,
        ...(item.summary === undefined ? {} : { summary: item.summary }),
        agentId: params.agentId,
        ...(item.providerRef === undefined ? {} : { vendorRef: item.providerRef }),
        ...(item.order === undefined ? {} : { order: item.order }),
        ...(item.parentProviderRef === undefined ? {} : { parentId: item.parentProviderRef }),
        ...(item.priority === undefined ? {} : { priority: item.priority }),
        ...(item.progress === undefined ? {} : { progress: item.progress }),
        ...(item.tokenBudget === undefined ? {} : { tokenBudget: item.tokenBudget }),
        ...(item.tokensUsed === undefined ? {} : { tokensUsed: item.tokensUsed }),
        ...(item.timeUsedSeconds === undefined ? {} : { timeUsedSeconds: item.timeUsedSeconds }),
        ...(item.createdAtMs === undefined ? {} : { createdAt: item.createdAtMs }),
        ...(item.startedAtMs === undefined ? {} : { startedAt: item.startedAtMs }),
        ...(item.completedAtMs === undefined ? {} : { completedAt: item.completedAtMs }),
        updatedAt: item.updatedAtMs,
        ...(item.providerData === undefined ? {} : { providerData: item.providerData }),
    });
    return parsed.success ? parsed.data : null;
}

function validateAndNormalizePublication(params: Readonly<{
    request: Parameters<WorkStatePublisher['publish']>[0];
    declaration: WorkStateSourceDeclaration;
    agentId: string;
    sourceFamily: string;
}>): Readonly<{
    fingerprint: string;
    items: SessionWorkStateV1['items'];
    primaryItemId: string | null;
    truncation?: SessionWorkStateTruncationV1;
}> | null {
    const { request } = params;
    if (!Number.isSafeInteger(request.sourceSequence) || request.sourceSequence < 0) return null;
    if (!Number.isSafeInteger(request.observedAtMs) || request.observedAtMs < 0) return null;
    if (request.items.length > MAX_ITEMS_PER_SOURCE) return null;
    if (
        request.truncation?.reason === 'itemLimit'
        && (request.items.length !== MAX_ITEMS_PER_SOURCE || request.truncation.omittedCount <= 0)
    ) return null;
    if (
        request.truncation?.omittedCount !== undefined
        && (!Number.isSafeInteger(request.truncation.omittedCount) || request.truncation.omittedCount < 0)
    ) return null;

    const localIds = new Set<string>();
    const items: SessionWorkStateV1['items'][number][] = [];
    for (const item of request.items) {
        const localId = item.localId.trim();
        if (!localId || localIds.has(localId) || !params.declaration.itemKinds.includes(item.kind)) return null;
        localIds.add(localId);
        const normalized = normalizeItem({ item, agentId: params.agentId, sourceFamily: params.sourceFamily });
        if (!normalized) return null;
        items.push(normalized);
    }

    const primaryLocalId = request.primaryLocalId?.trim() || null;
    if (primaryLocalId && !localIds.has(primaryLocalId)) return null;
    const truncation = normalizeTruncation(request.truncation);
    const normalizedForFingerprint = {
        sourceSequence: request.sourceSequence,
        observedAtMs: request.observedAtMs,
        items,
        primaryItemId: primaryLocalId
            ? qualifiedItemId({
                kind: request.items.find((item) => item.localId.trim() === primaryLocalId)!.kind,
                sourceFamily: params.sourceFamily,
                localId: primaryLocalId,
            })
            : null,
        ...(truncation ? { truncation } : {}),
    };
    const fingerprint = deterministicStringify(normalizedForFingerprint);
    if (Buffer.byteLength(fingerprint, 'utf8') > MAX_SOURCE_JSON_BYTES) return null;
    return {
        fingerprint,
        items,
        primaryItemId: normalizedForFingerprint.primaryItemId,
        ...(truncation ? { truncation } : {}),
    };
}

function buildAggregateTruncation(
    sourceTruncations: Readonly<Record<string, SessionWorkStateTruncationV1>>,
): SessionWorkStateTruncationV1 | undefined {
    const values = Object.values(sourceTruncations);
    if (values.length === 0) return undefined;
    const reason = values.some((value) => value.reason === 'item_limit')
        ? 'item_limit' as const
        : 'provider_limit' as const;
    const omittedCounts = values.map((value) => value.omittedCount);
    const omittedCount = omittedCounts.every((value): value is number => value !== undefined)
        ? omittedCounts.reduce((sum, value) => sum + value, 0)
        : undefined;
    return { reason, ...(omittedCount === undefined ? {} : { omittedCount }) };
}

function unavailablePublisher(code: string): WorkStatePublisher {
    return Object.freeze({
        async publish() {
            return { status: 'unavailable' as const, diagnostic: diagnostic(code) };
        },
    });
}

export function createNativeAgentSessionWorkStateService(params: Readonly<{
    session: Pick<ApiSessionClient, 'sessionId' | 'updateMetadata'>;
    pluginId: string;
    contributionId: string;
    agentId: string;
    generationId: string;
    declarations: readonly WorkStateSourceDeclaration[];
    isCurrent: () => boolean;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>): WorkStateService {
    const declarations = new Map(params.declarations.map((declaration) => [declaration.id, declaration]));
    const publishers = new Map<string, WorkStatePublisher>();
    let revisionOrdinal = 0;

    return Object.freeze({
        publisher(declaredSourceId: string) {
            const declaration = declarations.get(declaredSourceId);
            if (!declaration) return unavailablePublisher('agent_work_state_source_unavailable');
            const existing = publishers.get(declaredSourceId);
            if (existing) return existing;

            const sourceFamily = qualifiedSourceFamily({
                pluginId: params.pluginId,
                contributionId: params.contributionId,
                declaredSourceId,
            });
            const sourceKey = `${params.pluginId}/${params.contributionId}/${declaredSourceId}`;
            const state: PublisherState = {
                sourceSequence: -1,
                fingerprint: null,
                revision: `${params.generationId}:0`,
                queue: Promise.resolve(),
            };
            const publisher: WorkStatePublisher = Object.freeze({
                publish(
                    request: Parameters<WorkStatePublisher['publish']>[0],
                    options?: Parameters<WorkStatePublisher['publish']>[1],
                ) {
                    let resolveResult!: (result: Awaited<ReturnType<WorkStatePublisher['publish']>>) => void;
                    const result = new Promise<Awaited<ReturnType<WorkStatePublisher['publish']>>>((resolve) => {
                        resolveResult = resolve;
                    });
                    state.queue = state.queue.then(async () => {
                        if (options?.signal?.aborted) {
                            resolveResult({
                                status: 'unavailable',
                                diagnostic: diagnostic('agent_work_state_publish_aborted'),
                            });
                            return;
                        }
                        if (!params.isCurrent()) {
                            resolveResult({
                                status: 'unavailable',
                                diagnostic: diagnostic('agent_work_state_generation_retired'),
                            });
                            return;
                        }
                        const normalized = validateAndNormalizePublication({
                            request,
                            declaration,
                            agentId: params.agentId,
                            sourceFamily,
                        });
                        if (!normalized) {
                            resolveResult({
                                status: 'conflict',
                                diagnostic: diagnostic('agent_work_state_invalid_publication'),
                            });
                            return;
                        }
                        if (request.sourceSequence < state.sourceSequence) {
                            resolveResult({
                                status: 'ignoredStale',
                                revision: state.revision,
                                currentSourceSequence: state.sourceSequence,
                            });
                            return;
                        }
                        if (request.sourceSequence === state.sourceSequence) {
                            resolveResult(normalized.fingerprint === state.fingerprint
                                ? { status: 'unchanged', revision: state.revision, sourceSequence: request.sourceSequence }
                                : {
                                    status: 'conflict',
                                    diagnostic: diagnostic('agent_work_state_sequence_conflict'),
                                });
                            return;
                        }
                        params.recordRuntimeLimitMeasurement?.({
                            family: 'native-work-state-source',
                            decodedBytes: Buffer.byteLength(normalized.fingerprint, 'utf8'),
                            itemCount: normalized.items.length,
                        });

                        let retiredDuringMerge = false;
                        try {
                            await params.session.updateMetadata((metadata) => {
                                if (!params.isCurrent()) {
                                    retiredDuringMerge = true;
                                    return metadata;
                                }
                                const current = readSessionWorkStateV1FromMetadata(metadata);
                                const sourceTruncations = {
                                    ...((current?.sourceTruncations && typeof current.sourceTruncations === 'object')
                                        ? current.sourceTruncations as Record<string, SessionWorkStateTruncationV1>
                                        : {}),
                                };
                                if (normalized.truncation) sourceTruncations[sourceKey] = normalized.truncation;
                                else delete sourceTruncations[sourceKey];
                                const nextOwned = {
                                    v: 1 as const,
                                    backendId: params.agentId,
                                    agentId: params.agentId,
                                    updatedAt: request.observedAtMs,
                                    items: normalized.items,
                                    primaryItemId: normalized.primaryItemId,
                                    sourceTruncations,
                                    ...(buildAggregateTruncation(sourceTruncations)
                                        ? { truncated: buildAggregateTruncation(sourceTruncations) }
                                        : {}),
                                } satisfies SessionWorkStateV1;
                                const merged = mergeSessionWorkStateV1({
                                    existing: current,
                                    nextOwned,
                                    ownedItemIdPrefixes: declaration.itemKinds.map((kind) => ownedItemPrefix(kind, sourceFamily)),
                                });
                                const withPrimary = normalized.primaryItemId
                                    ? {
                                        ...merged,
                                        primaryItemId: resolveSessionWorkStatePrimaryItemId(
                                            merged.items,
                                            current?.primaryItemId,
                                            { preferItemIds: [normalized.primaryItemId] },
                                        ),
                                    }
                                    : merged;
                                params.recordRuntimeLimitMeasurement?.({
                                    family: 'native-work-state-aggregate',
                                    decodedBytes: Buffer.byteLength(
                                        JSON.stringify(withPrimary),
                                        'utf8',
                                    ),
                                    itemCount: withPrimary.items.length,
                                });
                                return writeSessionWorkStateV1ToMetadata(metadata, withPrimary as SessionWorkStateV1);
                            });
                        } catch {
                            resolveResult({
                                status: 'unavailable',
                                diagnostic: diagnostic('agent_work_state_host_unavailable'),
                            });
                            return;
                        }
                        if (retiredDuringMerge || !params.isCurrent()) {
                            resolveResult({
                                status: 'unavailable',
                                diagnostic: diagnostic('agent_work_state_generation_retired'),
                            });
                            return;
                        }
                        state.sourceSequence = request.sourceSequence;
                        state.fingerprint = normalized.fingerprint;
                        state.revision = `${params.generationId}:${++revisionOrdinal}`;
                        resolveResult({
                            status: 'applied',
                            revision: state.revision,
                            sourceSequence: request.sourceSequence,
                        });
                    }).catch(() => {
                        resolveResult({
                            status: 'unavailable',
                            diagnostic: diagnostic('agent_work_state_host_unavailable'),
                        });
                    });
                    return result;
                },
            });
            publishers.set(declaredSourceId, publisher);
            return publisher;
        },
    });
}
