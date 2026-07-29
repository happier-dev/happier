import {
    EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1,
    ExternalSessionOperationSocketBatchItemV1Schema,
    makeExternalSessionHistoricalImportBatchIdV1,
    type ExternalSessionOperationSocketBatchItemV1,
    type ExternalSessionRequiredItemDiagnosticV1,
    type ExternalSessionRequiredItemFailuresV1,
} from '@happier-dev/protocol/sessions';

import type { ExternalSessionOperationPrivateStagingStore } from './operationPrivateStaging';

export const EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP =
    EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1;

type HistoricalImportBatchWriteResult =
    | Readonly<{
        ok: true;
        batchId: string;
        acceptedThroughServerSeq: number;
    }>
    | Readonly<{
        ok: false;
        error: string;
    }>;

export type ExternalSessionHistoricalImportReplay = Readonly<{
    /**
     * The only execution entry point. Constructing this owner or discovering durable staging
     * never resumes work; the operation owner must call this from explicit operation Resume.
     */
    resume(operationId: string): Promise<
        | Readonly<{
            status: 'completed';
            acceptedThroughServerSeq: number | null;
        }>
        | Readonly<{
            status: 'awaiting_user_resume';
            reason:
                | 'staging_missing'
                | 'capture_incomplete'
                | 'staging_incomplete'
                | 'historical_import_failed'
                | 'required_items_failed';
            acceptedThroughServerSeq: number | null;
            requiredItemFailures?: ExternalSessionRequiredItemFailuresV1;
        }>
        | Readonly<{
            status: 'discard_required';
            acceptedThroughServerSeq: number | null;
        }>
    >;
}>;

type HistoricalImportBatch = Readonly<{
    batchId: string;
    items: readonly ExternalSessionOperationSocketBatchItemV1[];
}>;

function isWellFormedUnicode(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
            index += 1;
            continue;
        }
        if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) return false;
    }
    return true;
}

function containsOnlyWellFormedUnicode(value: unknown): boolean {
    if (typeof value === 'string') return isWellFormedUnicode(value);
    if (Array.isArray(value)) return value.every(containsOnlyWellFormedUnicode);
    if (value === null || typeof value !== 'object') return true;
    return Object.entries(value).every(
        ([key, entry]) => isWellFormedUnicode(key) && containsOnlyWellFormedUnicode(entry),
    );
}

type PreparedHistoricalImportItemResult =
    | Readonly<{
        ok: true;
        item: ExternalSessionOperationSocketBatchItemV1;
        cleanup?: () => Promise<void>;
    }>
    | Readonly<{
        ok: false;
        category: 'record' | 'media' | 'conversion';
    }>;

async function readBatchItems(
    values: readonly unknown[],
    prepareStagedItem?: (
        value: unknown,
        mode: 'validate' | 'publish',
    ) => Promise<PreparedHistoricalImportItemResult>,
    mode: 'validate' | 'publish' = 'validate',
): Promise<Readonly<{
    items: readonly Readonly<{
        item: ExternalSessionOperationSocketBatchItemV1;
        sourceItemIndex: number;
        cleanup?: () => Promise<void>;
    }>[];
    recordFailureIndexes: readonly number[];
    mediaFailureIndexes: readonly number[];
    conversionFailureIndexes: readonly number[];
}>> {
    const items: Array<Readonly<{
        item: ExternalSessionOperationSocketBatchItemV1;
        sourceItemIndex: number;
        cleanup?: () => Promise<void>;
    }>> = [];
    const recordFailureIndexes: number[] = [];
    const mediaFailureIndexes: number[] = [];
    const conversionFailureIndexes: number[] = [];
    for (const [sourceItemIndex, value] of values.entries()) {
        const prepared = prepareStagedItem
            ? await prepareStagedItem(value, mode)
            : { ok: true as const, item: value as ExternalSessionOperationSocketBatchItemV1 };
        if (!prepared.ok) {
            if (prepared.category === 'media') mediaFailureIndexes.push(sourceItemIndex);
            else if (prepared.category === 'conversion') conversionFailureIndexes.push(sourceItemIndex);
            else recordFailureIndexes.push(sourceItemIndex);
            continue;
        }
        const parsed = ExternalSessionOperationSocketBatchItemV1Schema.safeParse(prepared.item);
        if (!parsed.success || !containsOnlyWellFormedUnicode(parsed.data)) {
            await prepared.cleanup?.();
            recordFailureIndexes.push(sourceItemIndex);
            continue;
        }
        items.push(Object.freeze({
            item: parsed.data,
            sourceItemIndex,
            ...(prepared.cleanup ? { cleanup: prepared.cleanup } : {}),
        }));
    }
    return Object.freeze({
        items: Object.freeze(items),
        recordFailureIndexes: Object.freeze(recordFailureIndexes),
        mediaFailureIndexes: Object.freeze(mediaFailureIndexes),
        conversionFailureIndexes: Object.freeze(conversionFailureIndexes),
    });
}

