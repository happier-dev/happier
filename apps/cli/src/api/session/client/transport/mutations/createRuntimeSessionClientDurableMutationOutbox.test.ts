import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';

const { configurationMock } = vi.hoisted(() => ({
    configurationMock: { activeServerDir: '' },
}));

vi.mock('@/configuration', () => ({ configuration: configurationMock }));

import { resetSessionClientDurableMutationOutboxStateForTests } from './createSessionClientDurableMutationOutbox';
import { createRuntimeSessionClientDurableMutationOutbox } from './createRuntimeSessionClientDurableMutationOutbox';
import {
    createRegisteredSessionStateFieldMutation,
    createTranscriptMessageAppendMutation,
    type RegisteredSessionStateFieldMutationV1,
} from './sessionClientDurableMutationTypes';
import {
    createSessionClientDurableMutationPersistenceContext,
    parseRuntimeSessionClientDurableMutation,
    resolveSessionClientDurableMutationJournalPaths,
    saveSessionClientDurableMutationOutbox,
} from './sessionClientDurableMutationPersistence';

function serverContract(mode: 'session_sync_v2_pending_input_v1' | 'released_server_v0_2_1') {
    return {
        mode,
        runtimeActivity: mode === 'released_server_v0_2_1' ? 'legacy' : 'v2',
        pendingInput: mode === 'released_server_v0_2_1' ? 'released_server_v0_2_1' : 'v1',
        publisherAuthority: 'indeterminate',
        sessionConnectionEpoch: 1,
        socket: {},
        transcriptTransport: mode === 'released_server_v0_2_1'
            ? { mode: 'released_server_v0_2_1' as const }
            : { mode: 'session_transcript_observation_v1' as const },
    } as const;
}

function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

