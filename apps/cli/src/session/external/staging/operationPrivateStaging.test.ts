import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { stageSessionMediaMetadataForHistoricalImport } from '@/session/media/adoption';
import { garbageCollectUncommittedSessionMedia } from '@/session/media/garbageCollect';

import {
    classifyExternalSessionStagingSourceRead,
    createExternalSessionOperationPrivateStagingStore,
    measureExternalSessionStagingPageGroup,
    type ExternalSessionOperationPrivateStagingStore,
} from './operationPrivateStaging';

const accountCredentials = vi.hoisted(() => ({
    current: null as Readonly<{ token: string; encryption: null }> | null,
}));

vi.mock('@/persistence', () => ({
    readStoredCredentials: async () => accountCredentials.current,
}));

const temporaryDirectories: string[] = [];

function accountToken(subject: string): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none' })}.${encode({ sub: subject })}.`;
}

function useAccount(subject: string | null): void {
    accountCredentials.current = subject === null
        ? null
        : { token: accountToken(subject), encryption: null };
}

function stagingRootFor(activeServerDir: string, subject = 'vitest'): string {
    const accountKey = createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 32);
    return join(
        activeServerDir,
        'external-session-operations',
        'by-account',
        `sub-${accountKey}`,
        'staging',
    );
}

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
    accountCredentials.current = null;
    await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
    }));
});