function packBatchItems(input: Readonly<{
    items: readonly Readonly<{
        item: ExternalSessionOperationSocketBatchItemV1;
        sourceItemIndex: number;
    }>[];
    maxBatchItems: number;
    prepareStagedItem?: (
        value: unknown,
        mode: 'validate' | 'publish',
    ) => Promise<PreparedHistoricalImportItemResult>;
    isBatchWithinSerializedByteLimit(batch: HistoricalImportBatch): boolean;
}>): Readonly<{
    batches: readonly HistoricalImportBatch[];
    individuallyOversizeItemIndexes: readonly number[];
}> {
    if (input.items.length === 0) {
        return Object.freeze({
            batches: Object.freeze([]),
            individuallyOversizeItemIndexes: Object.freeze([]),
        });
    }

    const wholeGroupItems = input.items.map((entry) => entry.item);
    const wholeGroup = Object.freeze({
        batchId: makeExternalSessionHistoricalImportBatchIdV1(
            wholeGroupItems.map((item) => item.localId),
        ),
        items: wholeGroupItems,
    });
    if (
        wholeGroup.items.length <= input.maxBatchItems
        && input.isBatchWithinSerializedByteLimit(wholeGroup)
    ) {
        return Object.freeze({
            batches: Object.freeze([wholeGroup]),
            individuallyOversizeItemIndexes: Object.freeze([]),
        });
    }

    const batches: HistoricalImportBatch[] = [];
    let currentItems: ExternalSessionOperationSocketBatchItemV1[] = [];
    const individuallyOversizeItemIndexes: number[] = [];

    for (const entry of input.items) {
        const item = entry.item;
        const candidateItems = Object.freeze([...currentItems, item]);
        const candidate = Object.freeze({
            batchId: makeExternalSessionHistoricalImportBatchIdV1(
                candidateItems.map((candidateItem) => candidateItem.localId),
            ),
            items: candidateItems,
        });
        if (
            candidate.items.length <= input.maxBatchItems
            && input.isBatchWithinSerializedByteLimit(candidate)
        ) {
            currentItems = [...currentItems, item];
            continue;
        }

        if (currentItems.length > 0) {
            batches.push(Object.freeze({
                batchId: makeExternalSessionHistoricalImportBatchIdV1(
                    currentItems.map((currentItem) => currentItem.localId),
                ),
                items: Object.freeze(currentItems),
            }));
            currentItems = [];
        }

        const singleItemBatch = Object.freeze({
            batchId: makeExternalSessionHistoricalImportBatchIdV1([item.localId]),
            items: Object.freeze([item]),
        });
        if (
            input.maxBatchItems < 1
            || !input.isBatchWithinSerializedByteLimit(singleItemBatch)
        ) {
            individuallyOversizeItemIndexes.push(entry.sourceItemIndex);
            continue;
        }
        currentItems = [item];
    }

    if (currentItems.length > 0) {
        batches.push(Object.freeze({
            batchId: makeExternalSessionHistoricalImportBatchIdV1(
                currentItems.map((currentItem) => currentItem.localId),
            ),
            items: Object.freeze(currentItems),
        }));
    }
    return Object.freeze({
        batches: Object.freeze(batches),
        individuallyOversizeItemIndexes: Object.freeze(individuallyOversizeItemIndexes),
    });
}