describe('runtime session client durable mutation outbox', () => {
    beforeEach(async () => {
        configurationMock.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-session-mutations-'));
    });

    afterEach(async () => {
        await resetSessionClientDurableMutationOutboxStateForTests();
        await rm(configurationMock.activeServerDir, { recursive: true, force: true });
    });

    it('publishes the exact current-state Activity tail only after durable admission and dequeue', async () => {
        const sessionId = 'runtime-activity-tail';
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId,
            getSocket: () => ({ connected: true, emit: () => undefined }),
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => ({
                delivered: true,
                settlement: {
                    status: 'applied',
                    committedProjection: {
                        state: 'idle',
                        activeCount: 0,
                        observedAt: 1_000,
                        revision: 7,
                    },
                    committedRevision: 7,
                },
            }),
        });
        await outbox.awaitReady();
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        const before = outbox.readRuntimeActivitySnapshotTail();
        const changed = outbox.waitForRuntimeActivitySnapshotTailChange(before.sequence);

        await outbox.enqueueRegisteredSessionStateFieldMutation(
            createRegisteredSessionStateFieldMutation({
                sessionId,
                fieldId: 'runtime.activity',
                source: 'runtime',
                observedAt: 100,
                deliveryClass: 'durable_best_effort',
                op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
            }),
        );

        await expect(changed).resolves.toBe(true);
        expect(outbox.readRuntimeActivitySnapshotTail()).toEqual({
            sequence: 1,
            custody: {
                identity: {
                    mutationKey: `runtime-activity-snapshot:${sessionId}`,
                    admissionOrder: 1,
                },
                value: { state: 'idle', activeCount: 0 },
            },
            settlement: null,
        });
        const settlementChanged = outbox.waitForRuntimeActivitySnapshotTailChange(1);
        await outbox.flush('flush');
        await expect(settlementChanged).resolves.toBe(true);
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
        await outbox.close();
    });

    it('keeps Activity custody when a delivered response lacks exact matching settlement evidence', async () => {
        const sessionId = 'runtime-activity-invalid-settlement';
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId,
            getSocket: () => ({ connected: true, emit: () => undefined }),
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => ({
                delivered: true,
                settlement: {
                    status: 'applied',
                    committedProjection: {
                        state: 'idle',
                        activeCount: 0,
                        observedAt: 1_000,
                        revision: 7,
                    },
                    committedRevision: 8,
                },
            }),
        });
        await outbox.awaitReady();
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));

        await outbox.enqueueRegisteredSessionStateFieldMutation(
            createRegisteredSessionStateFieldMutation({
                sessionId,
                fieldId: 'runtime.activity',
                source: 'runtime',
                observedAt: 100,
                deliveryClass: 'durable_best_effort',
                op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
            }),
        );
        await outbox.flush('flush');

        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            sequence: 1,
            custody: {
                identity: {
                    mutationKey: `runtime-activity-snapshot:${sessionId}`,
                    admissionOrder: 1,
                },
                value: { state: 'idle', activeCount: 0 },
            },
            settlement: null,
        });
        await outbox.close();
    });

    it('detaches a cancelled tail waiter without changing durable Activity custody', async () => {
        const sessionId = 'runtime-activity-tail-cancel';
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId,
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });
        await outbox.awaitReady();
        const abort = new AbortController();
        const waiting = outbox.waitForRuntimeActivitySnapshotTailChange(0, abort.signal);
        abort.abort();
        await expect(waiting).resolves.toBe(false);

        await outbox.enqueueRegisteredSessionStateFieldMutation(
            createRegisteredSessionStateFieldMutation({
                sessionId,
                fieldId: 'runtime.activity',
                source: 'runtime',
                observedAt: 100,
                deliveryClass: 'durable_best_effort',
                op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
            }),
        );

        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            sequence: 1,
            custody: {
                identity: {
                    mutationKey: `runtime-activity-snapshot:${sessionId}`,
                    admissionOrder: 1,
                },
                value: { state: 'idle', activeCount: 0 },
            },
            settlement: null,
        });
        await outbox.close();
    });

    it('wakes the Pending consumer from generic custody with the exact durable settlement revision', async () => {
        const sessionId = 'runtime-activity-consumer-settlement';
        const deliveryStarted = createDeferred();
        const releaseDelivery = createDeferred();
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId,
            getSocket: () => ({ connected: true, emit: () => undefined }),
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => {
                deliveryStarted.resolve();
                await releaseDelivery.promise;
                return {
                    delivered: true,
                    settlement: {
                        status: 'applied',
                        committedProjection: {
                            state: 'idle',
                            activeCount: 0,
                            observedAt: 1_000,
                            revision: 9,
                        },
                        committedRevision: 9,
                    },
                };
            },
        });
        await outbox.awaitReady();
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await outbox.enqueueRegisteredSessionStateFieldMutation(
            createRegisteredSessionStateFieldMutation({
                sessionId,
                fieldId: 'runtime.activity',
                source: 'runtime',
                observedAt: 100,
                deliveryClass: 'durable_best_effort',
                op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
            }),
        );
        await deliveryStarted.promise;

        const materializeNextPendingMessageSafely = vi.fn()
            .mockResolvedValueOnce({
                type: 'deferred' as const,
                reason: 'runtime_activity_unknown' as const,
            })
            .mockResolvedValueOnce({
                type: 'materialized' as const,
                localId: 'settled-pending',
                seq: null,
                content: null,
            });
        const consumer = createSessionProviderInputConsumer({
            messageQueue: new MessageQueue2(() => 'hash'),
            session: {
                waitForMetadataUpdate: async () => false,
                materializeNextPendingMessageSafely,
                shouldAttemptPendingMaterialization: () => true,
                readRuntimeActivitySnapshotTail: () => outbox.readRuntimeActivitySnapshotTail(),
                waitForRuntimeActivitySnapshotTailChange: (sequence, signal) => (
                    outbox.waitForRuntimeActivitySnapshotTailChange(sequence, signal)
                ),
            },
            pendingQueueDeliveryTiming: 'after_runtime_idle',
        });

        const draining = consumer.drainPending({
            maxPopPerWake: 1,
            reason: 'composed-runtime-settlement',
        });
        await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
        releaseDelivery.resolve();

        await expect(draining).resolves.toMatchObject({ materialized: 1 });
        expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(2, {
            reconcileWhenEmpty: 'force',
            deliveryTiming: 'after_runtime_idle',
            expectedRuntimeActivityRevision: 9,
        });
        await outbox.close();
    });

    it('durably admits a semantic session end while still rejecting a cast exact turn end', async () => {
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });

        await outbox.enqueueSessionTurnMutation({
            v: 1,
            sessionId: 's1',
            mutationId: 'begin-turn-1',
            action: 'begin',
            turnId: 'turn-1',
            observedAt: 100,
        });
        await expect(outbox.enqueueSessionTurnMutation({
            v: 1,
            sessionId: 's1',
            mutationId: 'end-turn-1',
            action: 'end_session',
            turnId: 'turn-1',
            observedAt: 101,
        } as unknown as Parameters<typeof outbox.enqueueSessionTurnMutation>[0])).rejects.toThrow(/normal turn/);
        await outbox.enqueueSessionEnd({
            v: 1,
            sessionId: 's1',
            mutationId: 'session-end:s1',
            source: 'session_end',
            observedAt: 103,
        });
        await expect(outbox.enqueueRegisteredSessionStateFieldMutation(
            createRegisteredSessionStateFieldMutation({
                sessionId: 's1',
                fieldId: 'runtime.usageLimitRecovery',
                source: 'daemon',
                observedAt: 102,
                op: { kind: 'clear' },
            }),
        )).rejects.toThrow(/runtime custody/);

        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'runtime',
            sessionId: 's1',
        });
        const persisted = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ mutationId: string }>;
        };
        expect(persisted.mutations.map((mutation) => mutation.mutationId)).toEqual([
            'begin-turn-1',
            'session-end:s1',
        ]);
        await outbox.close();
    });

    it('keeps an inactive replacement from stealing delivery until explicit activation', async () => {
        const deliveredBy: string[] = [];
        const old = createRuntimeSessionClientDurableMutationOutbox({
            token: 'old-token',
            sessionId: 's1',
            getSocket: () => ({ connected: true, emit: () => undefined }),
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => {
                deliveredBy.push('old');
                return true;
            },
        });
        const replacement = createRuntimeSessionClientDurableMutationOutbox({
            token: 'replacement-token',
            sessionId: 's1',
            initiallyActive: false,
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => {
                deliveredBy.push('replacement');
                return true;
            },
        });

        await replacement.enqueueRegisteredSessionStateFieldMutation(
            createRegisteredSessionStateFieldMutation({
                sessionId: 's1',
                fieldId: 'runtime.workState',
                source: 'runtime',
                observedAt: 200,
                op: { kind: 'set', value: { v: 1, backendId: 'test', updatedAt: 200, items: [] } },
            }),
        );
        await replacement.flush('flush');
        expect(deliveredBy).toEqual(['old']);

        replacement.activateDelivery();
        old.deactivateDelivery();
        await replacement.enqueueRegisteredSessionStateFieldMutation(
            createRegisteredSessionStateFieldMutation({
                sessionId: 's1',
                fieldId: 'runtime.workState',
                source: 'runtime',
                observedAt: 201,
                op: { kind: 'set', value: { v: 1, backendId: 'test', updatedAt: 201, items: [] } },
            }),
        );
        await replacement.flush('flush');
        expect(deliveredBy).toEqual(['old', 'replacement']);

        await old.close();
        await replacement.close();
    });

    it('retains resolved authority while inactive and dispatches the admitted Activity exactly once on activation', async () => {
        const sessionId = 'inactive-authority-handoff';
        const deliveredMutationIds: string[] = [];
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId,
            initiallyActive: false,
            flushOnReady: false,
            getSocket: () => ({ connected: true, emit: () => undefined }),
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredMutationIds.push(mutation.mutationId);
                return {
                    delivered: true,
                    settlement: {
                        status: 'applied',
                        committedProjection: {
                            state: 'idle',
                            activeCount: 0,
                            observedAt: mutation.observedAt,
                            revision: 1,
                        },
                        committedRevision: 1,
                    },
                };
            },
        });
        await outbox.setSessionSyncPendingInputServerContract(
            serverContract('session_sync_v2_pending_input_v1'),
        );
        await outbox.enqueueRegisteredSessionStateFieldMutation(
            createRegisteredSessionStateFieldMutation({
                sessionId,
                fieldId: 'runtime.activity',
                source: 'runtime',
                observedAt: 100,
                deliveryClass: 'durable_best_effort',
                op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
            }),
        );
        await outbox.flush('flush');

        expect(deliveredMutationIds).toEqual([]);
        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'runtime',
            sessionId,
        });
        const beforeActivation = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ mutationId: string; attempts: number }>;
        };
        expect(beforeActivation.mutations).toEqual([
            expect.objectContaining({
                mutationId: `runtime-activity-snapshot:${sessionId}`,
                attempts: 0,
            }),
        ]);

        await outbox.activateDelivery();

        expect(deliveredMutationIds).toEqual([`runtime-activity-snapshot:${sessionId}`]);
        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: null,
            settlement: {
                identity: {
                    mutationKey: `runtime-activity-snapshot:${sessionId}`,
                    admissionOrder: 1,
                },
                result: 'applied',
                committedRevision: 1,
            },
        });
        await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await outbox.close();
    });

    it.each(['indeterminate', 'auth_failed'] as const)(
        'retains fail-closed %s authority across inactive activation without attempting Activity delivery',
        async (mode) => {
            const sessionId = `inactive-${mode}`;
            const deliver = vi.fn();
            const outbox = createRuntimeSessionClientDurableMutationOutbox({
                token: 'token',
                sessionId,
                initiallyActive: false,
                flushOnReady: false,
                getSocket: () => ({ connected: true, emit: () => undefined }),
                requestReconnect: () => undefined,
                deliverRegisteredSessionStateFieldMutation: deliver,
            });
            await outbox.setSessionSyncPendingInputServerContract({
                mode,
                runtimeActivity: 'indeterminate',
                pendingInput: 'indeterminate',
                publisherAuthority: 'indeterminate',
                sessionConnectionEpoch: 1,
                socket: { connected: true },
                transcriptTransport: mode === 'auth_failed'
                    ? { mode: 'auth_failed', reason: 'connection_auth_failed' }
                    : { mode: 'indeterminate', reason: 'connection_contract_unresolved' },
            });
            await outbox.enqueueRegisteredSessionStateFieldMutation(
                createRegisteredSessionStateFieldMutation({
                    sessionId,
                    fieldId: 'runtime.activity',
                    source: 'runtime',
                    observedAt: 100,
                    deliveryClass: 'durable_best_effort',
                    op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
                }),
            );

            await outbox.activateDelivery();

            expect(deliver).not.toHaveBeenCalled();
            const paths = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir: configurationMock.activeServerDir,
                custody: 'runtime',
                sessionId,
            });
            const persisted = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
                mutations: Array<{ mutationId: string; attempts: number }>;
            };
            expect(persisted.mutations).toEqual([
                expect.objectContaining({
                    mutationId: `runtime-activity-snapshot:${sessionId}`,
                    attempts: 0,
                }),
            ]);
            expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
                custody: {
                    identity: {
                        mutationKey: `runtime-activity-snapshot:${sessionId}`,
                        admissionOrder: 1,
                    },
                },
                settlement: null,
            });
            await outbox.close();
        },
    );

    it('retires unsupported Activity without blocking a sibling and accepts a later host reoffer', async () => {
        const deliveredFieldIds: string[] = [];
        const requestReconnect = vi.fn();
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'support-session',
            getSocket: () => ({ connected: true, emit: () => undefined }),
            requestReconnect,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredFieldIds.push(mutation.fieldId);
                if (mutation.fieldId !== 'runtime.activity' || mutation.op.kind !== 'set') return true;
                const value = mutation.op.value as { state: 'active' | 'idle' | 'unknown'; activeCount: number };
                return {
                    delivered: true,
                    settlement: {
                        status: 'applied',
                        committedProjection: {
                            ...value,
                            observedAt: mutation.observedAt,
                            revision: 1,
                        },
                        committedRevision: 1,
                    },
                };
            },
        });
        const activity = createRegisteredSessionStateFieldMutation({
            sessionId: 'support-session', fieldId: 'runtime.activity', source: 'runtime', observedAt: 1,
            deliveryClass: 'durable_best_effort',
            op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        });
        const workState = createRegisteredSessionStateFieldMutation({
            sessionId: 'support-session', fieldId: 'runtime.workState', source: 'runtime', observedAt: 2,
            op: { kind: 'set', value: { v: 1, backendId: 'test', updatedAt: 2, items: [] } },
        });

        await outbox.enqueueRegisteredSessionStateFieldMutation(activity);
        await outbox.enqueueRegisteredSessionStateFieldMutation(workState);
        await outbox.flush('flush');
        expect(deliveredFieldIds).toEqual(['runtime.workState']);
        expect(requestReconnect).not.toHaveBeenCalled();

        await outbox.setSessionSyncPendingInputServerContract(serverContract('released_server_v0_2_1'));
        expect(deliveredFieldIds).toEqual(['runtime.workState']);
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await outbox.enqueueRegisteredSessionStateFieldMutation(activity);
        await outbox.flush('flush');
        expect(deliveredFieldIds).toEqual(['runtime.workState', 'runtime.activity']);
        await outbox.close();
    });

    it('blocks unsupported capability by exact registered field instead of the whole kind', async () => {
        const deliveredFieldIds: string[] = [];
        const activity = createRegisteredSessionStateFieldMutation({
            sessionId: 'field-block-session', fieldId: 'runtime.activity', source: 'runtime', observedAt: 1,
            deliveryClass: 'durable_best_effort',
            op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        });
        const workState = createRegisteredSessionStateFieldMutation({
            sessionId: 'field-block-session', fieldId: 'runtime.workState', source: 'runtime', observedAt: 2,
            op: { kind: 'set', value: { v: 1, backendId: 'test', updatedAt: 2, items: [] } },
        });
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token', sessionId: 'field-block-session',
            initialRegisteredSessionStateFieldMutations: [activity, workState],
            flushOnReady: false,
            getSocket: () => ({ connected: true, emit: () => undefined }),
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredFieldIds.push(mutation.fieldId);
                return mutation.fieldId === 'runtime.activity'
                    ? { delivered: false, unsupportedCapability: true }
                    : true;
            },
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        expect(deliveredFieldIds).toEqual(['runtime.activity', 'runtime.workState']);
        await outbox.close();
    });

    it('keeps an indeterminate Activity delivery from blocking a sibling field or reconnecting', async () => {
        const deliveredFieldIds: string[] = [];
        const requestReconnect = vi.fn();
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token', sessionId: 'delivery-indeterminate-session',
            getSocket: () => ({ connected: true, emit: () => undefined }), requestReconnect,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredFieldIds.push(mutation.fieldId);
                return mutation.fieldId !== 'runtime.activity';
            },
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await outbox.enqueueRegisteredSessionStateFieldMutation(createRegisteredSessionStateFieldMutation({
            sessionId: 'delivery-indeterminate-session', fieldId: 'runtime.activity', source: 'runtime', observedAt: 1,
            deliveryClass: 'durable_best_effort', op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        }));
        await outbox.enqueueRegisteredSessionStateFieldMutation(createRegisteredSessionStateFieldMutation({
            sessionId: 'delivery-indeterminate-session', fieldId: 'runtime.workState', source: 'runtime', observedAt: 2,
            op: { kind: 'set', value: { v: 1, backendId: 'test', updatedAt: 2, items: [] } },
        }));
        await outbox.flush('flush');
        expect(deliveredFieldIds).toContain('runtime.workState');
        expect(requestReconnect).not.toHaveBeenCalled();
        await outbox.close();
    });

    it('stages a replacement snapshot while both handles are inactive before new-owner delivery', async () => {
        const unrelated = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'unrelated-local',
            content: 'unrelated transcript',
            createdAt: 100,
            provenance: { kind: 'non_dependent', source: 'external' },
        });
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'runtime',
            sessionId: 's1',
            parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [{
            kind: 'transcript_message_append',
            mutationId: unrelated.mutationId,
            payload: unrelated,
            createdAt: unrelated.createdAt,
            attempts: 0,
            nextAttemptAt: 0,
        }], persistenceContext);
        const activity = (
            mutationId: string,
            observedAt: number,
            value: unknown,
        ): RegisteredSessionStateFieldMutationV1 => ({
            v: 1,
            sessionId: 's1',
            mutationId,
            fieldId: 'runtime.activity',
            deliveryClass: 'durable_best_effort',
            source: 'runtime',
            observedAt,
            op: { kind: 'set', value },
        });
        const stale = activity('stale-activity', 101, {
            state: 'active',
            activeCount: 1,
        });
        const current = activity('current-activity', 102, {
            state: 'unknown',
            activeCount: 0,
        });
        const deliveredByOld: string[] = [];
        const deliveredByReplacement: string[] = [];
        const deliveredTranscriptLocalIds: string[] = [];
        const old = createRuntimeSessionClientDurableMutationOutbox({
            token: 'old-token',
            sessionId: 's1',
            initialRegisteredSessionStateFieldMutations: [stale],
            flushOnReady: false,
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredByOld.push(mutation.mutationId);
                return true;
            },
        });
        await old.awaitReady();
        const replacement = createRuntimeSessionClientDurableMutationOutbox({
            token: 'replacement-token',
            sessionId: 's1',
            initiallyActive: false,
            initialRegisteredSessionStateFieldMutations: [current],
            flushOnReady: false,
            getSocket: () => ({
                connected: true,
                emit: () => undefined,
                emitWithAck: async (event, payloadValue) => {
                    if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                        return { ok: true, capability: 'session-transcript-observation-v1' };
                    }
                    if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                        const payload = payloadValue as { localId?: unknown };
                        const localId = String(payload.localId ?? '');
                        deliveredTranscriptLocalIds.push(localId);
                        return {
                            ok: true,
                            status: 'observed',
                            id: 'message-1',
                            seq: 1,
                            localId,
                            didWrite: true,
                            ingestedAt: 200,
                        };
                    }
                    return { ok: true };
                },
            }),
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredByReplacement.push(mutation.mutationId);
                if (mutation.fieldId !== 'runtime.activity' || mutation.op.kind !== 'set') return true;
                const value = mutation.op.value as { state: 'active' | 'idle' | 'unknown'; activeCount: number };
                return {
                    delivered: true,
                    settlement: {
                        status: 'applied',
                        committedProjection: {
                            ...value,
                            observedAt: mutation.observedAt,
                            revision: 1,
                        },
                        committedRevision: 1,
                    },
                };
            },
        });

        await replacement.awaitReady();
        expect(deliveredByOld).toEqual([]);
        expect(deliveredByReplacement).toEqual([]);
        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'runtime',
            sessionId: 's1',
        });
        const beforeActivation = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ mutationId: string }>;
        };
        expect(beforeActivation.mutations.map((mutation) => mutation.mutationId)).toEqual([
            unrelated.mutationId,
            'runtime-activity-snapshot:s1',
        ]);

        old.deactivateDelivery();
        await replacement.enqueueRegisteredSessionStateFieldMutation(current);
        const afterStaging = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ mutationId: string }>;
        };
        expect(afterStaging.mutations.map((mutation) => mutation.mutationId)).toEqual([
            unrelated.mutationId,
            'runtime-activity-snapshot:s1',
        ]);
        replacement.activateDelivery();
        await replacement.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await replacement.flush('flush');
        expect(deliveredByOld).toEqual([]);
        expect(deliveredByReplacement).toEqual(['runtime-activity-snapshot:s1']);
        expect(deliveredTranscriptLocalIds).toEqual([unrelated.localId]);

        await old.close();
        await replacement.close();
    });
});