describe('operation-private External Sessions staging', () => {
    it('cleans an authoritatively abandoned nonterminal operation only after workspace-media custody is discharged', async () => {
        const activeServerDir = await createPrivateRoot('happier-staging-abandoned-');
        const operationId = 'operation-abandoned';
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 20, maxBytes: 20_000 },
            },
        });
        const media = [{
            workingDirectory: '/workspace',
            candidateWorkspaceRelativePath: '.happier/uploads/uncommitted.png',
        }];
        await store.beginOperation({
            operationId,
            representation: 'content',
            capturedSource,
        });
        await store.recordCreatedWorkspaceMedia({ operationId, media });

        await expect(store.cleanupAbandonedOperation({ operationId }))
            .resolves.toEqual({ status: 'not_ready' });
        await store.acknowledgeCreatedWorkspaceMediaCleanup({ operationId, media });
        await expect(store.cleanupAbandonedOperation({ operationId }))
            .resolves.toEqual({ status: 'completed' });

        const restarted = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 20, maxBytes: 20_000 },
            },
        });
        await expect(restarted.cleanupAbandonedOperation({ operationId }))
            .resolves.toEqual({ status: 'missing' });
    });

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
            // The page payload is durable and its reservation row still says
            // `reserved`: the exact instant the commit is lost.
            const reservation = value as { state?: string };
            if (
                failCommittedManifestOnce
                && /group-\d+\.json$/.test(path.replaceAll('\\', '/'))
                && reservation.state === 'committed'
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

    it('completes a resumed capture whose committed page row outlived the header write that folded it', async () => {
        // A page row is published before the header that folds it. Losing the
        // header write leaves the row committed while the header still lists
        // the page pending, and the resumed capture re-appends that exact page
        // and is answered `already_stored`. Without republishing the lost fold
        // the pending entry is permanent and the import can never complete.
        const activeServerDir = await createPrivateRoot('happier-external-staging-lost-fold-');
        let failFoldOnce = true;
        let committedRowPublished = false;
        const crashingWriter = async (path: string, value: unknown) => {
            const normalized = path.replaceAll('\\', '/');
            if (
                /group-\d+\.json$/.test(normalized)
                && (value as { state?: string }).state === 'committed'
            ) {
                await writeJsonAtomic(path, value);
                committedRowPublished = true;
                return;
            }
            if (failFoldOnce && committedRowPublished && normalized.endsWith('manifest.json')) {
                failFoldOnce = false;
                throw new Error('simulated crash before the committed fold is published');
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
            operationId: 'operation-lost-fold',
            representation: 'content',
            capturedSource,
        })).toEqual(expect.objectContaining({ status: 'ready' }));
        await expect(crashingStore.appendPageGroup({
            operationId: 'operation-lost-fold',
            captureIndex: 0,
            groupId: 'newest-page',
            items: [{ id: 'n-1' }],
            sourceRead: sameSourceRead,
        })).rejects.toThrow('simulated crash');

        // The resumed capture reads its source from the newest page again.
        const restarted = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
        });
        expect(await restarted.appendPageGroup({
            operationId: 'operation-lost-fold',
            captureIndex: 0,
            groupId: 'newest-page',
            items: [{ id: 'n-1' }],
            sourceRead: sameSourceRead,
        })).toEqual(expect.objectContaining({ status: 'already_stored' }));
        expect(await restarted.appendPageGroup({
            operationId: 'operation-lost-fold',
            captureIndex: 1,
            groupId: 'oldest-page',
            items: [{ id: 'o-1' }],
            sourceRead: { ...sameSourceRead, eof: true },
        })).toEqual(expect.objectContaining({ status: 'stored' }));
        await restarted.completeCapture({ operationId: 'operation-lost-fold' });
        expect(await restarted.readReplayState('operation-lost-fold')).toEqual({
            status: 'ready',
            lifecycle: 'active',
            acceptedThroughServerSeq: null,
            acknowledgedItemCount: 0,
        });
        expect(await readReplayGroups(restarted, 'operation-lost-fold')).toEqual([
            expect.objectContaining({ groupId: 'oldest-page', items: [{ id: 'o-1' }] }),
            expect.objectContaining({ groupId: 'newest-page', items: [{ id: 'n-1' }] }),
        ]);
    });

    it('repairs an acknowledged row fact after the header fold is lost during replay recovery', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-lost-ack-fold-');
        const limits = {
            perOperation: { maxItems: 20, maxBytes: 50_000 },
            aggregate: { maxItems: 40, maxBytes: 100_000 },
        } as const;
        const operationId = 'operation-lost-ack-fold';
        const groupId = 'only-page';
        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await store.beginOperation({ operationId, representation: 'content', capturedSource });
        await store.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: [{ id: 'only-1' }, { id: 'only-2' }],
            sourceRead: { ...sameSourceRead, eof: true },
        });
        await store.completeCapture({ operationId });

        let acknowledgedRowWritten = false;
        let failHeaderFoldOnce = true;
        const crashingStore = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
            persistence: {
                writeJsonAtomic: async (path, value) => {
                    const normalized = path.replaceAll('\\', '/');
                    if (
                        /group-\d+\.json$/.test(normalized)
                        && (value as { state?: string }).state === 'acknowledged'
                    ) {
                        await writeJsonAtomic(path, value);
                        acknowledgedRowWritten = true;
                        return;
                    }
                    if (
                        failHeaderFoldOnce
                        && acknowledgedRowWritten
                        && normalized.endsWith('manifest.json')
                    ) {
                        failHeaderFoldOnce = false;
                        throw new Error('simulated crash before acknowledged header fold');
                    }
                    await writeJsonAtomic(path, value);
                },
            },
        });

        await expect(crashingStore.acknowledgeReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            acceptedThroughServerSeq: 2,
        })).rejects.toThrow('simulated crash before acknowledged header fold');

        const restarted = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await expect(restarted.readReplayState(operationId)).resolves.toEqual({
            status: 'ready',
            lifecycle: 'active',
            acceptedThroughServerSeq: 2,
            acknowledgedItemCount: 2,
        });
        await expect(readReplayGroups(restarted, operationId)).resolves.toEqual([]);
        await expect(restarted.cleanupTerminalOperation({ operationId }))
            .resolves.toEqual({ status: 'completed' });
    });

    it('repairs an acknowledged row fact during an idempotent acknowledgement', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-idempotent-ack-fold-');
        const limits = {
            perOperation: { maxItems: 20, maxBytes: 50_000 },
            aggregate: { maxItems: 40, maxBytes: 100_000 },
        } as const;
        const operationId = 'operation-idempotent-ack-fold';
        const groupId = 'only-page';
        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await store.beginOperation({ operationId, representation: 'content', capturedSource });
        await store.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: [{ id: 'only-1' }],
            sourceRead: { ...sameSourceRead, eof: true },
        });
        await store.completeCapture({ operationId });

        let acknowledgedRowWritten = false;
        let failHeaderFoldOnce = true;
        const crashingStore = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
            persistence: {
                writeJsonAtomic: async (path, value) => {
                    const normalized = path.replaceAll('\\', '/');
                    if (
                        /group-\d+\.json$/.test(normalized)
                        && (value as { state?: string }).state === 'acknowledged'
                    ) {
                        await writeJsonAtomic(path, value);
                        acknowledgedRowWritten = true;
                        return;
                    }
                    if (
                        failHeaderFoldOnce
                        && acknowledgedRowWritten
                        && normalized.endsWith('manifest.json')
                    ) {
                        failHeaderFoldOnce = false;
                        throw new Error('simulated crash before acknowledged header fold');
                    }
                    await writeJsonAtomic(path, value);
                },
            },
        });

        await expect(crashingStore.acknowledgeReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            acceptedThroughServerSeq: 1,
        })).rejects.toThrow('simulated crash before acknowledged header fold');

        const restarted = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await expect(restarted.acknowledgeReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            acceptedThroughServerSeq: 1,
        })).resolves.toBeUndefined();
        const operationDirectory = join(
            stagingRootFor(activeServerDir),
            (await readdir(stagingRootFor(activeServerDir), { withFileTypes: true }))
                .find((entry) => entry.isDirectory())!.name,
        );
        expect(JSON.parse(await readFile(join(operationDirectory, 'manifest.json'), 'utf8')))
            .toMatchObject({
                summary: {
                    groupCount: 1,
                    acknowledgedGroupCount: 1,
                    acknowledgedItemCount: 1,
                    acceptedThroughServerSeq: 1,
                },
            });
        await expect(restarted.cleanupTerminalOperation({ operationId }))
            .resolves.toEqual({ status: 'completed' });
    });

    it('repairs an acknowledged row fact before terminal cleanup decides readiness', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-cleanup-ack-fold-');
        const limits = {
            perOperation: { maxItems: 20, maxBytes: 50_000 },
            aggregate: { maxItems: 40, maxBytes: 100_000 },
        } as const;
        const operationId = 'operation-cleanup-ack-fold';
        const groupId = 'only-page';
        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await store.beginOperation({ operationId, representation: 'content', capturedSource });
        await store.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: [{ id: 'only-1' }],
            sourceRead: { ...sameSourceRead, eof: true },
        });
        await store.completeCapture({ operationId });

        let acknowledgedRowWritten = false;
        let failHeaderFoldOnce = true;
        const crashingStore = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
            persistence: {
                writeJsonAtomic: async (path, value) => {
                    const normalized = path.replaceAll('\\', '/');
                    if (
                        /group-\d+\.json$/.test(normalized)
                        && (value as { state?: string }).state === 'acknowledged'
                    ) {
                        await writeJsonAtomic(path, value);
                        acknowledgedRowWritten = true;
                        return;
                    }
                    if (
                        failHeaderFoldOnce
                        && acknowledgedRowWritten
                        && normalized.endsWith('manifest.json')
                    ) {
                        failHeaderFoldOnce = false;
                        throw new Error('simulated crash before acknowledged header fold');
                    }
                    await writeJsonAtomic(path, value);
                },
            },
        });

        await expect(crashingStore.acknowledgeReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            acceptedThroughServerSeq: 1,
        })).rejects.toThrow('simulated crash before acknowledged header fold');

        const restarted = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        // Without the header fold repair, stale acknowledgedGroupCount is zero
        // and terminal cleanup incorrectly reports not_ready despite the row.
        await expect(restarted.cleanupTerminalOperation({ operationId }))
            .resolves.toEqual({ status: 'completed' });
    });

    it('preserves the row-count fold across insert, state transitions, extension rollback, and restart', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-row-count-fold-');
        const limits = {
            perOperation: { maxItems: 20, maxBytes: 50_000 },
            aggregate: { maxItems: 40, maxBytes: 100_000 },
        } as const;
        const operationId = 'operation-row-count-fold';
        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await store.beginOperation({ operationId, representation: 'content', capturedSource });
        await store.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId: 'acknowledged-prefix',
            items: [{ id: 'prefix' }],
            sourceRead: { ...sameSourceRead, eof: true },
        });
        await store.completeCapture({ operationId });
        await store.acknowledgeReplayGroup({
            operationId,
            captureIndex: 0,
            groupId: 'acknowledged-prefix',
            acceptedThroughServerSeq: 1,
        });
        const extension = await store.reopenAcknowledgedCapture({ operationId });
        await store.appendPageGroup({
            operationId,
            captureIndex: extension.nextCaptureIndex,
            groupId: 'discarded-extension',
            items: [{ id: 'extension' }],
            sourceRead: {
                ...sameSourceRead,
                revision: 'revision-2',
                relationshipToCapture: 'appended',
                eof: true,
            },
        });
        await store.rollbackUnacknowledgedCaptureExtension({ operationId });

        const restarted = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await expect(restarted.readCaptureCheckpoint({ operationId })).resolves.toEqual({
            status: 'ready',
            captureState: 'complete',
            sourcePagesRead: 1,
            stagedItemCount: 1,
            capturedThroughSourceRevision: 'revision-1',
        });
        await expect(restarted.readReplayState(operationId)).resolves.toEqual({
            status: 'ready',
            lifecycle: 'active',
            acceptedThroughServerSeq: 1,
            acknowledgedItemCount: 1,
        });
    });

    it.each([
        ['after removing tail payloads and before publishing the contracted header', false],
        ['after publishing the contracted header and before metadata cleanup', true],
    ] as const)(
        'keeps private extension payloads charged or removed when rollback crashes %s',
        async (_crashWindow, persistContractedHeaderBeforeFailure) => {
            const activeServerDir = await createPrivateRoot('happier-external-staging-rollback-order-');
            const limits = {
                perOperation: { maxItems: 20, maxBytes: 50_000 },
                aggregate: { maxItems: 40, maxBytes: 100_000 },
            } as const;
            const operationId = `operation-rollback-${String(persistContractedHeaderBeforeFailure)}`;
            const store = createExternalSessionOperationPrivateStagingStore({
                activeServerDir,
                limits,
            });
            await store.beginOperation({ operationId, representation: 'content', capturedSource });
            await store.appendPageGroup({
                operationId,
                captureIndex: 0,
                groupId: 'acknowledged-prefix',
                items: [{ id: 'prefix' }],
                sourceRead: sameSourceRead,
            });
            await store.appendPageGroup({
                operationId,
                captureIndex: 1,
                groupId: 'discarded-extension',
                items: [{ id: 'extension', content: 'large private page payload' }],
                sourceRead: {
                    ...sameSourceRead,
                    revision: 'revision-2',
                    relationshipToCapture: 'appended',
                    eof: true,
                },
            });
            await store.completeCapture({ operationId });
            await store.persistPreparedReplayGroup({
                operationId,
                captureIndex: 1,
                groupId: 'discarded-extension',
                items: [{ id: 'prepared-extension', content: 'large private prepared payload' }],
            });
            await store.acknowledgeReplayGroup({
                operationId,
                captureIndex: 0,
                groupId: 'acknowledged-prefix',
                acceptedThroughServerSeq: 1,
            });

            const stagingRoot = stagingRootFor(activeServerDir);
            const operationDirectory = join(
                stagingRoot,
                (await readdir(stagingRoot, { withFileTypes: true }))
                    .find((entry) => entry.isDirectory())!.name,
            );
            // Prepared receipts are admitted after capture completion. Model the
            // durable recovery input the rollback owner accepts by reopening
            // only its header while keeping the real tail row and receipt bytes.
            const persistedHeader = JSON.parse(
                await readFile(join(operationDirectory, 'manifest.json'), 'utf8'),
            ) as Record<string, unknown>;
            await writeJsonAtomic(join(operationDirectory, 'manifest.json'), {
                ...persistedHeader,
                captureState: 'capturing',
            });

            let armRollbackFailure = false;
            const crashingStore = createExternalSessionOperationPrivateStagingStore({
                activeServerDir,
                limits,
                persistence: {
                    writeJsonAtomic: async (path, value) => {
                        const header = value as Readonly<{
                            captureState?: unknown;
                            summary?: Readonly<{ groupCount?: unknown }>;
                        }>;
                        const isContractedRollbackHeader = armRollbackFailure
                            && path.replaceAll('\\', '/').endsWith('manifest.json')
                            && header.captureState === 'complete'
                            && header.summary?.groupCount === 1;
                        if (isContractedRollbackHeader && !persistContractedHeaderBeforeFailure) {
                            throw new Error('simulated crash before contracted rollback header publication');
                        }
                        await writeJsonAtomic(path, value);
                        if (isContractedRollbackHeader && persistContractedHeaderBeforeFailure) {
                            throw new Error('simulated crash after contracted rollback header publication');
                        }
                    },
                },
            });
            armRollbackFailure = true;
            await expect(crashingStore.rollbackUnacknowledgedCaptureExtension({ operationId }))
                .rejects.toThrow('simulated crash');

            expect(JSON.parse(await readFile(join(operationDirectory, 'manifest.json'), 'utf8')))
                .toMatchObject(
                    persistContractedHeaderBeforeFailure
                        ? { captureState: 'complete', summary: { groupCount: 1 } }
                        : { captureState: 'capturing', summary: { groupCount: 2 } },
                );
            // If the contracted header made it durable, neither private payload
            // may remain outside its capacity fold. Before it is durable, the
            // old header still retains both charges until a retry finishes.
            await expect(stat(join(operationDirectory, 'page-000000000001.json')))
                .rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(join(operationDirectory, 'prepared-000000000001.json')))
                .rejects.toMatchObject({ code: 'ENOENT' });

            const restarted = createExternalSessionOperationPrivateStagingStore({
                activeServerDir,
                limits,
            });
            await restarted.rollbackUnacknowledgedCaptureExtension({ operationId });
            // A restart after the contracted header must finish the low-cost row
            // cleanup rather than returning early and retaining an unadmitted row.
            await expect(stat(join(operationDirectory, 'group-000000000001.json')))
                .rejects.toMatchObject({ code: 'ENOENT' });
            await expect(restarted.readCaptureCheckpoint({ operationId })).resolves.toEqual({
                status: 'ready',
                captureState: 'complete',
                sourcePagesRead: 1,
                stagedItemCount: 1,
                capturedThroughSourceRevision: 'revision-1',
            });
            await expect(restarted.readReplayState(operationId)).resolves.toEqual({
                status: 'ready',
                lifecycle: 'active',
                acceptedThroughServerSeq: 1,
                acknowledgedItemCount: 1,
            });
            await expect(restarted.reopenAcknowledgedCapture({ operationId })).resolves.toEqual({
                nextCaptureIndex: 1,
                nextReplayOrder: -1,
            });
        },
    );

    it('retains an exact prepared replay receipt through restart without creating another staging owner', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-prepared-replay-');
        const limits = {
            perOperation: { maxItems: 10, maxBytes: 50_000 },
            aggregate: { maxItems: 20, maxBytes: 100_000 },
        } as const;
        const operationId = 'operation-prepared-replay';
        const groupId = 'prepared-page';
        const staged = [{ id: 'raw-item' }];
        const prepared = [{
            localId: 'history:raw-item',
            sidechainId: null,
            messageRole: 'agent',
            content: { t: 'encrypted', c: 'ciphertext-v1' },
        }];
        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await store.beginOperation({ operationId, representation: 'content', capturedSource });
        await store.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: staged,
            sourceRead: { ...sameSourceRead, eof: true },
        });
        await store.completeCapture({ operationId });

        await expect(store.persistPreparedReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: prepared,
        })).resolves.toMatchObject({ status: 'stored' });

        const restarted = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await expect(readReplayGroups(restarted, operationId)).resolves.toEqual([
            expect.objectContaining({
                groupId,
                items: staged,
                preparedItems: prepared,
            }),
        ]);
        await expect(restarted.persistPreparedReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: prepared,
        })).resolves.toEqual({ status: 'already_stored' });
        await expect(restarted.persistPreparedReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: [{ ...prepared[0], content: { t: 'encrypted', c: 'different' } }],
        })).rejects.toThrow('conflicts with its existing receipt');

        await restarted.clearPreparedReplayGroup({ operationId, captureIndex: 0, groupId });
        await expect(readReplayGroups(restarted, operationId)).resolves.toEqual([
            expect.objectContaining({ groupId, items: staged }),
        ]);
    });

    it('keeps a crash-durable prepared replay charged and repairs it on the exact operation retry', async () => {
        const activeServerDir = await createPrivateRoot(
            'happier-external-staging-prepared-crash-charge-',
        );
        const operationId = 'operation-prepared-crash-charge';
        const groupId = 'prepared-page';
        const staged = [{ id: 'raw-item' }];
        const prepared = [{
            localId: 'history:raw-item',
            sidechainId: null,
            messageRole: 'agent',
            content: { t: 'encrypted', c: 'ciphertext-v1' },
        }];
        const rawBytes = measureExternalSessionStagingPageGroup({
            captureIndex: 0,
            groupId,
            items: staged,
        }).serializedBytes;
        const preparedBytes = measureExternalSessionStagingPageGroup({
            captureIndex: 0,
            groupId,
            items: prepared,
        }).serializedBytes;
        const limits = {
            perOperation: { maxItems: 10, maxBytes: rawBytes + preparedBytes },
            aggregate: { maxItems: 20, maxBytes: rawBytes + preparedBytes },
        } as const;
        let failAfterPreparedPayloadOnce = true;
        const crashingStore = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
            persistence: {
                writeJsonAtomic: async (path, value) => {
                    await writeJsonAtomic(path, value);
                    if (
                        failAfterPreparedPayloadOnce
                        && path.replaceAll('\\', '/').endsWith(
                            'prepared-000000000000.json',
                        )
                    ) {
                        failAfterPreparedPayloadOnce = false;
                        throw new Error('simulated crash after prepared payload publication');
                    }
                },
            },
        });
        await crashingStore.beginOperation({
            operationId,
            representation: 'content',
            capturedSource,
        });
        await crashingStore.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: staged,
            sourceRead: { ...sameSourceRead, eof: true },
        });
        await crashingStore.completeCapture({ operationId });

        await expect(crashingStore.persistPreparedReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: prepared,
        })).rejects.toThrow('simulated crash after prepared payload publication');

        const restarted = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
        });
        await restarted.beginOperation({
            operationId: 'operation-capacity-probe',
            representation: 'content',
            capturedSource,
        });
        await expect(restarted.appendPageGroup({
            operationId: 'operation-capacity-probe',
            captureIndex: 0,
            groupId: 'capacity-probe-page',
            items: [{ id: 'must-not-fit' }],
            sourceRead: { ...sameSourceRead, eof: true },
        })).resolves.toEqual({
            status: 'refused',
            reason: 'aggregate_byte_capacity',
        });

        await expect(restarted.persistPreparedReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: prepared,
        })).resolves.toEqual({ status: 'stored' });
        await expect(readReplayGroups(restarted, operationId)).resolves.toEqual([
            expect.objectContaining({ groupId, items: staged, preparedItems: prepared }),
        ]);
    });

    it('releases a crash-durable prepared replay charge when cleanup clears the prepared row', async () => {
        const activeServerDir = await createPrivateRoot(
            'happier-external-staging-prepared-crash-clear-',
        );
        const operationId = 'operation-prepared-crash-clear';
        const groupId = 'prepared-page';
        const staged = [{ id: 'raw-item' }];
        const prepared = [{
            localId: 'history:raw-item',
            sidechainId: null,
            messageRole: 'agent',
            content: { t: 'encrypted', c: 'ciphertext-v1' },
        }];
        const probeItems = [{ id: 'capacity-probe', content: 'x'.repeat(1_000) }];
        const rawBytes = measureExternalSessionStagingPageGroup({
            captureIndex: 0,
            groupId,
            items: staged,
        }).serializedBytes;
        const probeBytes = measureExternalSessionStagingPageGroup({
            captureIndex: 0,
            groupId: 'capacity-probe-page',
            items: probeItems,
        }).serializedBytes;
        const limits = {
            perOperation: { maxItems: 10, maxBytes: rawBytes + probeBytes },
            aggregate: { maxItems: 20, maxBytes: rawBytes + probeBytes },
        } as const;
        let failAfterPreparedRowOnce = true;
        const crashingStore = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
            persistence: {
                writeJsonAtomic: async (path, value) => {
                    await writeJsonAtomic(path, value);
                    if (
                        failAfterPreparedRowOnce
                        && /group-\d+\.json$/.test(path.replaceAll('\\', '/'))
                        && (value as { preparedReplay?: unknown }).preparedReplay
                    ) {
                        failAfterPreparedRowOnce = false;
                        throw new Error('simulated crash after prepared row publication');
                    }
                },
            },
        });
        await crashingStore.beginOperation({
            operationId,
            representation: 'content',
            capturedSource,
        });
        await crashingStore.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: staged,
            sourceRead: { ...sameSourceRead, eof: true },
        });
        await crashingStore.completeCapture({ operationId });

        await expect(crashingStore.persistPreparedReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: prepared,
        })).rejects.toThrow('simulated crash after prepared row publication');

        let failAfterClearedRowOnce = true;
        const interruptedClear = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
            persistence: {
                writeJsonAtomic: async (path, value) => {
                    await writeJsonAtomic(path, value);
                    if (
                        failAfterClearedRowOnce
                        && /group-\d+\.json$/.test(path.replaceAll('\\', '/'))
                        && (value as { state?: string; preparedReplay?: unknown }).state
                            === 'committed'
                        && !(value as { preparedReplay?: unknown }).preparedReplay
                    ) {
                        failAfterClearedRowOnce = false;
                        throw new Error('simulated crash after cleared row publication');
                    }
                },
            },
        });
        await expect(interruptedClear.clearPreparedReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
        })).rejects.toThrow('simulated crash after cleared row publication');

        const restarted = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
        });
        await restarted.clearPreparedReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
        });
        await restarted.beginOperation({
            operationId: 'operation-capacity-probe-after-clear',
            representation: 'content',
            capturedSource,
        });
        await expect(restarted.appendPageGroup({
            operationId: 'operation-capacity-probe-after-clear',
            captureIndex: 0,
            groupId: 'capacity-probe-page',
            items: probeItems,
            sourceRead: { ...sameSourceRead, eof: true },
        })).resolves.toMatchObject({ status: 'stored' });
    });

    it('refuses prepared replay bytes at the same operation capacity ceiling before a server effect', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-prepared-capacity-');
        const operationId = 'operation-prepared-capacity';
        const groupId = 'prepared-page';
        const staged = [{ id: 'raw-item' }];
        const rawBytes = measureExternalSessionStagingPageGroup({
            captureIndex: 0,
            groupId,
            items: staged,
        }).serializedBytes;
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: rawBytes },
                aggregate: { maxItems: 20, maxBytes: 100_000 },
            },
        });
        await store.beginOperation({ operationId, representation: 'content', capturedSource });
        await store.appendPageGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: staged,
            sourceRead: { ...sameSourceRead, eof: true },
        });
        await store.completeCapture({ operationId });

        await expect(store.persistPreparedReplayGroup({
            operationId,
            captureIndex: 0,
            groupId,
            items: [{
                localId: 'history:raw-item',
                sidechainId: null,
                messageRole: 'agent',
                content: { t: 'encrypted', c: 'ciphertext-v1' },
            }],
        })).resolves.toEqual({
            status: 'refused',
            reason: 'per_operation_byte_capacity',
        });
        await expect(readReplayGroups(store, operationId)).resolves.toEqual([
            expect.objectContaining({ groupId, items: staged }),
        ]);
    });

    it.each([
        ['missing', 'External session staging prepared replay is unavailable'],
        ['changed', 'prepared replay does not match its reservation'],
    ] as const)(
        'fails closed when a manifest-bound prepared replay receipt is %s',
        async (corruption, expectedError) => {
            const activeServerDir = await createPrivateRoot(
                'happier-external-staging-prepared-integrity-',
            );
            const operationId = `operation-prepared-${corruption}`;
            const groupId = 'prepared-page';
            const store = createExternalSessionOperationPrivateStagingStore({
                activeServerDir,
                limits: {
                    perOperation: { maxItems: 10, maxBytes: 50_000 },
                    aggregate: { maxItems: 20, maxBytes: 100_000 },
                },
            });
            await store.beginOperation({ operationId, representation: 'content', capturedSource });
            await store.appendPageGroup({
                operationId,
                captureIndex: 0,
                groupId,
                items: [{ id: 'raw-item' }],
                sourceRead: { ...sameSourceRead, eof: true },
            });
            await store.completeCapture({ operationId });
            await store.persistPreparedReplayGroup({
                operationId,
                captureIndex: 0,
                groupId,
                items: [{
                    localId: 'history:raw-item',
                    sidechainId: null,
                    messageRole: 'agent',
                    content: { t: 'encrypted', c: 'ciphertext-v1' },
                }],
            });

            const stagingRoot = stagingRootFor(activeServerDir);
            const operationDirectory = join(
                stagingRoot,
                (await readdir(stagingRoot, { withFileTypes: true }))
                    .find((entry) => entry.isDirectory())!.name,
            );
            const preparedPath = join(operationDirectory, 'prepared-000000000000.json');
            if (corruption === 'missing') {
                await rm(preparedPath);
            } else {
                await writeFile(preparedPath, JSON.stringify({
                    schemaVersion: 1,
                    captureIndex: 0,
                    groupId,
                    items: [{
                        localId: 'history:raw-item',
                        sidechainId: null,
                        messageRole: 'agent',
                        content: { t: 'encrypted', c: 'changed-ciphertext' },
                    }],
                }));
            }

            await expect(readReplayGroups(store, operationId)).rejects.toThrow(expectedError);
        },
    );

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
            stagingRootFor(activeServerDir),
            (await readdir(stagingRootFor(activeServerDir), {
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

    it('binds staging and its capacity budget to the same Account scope as operation records', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-account-');
        const items = [{ id: 'account-a-page' }];
        const bytes = measureExternalSessionStagingPageGroup({
            captureIndex: 0,
            groupId: 'page-account-a',
            items,
        }).serializedBytes;
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 1, maxBytes: bytes },
            },
        });

        useAccount('account-a');
        await store.beginOperation({
            operationId: 'operation-account-a',
            representation: 'content',
            capturedSource,
        });
        expect((await store.appendPageGroup({
            operationId: 'operation-account-a',
            captureIndex: 0,
            groupId: 'page-account-a',
            items,
            sourceRead: sameSourceRead,
        })).status).toBe('stored');

        useAccount('account-b');
        await store.beginOperation({
            operationId: 'operation-account-b',
            representation: 'content',
            capturedSource,
        });
        // Account A's retained staging must not consume Account B's budget.
        expect((await store.appendPageGroup({
            operationId: 'operation-account-b',
            captureIndex: 0,
            groupId: 'page-account-b',
            items: [{ id: 'account-b-page' }],
            sourceRead: sameSourceRead,
        })).status).toBe('stored');
        expect(
            (await readdir(stagingRootFor(activeServerDir, 'account-a'))).length,
        ).toBeGreaterThan(0);
        // A restarted daemon resolves each partition afresh: Account A's retained
        // staging is not reachable from Account B even by exact operation id.
        const restarted = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 1, maxBytes: bytes },
            },
        });
        expect(await restarted.readCapturedSource({
            operationId: 'operation-account-a',
        })).toEqual({ status: 'missing' });
        useAccount('account-a');
        expect(await createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits: {
                perOperation: { maxItems: 10, maxBytes: 10_000 },
                aggregate: { maxItems: 1, maxBytes: bytes },
            },
        }).readCapturedSource({
            operationId: 'operation-account-a',
        })).toEqual({ status: 'ready', capturedSource });
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
            captureIndex: 1,
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

    it('persists created-media cleanup ownership across restart until deletion is acknowledged', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-media-owner-');
        const limits = {
            perOperation: { maxItems: 10, maxBytes: 10_000 },
            aggregate: { maxItems: 10, maxBytes: 10_000 },
        } as const;
        const operationId = 'operation-media-owner';
        const owned = [{
            workingDirectory: '/workspace',
            candidateWorkspaceRelativePath: '.happier/uploads/generated/session/message/file.png',
        }] as const;
        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await store.beginOperation({ operationId, representation: 'content', capturedSource });
        await store.recordCreatedWorkspaceMedia({ operationId, media: owned });

        const restarted = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
        });
        await expect(restarted.readCreatedWorkspaceMediaForCleanup({ operationId }))
            .resolves.toEqual(owned);
        // A failed filesystem deletion does not acknowledge the receipt. The next repair
        // must see the same operation-owned path and may retry the idempotent unlink.
        await expect(restarted.readCreatedWorkspaceMediaForCleanup({ operationId }))
            .resolves.toEqual(owned);
        await restarted.pauseOperation({ operationId, expiresAtMs: 1 });
        await restarted.markExpiredPausedWorkDiscardRequired({ operationId, nowMs: 1 });
        await expect(restarted.cleanupTerminalOperation({ operationId }))
            .resolves.toEqual({ status: 'not_ready' });
        await restarted.acknowledgeCreatedWorkspaceMediaCleanup({ operationId, media: owned });
        await expect(restarted.readCreatedWorkspaceMediaForCleanup({ operationId }))
            .resolves.toEqual([]);
        await expect(restarted.cleanupTerminalOperation({ operationId }))
            .resolves.toEqual({ status: 'completed' });
    });

    it('moves canonical Windows-path cleanup authority from a discarded predecessor to its active successor', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-media-transfer-');
        const limits = {
            perOperation: { maxItems: 10, maxBytes: 10_000 },
            aggregate: { maxItems: 20, maxBytes: 20_000 },
        } as const;
        const predecessorOperationId = 'operation-media-predecessor';
        const successorOperationId = 'operation-media-successor';
        const predecessorMedia = [{
            workingDirectory: 'C:\\Workspace\\Project\\',
            candidateWorkspaceRelativePath: '.happier\\uploads/generated\\session/message\\shared.png',
        }] as const;
        const successorMedia = [{
            workingDirectory: 'c:/workspace/project',
            candidateWorkspaceRelativePath: '.happier/uploads/generated/session/message/shared.png',
        }] as const;
        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await store.beginOperation({
            operationId: predecessorOperationId,
            representation: 'content',
            capturedSource,
        });
        await store.recordCreatedWorkspaceMedia({
            operationId: predecessorOperationId,
            media: predecessorMedia,
        });
        await store.pauseOperation({ operationId: predecessorOperationId, expiresAtMs: 1 });
        await store.markExpiredPausedWorkDiscardRequired({
            operationId: predecessorOperationId,
            nowMs: 1,
        });
        await store.beginOperation({
            operationId: successorOperationId,
            representation: 'content',
            capturedSource,
        });

        await store.transferDiscardedWorkspaceMediaOwnership({
            operationId: successorOperationId,
            media: successorMedia,
        });

        await expect(store.readCreatedWorkspaceMediaForCleanup({
            operationId: predecessorOperationId,
        })).resolves.toEqual([]);
        await expect(store.readCreatedWorkspaceMediaForCleanup({
            operationId: successorOperationId,
        })).resolves.toEqual(successorMedia);
        await expect(store.cleanupTerminalOperation({
            operationId: predecessorOperationId,
        })).resolves.toEqual({ status: 'completed' });
    });

    it('preserves ambiguous exact-path authority when another non-discarded owner remains', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-media-ambiguous-');
        const limits = {
            perOperation: { maxItems: 10, maxBytes: 10_000 },
            aggregate: { maxItems: 30, maxBytes: 30_000 },
        } as const;
        const discardedOperationId = 'operation-media-discarded';
        const activeOwnerOperationId = 'operation-media-active-owner';
        const successorOperationId = 'operation-media-ambiguous-successor';
        const shared = [{
            workingDirectory: '/workspace',
            candidateWorkspaceRelativePath: '.happier/uploads/generated/session/message/shared.png',
        }] as const;
        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        for (const operationId of [
            discardedOperationId,
            activeOwnerOperationId,
            successorOperationId,
        ]) {
            await store.beginOperation({ operationId, representation: 'content', capturedSource });
        }
        await store.recordCreatedWorkspaceMedia({ operationId: discardedOperationId, media: shared });
        await store.recordCreatedWorkspaceMedia({ operationId: activeOwnerOperationId, media: shared });
        await store.pauseOperation({ operationId: discardedOperationId, expiresAtMs: 1 });
        await store.markExpiredPausedWorkDiscardRequired({
            operationId: discardedOperationId,
            nowMs: 1,
        });

        await store.transferDiscardedWorkspaceMediaOwnership({
            operationId: successorOperationId,
            media: shared,
        });

        await expect(store.readCreatedWorkspaceMediaForCleanup({
            operationId: discardedOperationId,
        })).resolves.toEqual([]);
        await expect(store.readCreatedWorkspaceMediaForCleanup({
            operationId: activeOwnerOperationId,
        })).resolves.toEqual(shared);
        await expect(store.readCreatedWorkspaceMediaForCleanup({
            operationId: successorOperationId,
        })).resolves.toEqual([]);
    });

    it('keeps malformed persisted media paths raw-distinct instead of granting alias ownership', async () => {
        const activeServerDir = await createPrivateRoot(
            'happier-external-staging-media-malformed-',
        );
        const limits = {
            perOperation: { maxItems: 10, maxBytes: 10_000 },
            aggregate: { maxItems: 20, maxBytes: 20_000 },
        } as const;
        const predecessorOperationId = 'operation-media-malformed-predecessor';
        const successorOperationId = 'operation-media-malformed-successor';
        const predecessorMedia = [{
            workingDirectory: '/workspace/',
            candidateWorkspaceRelativePath: '../shared.png',
        }] as const;
        const successorMedia = [{
            workingDirectory: '/workspace',
            candidateWorkspaceRelativePath: '../shared.png',
        }] as const;
        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await store.beginOperation({
            operationId: predecessorOperationId,
            representation: 'content',
            capturedSource,
        });
        await store.recordCreatedWorkspaceMedia({
            operationId: predecessorOperationId,
            media: predecessorMedia,
        });
        await store.pauseOperation({ operationId: predecessorOperationId, expiresAtMs: 1 });
        await store.markExpiredPausedWorkDiscardRequired({
            operationId: predecessorOperationId,
            nowMs: 1,
        });
        await store.beginOperation({
            operationId: successorOperationId,
            representation: 'content',
            capturedSource,
        });

        await store.transferDiscardedWorkspaceMediaOwnership({
            operationId: successorOperationId,
            media: successorMedia,
        });

        await expect(store.readCreatedWorkspaceMediaForCleanup({
            operationId: predecessorOperationId,
        })).resolves.toEqual(predecessorMedia);
        await expect(store.readCreatedWorkspaceMediaForCleanup({
            operationId: successorOperationId,
        })).resolves.toEqual([]);
    });

    it('keeps POSIX-root media child identity case-sensitive', async () => {
        const activeServerDir = await createPrivateRoot(
            'happier-external-staging-media-posix-root-',
        );
        const limits = {
            perOperation: { maxItems: 10, maxBytes: 10_000 },
            aggregate: { maxItems: 20, maxBytes: 20_000 },
        } as const;
        const predecessorOperationId = 'operation-media-posix-root-predecessor';
        const successorOperationId = 'operation-media-posix-root-successor';
        const predecessorMedia = [{
            workingDirectory: '/',
            candidateWorkspaceRelativePath: '.happier/uploads/generated/session/message/File.png',
        }] as const;
        const successorMedia = [{
            workingDirectory: '/',
            candidateWorkspaceRelativePath: '.happier/uploads/generated/session/message/file.png',
        }] as const;
        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await store.beginOperation({
            operationId: predecessorOperationId,
            representation: 'content',
            capturedSource,
        });
        await store.recordCreatedWorkspaceMedia({
            operationId: predecessorOperationId,
            media: predecessorMedia,
        });
        await store.pauseOperation({ operationId: predecessorOperationId, expiresAtMs: 1 });
        await store.markExpiredPausedWorkDiscardRequired({
            operationId: predecessorOperationId,
            nowMs: 1,
        });
        await store.beginOperation({
            operationId: successorOperationId,
            representation: 'content',
            capturedSource,
        });

        await store.transferDiscardedWorkspaceMediaOwnership({
            operationId: successorOperationId,
            media: successorMedia,
        });

        await expect(store.readCreatedWorkspaceMediaForCleanup({
            operationId: predecessorOperationId,
        })).resolves.toEqual(predecessorMedia);
        await expect(store.readCreatedWorkspaceMediaForCleanup({
            operationId: successorOperationId,
        })).resolves.toEqual([]);
    });

    it('keeps duplicate-safe ownership after a crash between successor publication and predecessor discharge', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-media-crash-');
        const workingDirectory = await createPrivateRoot('happier-external-staging-media-workspace-');
        const limits = {
            perOperation: { maxItems: 10, maxBytes: 10_000 },
            aggregate: { maxItems: 20, maxBytes: 20_000 },
        } as const;
        const predecessorOperationId = 'operation-media-crash-predecessor';
        const successorOperationId = 'operation-media-crash-successor';
        const relativePath = '.happier/uploads/generated/session/message/shared.png';
        const predecessorMedia = [{
            workingDirectory: `${workingDirectory}/`,
            candidateWorkspaceRelativePath: relativePath.replaceAll('/', '\\'),
        }] as const;
        const successorMedia = [{
            workingDirectory,
            candidateWorkspaceRelativePath: relativePath,
        }] as const;
        await mkdir(join(workingDirectory, '.happier/uploads/generated/session/message'), {
            recursive: true,
        });
        await writeFile(join(workingDirectory, relativePath), 'shared');

        const store = createExternalSessionOperationPrivateStagingStore({ activeServerDir, limits });
        await store.beginOperation({
            operationId: predecessorOperationId,
            representation: 'content',
            capturedSource,
        });
        await store.recordCreatedWorkspaceMedia({
            operationId: predecessorOperationId,
            media: predecessorMedia,
        });
        await store.pauseOperation({ operationId: predecessorOperationId, expiresAtMs: 1 });
        await store.markExpiredPausedWorkDiscardRequired({
            operationId: predecessorOperationId,
            nowMs: 1,
        });
        await store.beginOperation({
            operationId: successorOperationId,
            representation: 'content',
            capturedSource,
        });

        let successorReceiptWritten = false;
        const crashing = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
            persistence: {
                writeJsonAtomic: async (path, value) => {
                    const manifest = value as {
                        operationId?: string;
                        createdWorkspaceMedia?: readonly unknown[];
                    };
                    if (
                        manifest.operationId === successorOperationId
                        && manifest.createdWorkspaceMedia?.length === 1
                    ) {
                        await writeJsonAtomic(path, value);
                        successorReceiptWritten = true;
                        return;
                    }
                    if (
                        successorReceiptWritten
                        && manifest.operationId === predecessorOperationId
                        && manifest.createdWorkspaceMedia?.length === 0
                    ) {
                        throw new Error('simulated crash before predecessor receipt discharge');
                    }
                    await writeJsonAtomic(path, value);
                },
            },
        });
        await expect(crashing.transferDiscardedWorkspaceMediaOwnership({
            operationId: successorOperationId,
            media: successorMedia,
        })).rejects.toThrow('simulated crash before predecessor receipt discharge');

        const restarted = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
        });
        // Either duplicate may be discharged first, but that cleanup pass must preserve the file.
        await expect(restarted.readCreatedWorkspaceMediaForCleanup({
            operationId: predecessorOperationId,
        })).resolves.toEqual([]);
        await expect(readFile(join(workingDirectory, relativePath)))
            .resolves.toEqual(Buffer.from('shared'));
        await expect(restarted.readCreatedWorkspaceMediaForCleanup({
            operationId: successorOperationId,
        })).resolves.toEqual(successorMedia);

        await restarted.pauseOperation({ operationId: successorOperationId, expiresAtMs: 1 });
        await restarted.markExpiredPausedWorkDiscardRequired({
            operationId: successorOperationId,
            nowMs: 1,
        });
        const cleanup = await restarted.readCreatedWorkspaceMediaForCleanup({
            operationId: successorOperationId,
        });
        await garbageCollectUncommittedSessionMedia({
            workingDirectory,
            candidateWorkspaceRelativePaths: cleanup.map(
                (entry) => entry.candidateWorkspaceRelativePath,
            ),
            reason: 'interrupted_ingestion',
        });
        await restarted.acknowledgeCreatedWorkspaceMediaCleanup({
            operationId: successorOperationId,
            media: cleanup,
        });
        await expect(restarted.cleanupTerminalOperation({
            operationId: successorOperationId,
        })).resolves.toEqual({ status: 'completed' });
        await expect(readFile(join(workingDirectory, relativePath)))
            .rejects.toMatchObject({ code: 'ENOENT' });
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
        await expect(readdir(stagingRootFor(activeServerDir)))
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

        const root = stagingRootFor(activeServerDir);
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
    it('keeps the metadata one captured page writes independent of how many pages precede it', async () => {
        // The accepted import ceiling is thousands of pages. If capturing a page
        // republishes every earlier page's metadata, the newest page of a long
        // capture costs proportionally more than the newest page of a short one
        // and the whole import becomes quadratic under the Account capacity lock.
        const measureFinalPageMetadataBytes = async (pageCount: number) => {
            const activeServerDir = await createPrivateRoot(
                `happier-external-staging-page-cost-${pageCount}-`,
            );
            let finalPageMetadataBytes = 0;
            let measuring = false;
            const measuringWriter = async (path: string, value: unknown) => {
                const normalized = path.replaceAll('\\', '/');
                if (
                    measuring
                    && (
                        normalized.endsWith('manifest.json')
                        || /group-\d+\.json$/.test(normalized)
                    )
                ) {
                    finalPageMetadataBytes += Buffer.byteLength(
                        JSON.stringify(value, null, 2),
                        'utf8',
                    );
                }
                await writeJsonAtomic(path, value);
            };
            const store = createExternalSessionOperationPrivateStagingStore({
                activeServerDir,
                limits: {
                    perOperation: { maxItems: 1_000, maxBytes: 4_000_000 },
                    aggregate: { maxItems: 2_000, maxBytes: 8_000_000 },
                },
                persistence: { writeJsonAtomic: measuringWriter },
            });
            await store.beginOperation({
                operationId: 'operation-page-cost',
                representation: 'content',
                capturedSource,
            });
            for (let captureIndex = 0; captureIndex < pageCount; captureIndex += 1) {
                measuring = captureIndex === pageCount - 1;
                expect((await store.appendPageGroup({
                    operationId: 'operation-page-cost',
                    captureIndex,
                    groupId: `cost-page-${captureIndex}`,
                    items: [{ id: `cost-${captureIndex}` }],
                    sourceRead: { ...sameSourceRead, eof: captureIndex === pageCount - 1 },
                })).status).toBe('stored');
            }
            return finalPageMetadataBytes;
        };

        const shortCapture = await measureFinalPageMetadataBytes(8);
        const longCapture = await measureFinalPageMetadataBytes(64);
        expect(shortCapture).toBeGreaterThan(0);
        // Eight times as many preceding pages. A page that republishes them all
        // costs about eight times as much; a page that publishes only itself
        // costs the same plus the few characters its larger indexes and running
        // totals occupy, so it cannot reach even twice the short capture.
        expect(longCapture).toBeLessThan(shortCapture * 2);
    });

    it('serializes concurrent same-Account page appends behind the one staging capacity lock', async () => {
        const activeServerDir = await createPrivateRoot('happier-external-staging-concurrent-lock-');
        const limits = {
            perOperation: { maxItems: 200, maxBytes: 2_000_000 },
            aggregate: { maxItems: 400, maxBytes: 4_000_000 },
        } as const;
        // Every staged mutation runs under one Account-partition `.capacity.lock`.
        // Observing the manifest writes is how a lost or per-operation lock becomes
        // visible: two operations' manifest writes would then interleave.
        const inFlightOperationDirectories = new Set<string>();
        let observedOverlap = false;
        let observedManifestWrites = 0;
        const observingWriter = async (path: string, value: unknown) => {
            if (!path.endsWith('manifest.json')) {
                await writeJsonAtomic(path, value);
                return;
            }
            const operationDirectory = join(path, '..');
            inFlightOperationDirectories.add(operationDirectory);
            observedManifestWrites += 1;
            if (inFlightOperationDirectories.size > 1) observedOverlap = true;
            try {
                // A genuine asynchronous settle, so an unserialized peer would be
                // in flight here rather than merely queued behind this microtask.
                await new Promise((resolve) => setTimeout(resolve, 1));
                await writeJsonAtomic(path, value);
            } finally {
                inFlightOperationDirectories.delete(operationDirectory);
            }
        };
        const store = createExternalSessionOperationPrivateStagingStore({
            activeServerDir,
            limits,
            persistence: { writeJsonAtomic: observingWriter },
        });

        const operationIds = ['operation-lock-a', 'operation-lock-b'] as const;
        for (const operationId of operationIds) {
            expect(await store.beginOperation({
                operationId,
                representation: 'content',
                capturedSource,
            })).toEqual(expect.objectContaining({ status: 'ready' }));
        }

        const appendPages = async (operationId: string) => {
            const outcomes: string[] = [];
            for (let captureIndex = 0; captureIndex < 8; captureIndex += 1) {
                const result = await store.appendPageGroup({
                    operationId,
                    captureIndex,
                    groupId: `${operationId}-page-${captureIndex}`,
                    items: [{ id: `${operationId}-${captureIndex}-1` }],
                    sourceRead: { ...sameSourceRead, eof: captureIndex === 7 },
                });
                outcomes.push(result.status);
            }
            return outcomes;
        };

        const [firstOutcomes, secondOutcomes] = await Promise.all(
            operationIds.map((operationId) => appendPages(operationId)),
        );

        // No waiter may be refused: a capacity-lock timeout surfaces as a throw.
        expect(firstOutcomes).toEqual(Array.from({ length: 8 }, () => 'stored'));
        expect(secondOutcomes).toEqual(Array.from({ length: 8 }, () => 'stored'));
        expect(observedManifestWrites).toBeGreaterThan(0);
        expect(observedOverlap).toBe(false);
        for (const operationId of operationIds) {
            await store.completeCapture({ operationId });
            const groups = await readReplayGroups(store, operationId);
            expect(groups.map((group) => group.groupId)).toEqual(
                Array.from({ length: 8 }, (_unused, index) => `${operationId}-page-${index}`)
                    .reverse(),
            );
        }
    });
});