export function createExternalSessionHistoricalImportReplay(input: Readonly<{
    staging: ExternalSessionOperationPrivateStagingStore;
    sourceGeneration: string;
    maxBatchItems: number;
    prepareStagedItem?: (
        value: unknown,
        mode: 'validate' | 'publish',
    ) => Promise<PreparedHistoricalImportItemResult>;
    isBatchWithinSerializedByteLimit(batch: HistoricalImportBatch): boolean;
    writeHistoricalBatch(params: Readonly<{
        operationId: string;
        batchId: string;
        items: readonly ExternalSessionOperationSocketBatchItemV1[];
    }>): Promise<HistoricalImportBatchWriteResult>;
    onReplayGroupAcknowledged?(checkpoint: Readonly<{
        groupId: string;
        acknowledgedItemCount: number;
        acceptedThroughServerSeq: number;
    }>): Promise<void>;
}>): ExternalSessionHistoricalImportReplay {
    return Object.freeze({
        async resume(operationId) {
            let replay = await input.staging.readReplayState(operationId);
            if (replay.status === 'missing') {
                return Object.freeze({
                    status: 'awaiting_user_resume' as const,
                    reason: 'staging_missing' as const,
                    acceptedThroughServerSeq: null,
                });
            }
            if (replay.status === 'discard_required') {
                return Object.freeze({
                    status: 'discard_required' as const,
                    acceptedThroughServerSeq: replay.acceptedThroughServerSeq,
                });
            }

            await input.staging.resumeOperation({ operationId });
            replay = await input.staging.readReplayState(operationId);
            if (replay.status === 'missing') {
                return Object.freeze({
                    status: 'awaiting_user_resume' as const,
                    reason: 'staging_missing' as const,
                    acceptedThroughServerSeq: null,
                });
            }
            if (replay.status === 'discard_required') {
                return Object.freeze({
                    status: 'discard_required' as const,
                    acceptedThroughServerSeq: replay.acceptedThroughServerSeq,
                });
            }
            if (replay.status === 'capture_incomplete') {
                return Object.freeze({
                    status: 'awaiting_user_resume' as const,
                    reason: 'capture_incomplete' as const,
                    acceptedThroughServerSeq: replay.acceptedThroughServerSeq,
                });
            }
            if (replay.status === 'incomplete') {
                return Object.freeze({
                    status: 'awaiting_user_resume' as const,
                    reason: 'staging_incomplete' as const,
                    acceptedThroughServerSeq: replay.acceptedThroughServerSeq,
                });
            }

            let acceptedThroughServerSeq = replay.acceptedThroughServerSeq;
            let acknowledgedItemCount = replay.acknowledgedItemCount;
            if (
                acknowledgedItemCount > 0
                && acceptedThroughServerSeq !== null
            ) {
                await input.onReplayGroupAcknowledged?.({
                    groupId: 'historical-import-checkpoint',
                    acknowledgedItemCount,
                    acceptedThroughServerSeq,
                });
            }
            let recordFailures = 0;
            let mediaFailures = 0;
            let conversionFailures = 0;
            const diagnostics: ExternalSessionRequiredItemDiagnosticV1[] = [];
            for await (const group of input.staging.streamReplayGroups(operationId)) {
                const parsed = await readBatchItems(
                    group.items,
                    input.prepareStagedItem,
                    'validate',
                );
                recordFailures += parsed.recordFailureIndexes.length;
                mediaFailures += parsed.mediaFailureIndexes.length;
                conversionFailures += parsed.conversionFailureIndexes.length;
                for (const sourceItemIndex of parsed.recordFailureIndexes) {
                    if (diagnostics.length >= EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP) break;
                    diagnostics.push({
                        category: 'record',
                        sourceGeneration: input.sourceGeneration,
                        sourcePageIndex: group.captureIndex,
                        sourceItemIndex,
                    });
                }
                for (const sourceItemIndex of parsed.mediaFailureIndexes) {
                    if (diagnostics.length >= EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP) break;
                    diagnostics.push({
                        category: 'media',
                        sourceGeneration: input.sourceGeneration,
                        sourcePageIndex: group.captureIndex,
                        sourceItemIndex,
                    });
                }
                for (const sourceItemIndex of parsed.conversionFailureIndexes) {
                    if (diagnostics.length >= EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP) break;
                    diagnostics.push({
                        category: 'conversion',
                        sourceGeneration: input.sourceGeneration,
                        sourcePageIndex: group.captureIndex,
                        sourceItemIndex,
                    });
                }
                const packed = packBatchItems({
                    items: parsed.items,
                    maxBatchItems: input.maxBatchItems,
                    isBatchWithinSerializedByteLimit:
                        input.isBatchWithinSerializedByteLimit,
                });
                conversionFailures += packed.individuallyOversizeItemIndexes.length;
                for (const sourceItemIndex of packed.individuallyOversizeItemIndexes) {
                    if (diagnostics.length >= EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP) break;
                    diagnostics.push({
                        category: 'conversion',
                        sourceGeneration: input.sourceGeneration,
                        sourcePageIndex: group.captureIndex,
                        sourceItemIndex,
                    });
                }
            }
            const totalRequiredFailures = recordFailures + mediaFailures + conversionFailures;
            if (totalRequiredFailures > 0) {
                return Object.freeze({
                    status: 'awaiting_user_resume' as const,
                    reason: 'required_items_failed' as const,
                    acceptedThroughServerSeq,
                    requiredItemFailures: Object.freeze({
                        total: totalRequiredFailures,
                        record: recordFailures,
                        media: mediaFailures,
                        conversion: conversionFailures,
                        diagnosticsTruncated:
                            totalRequiredFailures > EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP,
                        diagnostics: Object.freeze(diagnostics),
                    }),
                });
            }

            for await (const group of input.staging.streamReplayGroups(operationId)) {
                const parsed = await readBatchItems(
                    group.items,
                    input.prepareStagedItem,
                    'publish',
                );
                if (
                    parsed.recordFailureIndexes.length > 0
                    || parsed.mediaFailureIndexes.length > 0
                    || parsed.conversionFailureIndexes.length > 0
                ) {
                    await Promise.all(parsed.items.map((entry) => entry.cleanup?.()));
                    return Object.freeze({
                        status: 'awaiting_user_resume' as const,
                        reason: 'required_items_failed' as const,
                        acceptedThroughServerSeq,
                        requiredItemFailures: Object.freeze({
                            total:
                                parsed.recordFailureIndexes.length
                                + parsed.mediaFailureIndexes.length
                                + parsed.conversionFailureIndexes.length,
                            record: parsed.recordFailureIndexes.length,
                            media: parsed.mediaFailureIndexes.length,
                            conversion: parsed.conversionFailureIndexes.length,
                            diagnosticsTruncated: false,
                            diagnostics: Object.freeze([]),
                        }),
                    });
                }
                const packed = packBatchItems({
                    items: parsed.items,
                    maxBatchItems: input.maxBatchItems,
                    isBatchWithinSerializedByteLimit:
                        input.isBatchWithinSerializedByteLimit,
                });
                if (packed.individuallyOversizeItemIndexes.length > 0) {
                    await Promise.all(parsed.items.map((entry) => entry.cleanup?.()));
                    const diagnostics = packed.individuallyOversizeItemIndexes
                        .slice(0, EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP)
                        .map((sourceItemIndex) => Object.freeze({
                            category: 'conversion' as const,
                            sourceGeneration: input.sourceGeneration,
                            sourcePageIndex: group.captureIndex,
                            sourceItemIndex,
                        }));
                    return Object.freeze({
                        status: 'awaiting_user_resume' as const,
                        reason: 'required_items_failed' as const,
                        acceptedThroughServerSeq,
                        requiredItemFailures: Object.freeze({
                            total: packed.individuallyOversizeItemIndexes.length,
                            record: 0,
                            media: 0,
                            conversion: packed.individuallyOversizeItemIndexes.length,
                            diagnosticsTruncated:
                                packed.individuallyOversizeItemIndexes.length
                                > EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP,
                            diagnostics: Object.freeze(diagnostics),
                        }),
                    });
                }
                if (packed.batches.length === 0) {
                    await Promise.all(parsed.items.map((entry) => entry.cleanup?.()));
                    await input.staging.acknowledgeReplayGroup({
                        operationId,
                        groupId: group.groupId,
                        acceptedThroughServerSeq: acceptedThroughServerSeq ?? 0,
                    });
                    acceptedThroughServerSeq ??= 0;
                    continue;
                }
                for (const [batchIndex, batch] of packed.batches.entries()) {
                    let acknowledged: HistoricalImportBatchWriteResult;
                    try {
                        acknowledged = await input.writeHistoricalBatch({
                            operationId,
                            batchId: batch.batchId,
                            items: batch.items,
                        });
                    } catch (error) {
                        const laterItems = new Set(
                            packed.batches
                                .slice(batchIndex + 1)
                                .flatMap((laterBatch) => laterBatch.items),
                        );
                        await Promise.all(parsed.items
                            .filter((entry) => laterItems.has(entry.item))
                            .map(async (entry) => await entry.cleanup?.()));
                        throw error;
                    }
                    if (!acknowledged.ok) {
                        const refusedAndUnsentItems = new Set(
                            packed.batches
                                .slice(batchIndex)
                                .flatMap((unacceptedBatch) => unacceptedBatch.items),
                        );
                        await Promise.all(parsed.items
                            .filter((entry) => refusedAndUnsentItems.has(entry.item))
                            .map(async (entry) => await entry.cleanup?.()));
                        return Object.freeze({
                            status: 'awaiting_user_resume' as const,
                            reason: 'historical_import_failed' as const,
                            acceptedThroughServerSeq,
                        });
                    }
                    if (acknowledged.batchId !== batch.batchId) {
                        const unsentItems = new Set(
                            packed.batches
                                .slice(batchIndex + 1)
                                .flatMap((unsentBatch) => unsentBatch.items),
                        );
                        await Promise.all(parsed.items
                            .filter((entry) => unsentItems.has(entry.item))
                            .map(async (entry) => await entry.cleanup?.()));
                        return Object.freeze({
                            status: 'awaiting_user_resume' as const,
                            reason: 'historical_import_failed' as const,
                            acceptedThroughServerSeq,
                        });
                    }
                    acceptedThroughServerSeq = acknowledged.acceptedThroughServerSeq;
                }
                await input.staging.acknowledgeReplayGroup({
                    operationId,
                    groupId: group.groupId,
                    acceptedThroughServerSeq: acceptedThroughServerSeq ?? 0,
                });
                acknowledgedItemCount += packed.batches.reduce(
                    (total, batch) => total + batch.items.length,
                    0,
                );
                await input.onReplayGroupAcknowledged?.({
                    groupId: group.groupId,
                    acknowledgedItemCount,
                    acceptedThroughServerSeq: acceptedThroughServerSeq ?? 0,
                });
            }

            // Retain the acknowledged checkpoint until the outer operation owner durably commits
            // its terminal record/authority transition and explicitly cleans up staging.
            return Object.freeze({
                status: 'completed' as const,
                acceptedThroughServerSeq,
            });
        },
    });
}
