import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from '@/api/client/credentialAxios';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { prepareSessionEventMessageViaPort } from '../../transcript/sendMessages';
import { SESSION_CAPABILITY_NOTICE_SIDECAR_KEY } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { logger } from '@/ui/logger';
import { withWebLatencyTrace } from '@/daemon/externalActions/webLatencyTrace';
import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';

const { configurationMock } = vi.hoisted(() => ({
    configurationMock: { activeServerDir: '', apiServerUrl: 'https://api.test.invalid' },
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
    it('separates durable admission and socket ACK phases without releasing the exact receipt early', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const sink = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
        const started = createDeferred();
        const ack = createDeferred<unknown>();
        const sessionId = 'traced-transcript';
        const requestId = '23b2ed82-2ef7-4e4e-af0f-f64d599a08c6';
        const outbox = createRuntimeSessionClientDurableMutationOutbox({ token: 'token', sessionId,
            getSocket: () => ({ connected: true, emit() {}, emitWithAck: async () => {
                started.resolve(); return await ack.promise;
            } }), requestReconnect() {} });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        let settled = false;
        const pending = withWebLatencyTrace(requestId, () => outbox.enqueueTranscriptMessage(
            createTranscriptMessageAppendMutation({ sessionId, localId: 'original', content: 'private-sealed-content', createdAt: 100,
                provenance: { kind: 'non_dependent', source: 'background' } }))).then(result => { settled = true; return result; });
        try {
            await started.promise;
            expect(settled).toBe(false);
            for (const [phase, status] of [['session.outbox.persist', 'completed'], ['session.transcript.socket_ack', 'started']]) {
                expect(sink).toHaveBeenCalledWith('[web-latency]', expect.objectContaining({ phase, status, requestId }));
            }
            expect(sink.mock.calls.some(([, value]) => typeof value === 'object' && value !== null
                && 'phase' in value && value.phase === 'session.transcript.socket_ack'
                && 'status' in value && value.status === 'completed')).toBe(false);
            ack.resolve({ ok: true, status: 'observed', id: 'row', seq: 7, localId: 'original', didWrite: true, ingestedAt: 200 });
            expect(await pending).toMatchObject({ persisted: true, delivered: true, committedSequence: 7 });
            expect(sink).toHaveBeenCalledWith('[web-latency]', expect.objectContaining({
                phase: 'session.transcript.socket_ack', status: 'completed', requestId,
            }));
            expect(JSON.stringify(sink.mock.calls)).not.toContain('private-sealed-content');
        } finally { ack.resolve(null); await pending; await outbox.close(); sink.mockRestore(); vi.unstubAllEnvs(); }
    });
    it('releases optional diagnostics after durable admission while retaining their exact delivery', async () => {
        const started = createDeferred();
        const ack = createDeferred<unknown>();
        const sessionId = 'diagnostic-admission';
        let requests = 0;
        const outbox = createRuntimeSessionClientDurableMutationOutbox({ token: 'token', sessionId,
            getSocket: () => ({ connected: true, emit: vi.fn(), emitWithAck: async () => {
                requests += 1;
                started.resolve();
                return await ack.promise;
            } }), requestReconnect: () => undefined });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        let admitted = false;
        const pending = outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({ sessionId,
            localId: 'notice', content: 'sealed', createdAt: 100,
            provenance: { kind: 'non_dependent', source: 'background' } }), { awaitDelivery: false })
            .then(result => { admitted = true; return result; });
        try {
            await started.promise;
            await vi.waitFor(() => expect(admitted).toBe(true));
            expect(await pending).toMatchObject({ persisted: true, delivered: false, localId: 'notice' });
            expect(requests).toBe(1);
            const paths = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir: configurationMock.activeServerDir, custody: 'runtime', sessionId,
            });
            expect(JSON.parse(await readFile(paths.queuePath, 'utf8')).mutations).toHaveLength(1);
            ack.resolve({ ok: true, status: 'observed', id: 'notice-row', seq: 1,
                localId: 'notice', didWrite: true, ingestedAt: 200 });
            await outbox.flush('flush');
            expect(requests).toBe(1);
            await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            ack.resolve(null);
            await outbox.close();
            await pending;
        }
    });
    it('keeps startup capability facts on one transcript identity across runner delivery lifetimes', async () => {
        const sessionId = 'startup-notice-retry';
        const committed = new Set<string>();
        // The Home transport is the boundary; preparation, durable journal and
        // successor delivery all run through their production owners.
        const socket = { connected: true, emit: vi.fn(), emitWithAck: async (_event: string, input: unknown) => {
            const { localId } = input as { localId: string };
            const didWrite = !committed.has(localId);
            committed.add(localId);
            return { ok: true, status: 'observed', id: localId, seq: committed.size, localId, didWrite, ingestedAt: 200 };
        } };
        for (const [index, detail] of ['content_unreadable', 'content_unreadable', 'permission_denied'].entries()) {
            const outbox = createRuntimeSessionClientDurableMutationOutbox({ token: 'token', sessionId,
                getSocket: () => socket, requestReconnect: () => undefined });
            try {
                await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
                const prepared = prepareSessionEventMessageViaPort({
                    buildOutboundSessionMessagePayload: content => ({ t: 'plain', v: content }),
                }, { type: 'message', message: 'Skill unavailable', [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: { v: 1,
                    items: [{ kind: 'skill', name: 'Review', itemId: 'skill-1', code: 'skills_unavailable', detail }] } });
                const result = await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({ sessionId,
                    localId: prepared.localId, content: prepared.payload, createdAt: 100 + index,
                    provenance: { kind: 'non_dependent', source: 'background' } }));
                expect(result).toMatchObject({ persisted: true, delivered: true });
                expect(committed.size).toBe(index < 2 ? 1 : 2);
            } finally {
                await outbox.close();
            }
        }
    });
    it('cancels only the selected delivery handle on close and preserves the same transcript for its successor', async () => {
        const started = createDeferred();
        const lateAck = createDeferred<unknown>();
        const sessionId = 'selected-delivery-lifetime';
        const first = createRuntimeSessionClientDurableMutationOutbox({ token: 'token', sessionId,
            getSocket: () => ({ connected: true, emit: vi.fn(), emitWithAck: async () => {
                started.resolve(); return await lateAck.promise;
            } }), requestReconnect: () => undefined });
        await first.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        let firstSettled = false;
        const pending = first.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({ sessionId,
            localId: 'retained-transcript', content: 'sealed', createdAt: 100,
            provenance: { kind: 'non_dependent', source: 'background' } }))
            .then(result => { firstSettled = true; return result; });
        await started.promise;
        const successorAck = vi.fn(async (_event: string, payload: unknown) => ({ ok: true, status: 'observed',
            id: 'committed', seq: 47, localId: (payload as { localId: string }).localId, didWrite: true, ingestedAt: 200 }));
        const successor = createRuntimeSessionClientDurableMutationOutbox({ token: 'token', sessionId,
            getSocket: () => ({ connected: true, emit: vi.fn(), emitWithAck: successorAck }), requestReconnect: () => undefined });
        try {
            await first.close();
            await vi.waitFor(() => expect(firstSettled).toBe(true));
            expect(await pending).toMatchObject({ persisted: true, delivered: false, localId: 'retained-transcript' });
            await successor.flush('flush');
            expect(successorAck).toHaveBeenCalledWith(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
                expect.objectContaining({ localId: 'retained-transcript' }));
            lateAck.resolve({ ok: true, status: 'observed', id: 'stale', seq: 99,
                localId: 'retained-transcript', didWrite: true, ingestedAt: 200 });
            expect(await pending).toMatchObject({ delivered: false });
        } finally {
            lateAck.resolve(null);
            await first.close();
            await successor.close();
        }
    });
    beforeEach(async () => {
        configurationMock.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-session-mutations-'));
    });

    afterEach(async () => {
        await resetSessionClientDurableMutationOutboxStateForTests();
        await rm(configurationMock.activeServerDir, { recursive: true, force: true });
    });

    it.each(['exact', 'mismatched', 'offline'] as const)('reports only the exact transcript ACK sequence (%s)', async (ackMode) => {
        const sessionId = `transcript-receipt-${ackMode}`;
        const socket = {
            connected: ackMode !== 'offline',
            emit: vi.fn(),
            emitWithAck: vi.fn(async (_event: string, payload: unknown) => ({
                ok: true,
                status: 'observed',
                id: 'server-message',
                seq: 47,
                localId: ackMode === 'mismatched' ? 'another-message' : (payload as { localId: string }).localId,
                didWrite: true,
                ingestedAt: 200,
            })),
        };
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId,
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));

        const result = await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId,
            localId: 'ready-event',
            content: 'ready',
            createdAt: 102,
            provenance: { kind: 'non_dependent', source: 'external' },
        }));

        expect(result).toEqual(ackMode === 'exact'
            ? { persisted: true, delivered: true, localId: 'ready-event', committedSequence: 47 }
            : { persisted: true, delivered: false, localId: 'ready-event' });
        await outbox.close();
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
        expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(2, expect.objectContaining({
            reconcileWhenEmpty: 'force',
            deliveryTiming: 'after_runtime_idle',
            expectedRuntimeActivityRevision: 9,
        }));
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

    it('parks turn mutations without blocking the released-server transcript seam and replays them after upgrade', async () => {
        const sessionId = 'released-server-turn-parking';
        const turnMutation = {
            v: 1,
            sessionId,
            mutationId: 'released-server-begin-turn',
            action: 'begin',
            turnId: 'turn-1',
            observedAt: 100,
        } as const;
        const deliveredEvents: string[] = [];
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(async (event: string, payload: unknown) => {
                deliveredEvents.push(event);
                if (event === 'message') {
                    const message = payload as { localId: string };
                    return {
                        ok: true,
                        id: 'message-1',
                        seq: 1,
                        localId: message.localId,
                        didWrite: true,
                    };
                }
                return {
                    result: 'success',
                    receipt: {
                        ...turnMutation,
                        decision: 'applied',
                        appliedAt: 101,
                    },
                };
            }),
        };
        const requestReconnect = vi.fn();
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId,
            getSocket: () => socket,
            requestReconnect,
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('released_server_v0_2_1'));

        await outbox.enqueueSessionTurnMutation(turnMutation);
        const transcript = await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId,
            localId: 'released-server-transcript',
            content: 'compatible transcript',
            createdAt: 102,
            provenance: { kind: 'non_dependent', source: 'external' },
        }));

        expect(transcript).toEqual({
            persisted: true,
            delivered: true,
            localId: 'released-server-transcript',
            committedSequence: 1,
        });
        expect(deliveredEvents).toEqual(['message']);
        expect(requestReconnect).not.toHaveBeenCalled();
        // Transcript enqueue owns its exact ACK; the separate flush owns the
        // durable dequeue. Observe that cut before inspecting retained custody.
        await outbox.flush('flush');
        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'runtime',
            sessionId,
        });
        const parked = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ mutationId: string; attempts: number }>;
        };
        expect(parked.mutations).toEqual([
            expect.objectContaining({ mutationId: turnMutation.mutationId, attempts: 0 }),
        ]);

        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await outbox.flush('connect');

        await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(deliveredEvents).toEqual(['message', 'session-turn-mutation']);
        await outbox.close();
    });

    it.each(['failure', 'backoff'] as const)(
        'delivers runtime-activity terminal state past a turn %s while retaining ordered successors',
        async (blockedBy) => {
            const sessionId = `runtime-activity-turn-${blockedBy}`;
            const deliveredActivityStates: string[] = [];
            const post = vi.spyOn(axios, 'post').mockRejectedValue({ response: { status: 503 } });
            let revision = 0;
            const outbox = createRuntimeSessionClientDurableMutationOutbox({
                token: 'token',
                sessionId,
                getSocket: () => null,
                requestReconnect: () => undefined,
                initialRegisteredSessionStateFieldMutations: [createRegisteredSessionStateFieldMutation({
                    sessionId,
                    fieldId: 'runtime.activity',
                    deliveryClass: 'durable_best_effort',
                    source: 'runtime',
                    observedAt: 1,
                    op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
                })],
                deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                    if (mutation.fieldId !== 'runtime.activity' || mutation.op.kind !== 'set') return false;
                    const value = mutation.op.value as { state: 'active' | 'idle'; activeCount: number };
                    deliveredActivityStates.push(value.state);
                    revision += 1;
                    return {
                        delivered: true,
                        settlement: {
                            status: 'applied',
                            committedProjection: { ...value, observedAt: mutation.observedAt, revision },
                            committedRevision: revision,
                        },
                    };
                },
            });
            const paths = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir: configurationMock.activeServerDir, custody: 'runtime', sessionId,
            });
            try {
                await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
                expect(deliveredActivityStates).toEqual(['active']);
                await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
                deliveredActivityStates.length = 0;
                outbox.deactivateDelivery();
                for (const mutationId of ['blocked-turn', 'ordered-tail']) {
                    await outbox.enqueueSessionTurnMutation({
                        v: 1, sessionId, mutationId, action: 'begin', turnId: mutationId, observedAt: 2,
                    });
                }
                await outbox.flush('enqueue');
                if (blockedBy === 'backoff') await outbox.activateDelivery();
                await outbox.enqueueRegisteredSessionStateFieldMutation(createRegisteredSessionStateFieldMutation({
                    sessionId,
                    fieldId: 'runtime.activity',
                    deliveryClass: 'durable_best_effort',
                    source: 'runtime',
                    observedAt: 3,
                    op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
                }));
                await outbox.flush('enqueue');
                if (blockedBy === 'failure') await outbox.activateDelivery();

                expect(deliveredActivityStates).toEqual(['idle']);
                const retained = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
                    mutations: Array<{ mutationId: string; attempts: number }>;
                };
                expect(retained.mutations).toEqual([
                    expect.objectContaining({ mutationId: 'blocked-turn', attempts: expect.any(Number) }),
                    expect.objectContaining({ mutationId: 'ordered-tail', attempts: 0 }),
                ]);
                expect(retained.mutations[0].attempts).toBeGreaterThanOrEqual(1);
            } finally {
                await outbox.close();
                post.mockRestore();
            }
        },
    );

    it('delivers runtime-activity terminal state past a backed-off turn on its earlier timer', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const now = Date.now();
        const sessionId = 'runtime-activity-earlier-timer';
        const activity = createRegisteredSessionStateFieldMutation({
            sessionId, fieldId: 'runtime.activity', source: 'runtime', observedAt: now,
            deliveryClass: 'durable_best_effort',
            op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        });
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir, custody: 'runtime', sessionId,
            parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
        });
        const post = vi.spyOn(axios, 'post').mockRejectedValue({ response: { status: 503 } });
        let outbox: ReturnType<typeof createRuntimeSessionClientDurableMutationOutbox> | undefined;
        const deliveredActivityStates: string[] = [];
        let activityAttempts = 0;
        try {
            await saveSessionClientDurableMutationOutbox(sessionId, [
                {
                    kind: 'session_turn_mutation', mutationId: 'backed-off-head',
                    payload: { v: 1, sessionId, mutationId: 'backed-off-head', action: 'begin', turnId: 'head', observedAt: now },
                    createdAt: now, attempts: 6, nextAttemptAt: now + 60_000,
                },
                {
                    kind: 'session_turn_mutation', mutationId: 'ordered-tail',
                    payload: { v: 1, sessionId, mutationId: 'ordered-tail', action: 'begin', turnId: 'tail', observedAt: now },
                    createdAt: now, attempts: 0, nextAttemptAt: 0,
                },
                {
                    kind: 'registered_session_state_field', mutationId: activity.mutationId,
                    payload: activity, admissionOrder: 1, createdAt: now, attempts: 0, nextAttemptAt: 0,
                },
            ], persistenceContext);
            outbox = createRuntimeSessionClientDurableMutationOutbox({
                token: 'token', sessionId, flushOnReady: false,
                getSocket: () => null, requestReconnect: () => undefined,
                deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                    activityAttempts += 1;
                    if (activityAttempts === 1) return false;
                    deliveredActivityStates.push(mutation.fieldId);
                    return {
                        delivered: true,
                        settlement: {
                            status: 'applied',
                            committedProjection: { state: 'idle', activeCount: 0, observedAt: mutation.observedAt, revision: 1 },
                            committedRevision: 1,
                        },
                    };
                },
            });
            await outbox.awaitReady();
            await outbox.setSessionSyncPendingInputServerContract(
                serverContract('session_sync_v2_pending_input_v1'),
            );
            expect(deliveredActivityStates).toEqual([]);
            const beforeTimer = JSON.parse(await readFile(persistenceContext.paths.queuePath, 'utf8')) as {
                mutations: Array<{ mutationId: string; attempts: number; nextAttemptAt: number }>;
            };
            const [head, tail, pendingActivity] = beforeTimer.mutations;
            expect(head).toMatchObject({ mutationId: 'backed-off-head', attempts: 7 });
            expect(tail).toMatchObject({ mutationId: 'ordered-tail', attempts: 0 });
            expect(pendingActivity).toMatchObject({ kind: 'registered_session_state_field', attempts: 1 });
            expect(pendingActivity.nextAttemptAt).toBeLessThan(head.nextAttemptAt);
            await vi.advanceTimersByTimeAsync(pendingActivity.nextAttemptAt - Date.now());
            await vi.waitFor(async () => {
                expect(deliveredActivityStates).toEqual(['runtime.activity']);
                const retained = JSON.parse(await readFile(persistenceContext.paths.queuePath, 'utf8')) as {
                    mutations: Array<{ mutationId: string; attempts: number }>;
                };
                expect(retained.mutations).toEqual([
                    expect.objectContaining({ mutationId: 'backed-off-head', attempts: 7 }),
                    expect.objectContaining({ mutationId: 'ordered-tail', attempts: 0 }),
                ]);
            });
            expect(post).toHaveBeenCalledTimes(1);
        } finally {
            await outbox?.close();
            post.mockRestore();
            vi.useRealTimers();
        }
    });

    it('repairs a failed Activity retirement while its only sibling remains parked', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const sessionId = 'runtime-activity-retirement-repair';
        const now = Date.now();
        const activity = createRegisteredSessionStateFieldMutation({
            sessionId, fieldId: 'runtime.activity', source: 'runtime', observedAt: now,
            deliveryClass: 'durable_best_effort',
            op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        });
        const context = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir, custody: 'runtime', sessionId,
            parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox(sessionId, [
            {
                kind: 'session_turn_mutation', mutationId: 'parked-turn',
                payload: { v: 1, sessionId, mutationId: 'parked-turn', action: 'begin', turnId: 'head', observedAt: now },
                createdAt: now, attempts: 0, nextAttemptAt: 0,
            },
            {
                kind: 'registered_session_state_field', mutationId: activity.mutationId,
                payload: activity, admissionOrder: 1, createdAt: now, attempts: 0, nextAttemptAt: 0,
            },
        ], context);
        const deliver = vi.fn();
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token', sessionId, flushOnReady: false, initiallyActive: false,
            getSocket: () => null, requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: deliver,
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('released_server_v0_2_1'));
        let waiterSettled = false;
        const waiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(activity).then(result => {
            waiterSettled = true;
            return result;
        });
        try {
            await outbox.flush('enqueue');
            const backupPath = `${context.paths.queuePath}.retirement-backup`;
            await rename(context.paths.queuePath, backupPath);
            await mkdir(context.paths.queuePath);
            try {
                // A directory at the publication path makes the real atomic rename fail.
                await expect(outbox.activateDelivery()).rejects.toMatchObject({ code: expect.any(String) });
            } finally {
                await rm(context.paths.queuePath, { recursive: true });
                await rename(backupPath, context.paths.queuePath);
            }
            expect(waiterSettled).toBe(false);
            expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
                custody: { value: { state: 'idle', activeCount: 0 } }, settlement: null,
            });
            await vi.advanceTimersByTimeAsync(0);
            await vi.waitFor(async () => {
                const retained = JSON.parse(await readFile(context.paths.queuePath, 'utf8')) as {
                    mutations: Array<{ mutationId: string; attempts: number }>;
                };
                expect(retained.mutations).toEqual([
                    expect.objectContaining({ mutationId: 'parked-turn', attempts: 0 }),
                ]);
            });
            await expect(waiter).resolves.toEqual({ status: 'failed' });
            expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({ custody: null, settlement: null });
            expect(deliver).not.toHaveBeenCalled();
        } finally {
            await outbox.close();
            vi.useRealTimers();
        }
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
