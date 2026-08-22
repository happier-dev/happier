import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';
import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import {
    prepareExternalSessionHistoricalImportItem,
    readExternalSessionHistoricalImportStagedItem,
    stageExternalSessionHistoricalImportItem,
    validateExternalSessionHistoricalImportStagedItem,
} from '@/api/session/external/import/importExternalSessionTranscript';
import type { StoredCredentials } from '@/persistence';

import {
    EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP,
    createExternalSessionHistoricalImportReplay,
} from './historicalImportReplay';
import {
    createExternalSessionOperationPrivateStagingStore,
    type ExternalSessionOperationPrivateStagingStore,
} from './operationPrivateStaging';

type HistoricalImportBatchWriteInput = Parameters<
    Parameters<typeof createExternalSessionHistoricalImportReplay>[0]['writeHistoricalBatch']
>[0];

const temporaryDirectories: string[] = [];

async function createStore(
    existingActiveServerDir?: string,
): Promise<ExternalSessionOperationPrivateStagingStore> {
    const activeServerDir = existingActiveServerDir
        ?? await mkdtemp(join(tmpdir(), 'happier-historical-import-replay-'));
    if (!existingActiveServerDir) temporaryDirectories.push(activeServerDir);
    return createExternalSessionOperationPrivateStagingStore({
        activeServerDir,
        limits: {
            perOperation: { maxItems: 100, maxBytes: 100_000 },
            aggregate: { maxItems: 200, maxBytes: 200_000 },
        },
    });
}

async function readReplayGroups(
    staging: ExternalSessionOperationPrivateStagingStore,
    operationId: string,
) {
    const groups = [];
    for await (const group of staging.streamReplayGroups(operationId)) {
        groups.push(group);
    }
    return groups;
}

const capturedSource = Object.freeze({
    sourceIdentity: 'source-1',
    sourceGeneration: 'generation-1',
    revision: 'revision-1',
    boundary: 'boundary-1',
});

const finalSourcePage = Object.freeze({
    availability: 'reachable' as const,
    sourceIdentity: 'source-1',
    sourceGeneration: 'generation-1',
    revision: 'revision-1',
    relationshipToCapture: 'same' as const,
    eof: true,
});

const continuingSourcePage = Object.freeze({
    ...finalSourcePage,
    eof: false,
});

function item(id: string) {
    return Object.freeze({
        localId: `history:${id}`,
        sidechainId: null,
        messageRole: 'user',
        content: Object.freeze({
            t: 'plain',
            v: Object.freeze({ role: 'user', text: id }),
        }),
    });
}

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
    }));
});

