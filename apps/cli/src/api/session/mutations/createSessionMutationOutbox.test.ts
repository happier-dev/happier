import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import type { SessionSyncPendingInputServerContractMode } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import {
    SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';

vi.mock('axios');

let tempHomeDir: string | null = null;
const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
const originalMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
const originalAckTimeoutMs = process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
const originalTranscriptFlushBatchLimit = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT;
const originalDeliveryConcurrency = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY;

function serverContract(mode: SessionSyncPendingInputServerContractMode) {
    return {
        mode,
        runtimeActivity: mode === 'session_sync_v2_pending_input_v1' ? 'v2' : mode === 'released_server_v0_2_1' ? 'legacy' : 'indeterminate',
        pendingInput: mode === 'session_sync_v2_pending_input_v1' ? 'v1' : mode === 'released_server_v0_2_1' ? 'released_server_v0_2_1' : 'indeterminate',
        sessionConnectionEpoch: 1,
        socket: { connected: true },
    } as const;
}

async function useTempHappyHome(): Promise<void> {
    tempHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-outbox-unit-'));
    process.env.HAPPIER_HOME_DIR = tempHomeDir;
}

async function createRuntimePersistenceContext(sessionId: string) {
    const { configuration } = await import('@/configuration');
    const { createSessionMutationPersistenceContext, parseQueuedSessionMutation } = await import('./sessionMutationPersistence');
    return createSessionMutationPersistenceContext({
        activeServerDir: configuration.activeServerDir,
        custody: 'runtime',
        sessionId,
        parseQueuedMutation: parseQueuedSessionMutation,
    });
}

async function readPersistedOutboxMutations(sessionId: string): Promise<unknown[]> {
    const { configuration } = await import('@/configuration');
    const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.json`);
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mutations?: unknown[] };
        return Array.isArray(parsed.mutations) ? parsed.mutations : [];
    } catch {
        return [];
    }
}

async function readDeadLetterEntries(sessionId: string): Promise<unknown[]> {
    const { configuration } = await import('@/configuration');
    const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.dead-letter.json`);
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { entries?: unknown[] };
        return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
        return [];
    }
}

