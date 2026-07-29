import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { stageSessionMediaMetadataForHistoricalImport } from '@/session/media/adoption';

import {
    classifyExternalSessionStagingSourceRead,
    createExternalSessionOperationPrivateStagingStore,
    measureExternalSessionStagingPageGroup,
    type ExternalSessionOperationPrivateStagingStore,
} from './operationPrivateStaging';

const temporaryDirectories: string[] = [];

async function readReplayGroups(
    store: ExternalSessionOperationPrivateStagingStore,
    operationId: string,
) {
    const groups = [];
    for await (const group of store.streamReplayGroups(operationId)) groups.push(group);
    return groups;
}

async function createPrivateRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(path);
    return path;
}

const capturedSource = Object.freeze({
    sourceIdentity: 'source-1',
    sourceGeneration: 'generation-1',
    revision: 'revision-1',
    boundary: 'boundary-1',
});

const sameSourceRead = Object.freeze({
    availability: 'reachable' as const,
    sourceIdentity: 'source-1',
    sourceGeneration: 'generation-1',
    revision: 'revision-1',
    relationshipToCapture: 'same' as const,
    eof: false,
});

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
    }));
});

describe('operation-private External Sessions staging', () => {
    it('returns the exact persisted capture evidence needed for explicit Resume revalidation', async () => {
        const activeServerDir = await createPrivateRoot('happier-staging-capture-evidence-');
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 20, maxBytes: 20_000 },
            },
        });

        await store.beginOperation({
            operationId: 'operation-capture-evidence',
            representation: 'content',
            capturedSource,
        });

        await expect(store.readCapturedSource({
            operationId: 'operation-capture-evidence',
        })).resolves.toEqual({
            status: 'ready',
            capturedSource,
        });
        await expect(store.readCapturedSource({
            operationId: 'operation-missing',
        })).resolves.toEqual({ status: 'missing' });
    });

    it('recovers an atomically published page after a crash and replays oldest groups first without reversing page-local items', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-atomic-');
        let failCommittedManifestOnce = true;
        const crashingWriter = async (path: string, value: unknown) => {
            const manifest = value as { groups?: Array<{ state?: string }> };
            if (
                failCommittedManifestOnce
                && path.endsWith('manifest.json')
                && manifest.groups?.some((group) => group.state === 'committed')
            ) {
                failCommittedManifestOnce = false;
                throw new Error('simulated crash before committed manifest publication');
            }
            await writeJsonAtomic(path, value);
        };
        const limits = {
            perOperation: { maxItems: 20, maxBytes: 50_000 },
            aggregate: { maxItems: 40, maxBytes: 100_000 },
        } as const;
        const crashingStore = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
            persistence: { writeJsonAtomic: crashingWriter },
        });

        expect(await crashingStore.beginOperation({
            operationId: 'operation-1',
            representation: 'content',
            capturedSource,
        })).toEqual(expect.objectContaining({ status: 'ready' }));

        await expect(crashingStore.appendPageGroup({
            operationId: 'operation-1',
            captureIndex: 0,
            groupId: 'newest-page',
            items: [{ id: 'n-1' }, { id: 'n-2' }],
            sourceRead: sameSourceRead,
        })).rejects.toThrow('simulated crash');

        const restartedStore = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
        });
        expect(await restartedStore.appendPageGroup({
            operationId: 'operation-1',
            captureIndex: 0,
            groupId: 'newest-page',
            items: [{ id: 'n-1' }, { id: 'n-2' }],
            sourceRead: sameSourceRead,
        })).toEqual(expect.objectContaining({ status: 'stored' }));
        expect(await restartedStore.appendPageGroup({
            operationId: 'operation-1',
            captureIndex: 1,
            groupId: 'oldest-page',
            items: [{ id: 'o-1' }, { id: 'o-2' }],
            sourceRead: { ...sameSourceRead, eof: true },
        })).toEqual(expect.objectContaining({ status: 'stored' }));
        expect(await restartedStore.appendPageGroup({
            operationId: 'operation-1',
            captureIndex: 0,
            groupId: 'newest-page',
            items: [{ id: 'n-1' }, { id: 'n-2' }],
            sourceRead: sameSourceRead,
        })).toEqual(expect.objectContaining({ status: 'already_stored' }));
        await restartedStore.completeCapture({ operationId: 'operation-1' });
        await expect(restartedStore.readCaptureCheckpoint({
            operationId: 'operation-1',
        })).resolves.toEqual({
            status: 'ready',
            captureState: 'complete',
            sourcePagesRead: 2,
            stagedItemCount: 4,
            capturedThroughSourceRevision: 'revision-1',
        });

        expect(await restartedStore.readReplayState('operation-1')).toEqual({
            status: 'ready',
            lifecycle: 'active',
            acceptedThroughServerSeq: null,
            acknowledgedItemCount: 0,
        });
        expect(await readReplayGroups(restartedStore, 'operation-1')).toEqual([
                expect.objectContaining({
                    groupId: 'oldest-page',
                    items: [{ id: 'o-1' }, { id: 'o-2' }],
                }),
                expect.objectContaining({
                    groupId: 'newest-page',
                    items: [{ id: 'n-1' }, { id: 'n-2' }],
                }),
        ]);
    });

    it('streams chronological replay one page file at a time instead of buffering the whole staged transcript', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-stream-');
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 20, maxBytes: 50_000 },
                aggregate: { maxItems: 40, maxBytes: 100_000 },
            },
        });
        await store.beginOperation({
            operationId: 'operation-stream',
            representation: 'content',
            capturedSource,
        });
        await store.appendPageGroup({
            operationId: 'operation-stream',
            captureIndex: 0,
            groupId: 'newest-page',
            items: [{ id: 'newest' }],
            sourceRead: sameSourceRead,
        });
        await store.appendPageGroup({
            operationId: 'operation-stream',
            captureIndex: 1,
            groupId: 'oldest-page',
            items: [{ id: 'oldest' }],
            sourceRead: { ...sameSourceRead, eof: true },
        });
        await store.completeCapture({ operationId: 'operation-stream' });

        const replay = store.streamReplayGroups('operation-stream')[Symbol.asyncIterator]();
        await expect(replay.next()).resolves.toEqual({
            done: false,
            value: expect.objectContaining({
                captureIndex: 1,
                groupId: 'oldest-page',
                items: [{ id: 'oldest' }],
            }),
        });

        const operationDirectory = join(
            activeServerDir,
            'external-session-operation-staging',
            (await readdir(join(activeServerDir, 'external-session-operation-staging'), {
                withFileTypes: true,
            })).find((entry) => entry.isDirectory())!.name,
        );
        await rm(join(operationDirectory, 'page-000000000000.json'));

        await expect(replay.next()).rejects.toThrow(
            'External session staging page is unavailable',
        );
    });

    it('admits exact per-operation item and byte ceilings and refuses max-plus-one before reserving work', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-capacity-');
        const exactItems = [{ id: 'one' }, { id: 'two' }];
        const exactBytes = measureExternalSessionStagingPageGroup({
            captureIndex: 0,
            groupId: 'page-1',
            items: exactItems,
        }).serializedBytes;
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: exactItems.length, maxBytes: exactBytes },
                aggregate: { maxItems: 100, maxBytes: 1_000_000 },
            },
        });
        await store.beginOperation({
            operationId: 'operation-exact',
            representation: 'content',
            capturedSource,
        });

        expect(await store.appendPageGroup({
            operationId: 'operation-exact',
            captureIndex: 0,
            groupId: 'page-1',
            items: exactItems,
            sourceRead: { ...sameSourceRead, eof: true },
        })).toEqual(expect.objectContaining({ status: 'stored' }));
        expect(await store.appendPageGroup({
            operationId: 'operation-exact',
            captureIndex: 1,
            groupId: 'page-2',
            items: [{ id: 'extra' }],
            sourceRead: sameSourceRead,
        })).toEqual({
            status: 'refused',
            reason: 'per_operation_item_capacity',
        });
        await store.completeCapture({ operationId: 'operation-exact' });

        expect(await store.readReplayState('operation-exact')).toEqual(expect.objectContaining({
            status: 'ready',
        }));
        expect(await readReplayGroups(store, 'operation-exact')).toEqual([
            expect.objectContaining({ groupId: 'page-1' }),
        ]);

        await store.beginOperation({
            operationId: 'operation-byte-plus-one',
            representation: 'content',
            capturedSource,
        });
        expect(await store.appendPageGroup({
            operationId: 'operation-byte-plus-one',
            captureIndex: 0,
            groupId: 'page-too-large',
            items: [{ id: 'one', padding: 'x'.repeat(exactBytes) }],
            sourceRead: sameSourceRead,
        })).toEqual({
            status: 'refused',
            reason: 'per_operation_byte_capacity',
        });
        expect(await store.readReplayState('operation-byte-plus-one')).toEqual({
            status: 'capture_incomplete',
            lifecycle: 'active',
            acceptedThroughServerSeq: null,
            acknowledgedItemCount: 0,
        });
    });

    it('counts immutable media bytes in the same pre-admission capacity decision without publishing workspace media', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-media-capacity-');
        const workingDirectory = await createPrivateRoot('happier-external-staging-media-source-');
        const sourcePath = join(workingDirectory, 'source.png');
        await writeFile(sourcePath, Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS0AAAAASUVORK5CYII=',
            'base64',
        ));
        const itemWithoutMedia = { id: 'message-1', raw: { text: 'fits alone' } };
        const stagedRaw = await stageSessionMediaMetadataForHistoricalImport({
            raw: {
                text: 'fits alone',
                meta: {
                    happier: {
                        kind: 'session_media.v1',
                        payload: {
                            media: [{
                                role: 'output',
                                category: 'generated',
                                path: sourcePath,
                                mimeType: 'image/png',
                                name: 'source.png',
                            }],
                        },
                    },
                },
            },
            workingDirectory,
            sourceReadRoots: [],
        });
        const itemWithMedia = { id: 'message-1', raw: stagedRaw };
        const itemOnlyBytes = measureExternalSessionStagingPageGroup({
            captureIndex: 0,
            groupId: 'page',
            items: [itemWithoutMedia],
        }).serializedBytes;
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 1, maxBytes: itemOnlyBytes },
                aggregate: { maxItems: 10, maxBytes: 1_000_000 },
            },
        });
        await store.beginOperation({
            operationId: 'operation-media-capacity',
            representation: 'content',
            capturedSource,
        });

        await expect(store.appendPageGroup({
            operationId: 'operation-media-capacity',
            captureIndex: 0,
            groupId: 'page',
            items: [itemWithMedia],
            sourceRead: sameSourceRead,
        })).resolves.toEqual({
            status: 'refused',
            reason: 'per_operation_byte_capacity',
        });
        await expect(stat(join(workingDirectory, '.happier', 'uploads')))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('enforces aggregate capacity across operations without a second mutable quota ledger', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-aggregate-');
        const firstItems = [{ id: 'first' }];
        const secondItems = [{ id: 'second' }];
        const firstBytes = measureExternalSessionStagingPageGroup({
            captureIndex: 0,
            groupId: 'page-first',
            items: firstItems,
        }).serializedBytes;
        const secondBytes = measureExternalSessionStagingPageGroup({
            captureIndex: 0,
            groupId: 'page-second',
            items: secondItems,
        }).serializedBytes;
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 2, maxBytes: firstBytes + secondBytes },
            },
        });
        for (const operationId of ['operation-a', 'operation-b', 'operation-c']) {
            await store.beginOperation({
                operationId,
                representation: 'content',
                capturedSource,
            });
        }

        expect((await store.appendPageGroup({
            operationId: 'operation-a',
            captureIndex: 0,
            groupId: 'page-first',
            items: firstItems,
            sourceRead: sameSourceRead,
        })).status).toBe('stored');
        expect((await store.appendPageGroup({
            operationId: 'operation-b',
            captureIndex: 0,
            groupId: 'page-second',
            items: secondItems,
            sourceRead: sameSourceRead,
        })).status).toBe('stored');
        expect(await store.appendPageGroup({
            operationId: 'operation-c',
            captureIndex: 0,
            groupId: 'page-plus-one',
            items: [{ id: 'third' }],
            sourceRead: sameSourceRead,
        })).toEqual({
            status: 'refused',
            reason: 'aggregate_item_capacity',
        });
    });

    it('classifies deletion, recreation, append, rewrite, and unknown independently from EOF', () => {
        expect(classifyExternalSessionStagingSourceRead(capturedSource, {
            availability: 'unreachable',
        })).toEqual({
            outcome: 'deleted_or_unreachable',
            eof: null,
        });
        expect(classifyExternalSessionStagingSourceRead(capturedSource, {
            availability: 'reachable',
            sourceIdentity: 'source-1',
            sourceGeneration: 'generation-2',
            revision: 'revision-2',
            relationshipToCapture: 'appended',
            eof: true,
        })).toEqual({
            outcome: 'replaced_or_rewritten',
            eof: null,
        });
        expect(classifyExternalSessionStagingSourceRead(capturedSource, {
            availability: 'reachable',
            sourceIdentity: 'source-1',
            sourceGeneration: 'generation-1',
            revision: 'revision-2',
            relationshipToCapture: 'appended',
            eof: true,
        })).toEqual({
            outcome: 'appended_after_boundary',
            eof: true,
        });
        expect(classifyExternalSessionStagingSourceRead(capturedSource, {
            availability: 'reachable',
            sourceIdentity: 'source-1',
            sourceGeneration: 'generation-1',
            revision: 'revision-1-rewritten',
            relationshipToCapture: 'rewritten',
            eof: false,
        })).toEqual({
            outcome: 'replaced_or_rewritten',
            eof: null,
        });
        expect(classifyExternalSessionStagingSourceRead(capturedSource, {
            availability: 'unknown',
        })).toEqual({
            outcome: 'unknown',
            eof: null,
        });
    });

    it('does not collapse source unavailability into EOF or stage items from a non-continuous source', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-source-');
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 10, maxBytes: 10_000 },
            },
        });
        await store.beginOperation({
            operationId: 'operation-source',
            representation: 'content',
            capturedSource,
        });

        expect(await store.appendPageGroup({
            operationId: 'operation-source',
            captureIndex: 0,
            groupId: 'unavailable-page',
            items: [],
            sourceRead: { availability: 'unreachable' },
        })).toEqual({
            status: 'refused',
            reason: 'source_state_not_storable',
            sourceState: { outcome: 'deleted_or_unreachable', eof: null },
        });
        expect(await store.readReplayState('operation-source')).toEqual({
            status: 'capture_incomplete',
            lifecycle: 'active',
            acceptedThroughServerSeq: null,
            acknowledgedItemCount: 0,
        });
    });

    it('marks expired paused staging discard-required without deleting resumable bytes', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-expiry-');
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 10, maxBytes: 10_000 },
            },
        });
        await store.beginOperation({
            operationId: 'operation-paused',
            representation: 'content',
            capturedSource,
        });
        await store.appendPageGroup({
            operationId: 'operation-paused',
            captureIndex: 0,
            groupId: 'page-1',
            items: [{ id: 'kept' }],
            sourceRead: sameSourceRead,
        });
        await store.pauseOperation({
            operationId: 'operation-paused',
            expiresAtMs: 100,
        });

        expect(await store.markExpiredPausedWorkDiscardRequired({
            operationId: 'operation-paused',
            nowMs: 99,
        })).toEqual({ status: 'paused', expiresAtMs: 100 });
        expect(await store.markExpiredPausedWorkDiscardRequired({
            operationId: 'operation-paused',
            nowMs: 100,
        })).toEqual({ status: 'discard_required' });
        expect(await store.readReplayState('operation-paused')).toEqual(expect.objectContaining({
            status: 'discard_required',
        }));
        expect(await readReplayGroups(store, 'operation-paused')).toEqual([
            expect.objectContaining({ items: [{ id: 'kept' }] }),
        ]);
    });

    it('retains acknowledged and pending private groups for media cleanup after discard', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-discard-cleanup-');
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 10, maxBytes: 10_000 },
            },
        });
        await store.beginOperation({
            operationId: 'operation-discard-cleanup',
            representation: 'content',
            capturedSource,
        });
        await store.appendPageGroup({
            operationId: 'operation-discard-cleanup',
            captureIndex: 0,
            replayOrder: 0,
            groupId: 'newest-pending',
            items: [{ id: 'pending' }],
            sourceRead: sameSourceRead,
        });
        await store.appendPageGroup({
            operationId: 'operation-discard-cleanup',
            captureIndex: 1,
            replayOrder: 1,
            groupId: 'oldest-acknowledged',
            items: [{ id: 'acknowledged' }],
            sourceRead: { ...sameSourceRead, eof: true },
        });
        await store.completeCapture({ operationId: 'operation-discard-cleanup' });
        await store.acknowledgeReplayGroup({
            operationId: 'operation-discard-cleanup',
            groupId: 'oldest-acknowledged',
            acceptedThroughServerSeq: 1,
        });
        await store.pauseOperation({
            operationId: 'operation-discard-cleanup',
            expiresAtMs: 100,
        });
        await store.markExpiredPausedWorkDiscardRequired({
            operationId: 'operation-discard-cleanup',
            nowMs: 100,
        });

        const groups = [];
        for await (
          const group of store.streamAllGroupsForTerminalCleanup('operation-discard-cleanup')
        ) {
            groups.push(group);
        }
        expect(groups).toEqual([
            expect.objectContaining({
                groupId: 'oldest-acknowledged',
                items: [{ id: 'acknowledged' }],
            }),
            expect.objectContaining({
                groupId: 'newest-pending',
                items: [{ id: 'pending' }],
            }),
        ]);
    });

    it('rejects reference-only staging until an immutable revision-scoped source is proven', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-reference-');
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 10, maxBytes: 10_000 },
            },
        });

        expect(await store.beginOperation({
            operationId: 'operation-reference',
            representation: 'reference_only',
            capturedSource,
        })).toEqual({
            status: 'refused',
            reason: 'reference_only_unavailable',
        });
        await expect(readdir(join(activeServerDir, 'external-session-operation-staging')))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('hashes operation ids into POSIX/Windows-safe private paths and preserves restrictive permissions', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-paths-');
        await mkdir(activeServerDir, { recursive: true, mode: 0o777 });
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 20, maxBytes: 20_000 },
            },
        });
        for (const operationId of ['../escape/../../operation', 'C:\\Users\\alice2\\..\\secret']) {
            await store.beginOperation({
                operationId,
                representation: 'content',
                capturedSource,
            });
        }

        const root = join(activeServerDir, 'external-session-operation-staging');
        const entries = (await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !entry.name.endsWith('.lock'));
        expect(entries).toHaveLength(2);
        expect(entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.name))).toBe(true);
        for (const entry of entries) {
            expect(JSON.parse(await readFile(join(root, entry.name, 'manifest.json'), 'utf8')))
                .toEqual(expect.objectContaining({ operationId: expect.any(String) }));
        }
        if (process.platform !== 'win32') {
            expect((await stat(root)).mode & 0o777).toBe(0o700);
            for (const entry of entries) {
                expect((await stat(join(root, entry.name))).mode & 0o777).toBe(0o700);
                expect((await stat(join(root, entry.name, 'manifest.json'))).mode & 0o777).toBe(0o600);
            }
        }
    });
});