describe('historical import replay', () => {
    it('admits an exact UTF-8 byte boundary and rejects max+1 as an individually oversize required item', async () => {
        const first = item('é');
        const second = item('漢');
        const serializedBytesForBatch = (input: Readonly<{
            items: readonly unknown[];
        }>) => new TextEncoder().encode(JSON.stringify(input.items)).byteLength;
        const exactFirstBytes = serializedBytesForBatch({ items: [first] });

        const exactStaging = await createStore();
        await exactStaging.beginOperation({
            operationId: 'operation-exact-boundary',
            representation: 'content',
            capturedSource,
        });
        await exactStaging.appendPageGroup({
            operationId: 'operation-exact-boundary',
            captureIndex: 0,
            groupId: 'utf8-page',
            items: [first],
            sourceRead: finalSourcePage,
        });
        await exactStaging.completeCapture({ operationId: 'operation-exact-boundary' });
        const exactWrite = vi.fn(async (batch: Readonly<{ batchId: string }>) => ({
            ok: true as const,
            batchId: batch.batchId,
            acceptedThroughServerSeq: 1,
        }));
        const exactReplay = createExternalSessionHistoricalImportReplay({
            staging: exactStaging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 1,
            isBatchWithinSerializedByteLimit: (batch) =>
                serializedBytesForBatch(batch) <= exactFirstBytes,
            writeHistoricalBatch: exactWrite,
        });
        expect(await exactReplay.resume('operation-exact-boundary')).toEqual({
            status: 'completed',
            acceptedThroughServerSeq: 1,
        });
        expect(exactWrite).toHaveBeenCalledWith({
            operationId: 'operation-exact-boundary',
            batchId:
                'historical-import-batch:v1:7d447da26eb371f7ae43db28f85a1e1bba376f21e8dea91567cb9ed8d6b81093',
            items: [first],
        });

        const oversizeStaging = await createStore();
        await oversizeStaging.beginOperation({
            operationId: 'operation-max-plus-one',
            representation: 'content',
            capturedSource,
        });
        await oversizeStaging.appendPageGroup({
            operationId: 'operation-max-plus-one',
            captureIndex: 0,
            groupId: 'utf8-page',
            items: [first, second],
            sourceRead: finalSourcePage,
        });
        await oversizeStaging.completeCapture({ operationId: 'operation-max-plus-one' });
        const oversizeWrite = vi.fn();
        const oversizeReplay = createExternalSessionHistoricalImportReplay({
            staging: oversizeStaging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 2,
            isBatchWithinSerializedByteLimit: (batch) =>
                serializedBytesForBatch(batch) <= exactFirstBytes,
            writeHistoricalBatch: oversizeWrite,
        });
        expect(await oversizeReplay.resume('operation-max-plus-one')).toEqual({
            status: 'awaiting_user_resume',
            reason: 'required_items_failed',
            acceptedThroughServerSeq: null,
            requiredItemFailures: {
                total: 1,
                record: 0,
                media: 0,
                conversion: 1,
                diagnosticsTruncated: false,
                diagnostics: [{
                    category: 'conversion',
                    sourceGeneration: 'source-generation-1',
                    sourcePageIndex: 0,
                    sourceItemIndex: 1,
                }],
            },
        });
        expect(oversizeWrite).not.toHaveBeenCalled();
    });

    it('does not publish smaller siblings when the publish transform makes one required item oversize', async () => {
        const staging = await createStore();
        await staging.beginOperation({
            operationId: 'operation-publish-transform-oversize',
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId: 'operation-publish-transform-oversize',
            captureIndex: 0,
            groupId: 'publish-transform-page',
            items: [item('small'), item('grows-during-publish')],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({
            operationId: 'operation-publish-transform-oversize',
        });

        const cleanups = new Map([
            ['history:small', vi.fn(async () => undefined)],
            ['history:grows-during-publish', vi.fn(async () => undefined)],
        ]);
        const writeHistoricalBatch = vi.fn(async (batch: Readonly<{ batchId: string }>) => ({
            ok: true as const,
            batchId: batch.batchId,
            acceptedThroughServerSeq: 1,
        }));
        const replay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 2,
            createPreparationPhase: async (mode) => ({
                prepareStagedItem: async (value) => {
                    const original = value as ReturnType<typeof item>;
                    const prepared = mode === 'validate'
                        ? original
                        : original.localId === 'history:grows-during-publish'
                            ? {
                                ...original,
                                content: {
                                    t: 'plain' as const,
                                    v: { role: 'user', text: 'é'.repeat(2_000) },
                                },
                            }
                            : original;
                    return {
                        ok: true as const,
                        item: prepared,
                        ...(mode === 'publish'
                            ? { cleanup: cleanups.get(original.localId)! }
                            : {}),
                    };
                },
            }),
            isBatchWithinSerializedByteLimit: ({ items }) =>
                new TextEncoder().encode(JSON.stringify(items)).byteLength <= 500,
            writeHistoricalBatch,
        });

        await expect(replay.resume('operation-publish-transform-oversize')).resolves.toEqual({
            status: 'awaiting_user_resume',
            reason: 'required_items_failed',
            acceptedThroughServerSeq: null,
            requiredItemFailures: {
                total: 1,
                record: 0,
                media: 0,
                conversion: 1,
                diagnosticsTruncated: false,
                diagnostics: [{
                    category: 'conversion',
                    sourceGeneration: 'source-generation-1',
                    sourcePageIndex: 0,
                    sourceItemIndex: 1,
                }],
            },
        });
        expect(writeHistoricalBatch).not.toHaveBeenCalled();
        expect(cleanups.get('history:small')).toHaveBeenCalledOnce();
        expect(cleanups.get('history:grows-during-publish')).toHaveBeenCalledOnce();
    });

    it('cleans prepared siblings when another required item fails during publish preparation', async () => {
        const staging = await createStore();
        await staging.beginOperation({
            operationId: 'operation-publish-preparation-failure',
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId: 'operation-publish-preparation-failure',
            captureIndex: 0,
            groupId: 'publish-preparation-page',
            items: [item('prepared'), item('media-fails')],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({
            operationId: 'operation-publish-preparation-failure',
        });

        const cleanupPrepared = vi.fn(async () => undefined);
        const writeHistoricalBatch = vi.fn();
        const replay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 2,
            createPreparationPhase: async (mode) => ({
                prepareStagedItem: async (value) => {
                    const original = value as ReturnType<typeof item>;
                    if (
                        mode === 'publish'
                        && original.localId === 'history:media-fails'
                    ) {
                        return { ok: false as const, category: 'media' as const };
                    }
                    return {
                        ok: true as const,
                        item: original,
                        ...(mode === 'publish' && original.localId === 'history:prepared'
                            ? { cleanup: cleanupPrepared }
                            : {}),
                    };
                },
            }),
            isBatchWithinSerializedByteLimit: () => true,
            writeHistoricalBatch,
        });

        await expect(replay.resume('operation-publish-preparation-failure')).resolves.toMatchObject({
            status: 'awaiting_user_resume',
            reason: 'required_items_failed',
            acceptedThroughServerSeq: null,
            requiredItemFailures: {
                total: 1,
                record: 0,
                media: 1,
                conversion: 0,
            },
        });
        expect(writeHistoricalBatch).not.toHaveBeenCalled();
        expect(cleanupPrepared).toHaveBeenCalledOnce();
    });

    it('counts every malformed/non-UTF8 required row beyond the diagnostic cap and sends no partial batch', async () => {
        const staging = await createStore();
        await staging.beginOperation({
            operationId: 'operation-required-failures',
            representation: 'content',
            capturedSource,
        });
        const malformed = Array.from(
            { length: EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP + 3 },
            (_, index) => ({
                localId: `malformed:${index}`,
                sidechainId: null,
                messageRole: 'user',
                content: index === 0
                    ? { t: 'plain', v: { text: '\uD800' } }
                    : { t: 'invalid', raw: 'must-not-leave-private-staging' },
            }),
        );
        await staging.appendPageGroup({
            operationId: 'operation-required-failures',
            captureIndex: 0,
            groupId: 'malformed-page',
            items: malformed,
            sourceRead: continuingSourcePage,
        });
        await staging.appendPageGroup({
            operationId: 'operation-required-failures',
            captureIndex: 1,
            groupId: 'oversize-page',
            items: [{
                ...item('oversize'),
                content: {
                    t: 'plain',
                    v: { role: 'user', text: 'x'.repeat(10_000) },
                },
            }],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({ operationId: 'operation-required-failures' });

        const writeHistoricalBatch = vi.fn();
        const replay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 200,
            isBatchWithinSerializedByteLimit: ({ items }) => (
                new TextEncoder().encode(JSON.stringify(items)).byteLength
            ) <= 1_000,
            writeHistoricalBatch,
        });

        const replayResult = await replay.resume('operation-required-failures');
        expect(replayResult).toMatchObject({
            status: 'awaiting_user_resume',
            reason: 'required_items_failed',
            acceptedThroughServerSeq: null,
            requiredItemFailures: {
                total: EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP + 4,
                record: EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP + 3,
                media: 0,
                conversion: 1,
                diagnosticsTruncated: true,
            },
        });
        if (
            replayResult.status !== 'awaiting_user_resume'
            || replayResult.reason !== 'required_items_failed'
            || !replayResult.requiredItemFailures
        ) {
            throw new Error('Expected bounded required-item diagnostics.');
        }
        expect(replayResult.requiredItemFailures.diagnostics).toHaveLength(
            EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP,
        );
        expect(replayResult.requiredItemFailures.diagnostics?.[0]).toEqual({
            category: 'conversion',
            sourceGeneration: 'source-generation-1',
            sourcePageIndex: 1,
            sourceItemIndex: 0,
        });
        expect(replayResult.requiredItemFailures.diagnostics?.at(-1)).toEqual({
            category: 'record',
            sourceGeneration: 'source-generation-1',
            sourcePageIndex: 0,
            sourceItemIndex: EXTERNAL_SESSION_HISTORICAL_IMPORT_DIAGNOSTIC_CAP - 2,
        });
        expect(writeHistoricalBatch).not.toHaveBeenCalled();
        expect(JSON.stringify(replayResult)).not.toContain('must-not-leave-private-staging');
    });

    it('stays passive after restart and retains the completed checkpoint until terminal-owner cleanup', async () => {
        const staging = await createStore();
        await staging.beginOperation({
            operationId: 'operation-1',
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId: 'operation-1',
            captureIndex: 0,
            groupId: 'newest-page',
            items: [item('new-1'), item('new-2')],
            sourceRead: continuingSourcePage,
        });
        await staging.appendPageGroup({
            operationId: 'operation-1',
            captureIndex: 1,
            groupId: 'oldest-page',
            items: [item('old-1'), item('old-2')],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({ operationId: 'operation-1' });

        const accepted: string[] = [];
        let refuseNewestOnce = true;
        const writeHistoricalBatch = vi.fn(async (input: Readonly<{
            operationId: string;
            batchId: string;
            items: readonly unknown[];
        }>) => {
            accepted.push(...input.items.map((entry) => (entry as { localId: string }).localId));
            const firstLocalId = (input.items[0] as { localId: string }).localId;
            if (firstLocalId === 'history:new-1' && refuseNewestOnce) {
                refuseNewestOnce = false;
                return { ok: false as const, error: 'server_unavailable' };
            }
            return {
                ok: true as const,
                batchId: input.batchId,
                acceptedThroughServerSeq: firstLocalId === 'history:old-1' ? 12 : 14,
            };
        });

        const firstProcess = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 200,
            isBatchWithinSerializedByteLimit: ({ items }) => (
                new TextEncoder().encode(JSON.stringify(items)).byteLength
            ) <= 50_000,
            writeHistoricalBatch,
        });
        expect(await firstProcess.resume('operation-1')).toEqual({
            status: 'awaiting_user_resume',
            reason: 'historical_import_failed',
            acceptedThroughServerSeq: 12,
        });

        const callsBeforeExplicitResume = writeHistoricalBatch.mock.calls.length;
        const restartedProcess = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 200,
            isBatchWithinSerializedByteLimit: ({ items }) => (
                new TextEncoder().encode(JSON.stringify(items)).byteLength
            ) <= 50_000,
            writeHistoricalBatch,
        });
        await Promise.resolve();
        expect(writeHistoricalBatch).toHaveBeenCalledTimes(callsBeforeExplicitResume);

        expect(await restartedProcess.resume('operation-1')).toEqual({
            status: 'completed',
            acceptedThroughServerSeq: 14,
        });
        expect(accepted).toEqual([
            'history:old-1',
            'history:old-2',
            'history:new-1',
            'history:new-2',
            'history:new-1',
            'history:new-2',
        ]);
        expect(await staging.readReplayState('operation-1')).toEqual({
            status: 'ready',
            lifecycle: 'active',
            acceptedThroughServerSeq: 14,
            acknowledgedItemCount: 4,
        });

        const afterOuterCommitRestart = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 200,
            isBatchWithinSerializedByteLimit: ({ items }) => (
                new TextEncoder().encode(JSON.stringify(items)).byteLength
            ) <= 50_000,
            writeHistoricalBatch,
        });
        expect(await afterOuterCommitRestart.resume('operation-1')).toEqual({
            status: 'completed',
            acceptedThroughServerSeq: 14,
        });
        expect(writeHistoricalBatch).toHaveBeenCalledTimes(callsBeforeExplicitResume + 1);

        expect(await staging.cleanupTerminalOperation({ operationId: 'operation-1' }))
            .toEqual({ status: 'completed' });
        expect(await staging.readReplayState('operation-1')).toEqual({ status: 'missing' });
    });

    it('recovers the acknowledged item count before replaying the next group after a checkpoint crash', async () => {
        const staging = await createStore();
        await staging.beginOperation({
            operationId: 'operation-checkpoint-crash',
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId: 'operation-checkpoint-crash',
            captureIndex: 0,
            groupId: 'newest-page',
            items: [item('new-1'), item('new-2')],
            sourceRead: continuingSourcePage,
        });
        await staging.appendPageGroup({
            operationId: 'operation-checkpoint-crash',
            captureIndex: 1,
            groupId: 'oldest-page',
            items: [item('old-1'), item('old-2')],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({ operationId: 'operation-checkpoint-crash' });

        let serverAcceptedCount = 0;
        const writeHistoricalBatch = vi.fn(async (batch: Readonly<{
            batchId: string;
            items: readonly unknown[];
        }>) => {
            serverAcceptedCount += batch.items.length;
            return {
                ok: true as const,
                batchId: batch.batchId,
                acceptedThroughServerSeq: serverAcceptedCount,
            };
        });
        const crashingReplay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 200,
            isBatchWithinSerializedByteLimit: () => true,
            writeHistoricalBatch,
            onReplayGroupAcknowledged: async () => {
                throw new Error('operation record checkpoint write failed');
            },
        });

        await expect(crashingReplay.resume('operation-checkpoint-crash'))
            .rejects.toThrow('operation record checkpoint write failed');
        expect(writeHistoricalBatch).toHaveBeenCalledOnce();

        const restartEvents: string[] = [];
        const restartedReplay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 200,
            isBatchWithinSerializedByteLimit: () => true,
            writeHistoricalBatch: async (batch) => {
                restartEvents.push(`batch:${batch.batchId}`);
                return await writeHistoricalBatch(batch);
            },
            onReplayGroupAcknowledged: async (checkpoint) => {
                restartEvents.push(
                    `checkpoint:${checkpoint.groupId}:${checkpoint.acknowledgedItemCount}:${checkpoint.acceptedThroughServerSeq}`,
                );
            },
        });

        await expect(restartedReplay.resume('operation-checkpoint-crash')).resolves.toEqual({
            status: 'completed',
            acceptedThroughServerSeq: 4,
        });
        expect(restartEvents).toEqual([
            'checkpoint:historical-import-checkpoint:2:2',
            'batch:historical-import-batch:v1:ee34cf6ad32e851e7cc73b6b3d999c48b8b7915d145df4b958f03f8ba6bc3c53',
            'checkpoint:newest-page:4:4',
        ]);
    });

    it('replays every content-addressed split batch after a group-checkpoint crash', async () => {
        const staging = await createStore();
        const sharedMedia = [{
            workingDirectory: '/workspace',
            candidateWorkspaceRelativePath: '.happier/uploads/generated/session/message/shared.png',
        }] as const;
        await staging.beginOperation({
            operationId: 'operation-ack-crash-predecessor',
            representation: 'content',
            capturedSource,
        });
        await staging.recordCreatedWorkspaceMedia({
            operationId: 'operation-ack-crash-predecessor',
            media: sharedMedia,
        });
        await staging.pauseOperation({
            operationId: 'operation-ack-crash-predecessor',
            expiresAtMs: 1,
        });
        await staging.markExpiredPausedWorkDiscardRequired({
            operationId: 'operation-ack-crash-predecessor',
            nowMs: 1,
        });
        await staging.beginOperation({
            operationId: 'operation-ack-crash',
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId: 'operation-ack-crash',
            captureIndex: 0,
            groupId: 'only-page',
            items: [item('only-a'), item('only-b')],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({ operationId: 'operation-ack-crash' });

        const durableStaging = staging as ExternalSessionOperationPrivateStagingStore;
        let crashOnce = true;
        const crashingStaging: ExternalSessionOperationPrivateStagingStore = Object.freeze({
            ...durableStaging,
            async acknowledgeReplayGroup(input) {
                if (crashOnce) {
                    crashOnce = false;
                    throw new Error('simulated crash after server acknowledgment');
                }
                return await durableStaging.acknowledgeReplayGroup(input);
            },
        });
        const acceptedBatchIds = new Set<string>();
        const observedBatchIds: string[] = [];
        let acceptedThroughServerSeq = 0;
        const writeHistoricalBatch = vi.fn(async (input: Readonly<{
            batchId: string;
            items: readonly unknown[];
        }>) => {
            observedBatchIds.push(input.batchId);
            if (!acceptedBatchIds.has(input.batchId)) {
                acceptedBatchIds.add(input.batchId);
                acceptedThroughServerSeq += input.items.length;
            }
            return {
                ok: true as const,
                batchId: input.batchId,
                acceptedThroughServerSeq,
            };
        });

        const crashingProcess = createExternalSessionHistoricalImportReplay({
            staging: crashingStaging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 1,
            createPreparationPhase: async () => ({
                prepareStagedItem: async (value) => ({
                    ok: true as const,
                    item: value as ReturnType<typeof item>,
                    workspaceMedia: sharedMedia,
                }),
            }),
            isBatchWithinSerializedByteLimit: ({ items }) => (
                new TextEncoder().encode(JSON.stringify(items)).byteLength
            ) <= 50_000,
            writeHistoricalBatch,
        });
        await expect(crashingProcess.resume('operation-ack-crash'))
            .rejects.toThrow('simulated crash after server acknowledgment');
        await expect(staging.readCreatedWorkspaceMediaForCleanup({
            operationId: 'operation-ack-crash-predecessor',
        })).resolves.toEqual([]);
        await expect(staging.readCreatedWorkspaceMediaForCleanup({
            operationId: 'operation-ack-crash',
        })).resolves.toEqual(sharedMedia);

        const restartedProcess = createExternalSessionHistoricalImportReplay({
            staging: durableStaging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 1,
            createPreparationPhase: async () => ({
                prepareStagedItem: async (value) => ({
                    ok: true as const,
                    item: value as ReturnType<typeof item>,
                    workspaceMedia: sharedMedia,
                }),
            }),
            isBatchWithinSerializedByteLimit: ({ items }) => (
                new TextEncoder().encode(JSON.stringify(items)).byteLength
            ) <= 50_000,
            writeHistoricalBatch,
        });
        expect(await restartedProcess.resume('operation-ack-crash')).toEqual({
            status: 'completed',
            acceptedThroughServerSeq: 2,
        });
        expect(observedBatchIds).toHaveLength(4);
        expect(observedBatchIds[0]).not.toBe(observedBatchIds[1]);
        expect(observedBatchIds.slice(2)).toEqual(observedBatchIds.slice(0, 2));
        expect(await staging.readReplayState('operation-ack-crash')).toEqual({
            status: 'ready',
            lifecycle: 'active',
            acceptedThroughServerSeq: 2,
            acknowledgedItemCount: 2,
        });
    });

    it.each(['legacy', 'dataKey'] as const)(
        'replays byte-identical E2EE content after a lost server acknowledgment (%s)',
        async (encryptionVariant) => {
            const activeServerDir = await mkdtemp(
                join(tmpdir(), 'happier-historical-import-replay-e2ee-'),
            );
            temporaryDirectories.push(activeServerDir);
            const staging = await createStore(activeServerDir);
            const operationId = `operation-e2ee-ack-crash-${encryptionVariant}`;
            const sessionId = `session-e2ee-ack-crash-${encryptionVariant}`;
            const rawItem: ExternalSessionTranscriptRawMessageV1 = {
                id: `provider-item-${encryptionVariant}`,
                localId: `provider-item-${encryptionVariant}`,
                createdAtMs: 123,
                messageRole: 'agent',
                raw: { role: 'agent', content: { type: 'output', data: 'accepted once' } },
            };
            const stagedItem = await stageExternalSessionHistoricalImportItem({
                item: rawItem,
                workingDirectory: null,
                sourceReadRoots: [],
            });
            await staging.beginOperation({
                operationId,
                representation: 'content',
                capturedSource,
            });
            await staging.appendPageGroup({
                operationId,
                captureIndex: 0,
                groupId: 'only-page',
                items: [stagedItem],
                sourceRead: finalSourcePage,
            });
            await staging.completeCapture({ operationId });

            const key = new Uint8Array(32).fill(encryptionVariant === 'legacy' ? 7 : 11);
            const credentials: StoredCredentials = encryptionVariant === 'legacy'
                ? { token: 'token', encryption: { type: 'legacy', secret: key } }
                : {
                    token: 'token',
                    encryption: { type: 'dataKey', publicKey: key, machineKey: key },
                };
            const linked: LoadedLinkedExternalSession = {
                rawSession: {
                    id: sessionId,
                    encryptionMode: 'e2ee',
                    dataEncryptionKey: null,
                } as LoadedLinkedExternalSession['rawSession'],
                metadata: {},
                sessionPath: null,
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: `remote-${encryptionVariant}`,
                linkGeneration: 'generation-1',
                source: {
                    kind: 'opencodeServer',
                    baseUrl: 'http://127.0.0.1:4096',
                    directory: '/workspace',
                },
                codexBackendMode: null,
            };
            const phaseModes: Array<'validate' | 'publish'> = [];
            const publishPreparations = vi.fn();
            const batchEffectRevalidations = vi.fn();
            const createPreparationPhase = async (mode: 'validate' | 'publish') => {
                phaseModes.push(mode);
                return {
                    prepareStagedItem: async (value: unknown) => {
                        const staged = readExternalSessionHistoricalImportStagedItem(value);
                        if (!staged) return { ok: false as const, category: 'record' as const };
                        if (mode === 'validate') {
                            return {
                                ok: true as const,
                                item: validateExternalSessionHistoricalImportStagedItem({
                                    staged,
                                    linked,
                                    credentials,
                                    sessionId,
                                }),
                            };
                        }
                        publishPreparations();
                        return {
                            ok: true as const,
                            item: await prepareExternalSessionHistoricalImportItem({
                                item: staged.item,
                                linked,
                                credentials,
                                sessionId,
                                workingDirectory: null,
                                sourceReadRoots: [],
                            }),
                        };
                    },
                    ...(mode === 'publish'
                        ? { revalidateBeforeBatchEffect: async () => { batchEffectRevalidations(); } }
                        : {}),
                };
            };

            let acceptedItem: HistoricalImportBatchWriteInput['items'][number] | undefined;
            let persistedStableItemCount = 0;
            const writeHistoricalBatch = vi.fn(async (input: HistoricalImportBatchWriteInput) => {
                const candidate = input.items[0]!;
                if (acceptedItem && !isDeepStrictEqual(acceptedItem, candidate)) {
                    return { ok: false as const, error: 'batch_conflict' };
                }
                if (!acceptedItem) {
                    acceptedItem = candidate;
                    persistedStableItemCount += 1;
                }
                return {
                    ok: true as const,
                    batchId: input.batchId,
                    acceptedThroughServerSeq: 1,
                };
            });
            const durableStaging = staging as ExternalSessionOperationPrivateStagingStore;
            let crashOnce = true;
            const crashingStaging: ExternalSessionOperationPrivateStagingStore = Object.freeze({
                ...durableStaging,
                async acknowledgeReplayGroup(input) {
                    if (crashOnce) {
                        crashOnce = false;
                        throw new Error('simulated lost server acknowledgment');
                    }
                    return await durableStaging.acknowledgeReplayGroup(input);
                },
            });
            const createReplay = (replayStaging: ExternalSessionOperationPrivateStagingStore) =>
                createExternalSessionHistoricalImportReplay({
                    staging: replayStaging,
                    sourceGeneration: 'source-generation-1',
                    maxBatchItems: 1,
                    createPreparationPhase,
                    isBatchWithinSerializedByteLimit: ({ items }) => (
                        new TextEncoder().encode(JSON.stringify(items)).byteLength
                    ) <= 50_000,
                    writeHistoricalBatch,
                });

            await expect(createReplay(crashingStaging).resume(operationId))
                .rejects.toThrow('simulated lost server acknowledgment');
            const restartedStaging = await createStore(activeServerDir);
            await expect(createReplay(restartedStaging).resume(operationId)).resolves.toEqual({
                status: 'completed',
                acceptedThroughServerSeq: 1,
            });
            expect(writeHistoricalBatch).toHaveBeenCalledTimes(2);
            expect(writeHistoricalBatch.mock.calls[1]![0].items)
                .toEqual(writeHistoricalBatch.mock.calls[0]![0].items);
            expect(persistedStableItemCount).toBe(1);
            expect(phaseModes).toEqual(['validate', 'publish', 'validate', 'publish']);
            expect(publishPreparations).toHaveBeenCalledTimes(2);
            expect(batchEffectRevalidations).toHaveBeenCalledTimes(2);
        },
    );

    it('cleans media prepared for the refused and later unsent batches without touching accepted media', async () => {
        const staging = await createStore();
        await staging.beginOperation({
            operationId: 'operation-refused-media-cleanup',
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId: 'operation-refused-media-cleanup',
            captureIndex: 0,
            groupId: 'only-page',
            items: [item('accepted'), item('refused'), item('unsent')],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({ operationId: 'operation-refused-media-cleanup' });

        const cleanups = new Map([
            ['history:accepted', vi.fn(async () => undefined)],
            ['history:refused', vi.fn(async () => undefined)],
            ['history:unsent', vi.fn(async () => undefined)],
        ]);
        let batchIndex = 0;
        const replay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 1,
            isBatchWithinSerializedByteLimit: () => true,
            createPreparationPhase: async (mode) => ({
                prepareStagedItem: async (value) => ({
                    ok: true as const,
                    item: value as ReturnType<typeof item>,
                    ...(mode === 'publish'
                        ? { cleanup: cleanups.get((value as ReturnType<typeof item>).localId)! }
                        : {}),
                }),
            }),
            writeHistoricalBatch: async (batch) => {
                batchIndex += 1;
                return batchIndex === 1
                    ? {
                        ok: true as const,
                        batchId: batch.batchId,
                        acceptedThroughServerSeq: 1,
                    }
                    : { ok: false as const, error: 'server_unavailable' };
            },
        });

        await expect(replay.resume('operation-refused-media-cleanup')).resolves.toEqual({
            status: 'awaiting_user_resume',
            reason: 'historical_import_failed',
            acceptedThroughServerSeq: 1,
        });
        expect(cleanups.get('history:accepted')).not.toHaveBeenCalled();
        expect(cleanups.get('history:refused')).toHaveBeenCalledOnce();
        expect(cleanups.get('history:unsent')).toHaveBeenCalledOnce();
    });

    it('discards an E2EE prepared receipt after a definitive first-batch rejection', async () => {
        const staging = await createStore();
        const operationId = 'operation-e2ee-definitive-rejection';
        await staging.beginOperation({
            operationId,
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId: 'only-page',
            items: [item('definitive-rejection')],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({ operationId });

        let publishAttempt = 0;
        const publishedCiphertexts: string[] = [];
        let writeAttempt = 0;
        const replay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 1,
            createPreparationPhase: async (mode) => ({
                prepareStagedItem: async (value) => {
                    const original = value as ReturnType<typeof item>;
                    return {
                        ok: true as const,
                        item: {
                            ...original,
                            content: {
                                t: 'encrypted' as const,
                                c: mode === 'publish'
                                    ? `publish-ciphertext-${++publishAttempt}`
                                    : 'validation-ciphertext',
                            },
                        },
                    };
                },
            }),
            isBatchWithinSerializedByteLimit: () => true,
            writeHistoricalBatch: async (batch) => {
                publishedCiphertexts.push(
                    (batch.items[0]!.content as { c: string }).c,
                );
                writeAttempt += 1;
                return writeAttempt === 1
                    ? { ok: false as const, error: 'server_rejected' }
                    : {
                        ok: true as const,
                        batchId: batch.batchId,
                        acceptedThroughServerSeq: 1,
                    };
            },
        });

        await expect(replay.resume(operationId)).resolves.toMatchObject({
            status: 'awaiting_user_resume',
            reason: 'historical_import_failed',
        });
        await expect(replay.resume(operationId)).resolves.toEqual({
            status: 'completed',
            acceptedThroughServerSeq: 1,
        });
        expect(publishedCiphertexts).toEqual([
            'publish-ciphertext-1',
            'publish-ciphertext-2',
        ]);
    });

    it('revalidates after retaining an E2EE receipt and immediately before its first socket effect', async () => {
        const durableStaging = await createStore();
        const operationId = 'operation-e2ee-revalidate-after-receipt';
        await durableStaging.beginOperation({
            operationId,
            representation: 'content',
            capturedSource,
        });
        await durableStaging.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId: 'only-page',
            items: [item('revalidate-after-receipt')],
            sourceRead: finalSourcePage,
        });
        await durableStaging.completeCapture({ operationId });

        let currentAuthority = 'authority-1';
        const authorityChangingStaging: ExternalSessionOperationPrivateStagingStore = Object.freeze({
            ...durableStaging,
            async persistPreparedReplayGroup(input) {
                const persisted = await durableStaging.persistPreparedReplayGroup(input);
                currentAuthority = 'authority-2';
                return persisted;
            },
        });
        const writeHistoricalBatch = vi.fn(async (batch: Readonly<{ batchId: string }>) => ({
            ok: true as const,
            batchId: batch.batchId,
            acceptedThroughServerSeq: 1,
        }));
        const replay = createExternalSessionHistoricalImportReplay({
            staging: authorityChangingStaging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 1,
            createPreparationPhase: async (mode) => ({
                prepareStagedItem: async (value) => ({
                    ok: true as const,
                    item: {
                        ...(value as ReturnType<typeof item>),
                        content: { t: 'encrypted' as const, c: 'prepared-ciphertext' },
                    },
                }),
                ...(mode === 'publish'
                    ? {
                        revalidateBeforeBatchEffect: async () => {
                            if (currentAuthority !== 'authority-1') {
                                throw new Error('source_changed');
                            }
                        },
                    }
                    : {}),
            }),
            isBatchWithinSerializedByteLimit: () => true,
            writeHistoricalBatch,
        });

        await expect(replay.resume(operationId)).rejects.toThrow('source_changed');
        expect(writeHistoricalBatch).not.toHaveBeenCalled();
        const replayGroups = await readReplayGroups(durableStaging, operationId);
        expect(replayGroups).toEqual([
            expect.objectContaining({ groupId: 'only-page' }),
        ]);
        expect(replayGroups[0]!.preparedItems).toBeUndefined();
    });

    it('revalidates before transferring discarded workspace-media custody after retaining an E2EE receipt', async () => {
        const durableStaging = await createStore();
        const predecessorOperationId = 'operation-e2ee-media-custody-predecessor';
        const operationId = 'operation-e2ee-media-custody-successor';
        const sharedMedia = [{
            workingDirectory: '/workspace',
            candidateWorkspaceRelativePath: '.happier/uploads/generated/session/message/fenced.png',
        }] as const;
        await durableStaging.beginOperation({
            operationId: predecessorOperationId,
            representation: 'content',
            capturedSource,
        });
        await durableStaging.recordCreatedWorkspaceMedia({
            operationId: predecessorOperationId,
            media: sharedMedia,
        });
        await durableStaging.pauseOperation({
            operationId: predecessorOperationId,
            expiresAtMs: 1,
        });
        await durableStaging.markExpiredPausedWorkDiscardRequired({
            operationId: predecessorOperationId,
            nowMs: 1,
        });
        await durableStaging.beginOperation({
            operationId,
            representation: 'content',
            capturedSource,
        });
        await durableStaging.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId: 'only-page',
            items: [item('revalidate-before-media-custody')],
            sourceRead: finalSourcePage,
        });
        await durableStaging.completeCapture({ operationId });

        let currentAuthority = 'authority-1';
        const transferDiscardedWorkspaceMediaOwnership = vi.fn(async (
            input: Parameters<
                ExternalSessionOperationPrivateStagingStore['transferDiscardedWorkspaceMediaOwnership']
            >[0],
        ) => await durableStaging.transferDiscardedWorkspaceMediaOwnership(input));
        const authorityChangingStaging: ExternalSessionOperationPrivateStagingStore = Object.freeze({
            ...durableStaging,
            async persistPreparedReplayGroup(input) {
                const persisted = await durableStaging.persistPreparedReplayGroup(input);
                currentAuthority = 'authority-2';
                return persisted;
            },
            transferDiscardedWorkspaceMediaOwnership,
        });
        const writeHistoricalBatch = vi.fn(async (batch: Readonly<{ batchId: string }>) => ({
            ok: true as const,
            batchId: batch.batchId,
            acceptedThroughServerSeq: 1,
        }));
        const replay = createExternalSessionHistoricalImportReplay({
            staging: authorityChangingStaging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 1,
            createPreparationPhase: async (mode) => ({
                prepareStagedItem: async (value) => ({
                    ok: true as const,
                    item: {
                        ...(value as ReturnType<typeof item>),
                        content: { t: 'encrypted' as const, c: 'prepared-ciphertext' },
                    },
                    workspaceMedia: sharedMedia,
                }),
                ...(mode === 'publish'
                    ? {
                        revalidateBeforeBatchEffect: async () => {
                            if (currentAuthority !== 'authority-1') {
                                throw new Error('source_changed');
                            }
                        },
                    }
                    : {}),
            }),
            isBatchWithinSerializedByteLimit: () => true,
            writeHistoricalBatch,
        });

        await expect(replay.resume(operationId)).rejects.toThrow('source_changed');
        expect(transferDiscardedWorkspaceMediaOwnership).not.toHaveBeenCalled();
        expect(writeHistoricalBatch).not.toHaveBeenCalled();
        await expect(durableStaging.readCreatedWorkspaceMediaForCleanup({
            operationId: predecessorOperationId,
        })).resolves.toEqual(sharedMedia);
        await expect(durableStaging.readCreatedWorkspaceMediaForCleanup({
            operationId,
        })).resolves.toEqual([]);
        const replayGroups = await readReplayGroups(durableStaging, operationId);
        expect(replayGroups[0]!.preparedItems).toBeUndefined();
    });

    it('creates fresh validation and publication snapshots for every replay attempt', async () => {
        const staging = await createStore();
        await staging.beginOperation({
            operationId: 'operation-fresh-phase-snapshots',
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId: 'operation-fresh-phase-snapshots',
            captureIndex: 0,
            groupId: 'only-page',
            items: [item('snapshot')],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({ operationId: 'operation-fresh-phase-snapshots' });

        let authorityVersion = 1;
        const phaseSnapshots: Array<Readonly<{
            mode: 'validate' | 'publish';
            authorityVersion: number;
        }>> = [];
        const publishedTexts: string[] = [];
        let writeAttempt = 0;
        const replay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 1,
            createPreparationPhase: async (mode) => {
                const phaseAuthorityVersion = authorityVersion;
                phaseSnapshots.push({ mode, authorityVersion: phaseAuthorityVersion });
                return {
                    prepareStagedItem: async (value) => ({
                        ok: true as const,
                        item: {
                            ...(value as ReturnType<typeof item>),
                            content: {
                                t: 'plain' as const,
                                v: { text: `authority-${phaseAuthorityVersion}` },
                            },
                        },
                    }),
                    ...(mode === 'publish'
                        ? { revalidateBeforeBatchEffect: async () => undefined }
                        : {}),
                };
            },
            isBatchWithinSerializedByteLimit: () => true,
            writeHistoricalBatch: async (batch) => {
                writeAttempt += 1;
                publishedTexts.push(
                    String((batch.items[0]!.content as { v: { text: string } }).v.text),
                );
                return writeAttempt === 1
                    ? { ok: false as const, error: 'server_unavailable' }
                    : {
                        ok: true as const,
                        batchId: batch.batchId,
                        acceptedThroughServerSeq: 1,
                    };
            },
        });

        await expect(replay.resume('operation-fresh-phase-snapshots')).resolves.toMatchObject({
            status: 'awaiting_user_resume',
            reason: 'historical_import_failed',
        });
        authorityVersion = 2;
        await expect(replay.resume('operation-fresh-phase-snapshots')).resolves.toEqual({
            status: 'completed',
            acceptedThroughServerSeq: 1,
        });
        expect(phaseSnapshots).toEqual([
            { mode: 'validate', authorityVersion: 1 },
            { mode: 'publish', authorityVersion: 1 },
            { mode: 'validate', authorityVersion: 2 },
            { mode: 'publish', authorityVersion: 2 },
        ]);
        expect(publishedTexts).toEqual(['authority-1', 'authority-2']);
    });

    it('revalidates a publication phase after item preparation and before the first batch effect', async () => {
        const staging = await createStore();
        await staging.beginOperation({
            operationId: 'operation-publication-currentness',
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId: 'operation-publication-currentness',
            captureIndex: 0,
            groupId: 'only-page',
            items: [item('link-change')],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({ operationId: 'operation-publication-currentness' });

        let currentLink = 'link-1';
        const cleanupPrepared = vi.fn(async () => undefined);
        const writeHistoricalBatch = vi.fn(async (batch: Readonly<{ batchId: string }>) => ({
            ok: true as const,
            batchId: batch.batchId,
            acceptedThroughServerSeq: 1,
        }));
        const replay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 1,
            createPreparationPhase: async (mode) => {
                const phaseLink = currentLink;
                return {
                    prepareStagedItem: async (value) => {
                        if (mode === 'publish') currentLink = 'link-2';
                        return {
                            ok: true as const,
                            item: value as ReturnType<typeof item>,
                            ...(mode === 'publish' ? { cleanup: cleanupPrepared } : {}),
                        };
                    },
                    ...(mode === 'publish'
                        ? {
                            revalidateBeforeBatchEffect: async () => {
                                if (currentLink !== phaseLink) {
                                    throw new Error('source_changed');
                                }
                            },
                        }
                        : {}),
                };
            },
            isBatchWithinSerializedByteLimit: () => true,
            writeHistoricalBatch,
        });

        await expect(replay.resume('operation-publication-currentness'))
            .rejects.toThrow('source_changed');
        expect(writeHistoricalBatch).not.toHaveBeenCalled();
        expect(cleanupPrepared).toHaveBeenCalledOnce();
    });

    it('revalidates again before a later split-batch effect and preserves accepted cleanup custody', async () => {
        const staging = await createStore();
        await staging.beginOperation({
            operationId: 'operation-split-batch-currentness',
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId: 'operation-split-batch-currentness',
            captureIndex: 0,
            groupId: 'split-page',
            items: [item('accepted'), item('stale-before-effect')],
            sourceRead: finalSourcePage,
        });
        await staging.completeCapture({ operationId: 'operation-split-batch-currentness' });

        let currentLink = 'link-1';
        const cleanups = new Map([
            ['history:accepted', vi.fn(async () => undefined)],
            ['history:stale-before-effect', vi.fn(async () => undefined)],
        ]);
        const writeHistoricalBatch = vi.fn(async (batch: HistoricalImportBatchWriteInput) => {
            currentLink = 'link-2';
            return {
                ok: true as const,
                batchId: batch.batchId,
                acceptedThroughServerSeq: 1,
            };
        });
        const replay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 1,
            createPreparationPhase: async (mode) => {
                const phaseLink = currentLink;
                return {
                    prepareStagedItem: async (value) => ({
                        ok: true as const,
                        item: value as ReturnType<typeof item>,
                        ...(mode === 'publish'
                            ? { cleanup: cleanups.get((value as ReturnType<typeof item>).localId)! }
                            : {}),
                    }),
                    ...(mode === 'publish'
                        ? {
                            revalidateBeforeBatchEffect: async () => {
                                if (currentLink !== phaseLink) {
                                    throw new Error('source_changed');
                                }
                            },
                        }
                        : {}),
                };
            },
            isBatchWithinSerializedByteLimit: () => true,
            writeHistoricalBatch,
        });

        await expect(replay.resume('operation-split-batch-currentness'))
            .rejects.toThrow('source_changed');
        expect(writeHistoricalBatch).toHaveBeenCalledOnce();
        expect(cleanups.get('history:accepted')).not.toHaveBeenCalled();
        expect(cleanups.get('history:stale-before-effect')).toHaveBeenCalledOnce();
    });

    it('never replays an incomplete capture', async () => {
        const staging = await createStore();
        await staging.beginOperation({
            operationId: 'operation-incomplete',
            representation: 'content',
            capturedSource,
        });
        await staging.appendPageGroup({
            operationId: 'operation-incomplete',
            captureIndex: 0,
            groupId: 'newest-page',
            items: [item('newest')],
            sourceRead: continuingSourcePage,
        });
        const writeHistoricalBatch = vi.fn();
        const replay = createExternalSessionHistoricalImportReplay({
            staging,
            sourceGeneration: 'source-generation-1',
            maxBatchItems: 200,
            isBatchWithinSerializedByteLimit: ({ items }) => (
                new TextEncoder().encode(JSON.stringify(items)).byteLength
            ) <= 50_000,
            writeHistoricalBatch,
        });

        expect(await replay.resume('operation-incomplete')).toEqual({
            status: 'awaiting_user_resume',
            reason: 'capture_incomplete',
            acceptedThroughServerSeq: null,
        });
        expect(writeHistoricalBatch).not.toHaveBeenCalled();
    });
});