async function writeDeadLetterEntries(sessionId: string, entries: readonly unknown[]): Promise<void> {
    const { configuration } = await import('@/configuration');
    const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.dead-letter.json`);
    await mkdir(join(configuration.activeServerDir, 'session-mutations'), { recursive: true });
    await writeFile(filePath, JSON.stringify({ v: 1, entries }, null, 2), 'utf8');
}

function createDeferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

function createObservationSocket(options: Readonly<{
    connected?: boolean;
    onObservation?: (payload: unknown) => void;
    observe?: (payload: unknown) => Promise<unknown> | unknown;
}> = {}) {
    return createApiSessionSocketStub({
        connected: options.connected ?? true,
        emitWithAck: async (event, payload) => {
            if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                return { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 };
            }
            if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                options.onObservation?.(payload);
                if (options.observe) return await options.observe(payload);
                const localId = (payload as { localId?: unknown }).localId;
                return {
                    ok: true,
                    status: 'observed',
                    id: `server-${String(localId)}`,
                    seq: 1,
                    localId,
                    didWrite: true,
                    ingestedAt: Date.now(),
                };
            }
            return { ok: false, error: 'unsupported' };
        },
    });
}

describe('createSessionMutationOutbox', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.doUnmock('./sessionMutationPersistence');
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.get).mockReset();
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '2';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        await useTempHappyHome();
    });

    it('publishes a generic runtime Activity settlement only after durable admission and dequeue', async () => {
        const sessionId = 's-runtime-activity-exact-tail';
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async (event, payload) => {
                if (event !== SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT) {
                    return { ok: false, error: 'unsupported' };
                }
                const request = payload as { sessionId: string; mutationId: string };
                return {
                    status: 'applied',
                    sessionId: request.sessionId,
                    mutationId: request.mutationId,
                    projection: {
                        state: 'idle',
                        activeCount: 0,
                        observedAt: 1_000,
                        revision: 7,
                    },
                };
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createRuntimeActivitySnapshotMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        await outbox.awaitReady();
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        const before = outbox.readRuntimeActivitySnapshotTail();
        const changed = outbox.waitForRuntimeActivitySnapshotTailChange(before.sequence);

        await outbox.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        }));

        await expect(changed).resolves.toBe(true);
        expect(outbox.readRuntimeActivitySnapshotTail()).toEqual({
            sequence: 2,
            custody: null,
            settlement: {
                identity: {
                    mutationKey: `runtime-activity-snapshot:${sessionId}`,
                    admissionOrder: 1,
                },
                desiredValue: { state: 'idle', activeCount: 0 },
                result: 'applied',
                committedProjection: {
                    state: 'idle',
                    activeCount: 0,
                    observedAt: 1_000,
                    revision: 7,
                },
                committedRevision: 7,
            },
        });
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([]);
        await outbox.close();
    });

    it('assigns runtime Activity admission order only after durable custody succeeds', async () => {
        let rejectFirstActivityAdmission = true;
        vi.doMock('./sessionMutationPersistence', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./sessionMutationPersistence')>();
            return {
                ...actual,
                saveSessionMutationOutbox: vi.fn(async (
                    context: Parameters<typeof actual.saveSessionMutationOutbox>[0],
                    mutations: Parameters<typeof actual.saveSessionMutationOutbox>[1],
                ) => {
                    if (
                        rejectFirstActivityAdmission
                        && mutations.some((mutation) => mutation.kind === 'runtime_activity_snapshot')
                    ) {
                        rejectFirstActivityAdmission = false;
                        throw new Error('injected admission persistence failure');
                    }
                    await actual.saveSessionMutationOutbox(context, mutations);
                }),
            };
        });
        const sessionId = 's-runtime-activity-admission-cut';
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createRuntimeActivitySnapshotMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => createApiSessionSocketStub({ connected: false }),
            requestReconnect: () => {},
        });
        await outbox.awaitReady();
        const mutation = createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        });

        await expect(outbox.enqueueRuntimeActivitySnapshot(mutation))
            .rejects.toThrow('injected admission persistence failure');
        expect(outbox.readRuntimeActivitySnapshotTail()).toEqual({
            sequence: 0,
            custody: null,
            settlement: null,
        });

        await expect(outbox.enqueueRuntimeActivitySnapshot(mutation)).resolves.toMatchObject({
            persisted: true,
        });
        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            sequence: 1,
            custody: {
                identity: {
                    admissionOrder: 1,
                    mutationKey: `runtime-activity-snapshot:${sessionId}`,
                },
                value: { state: 'idle', activeCount: 0 },
            },
            settlement: null,
        });
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([
            expect.objectContaining({
                kind: 'runtime_activity_snapshot',
                mutationId: `runtime-activity-snapshot:${sessionId}`,
                admissionOrder: 1,
            }),
        ]);
        await outbox.close();
    });

    it('returns identical Activity custody without allocating another admission identity or sequence', async () => {
        const sessionId = 's-runtime-activity-identical-custody';
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createRuntimeActivitySnapshotMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => createApiSessionSocketStub({ connected: false }),
            requestReconnect: () => {},
        });
        await outbox.awaitReady();
        const mutation = createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        });

        await outbox.enqueueRuntimeActivitySnapshot(mutation);
        const firstTail = outbox.readRuntimeActivitySnapshotTail();
        await outbox.enqueueRuntimeActivitySnapshot(mutation);

        expect(outbox.readRuntimeActivitySnapshotTail()).toEqual(firstTail);
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([
            expect.objectContaining({
                kind: 'runtime_activity_snapshot',
                admissionOrder: 1,
                mutationId: `runtime-activity-snapshot:${sessionId}`,
            }),
        ]);
        await outbox.close();
    });

    it('coalesces older undelivered Activity custody by stable key and later admission order, not clocks', async () => {
        const sessionId = 's-runtime-activity-admission-wins';
        const deliveredSnapshots: unknown[] = [];
        const { createSessionMutationJournal } = await import('./createSessionMutationOutbox');
        const { createRuntimeActivitySnapshotMutation } = await import('./sessionMutationTypes');
        const journal = createSessionMutationJournal({
            custody: 'runtime',
            sessionId,
            paths: (await createRuntimePersistenceContext(sessionId)).paths,
            admission: (await import('./sessionMutationPersistence')).parseQueuedSessionMutation,
            token: 'tok',
            getSocket: () => createApiSessionSocketStub({ connected: false }),
            requestReconnect: () => {},
            deliverRuntimeActivitySnapshot: async (mutation) => {
                deliveredSnapshots.push(mutation.snapshot);
                return {
                    status: 'delivered',
                    path: 'socket',
                    runtimeActivityEvidence: {
                        disposition: 'unchanged',
                        projection: {
                            ...mutation.snapshot,
                            observedAt: 1,
                            revision: 9,
                        },
                    },
                };
            },
        });
        await journal.awaitReady();

        await journal.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'active', activeCount: 3 },
        }));
        await journal.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        }));

        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([
            expect.objectContaining({
                mutationId: `runtime-activity-snapshot:${sessionId}`,
                admissionOrder: 2,
                payload: expect.objectContaining({
                    snapshot: { state: 'idle', activeCount: 0 },
                }),
            }),
        ]);

        await journal.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await journal.flush('flush');
        expect(deliveredSnapshots).toEqual([
            { state: 'idle', activeCount: 0 },
        ]);
        await journal.close();
    });

    it('hydrates the highest Activity admission order even when a lower order has the later wall clock and file position', async () => {
        const sessionId = 's-runtime-activity-hydrated-admission-wins';
        const deliveredSnapshots: unknown[] = [];
        const { createSessionMutationJournal } = await import('./createSessionMutationOutbox');
        const {
            createRuntimeActivitySnapshotMutation,
        } = await import('./sessionMutationTypes');
        const persistence = await import('./sessionMutationPersistence');
        const context = await createRuntimePersistenceContext(sessionId);
        const stableMutationId = `runtime-activity-snapshot:${sessionId}`;
        await persistence.saveSessionMutationOutbox(context, [
            {
                kind: 'runtime_activity_snapshot',
                mutationId: stableMutationId,
                payload: createRuntimeActivitySnapshotMutation({
                    sessionId,
                    snapshot: { state: 'active', activeCount: 4 },
                }),
                admissionOrder: 2,
                createdAt: 100,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'runtime_activity_snapshot',
                mutationId: stableMutationId,
                payload: createRuntimeActivitySnapshotMutation({
                    sessionId,
                    snapshot: { state: 'idle', activeCount: 0 },
                }),
                admissionOrder: 1,
                createdAt: 10_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);
        const journal = createSessionMutationJournal({
            custody: 'runtime',
            sessionId,
            paths: context.paths,
            admission: persistence.parseQueuedSessionMutation,
            token: 'tok',
            getSocket: () => createApiSessionSocketStub({ connected: true }),
            requestReconnect: () => {},
            deliverRuntimeActivitySnapshot: async (mutation) => {
                deliveredSnapshots.push(mutation.snapshot);
                return { status: 'retryable', reason: 'injected_hold' };
            },
        });
        await journal.awaitReady();

        expect(deliveredSnapshots).toEqual([]);
        expect(journal.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: {
                identity: {
                    admissionOrder: 2,
                    mutationKey: stableMutationId,
                },
                value: { state: 'active', activeCount: 4 },
            },
        });
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([
            expect.objectContaining({ admissionOrder: 2 }),
        ]);
        await journal.close();
    });

    it('does not let an older in-flight ACK settle newer Activity custody', async () => {
        const sessionId = 's-runtime-activity-stale-ack';
        const olderStarted = createDeferred<void>();
        const releaseOlder = createDeferred<void>();
        const newerStarted = createDeferred<void>();
        const releaseNewer = createDeferred<void>();
        let deliveryCount = 0;
        const { createSessionMutationJournal } = await import('./createSessionMutationOutbox');
        const { createRuntimeActivitySnapshotMutation } = await import('./sessionMutationTypes');
        const journal = createSessionMutationJournal({
            custody: 'runtime',
            sessionId,
            paths: (await createRuntimePersistenceContext(sessionId)).paths,
            admission: (await import('./sessionMutationPersistence')).parseQueuedSessionMutation,
            token: 'tok',
            getSocket: () => createApiSessionSocketStub({ connected: true }),
            requestReconnect: () => {},
            deliverRuntimeActivitySnapshot: async (mutation) => {
                deliveryCount += 1;
                if (deliveryCount === 1) {
                    olderStarted.resolve();
                    await releaseOlder.promise;
                } else {
                    newerStarted.resolve();
                    await releaseNewer.promise;
                }
                return {
                    status: 'delivered',
                    path: 'socket',
                    runtimeActivityEvidence: {
                        disposition: deliveryCount === 1 ? 'applied' : 'unchanged',
                        projection: {
                            ...mutation.snapshot,
                            observedAt: deliveryCount,
                            revision: deliveryCount,
                        },
                    },
                };
            },
        });
        await journal.awaitReady();
        await journal.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));

        const older = journal.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        }));
        await olderStarted.promise;
        const newer = journal.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'active', activeCount: 1 },
        }));
        await expect.poll(
            () => journal.readRuntimeActivitySnapshotTail().custody?.identity.admissionOrder,
        ).toBe(2);

        releaseOlder.resolve();
        await newerStarted.promise;
        expect(journal.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: {
                identity: { admissionOrder: 2 },
                value: { state: 'active', activeCount: 1 },
            },
            settlement: null,
        });

        releaseNewer.resolve();
        await Promise.all([older, newer]);
        expect(journal.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: null,
            settlement: {
                identity: { admissionOrder: 2 },
                desiredValue: { state: 'active', activeCount: 1 },
                result: 'unchanged',
            },
        });
        await journal.close();
    });

    it('retains exact Activity custody when applied ACK dequeue persistence fails, then settles unchanged retry', async () => {
        let rejectNextEmptySave = false;
        vi.doMock('./sessionMutationPersistence', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./sessionMutationPersistence')>();
            return {
                ...actual,
                saveSessionMutationOutbox: vi.fn(async (context, mutations) => {
                    if (rejectNextEmptySave && mutations.length === 0) {
                        rejectNextEmptySave = false;
                        throw new Error('injected dequeue persistence failure');
                    }
                    await actual.saveSessionMutationOutbox(context, mutations);
                }),
            };
        });
        const sessionId = 's-runtime-activity-dequeue-retry';
        let deliveryCount = 0;
        const { createSessionMutationJournal } = await import('./createSessionMutationOutbox');
        const { createRuntimeActivitySnapshotMutation } = await import('./sessionMutationTypes');
        const persistence = await import('./sessionMutationPersistence');
        const journal = createSessionMutationJournal({
            custody: 'runtime',
            sessionId,
            paths: (await createRuntimePersistenceContext(sessionId)).paths,
            admission: persistence.parseQueuedSessionMutation,
            token: 'tok',
            getSocket: () => createApiSessionSocketStub({ connected: true }),
            requestReconnect: () => {},
            deliverRuntimeActivitySnapshot: async (mutation) => {
                deliveryCount += 1;
                if (deliveryCount === 1) rejectNextEmptySave = true;
                return {
                    status: 'delivered',
                    path: 'socket',
                    runtimeActivityEvidence: {
                        disposition: deliveryCount === 1 ? 'applied' : 'unchanged',
                        projection: {
                            ...mutation.snapshot,
                            observedAt: deliveryCount,
                            revision: 12,
                        },
                    },
                };
            },
        });
        await journal.awaitReady();
        await journal.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        }));
        expect(deliveryCount).toBe(0);
        await journal.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await expect(journal.flush('flush')).rejects.toThrow('injected dequeue persistence failure');
        expect(deliveryCount).toBe(1);
        expect(journal.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: {
                identity: { admissionOrder: 1 },
                value: { state: 'idle', activeCount: 0 },
            },
            settlement: null,
        });
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([
            expect.objectContaining({ kind: 'runtime_activity_snapshot', admissionOrder: 1 }),
        ]);

        await journal.flush('flush');
        expect(deliveryCount).toBe(2);
        expect(journal.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: null,
            settlement: {
                identity: { admissionOrder: 1 },
                desiredValue: { state: 'idle', activeCount: 0 },
                result: 'unchanged',
                committedProjection: expect.objectContaining({ revision: 12 }),
                committedRevision: 12,
            },
        });
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([]);
        await journal.close();
    });

    it('automatically retries restored Activity custody across a detached retry rejection', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '1';
        let rejectedEmptySavesRemaining = 2;
        vi.doMock('./sessionMutationPersistence', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./sessionMutationPersistence')>();
            return {
                ...actual,
                saveSessionMutationOutbox: vi.fn(async (context, mutations) => {
                    if (rejectedEmptySavesRemaining > 0 && mutations.length === 0) {
                        rejectedEmptySavesRemaining -= 1;
                        throw new Error('injected dequeue persistence failure');
                    }
                    await actual.saveSessionMutationOutbox(context, mutations);
                }),
            };
        });
        const sessionId = 's-runtime-activity-automatic-dequeue-retry';
        let deliveryCount = 0;
        const { createSessionMutationJournal } = await import('./createSessionMutationOutbox');
        const { createRuntimeActivitySnapshotMutation } = await import('./sessionMutationTypes');
        const persistence = await import('./sessionMutationPersistence');
        const journal = createSessionMutationJournal({
            custody: 'runtime',
            sessionId,
            paths: (await createRuntimePersistenceContext(sessionId)).paths,
            admission: persistence.parseQueuedSessionMutation,
            token: 'tok',
            getSocket: () => createApiSessionSocketStub({ connected: true }),
            requestReconnect: () => {},
            deliverRuntimeActivitySnapshot: async (mutation) => {
                deliveryCount += 1;
                return {
                    status: 'delivered',
                    path: 'socket',
                    runtimeActivityEvidence: {
                        disposition: deliveryCount === 1 ? 'applied' : 'unchanged',
                        projection: {
                            ...mutation.snapshot,
                            observedAt: deliveryCount,
                            revision: 12,
                        },
                    },
                };
            },
        });
        await journal.awaitReady();
        await journal.flush('startup');
        await journal.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));

        await journal.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        }));

        await expect.poll(() => journal.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: null,
            settlement: {
                identity: { admissionOrder: 1 },
                result: 'unchanged',
                committedProjection: expect.objectContaining({ revision: 12 }),
                committedRevision: 12,
            },
        });
        expect(deliveryCount).toBe(3);
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([]);
        await journal.close();
    });

    it('retains indeterminate Runtime Activity without blocking unrelated flush or reconnecting', async () => {
        const sessionId = 's-runtime-activity-support-disposition';
        const runtimeDeliveries: unknown[] = [];
        const requestReconnect = vi.fn();
        const socket = createObservationSocket({
            onObservation: () => {},
        });
        socket.emitWithAck = vi.fn(async (event, payload) => {
            if (event === SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT) {
                runtimeDeliveries.push(payload);
                return { status: 'unchanged', sessionId, mutationId: `runtime-activity-snapshot:${sessionId}`, projection: {
                    state: 'idle', activeCount: 0, observedAt: 1, revision: 1,
                } };
            }
            if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                return { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 };
            }
            if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                return { ok: true, status: 'observed', id: 'server-segment', seq: 1, localId: 'segment', didWrite: true, ingestedAt: 1 };
            }
            return { ok: false, error: 'unsupported' };
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createRuntimeActivitySnapshotMutation, createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({ token: 'tok', sessionId, getSocket: () => socket, requestReconnect });

        await outbox.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId,
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment', messageRole: 'agent', content: 'encrypted', createdAt: 1, updatedAt: 1,
        }));

        expect(runtimeDeliveries).toEqual([]);
        expect(requestReconnect).not.toHaveBeenCalled();
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([
            expect.objectContaining({ kind: 'runtime_activity_snapshot' }),
        ]);

        await outbox.setSessionSyncPendingInputServerContract(serverContract('released_server_v0_2_1'));
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([]);
        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({ custody: null, settlement: null });

        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await outbox.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        }));
        expect(runtimeDeliveries).toHaveLength(1);
        await outbox.close();
    });

    it('does not let an older unsupported retirement clear newer Activity custody', async () => {
        let blockNextDeadLetterAppend = false;
        const appendStarted = createDeferred();
        const appendMayFinish = createDeferred();
        vi.doMock('./sessionMutationPersistence', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./sessionMutationPersistence')>();
            return {
                ...actual,
                appendSessionMutationDeadLetters: vi.fn(async (
                    context: Parameters<typeof actual.appendSessionMutationDeadLetters>[0],
                    entries: Parameters<typeof actual.appendSessionMutationDeadLetters>[1],
                ) => {
                    if (blockNextDeadLetterAppend) {
                        blockNextDeadLetterAppend = false;
                        appendStarted.resolve(undefined);
                        await appendMayFinish.promise;
                    }
                    await actual.appendSessionMutationDeadLetters(context, entries);
                }),
            };
        });
        const sessionId = 's-runtime-activity-stale-retirement';
        const { createSessionMutationJournal } = await import('./createSessionMutationOutbox');
        const { parseQueuedSessionMutation } = await import('./sessionMutationPersistence');
        const { createRuntimeActivitySnapshotMutation } = await import('./sessionMutationTypes');
        const journal = createSessionMutationJournal({
            custody: 'runtime',
            sessionId,
            paths: (await createRuntimePersistenceContext(sessionId)).paths,
            admission: parseQueuedSessionMutation,
            token: 'tok',
            getSocket: () => createApiSessionSocketStub({ connected: false }),
            requestReconnect: () => {},
            deliverRuntimeActivitySnapshot: async (mutation) => ({
                status: 'delivered',
                path: 'socket',
                runtimeActivityEvidence: {
                    disposition: 'unchanged',
                    projection: {
                        ...mutation.snapshot,
                        observedAt: 5,
                        revision: 5,
                    },
                },
            }),
        });
        await journal.awaitReady();
        await journal.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'active', activeCount: 1 },
        }));

        blockNextDeadLetterAppend = true;
        const retireOlder = journal.setSessionSyncPendingInputServerContract(serverContract('released_server_v0_2_1'));
        await appendStarted.promise;
        await journal.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        const admitNewer = journal.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        }));
        await vi.waitFor(() => {
            expect(journal.readRuntimeActivitySnapshotTail().custody?.identity.admissionOrder).toBe(2);
        });
        appendMayFinish.resolve(undefined);

        await retireOlder;
        await admitNewer;
        expect(journal.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: null,
            settlement: {
                identity: { admissionOrder: 2 },
                desiredValue: { state: 'idle', activeCount: 0 },
                result: 'unchanged',
                committedProjection: expect.objectContaining({ revision: 5 }),
                committedRevision: 5,
            },
        });
        await journal.close();
    });

    it('keeps an indeterminate Activity ACK from blocking unrelated delivery or reconnecting', async () => {
        const sessionId = 's-runtime-activity-ack-indeterminate';
        const deliveredTranscriptLocalIds: string[] = [];
        const requestReconnect = vi.fn();
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async (event, payload) => {
                if (event === SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT) return {};
                if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                    return { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 };
                }
                if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                    const localId = String((payload as { localId?: unknown }).localId ?? '');
                    deliveredTranscriptLocalIds.push(localId);
                    return { ok: true, status: 'observed', id: 'server-segment', seq: 1, localId, didWrite: true, ingestedAt: 1 };
                }
                return { ok: false, error: 'unsupported' };
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createRuntimeActivitySnapshotMutation, createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({ token: 'tok', sessionId, getSocket: () => socket, requestReconnect });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await outbox.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId, snapshot: { state: 'idle', activeCount: 0 },
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId, provenance: { kind: 'non_dependent', source: 'external' }, localId: 'segment',
            messageRole: 'agent', content: 'encrypted', createdAt: 1, updatedAt: 1,
        }));

        expect(deliveredTranscriptLocalIds).toEqual(['segment']);
        expect(requestReconnect).not.toHaveBeenCalled();
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([
            expect.objectContaining({ kind: 'runtime_activity_snapshot' }),
        ]);
        await outbox.close();
    });

    it('cancelling an exact-tail waiter leaves durable runtime Activity custody intact', async () => {
        const sessionId = 's-runtime-activity-tail-cancel';
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createRuntimeActivitySnapshotMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        await outbox.awaitReady();
        const abort = new AbortController();
        const waiting = outbox.waitForRuntimeActivitySnapshotTailChange(
            outbox.readRuntimeActivitySnapshotTail().sequence,
            abort.signal,
        );
        abort.abort();
        await expect(waiting).resolves.toBe(false);

        await outbox.enqueueRuntimeActivitySnapshot(createRuntimeActivitySnapshotMutation({
            sessionId,
            snapshot: { state: 'idle', activeCount: 0 },
        }));

        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            sequence: 1,
            custody: {
                identity: {
                    admissionOrder: 1,
                    mutationKey: `runtime-activity-snapshot:${sessionId}`,
                },
                value: { state: 'idle', activeCount: 0 },
            },
            settlement: null,
        });
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([
            expect.objectContaining({ kind: 'runtime_activity_snapshot', admissionOrder: 1 }),
        ]);
        await outbox.close();
    });

    it('quarantines hydrated and newly enqueued no-turn session ends instead of retrying them durably', async () => {
        const sessionId = 's-no-broad-end';
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const hydrated = createSessionTurnMutation({
            sessionId,
            mutationId: 'broad-end-hydrated',
            action: 'end_session',
            observedAt: 1_000,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext(sessionId), [{
            kind: 'session_turn',
            mutationId: hydrated.mutationId,
            payload: hydrated,
            createdAt: 1_000,
            attempts: 7,
            nextAttemptAt: 0,
        }]);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => createApiSessionSocketStub({ connected: false }),
            requestReconnect: () => {},
        });

        await outbox.awaitReady();
        await outbox.flush('startup');
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([]);
        await expect(readDeadLetterEntries(sessionId)).resolves.toEqual([
            expect.objectContaining({
                mutationId: 'broad-end-hydrated',
                reason: 'broad_session_end_requires_exact_turn',
            }),
        ]);

        await outbox.enqueueSessionTurn(createSessionTurnMutation({
            sessionId,
            mutationId: 'broad-end-new',
            action: 'end_session',
            observedAt: 2_000,
        }));
        await outbox.flush('flush');

        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([]);
        await expect(readDeadLetterEntries(sessionId)).resolves.toEqual([
            expect.objectContaining({ mutationId: 'broad-end-hydrated' }),
            expect.objectContaining({
                mutationId: 'broad-end-new',
                reason: 'broad_session_end_requires_exact_turn',
            }),
        ]);
        await outbox.close();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
        if (originalMaxAttempts === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = originalMaxAttempts;
        }
        if (originalBaseRetryMs === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
        }
        if (originalJitterMs === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
        }
        if (originalAckTimeoutMs === undefined) {
            delete process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
        } else {
            process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = originalAckTimeoutMs;
        }
        if (originalTranscriptFlushBatchLimit === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT = originalTranscriptFlushBatchLimit;
        }
        if (originalDeliveryConcurrency === undefined) {
            delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY;
        } else {
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY = originalDeliveryConcurrency;
        }
        if (tempHomeDir) {
            await rm(tempHomeDir, { recursive: true, force: true });
            tempHomeDir = null;
        }
    });

    it('drops old-server touch_active schema rejections without blocking a later terminal turn mutation', async () => {
        const deliveredActions: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (_url, body) => {
            const action = (body as { action?: unknown }).action;
            const normalizedAction = typeof action === 'string' ? action : 'unknown';
            deliveredActions.push(normalizedAction);
            if (normalizedAction === 'touch_active') {
                throw { response: { status: 400 } };
            }
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket emit should not be reached while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const touchActive = createSessionTurnMutation({
            sessionId: 's1',
            action: 'touch_active',
            turnId: 'turn-compat',
            provider: 'codex',
            mutationId: 'mutation-touch-active',
            observedAt: 1_000,
        });
        const complete = createSessionTurnMutation({
            sessionId: 's1',
            action: 'complete',
            turnId: 'turn-compat',
            provider: 'codex',
            mutationId: 'mutation-complete',
            observedAt: 1_100,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [
            {
                kind: 'session_turn',
                mutationId: touchActive.mutationId,
                payload: touchActive,
                createdAt: 1_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: complete.mutationId,
                payload: complete,
                createdAt: 1_100,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');

        expect(deliveredActions).toEqual(['touch_active', 'complete']);
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it.each([400, 422] as const)('keeps exhausted HTTP %s turn rejections queued instead of losing authoritative state', async (status) => {
        const deliveredTurnIds: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (_url, body) => {
            const turnId = (body as { turnId?: unknown }).turnId;
            if (typeof turnId === 'string') deliveredTurnIds.push(turnId);
            if (turnId === 'turn-blocked') {
                throw { response: { status } };
            }
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket emit should not be reached while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const blockedBegin = createSessionTurnMutation({
            sessionId: 's1',
            action: 'begin',
            turnId: 'turn-blocked',
            provider: 'codex',
            mutationId: 'mutation-blocked-begin',
            observedAt: 1_000,
        });
        const blockedComplete = createSessionTurnMutation({
            sessionId: 's1',
            action: 'complete',
            turnId: 'turn-blocked',
            provider: 'codex',
            mutationId: 'mutation-blocked-complete',
            observedAt: 1_100,
        });
        const independentBegin = createSessionTurnMutation({
            sessionId: 's1',
            action: 'begin',
            turnId: 'turn-independent',
            provider: 'codex',
            mutationId: 'mutation-independent-begin',
            observedAt: 2_000,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [
            {
                kind: 'session_turn',
                mutationId: blockedBegin.mutationId,
                payload: blockedBegin,
                createdAt: 1_000,
                attempts: 1,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: blockedComplete.mutationId,
                payload: blockedComplete,
                createdAt: 1_100,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: independentBegin.mutationId,
                payload: independentBegin,
                createdAt: 2_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');

        expect(deliveredTurnIds).not.toContain('turn-independent');
        expect(deliveredTurnIds).not.toContain('turn-blocked-complete');
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-blocked-begin',
                attempts: 2,
            }),
            expect.objectContaining({ mutationId: 'mutation-blocked-complete' }),
            expect.objectContaining({ mutationId: 'mutation-independent-begin' }),
        ]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it('retries authoritative turn mutations beyond max attempts and delivers after reconnect', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '0';
        let shouldFail = true;
        vi.mocked(axios.post).mockImplementation(async () => {
            if (shouldFail) {
                throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:41001'), {
                    isAxiosError: true,
                    code: 'ECONNREFUSED',
                });
            }
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const complete = createSessionTurnMutation({
            sessionId: 's-authoritative-retry',
            action: 'complete',
            turnId: 'turn-1',
            provider: 'claude',
            mutationId: 'mutation-complete',
            observedAt: 1_100,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext('s-authoritative-retry'), [{
            kind: 'session_turn',
            mutationId: complete.mutationId,
            payload: complete,
            createdAt: 1_100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's-authoritative-retry',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');
        await outbox.flush('flush');

        await expect(readDeadLetterEntries('s-authoritative-retry')).resolves.toEqual([]);
        const persistedAfterFailures = await readPersistedOutboxMutations('s-authoritative-retry');
        expect(persistedAfterFailures).toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-complete',
            }),
        ]);
        expect((persistedAfterFailures[0] as { attempts?: unknown }).attempts).toBeGreaterThan(1);

        shouldFail = false;
        await outbox.flush('connect');

        expect(vi.mocked(axios.post).mock.calls.length).toBeGreaterThanOrEqual(3);
        await expect(readPersistedOutboxMutations('s-authoritative-retry')).resolves.toEqual([]);
        await expect(readDeadLetterEntries('s-authoritative-retry')).resolves.toEqual([]);
        await outbox.close();
    });

    it('reports a persistently blocking authoritative mutation once without changing its retry custody', async () => {
        const { logger } = await import('@/ui/logger');
        const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 422 } });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation, createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const sessionId = 's-authoritative-blocked-warning';
        const blocked = createSessionTurnMutation({
            sessionId,
            action: 'begin',
            turnId: 'turn-blocked',
            provider: 'claude',
            mutationId: 'mutation-blocked-begin-warning',
            observedAt: 1_000,
        });
        const following = createTranscriptMessageAppendMutation({
            sessionId,
            provenance: { kind: 'non_dependent', source: 'history' },
            localId: 'following-transcript-row',
            messageRole: 'agent',
            content: 'following',
            createdAt: 1_100,
            updatedAt: 1_100,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext(sessionId), [
            {
                kind: 'session_turn',
                mutationId: blocked.mutationId,
                payload: blocked,
                createdAt: 1_000,
                attempts: 1,
                nextAttemptAt: 0,
            },
            {
                kind: 'transcript_message_append',
                mutationId: following.mutationId,
                payload: following,
                intentOrder: 1,
                createdAt: 1_100,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        try {
            await outbox.flush('flush');
            await outbox.flush('flush');

            expect(infoFileSpy).toHaveBeenCalledTimes(1);
            expect(infoFileSpy).toHaveBeenCalledWith(
                '[API] Authoritative session mutation remains queued and is blocking later mutations',
                expect.objectContaining({
                    sessionId,
                    mutationId: blocked.mutationId,
                    mutationKind: 'session_turn',
                    action: 'begin',
                    turnId: 'turn-blocked',
                    provider: 'claude',
                    attempts: 2,
                    deliveryStatus: 'retryable',
                    reason: 'incompatible_session_turn_mutation_http',
                    httpStatus: 422,
                    blockedMutationCount: 1,
                    blockedMutationKinds: { transcript_message_append: 1 },
                }),
            );
            const persisted = await readPersistedOutboxMutations(sessionId);
            expect(persisted).toEqual([
                expect.objectContaining({
                    mutationId: blocked.mutationId,
                }),
                expect.objectContaining({ mutationId: following.mutationId }),
            ]);
            expect((persisted[0] as { attempts?: unknown }).attempts).toEqual(expect.any(Number));
            expect((persisted[0] as { attempts: number }).attempts).toBeGreaterThanOrEqual(2);
            await expect(readDeadLetterEntries(sessionId)).resolves.toEqual([]);
        } finally {
            infoFileSpy.mockRestore();
            await outbox.close();
        }
    });

    it('re-resolves the live server URL and retries a terminal turn mutation after a local endpoint refusal', async () => {
        const attemptedUrls: string[] = [];
        vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:41001');
        vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', '');
        vi.mocked(axios.post).mockImplementation(async (url) => {
            attemptedUrls.push(String(url));
            if (attemptedUrls.length === 1) {
                vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:52002');
                throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:41001'), {
                    isAxiosError: true,
                    code: 'ECONNREFUSED',
                });
            }
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket emit should not be reached while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const complete = createSessionTurnMutation({
            sessionId: 's1',
            action: 'complete',
            turnId: 'turn-1',
            provider: 'claude',
            mutationId: 'mutation-complete',
            observedAt: 1_100,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [{
            kind: 'session_turn',
            mutationId: complete.mutationId,
            payload: complete,
            createdAt: 1_100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        await outbox.flush('flush');

        expect(attemptedUrls).toEqual([
            'http://127.0.0.1:41001/v1/sessions/s1/turns/mutations',
            'http://127.0.0.1:52002/v1/sessions/s1/turns/mutations',
        ]);
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it('serializes concurrent enqueue persists so an older save cannot overwrite a newer accepted mutation', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const saves: Array<{
            mutationIds: string[];
            resolve: () => void;
        }> = [];
        vi.doMock('./sessionMutationPersistence', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./sessionMutationPersistence')>();
            return {
                ...actual,
                loadSessionMutationOutbox: vi.fn(async () => []),
                saveSessionMutationOutbox: vi.fn(async (_sessionId: string, mutations: readonly { mutationId?: unknown }[]) => {
                    if (saves.length >= 2) return;
                    const deferred = createDeferred<void>();
                    saves.push({
                        mutationIds: mutations.map((mutation) => String(mutation.mutationId ?? '')),
                        resolve: () => deferred.resolve(),
                    });
                    await deferred.promise;
                }),
                appendSessionMutationDeadLetters: vi.fn(async () => undefined),
            };
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            sessionId: 's-concurrent-persist',
            token: 'token',
            getSocket: () => createApiSessionSocketStub({ connected: false }),
            requestReconnect: () => {},
        });

        const first = outbox.enqueueSessionTurn(createSessionTurnMutation({
            sessionId: 's-concurrent-persist',
            action: 'begin',
            turnId: 'turn-a',
            mutationId: 'mutation-a-begin',
        }));
        await expect.poll(() => saves.length, { timeout: 100 }).toBe(1);
        const second = outbox.enqueueSessionTurn(createSessionTurnMutation({
            sessionId: 's-concurrent-persist',
            action: 'append_transcript_anchors',
            turnId: 'turn-b',
            mutationId: 'mutation-b-anchors',
        }));
        await Promise.resolve();
        await Promise.resolve();
        const concurrentSaveCountBeforeFirstCompletes = saves.length;

        saves[0].resolve();
        await first;
        await expect.poll(() => saves.length, { timeout: 100 }).toBe(2);
        saves[1].resolve();
        await second;

        expect(concurrentSaveCountBeforeFirstCompletes).toBe(1);
        expect(saves[1].mutationIds).toEqual(expect.arrayContaining([
            'mutation-a-begin',
            'mutation-b-anchors',
        ]));
        await outbox.close();
    });

    it('rechecks pending enqueue persistence after dead-letter recovery yields before offering mutations to transport', async () => {
        const recoveryStarted = createDeferred<void>();
        const releaseRecovery = createDeferred<void>();
        const persistenceStarted = createDeferred<void>();
        const releasePersistence = createDeferred<void>();
        const deliveryStarted = createDeferred<void>();
        let recoveryCallCount = 0;
        let saveCallCount = 0;
        vi.doMock('./sessionMutationPersistence', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./sessionMutationPersistence')>();
            return {
                ...actual,
                recoverAuthoritativeSessionMutationDeadLetters: vi.fn(async () => {
                    recoveryCallCount += 1;
                    if (recoveryCallCount === 1) return [];
                    recoveryStarted.resolve();
                    await releaseRecovery.promise;
                    return [];
                }),
                saveSessionMutationOutbox: vi.fn(async (context, mutations) => {
                    saveCallCount += 1;
                    if (saveCallCount === 1) {
                        persistenceStarted.resolve();
                        await releasePersistence.promise;
                    }
                    await actual.saveSessionMutationOutbox(context, mutations);
                }),
            };
        });
        vi.mocked(axios.post).mockImplementation(async () => {
            deliveryStarted.resolve();
            return { status: 200, data: { ok: true } } as never;
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            sessionId: 's-recovery-enqueue-race',
            token: 'token',
            getSocket: () => createApiSessionSocketStub({ connected: false }),
            requestReconnect: () => {},
        });

        await outbox.awaitReady();
        await recoveryStarted.promise;
        const enqueue = outbox.enqueueSessionTurn(createSessionTurnMutation({
            sessionId: 's-recovery-enqueue-race',
            action: 'begin',
            turnId: 'turn-race',
            mutationId: 'mutation-race',
        }));
        await persistenceStarted.promise;

        try {
            releaseRecovery.resolve();
            const disposition = await Promise.race([
                deliveryStarted.promise.then(() => 'delivered' as const),
                new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
            ]);
            expect(disposition).toBe('pending');
        } finally {
            releaseRecovery.resolve();
            releasePersistence.resolve();
            await enqueue;
            await outbox.close();
        }
    });

    it('keeps unsupported session turn mutations queued after retry exhaustion', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => ({ ok: false, errorCode: 'unsupported' }),
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const begin = createSessionTurnMutation({
            sessionId: 's1',
            action: 'begin',
            turnId: 'turn-unsupported',
            provider: 'codex',
            mutationId: 'mutation-unsupported-begin',
            observedAt: 1_000,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [{
            kind: 'session_turn',
            mutationId: begin.mutationId,
            payload: begin,
            createdAt: 1_000,
            attempts: 0,
            nextAttemptAt: 0,
        }]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');

        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-unsupported-begin',
                attempts: 1,
            }),
        ]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it.each(['begin', 'touch_active'] as const)(
        'does not wait for non-terminal %s session turn delivery before resolving the enqueue',
        async (action) => {
            const delivery = createDeferred<unknown>();
            const socket = createApiSessionSocketStub({
                connected: true,
                emitWithAck: async () => await delivery.promise,
            });
            vi.mocked(axios.post).mockRejectedValue(new Error('HTTP fallback should not run after socket delivery'));
            const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
            const { createSessionTurnMutation } = await import('./sessionMutationTypes');
            const outbox = createSessionMutationOutbox({
                token: 'tok',
                sessionId: 's-non-terminal-turn-delivery',
                getSocket: () => socket,
                requestReconnect: () => {},
            });
            let enqueueSettled = false;
            const enqueue = outbox.enqueueSessionTurn(createSessionTurnMutation({
                sessionId: 's-non-terminal-turn-delivery',
                action,
                turnId: `turn-${action}`,
                provider: 'claude',
                mutationId: `mutation-${action}`,
                observedAt: 1_000,
            })).then(() => {
                enqueueSettled = true;
            });

            try {
                await expect.poll(() => socket.emitWithAck.mock.calls.length).toBe(1);
                await Promise.resolve();
                await Promise.resolve();

                expect(enqueueSettled).toBe(true);
                await expect(readPersistedOutboxMutations('s-non-terminal-turn-delivery')).resolves.toEqual([
                    expect.objectContaining({
                        kind: 'session_turn',
                        mutationId: `mutation-${action}`,
                    }),
                ]);
            } finally {
                delivery.resolve({ ok: true });
                await Promise.allSettled([enqueue]);
                await outbox.close();
            }
        },
    );

    it.each(['fail', 'cancel'] as const)(
        'awaits delivery flush before resolving terminal %s session turn enqueues',
        async (action) => {
            const delivery = createDeferred<unknown>();
            const socket = createApiSessionSocketStub({
                connected: true,
                emitWithAck: async () => await delivery.promise,
            });
            vi.mocked(axios.post).mockRejectedValue(new Error('HTTP fallback should not run after socket delivery'));
            const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
            const { createSessionTurnMutation } = await import('./sessionMutationTypes');
            const outbox = createSessionMutationOutbox({
                token: 'tok',
                sessionId: 's-terminal-turn-delivery',
                getSocket: () => socket,
                requestReconnect: () => {},
            });
            let enqueueSettled = false;
            const enqueue = outbox.enqueueSessionTurn(createSessionTurnMutation({
                sessionId: 's-terminal-turn-delivery',
                action,
                turnId: `turn-${action}`,
                provider: 'claude',
                ...(action === 'fail'
                    ? {
                        issue: {
                            v: 1,
                            scope: 'primary_session',
                            status: 'failed',
                            code: 'provider_session_error',
                            source: 'provider_session_error',
                            occurredAt: 1_000,
                            provider: 'claude',
                            sanitizedPreview: 'Claude terminal delivery failed',
                        },
                    }
                    : {}),
                mutationId: `mutation-${action}`,
                observedAt: 1_000,
            })).then(() => {
                enqueueSettled = true;
            });

            try {
                await expect.poll(() => socket.emitWithAck.mock.calls.length).toBe(1);
                await Promise.resolve();
                await Promise.resolve();

                expect(enqueueSettled).toBe(false);

                delivery.resolve({ ok: true });
                await enqueue;
                expect(enqueueSettled).toBe(true);
                await expect(readPersistedOutboxMutations('s-terminal-turn-delivery')).resolves.toEqual([]);
            } finally {
                delivery.resolve({ ok: true });
                await Promise.allSettled([enqueue]);
                await outbox.close();
            }
        },
    );

    it('persists a transcript committed snapshot when observation transport is unavailable', async () => {
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket should not be used while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Hello' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));

        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s1:segment-1',
                payload: expect.objectContaining({
                    source: 'transcript_message_append',
                    localId: 'segment-1',
                    messageRole: 'agent',
                    content: expect.objectContaining({
                        t: 'plain',
                        v: expect.objectContaining({
                            content: expect.objectContaining({ text: 'Hello' }),
                        }),
                    }),
                }),
            }),
        ]);
        expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
        await outbox.close();
    });

    it('quarantines a permanently invalid transcript row without blocking the following row', async () => {
        const observedLocalIds: string[] = [];
        const socket = createObservationSocket({
            observe: (payload) => {
                const localId = String((payload as { localId?: unknown }).localId ?? '');
                observedLocalIds.push(localId);
                return localId === 'invalid-history-row'
                    ? { ok: false, error: 'invalid_observation' }
                    : {
                        ok: true,
                        status: 'observed',
                        id: `server-${localId}`,
                        seq: 2,
                        localId,
                        didWrite: true,
                        ingestedAt: 2_000,
                    };
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's-invalid-history',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        const transcriptMutation = (localId: string) => createTranscriptMessageAppendMutation({
            sessionId: 's-invalid-history',
            provenance: { kind: 'non_dependent', source: 'history' },
            localId,
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: localId } } },
            createdAt: 1_000,
            updatedAt: 1_000,
        });

        await outbox.enqueueTranscriptMessage(transcriptMutation('invalid-history-row'));
        await outbox.enqueueTranscriptMessage(transcriptMutation('following-history-row'));
        await outbox.flush('flush');

        await expect(readPersistedOutboxMutations('s-invalid-history')).resolves.toEqual([]);
        await expect(readDeadLetterEntries('s-invalid-history')).resolves.toEqual([
            expect.objectContaining({
                mutationId: 'transcript:s-invalid-history:invalid-history-row',
                reason: 'permanent_invalid_payload',
                diagnostic: expect.objectContaining({
                    deliveryStatus: 'permanent_invalid_payload',
                    reason: 'transcript_observation_invalid',
                }),
            }),
        ]);
        expect(observedLocalIds.filter((localId) => localId === 'following-history-row')).toHaveLength(1);
        await outbox.close();
    });

    it('reports transcript snapshots as not persisted when enqueued after outbox close', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async () => {
                throw new Error('socket should not be used while disconnected');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        await outbox.close();

        const result = await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-after-close',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Late' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));

        expect(result).toEqual({ persisted: false, delivered: false });
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
    });

    it('coalesces repeated transcript snapshots by localId and keeps the latest content', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Older' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Newest' } } },
            createdAt: 1_000,
            updatedAt: 1_200,
        }));

        const persisted = await readPersistedOutboxMutations('s1');
        expect(persisted).toHaveLength(1);
        expect(JSON.stringify(persisted[0])).toContain('Newest');
        expect(JSON.stringify(persisted[0])).not.toContain('Older');
        await outbox.close();
    });

    it('uses enqueue intent order when the wall clock moves backward for a newer transcript revision', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Revision one' } } },
            createdAt: 1_000,
            updatedAt: 1_200,
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Revision two' } } },
            createdAt: 900,
            updatedAt: 1_100,
        }));

        const persisted = await readPersistedOutboxMutations('s1');
        expect(persisted).toHaveLength(1);
        expect(JSON.stringify(persisted[0])).toContain('Revision two');
        expect(JSON.stringify(persisted[0])).not.toContain('Revision one');
        await outbox.close();
    });

    it('keeps the newer persisted transcript snapshot when stale duplicate records load last', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const newer = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Persisted newer' } } },
            createdAt: 1_000,
            updatedAt: 1_200,
        });
        const older = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            sidechainId: 'sc-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Persisted stale last' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [
            {
                kind: 'transcript_message_append',
                mutationId: newer.mutationId,
                payload: newer,
                createdAt: 1_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'transcript_message_append',
                mutationId: older.mutationId,
                payload: older,
                createdAt: 1_010,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        await outbox.flush('startup');

        const persisted = await readPersistedOutboxMutations('s1');
        expect(persisted).toHaveLength(1);
        expect(JSON.stringify(persisted[0])).toContain('Persisted newer');
        expect(JSON.stringify(persisted[0])).not.toContain('Persisted stale last');
        await outbox.close();
    });

    it('does not let a stale in-flight transcript retry overwrite a newer queued snapshot', async () => {
        let rejectFirstObservation: ((error: Error) => void) | null = null;
        let observationCount = 0;
        const socket = createObservationSocket({
            observe: async () => {
                observationCount += 1;
                if (observationCount === 1) {
                    return await new Promise((_resolve, reject) => {
                        rejectFirstObservation = reject;
                    });
                }
                throw new Error('server unavailable');
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const oldMutation = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Older in-flight' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [{
            kind: 'transcript_message_append',
            mutationId: oldMutation.mutationId,
            payload: oldMutation,
            createdAt: 1_000,
            attempts: 0,
            nextAttemptAt: 0,
        }]);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        for (let i = 0; i < 20 && !rejectFirstObservation; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (!rejectFirstObservation) {
            throw new Error('expected old transcript delivery to be in flight');
        }
        const rejectOldDelivery: (error: Error) => void = rejectFirstObservation;
        const enqueueNewer = outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Newer queued' } } },
            createdAt: 900,
            updatedAt: 1_000,
        }));
        rejectOldDelivery(new Error('old delivery failed'));
        await enqueueNewer;

        const persisted = await readPersistedOutboxMutations('s1');
        expect(persisted).toHaveLength(1);
        expect(JSON.stringify(persisted[0])).toContain('Newer queued');
        expect(JSON.stringify(persisted[0])).not.toContain('Older in-flight');
        await outbox.close();
    });

    it('persists the exact in-flight remainder before admitting a concurrent transcript enqueue', async () => {
        const sessionId = 's-concurrent-drain-enqueue';
        const firstAck = createDeferred<unknown>();
        const deliveredLocalIds: string[] = [];
        const socket = createObservationSocket({
            onObservation: (payload) => {
                const localId = (payload as { localId?: unknown }).localId;
                if (typeof localId === 'string') deliveredLocalIds.push(localId);
            },
            observe: async (payload) => {
                const localId = (payload as { localId?: unknown }).localId;
                if (localId === 'segment-a') return await firstAck.promise;
                return {
                    ok: true,
                    status: 'observed',
                    id: `server-${String(localId)}`,
                    seq: 1,
                    localId,
                    didWrite: true,
                    ingestedAt: Date.now(),
                };
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const {
            parseQueuedSessionMutation,
            saveSessionMutationOutbox,
        } = await import('./sessionMutationPersistence');
        const createMutation = (localId: string, order: number) => createTranscriptMessageAppendMutation({
            sessionId,
            provenance: { kind: 'non_dependent', source: 'external' },
            localId,
            messageRole: 'agent',
            content: localId,
            createdAt: order,
            updatedAt: order,
        });
        const initial = ['segment-a', 'segment-b'].map((localId, index) => {
            const payload = createMutation(localId, index + 1);
            return {
                kind: 'transcript_message_append' as const,
                mutationId: payload.mutationId,
                payload,
                intentOrder: index + 1,
                createdAt: index + 1,
                attempts: 0,
                nextAttemptAt: 0,
            };
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext(sessionId), initial);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await expect.poll(() => deliveredLocalIds).toEqual(['segment-a']);
        const enqueueLate = outbox.enqueueTranscriptMessage(createMutation('segment-c', 3));
        await expect.poll(async () => (
            (await readPersistedOutboxMutations(sessionId)).map((value) => {
                const parsed = parseQueuedSessionMutation(value, sessionId);
                return parsed.ok && parsed.mutation.kind === 'transcript_message_append'
                    ? parsed.mutation.payload.localId
                    : null;
            })
        )).toEqual(['segment-a', 'segment-b', 'segment-c']);
        firstAck.resolve({
            ok: true,
            status: 'observed',
            id: 'server-segment-a',
            seq: 1,
            localId: 'segment-a',
            didWrite: true,
            ingestedAt: Date.now(),
        });

        await enqueueLate;
        expect(deliveredLocalIds).toEqual(['segment-a', 'segment-b', 'segment-c']);
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([]);
        await outbox.close();
    });

    it('restarts from the full ordered batch after the first delivery response is lost', async () => {
        const sessionId = 's-response-loss-restart';
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const createMutation = (localId: string, order: number) => createTranscriptMessageAppendMutation({
            sessionId,
            provenance: { kind: 'non_dependent', source: 'external' },
            localId,
            messageRole: 'agent',
            content: localId,
            createdAt: order,
            updatedAt: order,
        });
        const initial = ['segment-a', 'segment-b'].map((localId, index) => {
            const payload = createMutation(localId, index + 1);
            return {
                kind: 'transcript_message_append' as const,
                mutationId: payload.mutationId,
                payload,
                intentOrder: index + 1,
                createdAt: index + 1,
                attempts: 0,
                nextAttemptAt: 0,
            };
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext(sessionId), initial);
        const failedAttempts: string[] = [];
        const first = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => createObservationSocket({
                onObservation: (payload) => {
                    const localId = (payload as { localId?: unknown }).localId;
                    if (typeof localId === 'string') failedAttempts.push(localId);
                },
                observe: () => {
                    throw new Error('response lost after server observation');
                },
            }),
            requestReconnect: () => {},
        });

        await first.flush('flush');
        expect(failedAttempts).toEqual(['segment-a']);
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([
            expect.objectContaining({ mutationId: initial[0].mutationId }),
            expect.objectContaining({ mutationId: initial[1].mutationId }),
        ]);
        await first.close();

        const recoveredLocalIds: string[] = [];
        const restarted = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => createObservationSocket({
                onObservation: (payload) => {
                    const localId = (payload as { localId?: unknown }).localId;
                    if (typeof localId === 'string') recoveredLocalIds.push(localId);
                },
            }),
            requestReconnect: () => {},
        });
        await restarted.flush('flush');

        expect(recoveredLocalIds).toEqual(['segment-a', 'segment-b']);
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([]);
        await restarted.close();
    });

    it('flushes only the latest coalesced transcript snapshot after reconnect', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '0';
        const deliveredObservations: unknown[] = [];
        const socket = createObservationSocket({
            connected: false,
            onObservation: (payload) => deliveredObservations.push(payload),
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Part one' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Final answer' } } },
            createdAt: 1_000,
            updatedAt: 1_200,
        }));

        socket.connected = true;
        await outbox.flush('connect');

        expect(deliveredObservations).toHaveLength(1);
        expect(deliveredObservations[0]).toMatchObject({
            content: expect.objectContaining({
                v: expect.objectContaining({
                    content: expect.objectContaining({ text: 'Final answer' }),
                }),
            }),
            localId: 'segment-1',
            messageRole: 'agent',
        });
        expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it('rejects transcript coalescing when a reused localId changes sidechain', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            sidechainId: 'sc-a',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'A' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));

        await expect(outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            sidechainId: 'sc-b',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'B' } } },
            createdAt: 1_000,
            updatedAt: 1_200,
        }))).rejects.toThrow(/sidechain/i);
        await outbox.close();
    });

    it('preserves delivery order for transcript snapshots with different localIds', async () => {
        const deliveredLocalIds: string[] = [];
        const socket = createObservationSocket({
            onObservation: (payload) => {
                const localId = (payload as { localId?: unknown }).localId;
                if (typeof localId === 'string') deliveredLocalIds.push(localId);
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-a',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'A' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-b',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'B' } } },
            createdAt: 1_010,
            updatedAt: 1_200,
        }));

        expect(deliveredLocalIds).toEqual(['segment-a', 'segment-b']);
        expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
        await outbox.close();
    });

    it('retains exhausted transcript retries and preserves later exact turns while observation is unavailable', async () => {
        const deliveredUrls: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (url) => {
            deliveredUrls.push(String(url));
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createObservationSocket({
            observe: () => ({ ok: false, error: 'internal' }),
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const {
            createSessionTurnMutation,
            createTranscriptMessageAppendMutation,
        } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const transcript = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'lost' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        const turn = createSessionTurnMutation({
            sessionId: 's1',
            mutationId: 'turn-independent',
            action: 'cancel',
            turnId: 'turn-independent',
            observedAt: 2_000,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [
            {
                kind: 'transcript_message_append',
                mutationId: transcript.mutationId,
                payload: transcript,
                createdAt: 1_000,
                attempts: 1,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: turn.mutationId,
                payload: turn,
                createdAt: 2_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('flush');

        expect(deliveredUrls).toEqual([]);
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s1:segment-1',
            }),
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'turn-independent',
            }),
        ]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([]);
        await outbox.close();
    });

    it('does not manufacture a no-turn terminal mutation from incomplete dead-letter evidence', async () => {
        const deliveredUrls: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (url) => {
            deliveredUrls.push(String(url));
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const {
            createSessionTurnMutation,
            createTranscriptMessageAppendMutation,
        } = await import('./sessionMutationTypes');
        const turn = createSessionTurnMutation({
            sessionId: 's-dead-letter-recovery',
            action: 'complete',
            turnId: 'turn-1',
            provider: 'claude',
            mutationId: 'mutation-recovered-complete',
            observedAt: 1_100,
        });
        const transcript = createTranscriptMessageAppendMutation({
            sessionId: 's-dead-letter-recovery',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-lost',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'lossy' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        await writeDeadLetterEntries('s-dead-letter-recovery', [
            {
                v: 1,
                kind: 'session_turn',
                sessionId: 's-dead-letter-recovery',
                mutationId: turn.mutationId,
                reason: 'retry_exhausted',
                attempts: 12,
                createdAt: 1_100,
                deadLetteredAt: 1_300,
                payloadSummary: {
                    keys: ['action', 'mutationId', 'observedAt', 'provider', 'sessionId', 'turnId', 'v'],
                    action: 'complete',
                    mutationId: turn.mutationId,
                    sessionId: 's-dead-letter-recovery',
                },
            },
            {
                v: 1,
                kind: 'transcript_message_append',
                sessionId: 's-dead-letter-recovery',
                mutationId: transcript.mutationId,
                reason: 'retry_exhausted',
                attempts: 12,
                createdAt: 1_000,
                deadLetteredAt: 1_300,
                queuedMutation: {
                    kind: 'transcript_message_append',
                    mutationId: transcript.mutationId,
                    payload: transcript,
                    createdAt: 1_000,
                    attempts: 12,
                    nextAttemptAt: 0,
                },
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's-dead-letter-recovery',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('connect');
        await outbox.flush('connect');

        expect(deliveredUrls).toEqual([]);
        await expect(readPersistedOutboxMutations('s-dead-letter-recovery')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s-dead-letter-recovery:segment-lost',
            }),
        ]);
        const deadLetters = await readDeadLetterEntries('s-dead-letter-recovery');
        expect(deadLetters[0]).toEqual(
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-recovered-complete',
            }),
        );
        expect(deadLetters[0]).not.toHaveProperty('recoveryAttemptedAt');
        expect(deadLetters[1]).toEqual(expect.objectContaining({
            kind: 'transcript_message_append',
            mutationId: 'transcript:s-dead-letter-recovery:segment-lost',
            recoveryAttemptedAt: expect.any(Number),
        }));
        await outbox.close();
    });

    it('persists an authoritative dead-letter recovery before offering it to transport', async () => {
        const sessionId = 's-recovery-custody-order';
        const persistedAtDelivery: unknown[][] = [];
        vi.mocked(axios.post).mockImplementation(async () => {
            persistedAtDelivery.push(await readPersistedOutboxMutations(sessionId));
            return { status: 200, data: { ok: true } } as never;
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const turn = createSessionTurnMutation({
            sessionId,
            action: 'complete',
            turnId: 'turn-recovered',
            provider: 'claude',
            mutationId: 'mutation-recovered',
            observedAt: 1_100,
        });
        const queuedMutation = {
            kind: 'session_turn' as const,
            mutationId: turn.mutationId,
            payload: turn,
            createdAt: 1_100,
            attempts: 12,
            nextAttemptAt: 0,
        };
        await writeDeadLetterEntries(sessionId, [{
            v: 1,
            kind: 'session_turn',
            sessionId,
            mutationId: turn.mutationId,
            reason: 'retry_exhausted',
            attempts: 12,
            createdAt: 1_100,
            deadLetteredAt: 1_300,
            queuedMutation,
        }]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => createApiSessionSocketStub({ connected: false }),
            requestReconnect: () => {},
        });

        await outbox.flush('connect');

        expect(persistedAtDelivery).toHaveLength(1);
        expect(persistedAtDelivery[0]).toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'mutation-recovered',
            }),
        ]);
        await outbox.close();
    });

    it('rewrites quarantined startup rows before offering surviving mutations to transport', async () => {
        const sessionId = 's-startup-quarantine-order';
        const persistedAtDelivery: unknown[][] = [];
        vi.mocked(axios.post).mockImplementation(async () => {
            persistedAtDelivery.push(await readPersistedOutboxMutations(sessionId));
            return { status: 200, data: { ok: true } } as never;
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const invalidBroadEnd = createSessionTurnMutation({
            sessionId,
            action: 'end_session',
            mutationId: 'invalid-broad-end',
            observedAt: 1_000,
        });
        const validComplete = createSessionTurnMutation({
            sessionId,
            action: 'complete',
            turnId: 'turn-valid',
            mutationId: 'valid-complete',
            observedAt: 1_100,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext(sessionId), [
            {
                kind: 'session_turn',
                mutationId: invalidBroadEnd.mutationId,
                payload: invalidBroadEnd,
                createdAt: 1_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: validComplete.mutationId,
                payload: validComplete,
                createdAt: 1_100,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);

        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => createApiSessionSocketStub({ connected: false }),
            requestReconnect: () => {},
        });

        await outbox.flush('startup');

        expect(persistedAtDelivery).toHaveLength(1);
        expect(persistedAtDelivery[0]).toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'valid-complete',
            }),
        ]);
        await outbox.close();
    });

    it('keeps socket ACK timeouts queued and requests reconnect for transcript snapshots', async () => {
        process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '1';
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const requestReconnect = vi.fn();
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async () => await new Promise<never>(() => {}),
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect,
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'queued' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }));

        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s1:segment-1',
            }),
        ]);
        expect(requestReconnect).toHaveBeenCalled();
        await outbox.close();
    });

    it('sends acknowledged transcript observations with encrypted and plain content shapes', async () => {
        const deliveredObservations: unknown[] = [];
        const socket = createObservationSocket({
            onObservation: (payload) => deliveredObservations.push(payload),
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'encrypted-1',
            messageRole: 'agent',
            content: 'encrypted-payload',
            createdAt: 1_000,
            updatedAt: 1_100,
        }));
        await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'plain-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'plain' } } },
            createdAt: 1_200,
            updatedAt: 1_300,
        }));

        expect(deliveredObservations).toEqual([
            expect.objectContaining({
                content: 'encrypted-payload',
                localId: 'encrypted-1',
                messageRole: 'agent',
            }),
            expect.objectContaining({
                content: expect.objectContaining({
                    t: 'plain',
                    v: expect.objectContaining({
                        content: expect.objectContaining({ text: 'plain' }),
                    }),
                }),
                localId: 'plain-1',
                messageRole: 'agent',
            }),
        ]);
        expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
        await outbox.close();
    });

    it('delivers transcript snapshots through the exact released-server-v0.2.1 message seam', async () => {
        const emitted: Array<{ event: string; payload: unknown }> = [];
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async (event, payload) => {
                emitted.push({ event, payload });
                return event === 'message'
                    ? { ok: true, id: 'message-1', seq: 1, localId: 'gemini-segment', didWrite: true }
                    : { ok: false, error: 'unsupported' };
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's-gemini-released',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('released_server_v0_2_1'));

        await expect(outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: 's-gemini-released',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'gemini-segment',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Gemini output' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        }))).resolves.toEqual({ persisted: true, delivered: true });

        expect(emitted).toEqual([{
            event: 'message',
            payload: {
                sid: 's-gemini-released',
                message: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Gemini output' } } },
                localId: 'gemini-segment',
                echoToSender: true,
                messageRole: 'agent',
            },
        }]);
        await expect(readPersistedOutboxMutations('s-gemini-released')).resolves.toEqual([]);
        await outbox.close();
    });

    it('caps transcript deliveries per reconnect flush without blocking other mutation kinds', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        const deliveredUrls: string[] = [];
        const deliveredTranscriptLocalIds: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (url) => {
            deliveredUrls.push(String(url));
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createObservationSocket({
            onObservation: (payload) => {
                const localId = (payload as { localId?: unknown }).localId;
                if (typeof localId === 'string') deliveredTranscriptLocalIds.push(localId);
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const {
            createSessionTurnMutation,
            createTranscriptMessageAppendMutation,
        } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const firstTranscript = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-1',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'first' } } },
            createdAt: 1_000,
            updatedAt: 1_100,
        });
        const secondTranscript = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            provenance: { kind: 'non_dependent', source: 'external' },
            localId: 'segment-2',
            messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'second' } } },
            createdAt: 1_010,
            updatedAt: 1_200,
        });
        const turn = createSessionTurnMutation({
            sessionId: 's1',
            mutationId: 'turn-independent',
            action: 'cancel',
            turnId: 'turn-independent',
            observedAt: 2_000,
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [
            {
                kind: 'transcript_message_append',
                mutationId: firstTranscript.mutationId,
                payload: firstTranscript,
                createdAt: 1_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'transcript_message_append',
                mutationId: secondTranscript.mutationId,
                payload: secondTranscript,
                createdAt: 1_010,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: turn.mutationId,
                payload: turn,
                createdAt: 2_000,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await outbox.flush('connect');

        expect(deliveredTranscriptLocalIds).toEqual(['segment-1']);
        expect(deliveredUrls.some((url) => url.includes('/turns/mutations'))).toBe(true);
        await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s1:segment-2',
            }),
        ]);
        await outbox.close();
    });

    it('limits durable deliveries globally across reattached session outboxes', async () => {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY = '1';
        const startedUrls: string[] = [];
        const releases: Array<() => void> = [];
        let activeDeliveries = 0;
        let maxActiveDeliveries = 0;
        const socket = createObservationSocket({
            observe: async (payload) => {
                startedUrls.push(String((payload as { localId?: unknown }).localId));
                activeDeliveries += 1;
                maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
                await new Promise<void>((resolve) => {
                    releases.push(resolve);
                });
                activeDeliveries -= 1;
                const localId = (payload as { localId?: unknown }).localId;
                return {
                    ok: true,
                    status: 'observed',
                    id: `server-${String(localId)}`,
                    seq: 1,
                    localId,
                    didWrite: true,
                    ingestedAt: Date.now(),
                };
            },
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');

        for (const sessionId of ['s1', 's2']) {
            const mutation = createTranscriptMessageAppendMutation({
                sessionId,
                provenance: { kind: 'non_dependent', source: 'external' },
                localId: `segment-${sessionId}`,
                messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: sessionId } } },
                createdAt: 1_000,
                updatedAt: 1_100,
            });
            await saveSessionMutationOutbox(await createRuntimePersistenceContext(sessionId), [{
                kind: 'transcript_message_append',
                mutationId: mutation.mutationId,
                payload: mutation,
                createdAt: 1_000,
                attempts: 0,
                nextAttemptAt: 0,
            }]);
        }

        const outbox1 = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's1',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        const outbox2 = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's2',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        const flush1 = outbox1.flush('connect');
        const flush2 = outbox2.flush('connect');

        try {
            await expect.poll(() => startedUrls.length).toBeGreaterThanOrEqual(1);
            await Promise.resolve();
            await Promise.resolve();

            expect(startedUrls).toHaveLength(1);
            expect(maxActiveDeliveries).toBe(1);

            releases.shift()?.();
            await expect.poll(() => startedUrls.length).toBe(2);
            expect(maxActiveDeliveries).toBe(1);
            expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
        } finally {
            for (const release of releases.splice(0)) release();
            await Promise.allSettled([flush1, flush2]);
            await outbox1.close();
            await outbox2.close();
        }
    });

    it('serializes same-session outbox handles through one owner so concurrent enqueues cannot overwrite the file', async () => {
        vi.mocked(axios.post).mockRejectedValue(new Error('server unavailable'));
        const saves: Array<{
            mutationIds: string[];
            resolve: () => void;
        }> = [];
        vi.doMock('./sessionMutationPersistence', async (importOriginal) => {
            const actual = await importOriginal<typeof import('./sessionMutationPersistence')>();
            return {
                ...actual,
                loadSessionMutationOutbox: vi.fn(async () => []),
                saveSessionMutationOutbox: vi.fn(async (_sessionId: string, mutations: readonly { mutationId?: unknown }[]) => {
                    if (saves.length >= 2) return;
                    const deferred = createDeferred<void>();
                    saves.push({
                        mutationIds: mutations.map((mutation) => String(mutation.mutationId ?? '')),
                        resolve: () => deferred.resolve(),
                    });
                    await deferred.promise;
                }),
                appendSessionMutationDeadLetters: vi.fn(async () => undefined),
            };
        });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const {
            createSessionTurnMutation,
        } = await import('./sessionMutationTypes');
        const socket = createApiSessionSocketStub({ connected: false });
        const firstHandle = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's-shared-owner',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        const secondHandle = createSessionMutationOutbox({
            token: 'tok',
            sessionId: 's-shared-owner',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        const first = firstHandle.enqueueSessionTurn(createSessionTurnMutation({
            sessionId: 's-shared-owner',
            action: 'begin',
            turnId: 'turn-1',
            mutationId: 'mutation-turn-begin',
            observedAt: 1_000,
        }));
        await expect.poll(() => saves.length, { timeout: 100 }).toBe(1);
        const second = secondHandle.enqueueSessionTurn(createSessionTurnMutation({
            sessionId: 's-shared-owner',
            mutationId: 'mutation-turn-cancel',
            action: 'cancel',
            turnId: 'turn-1',
            observedAt: 2_000,
        }));
        await Promise.resolve();
        await Promise.resolve();
        const saveCountBeforeFirstCompletes = saves.length;

        saves[0].resolve();
        await first;
        await expect.poll(() => saves.length, { timeout: 100 }).toBe(2);
        saves[1].resolve();
        await second;

        expect(saveCountBeforeFirstCompletes).toBe(1);
        expect(saves[1].mutationIds).toEqual(expect.arrayContaining([
            'mutation-turn-begin',
            'mutation-turn-cancel',
        ]));
        await firstHandle.close();
        await secondHandle.close();
    });

    it('uses the currently selected shared handle token after account credential rotation', async () => {
        const authorizationHeaders: string[] = [];
        vi.mocked(axios.post).mockImplementation(async (_url, _body, config) => {
            authorizationHeaders.push(String(config?.headers?.Authorization ?? ''));
            return { status: 200, data: { ok: true } } as never;
        });
        const socket = createApiSessionSocketStub({ connected: false });
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createSessionTurnMutation } = await import('./sessionMutationTypes');
        const stale = createSessionMutationOutbox({
            token: 'stale-token',
            sessionId: 's-token-rotation',
            getSocket: () => socket,
            requestReconnect: () => {},
        });
        const current = createSessionMutationOutbox({
            token: 'current-token',
            sessionId: 's-token-rotation',
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        await current.enqueueSessionTurn(createSessionTurnMutation({
            sessionId: 's-token-rotation',
            mutationId: 'rotated-token-turn',
            action: 'cancel',
            turnId: 'turn-1',
            observedAt: 1_000,
        }));

        expect(authorizationHeaders).toContain('Bearer current-token');
        expect(authorizationHeaders).not.toContain('Bearer stale-token');
        await stale.close();
        await current.close();
    });

    it('drains a five-thousand-entry persisted transcript backlog without rebuilding the remaining batch per delivery', async () => {
        const sessionId = 's-large-transcript-backlog';
        const { createSessionMutationOutbox } = await import('./createSessionMutationOutbox');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const { saveSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const mutations = Array.from({ length: 5_000 }, (_, index) => {
            const payload = createTranscriptMessageAppendMutation({
                sessionId,
                localId: `large-backlog-${index}`,
                messageRole: 'agent',
                content: 'x'.repeat(256),
                createdAt: index + 1,
                updatedAt: index + 1,
                provenance: { kind: 'non_dependent', source: 'external' },
            });
            return {
                kind: 'transcript_message_append' as const,
                mutationId: payload.mutationId,
                payload,
                intentOrder: index + 1,
                createdAt: index + 1,
                attempts: 0,
                nextAttemptAt: 0,
            };
        });
        await saveSessionMutationOutbox(await createRuntimePersistenceContext(sessionId), mutations);
        const deliveredLocalIds: string[] = [];
        const socket = createObservationSocket({
            onObservation: (payload) => {
                const localId = (payload as { localId?: unknown }).localId;
                if (typeof localId === 'string') deliveredLocalIds.push(localId);
            },
        });
        const outbox = createSessionMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => socket,
            requestReconnect: () => {},
        });

        const startedAt = performance.now();
        await outbox.awaitReady();
        await outbox.flush('flush');
        const elapsedMs = performance.now() - startedAt;

        expect(deliveredLocalIds).toEqual(
            mutations.map((mutation) => mutation.payload.localId),
        );
        await expect(readPersistedOutboxMutations(sessionId)).resolves.toEqual([]);
        expect(elapsedMs).toBeLessThan(25_000);
        await outbox.close();
    }, 35_000);
});