describe.runIf(process.env.HAPPIER_RUN_EXTERNAL_SESSION_BENCHMARK === '1')(
    'External Sessions private-staging page metadata growth benchmark',
    () => {
        // Every page mutation runs under the Account-partition capacity lock and
        // republishes the operation's page metadata. This measures every
        // metadata byte one accepted import serializes as its page count grows
        // — the operation header AND the per-page reservation rows, so moving a
        // row out of the header cannot make the measurement look bounded on its
        // own. It records the shape and sets no threshold.
        it('measures page metadata serialization as accepted page count grows', async () => {
            const measurePageCount = async (pageCount: number) => {
                const activeServerDir = await createPrivateRoot(
                    `happier-external-staging-growth-${pageCount}-`,
                );
                let pageMetadataWrites = 0;
                let pageMetadataBytes = 0;
                let lastPageMetadataBytes = 0;
                const normalizedPath = (path: string) => path.replaceAll('\\', '/');
                const isPageMetadataWrite = (path: string) => (
                    normalizedPath(path).endsWith('manifest.json')
                    || /group-\d+\.json$/.test(normalizedPath(path))
                );
                const measuringWriter = async (path: string, value: unknown) => {
                    if (isPageMetadataWrite(path)) {
                        const bytes = Buffer.byteLength(
                            JSON.stringify(value, null, 2),
                            'utf8',
                        );
                        pageMetadataWrites += 1;
                        pageMetadataBytes += bytes;
                        lastPageMetadataBytes += bytes;
                    }
                    await writeJsonAtomic(path, value);
                };
                const store = createExternalSessionOperationPrivateStagingStore({
                    activeServerDir,
                    limits: {
                        perOperation: { maxItems: 100_000, maxBytes: 512 * 1024 * 1024 },
                        aggregate: { maxItems: 500_000, maxBytes: 2 * 1024 * 1024 * 1024 },
                    },
                    persistence: { writeJsonAtomic: measuringWriter },
                });
                await store.beginOperation({
                    operationId: 'operation-growth',
                    representation: 'content',
                    capturedSource,
                });
                const startedAt = performance.now();
                for (let captureIndex = 0; captureIndex < pageCount; captureIndex += 1) {
                    if (captureIndex === pageCount - 1) lastPageMetadataBytes = 0;
                    const result = await store.appendPageGroup({
                        operationId: 'operation-growth',
                        captureIndex,
                        groupId: `growth-page-${captureIndex}`,
                        items: [{ id: `growth-${captureIndex}-1` }],
                        sourceRead: {
                            ...sameSourceRead,
                            eof: captureIndex === pageCount - 1,
                        },
                    });
                    expect(result.status).toBe('stored');
                }
                const elapsedMs = performance.now() - startedAt;
                return {
                    pageCount,
                    pageMetadataWrites,
                    pageMetadataBytes,
                    lastPageMetadataBytes,
                    elapsedMs: Math.round(elapsedMs),
                };
            };

            const small = await measurePageCount(200);
            const large = await measurePageCount(400);
            const bytesGrowthRatio = large.pageMetadataBytes / small.pageMetadataBytes;
            process.stdout.write(`EXTERNAL_SESSION_STAGING_PAGE_METADATA_GROWTH ${JSON.stringify({
                small,
                large,
                bytesGrowthRatio: Math.round(bytesGrowthRatio * 100) / 100,
                perPageMetadataBytesAtLargeTail: large.lastPageMetadataBytes,
                note: 'Doubling the page count doubles page metadata bytes when'
                    + ' the per-page cost is bounded, and roughly quadruples them'
                    + ' when every page rewrites all prior page rows.',
            })}\n`);
            expect(small.pageMetadataWrites).toBeGreaterThan(0);
            expect(large.pageMetadataWrites).toBeGreaterThan(small.pageMetadataWrites);
        }, 600_000);
    },
);
