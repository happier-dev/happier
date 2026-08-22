import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    RegisteredSessionStateFieldMutationV1,
    TranscriptMessageAppendMutationV1,
    VoiceAgentTranscriptTurnMutationV1,
} from './sessionClientDurableMutationTypes';
import { createRegisteredSessionStateFieldMutation } from './sessionClientDurableMutationTypes';
import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';
import { resolveSessionClientConnectionContract } from '../sessionClientConnectionContract';

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

const persistenceMocks = vi.hoisted(() => ({
    appendDeadLetters: vi.fn(),
    loadDeadLetters: vi.fn<() => Promise<readonly unknown[]>>(),
    load: vi.fn<() => Promise<readonly unknown[]>>(),
    markRecovered: vi.fn<(sessionId: string, mutationIds: readonly string[]) => Promise<void>>(),
    recover: vi.fn<() => Promise<readonly unknown[]>>(),
    save: vi.fn<(sessionId: string, mutations: readonly unknown[]) => Promise<void>>(),
}));

vi.mock('./sessionClientDurableMutationPersistence', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./sessionClientDurableMutationPersistence')>();
    return {
        ...actual,
        appendSessionClientDurableMutationDeadLetters: persistenceMocks.appendDeadLetters,
        loadSessionClientDurableMutationDeadLetters: persistenceMocks.loadDeadLetters,
        loadSessionClientDurableMutationOutbox: persistenceMocks.load,
        markAuthoritativeSessionClientDurableMutationDeadLettersRecovered: persistenceMocks.markRecovered,
        recoverAuthoritativeSessionClientDurableMutationDeadLetters: persistenceMocks.recover,
        resolveSessionClientDurableMutationOutboxPath: vi.fn((sessionId: string) => `/outbox/${sessionId}`),
        saveSessionClientDurableMutationOutbox: persistenceMocks.save,
    };
});

function createFieldMutation(params: Readonly<{
    mutationId: string;
    observedAt: number;
}>): RegisteredSessionStateFieldMutationV1 {
    return {
        v: 1,
        sessionId: 'session-1',
        mutationId: params.mutationId,
        fieldId: 'runtime.workState',
        deliveryClass: 'durable_required',
        op: {
            kind: 'set',
            value: {
                v: 1,
                backendId: 'test',
                updatedAt: params.observedAt,
                items: [],
            },
        },
        source: 'runtime',
        observedAt: params.observedAt,
    };
}

function createActivityMutation(params: Readonly<{
    observedAt: number;
    state: 'active' | 'idle' | 'unknown';
    activeCount?: number;
}>): RegisteredSessionStateFieldMutationV1 {
    return createRegisteredSessionStateFieldMutation({
        sessionId: 'session-1',
        fieldId: 'runtime.activity',
        deliveryClass: 'durable_best_effort',
        source: 'runtime',
        observedAt: params.observedAt,
        op: {
            kind: 'set',
            value: {
                state: params.state,
                activeCount: params.activeCount ?? 0,
            },
        },
    });
}

function createExactActivitySettlement(
    mutation: RegisteredSessionStateFieldMutationV1,
    status: 'applied' | 'unchanged',
    revision: number,
) {
    if (mutation.fieldId !== 'runtime.activity' || mutation.op.kind !== 'set') {
        throw new Error('Expected a runtime Activity snapshot mutation');
    }
    const value = mutation.op.value as {
        state: 'active' | 'idle' | 'unknown';
        activeCount: number;
    };
    return {
        delivered: true,
        settlement: {
            status,
            committedProjection: {
                ...value,
                observedAt: mutation.observedAt,
                revision,
            },
            committedRevision: revision,
        },
    } as const;
}

function createTranscriptMutation(params: Readonly<{
    localId: string;
    sidechainId: string | null;
    text: string;
    messageRole?: 'user' | 'agent';
}>): TranscriptMessageAppendMutationV1 {
    return {
        v: 1,
        sessionId: 'session-1',
        mutationId: `transcript:session-1:${params.localId}`,
        source: 'transcript_message_append',
        localId: params.localId,
        sidechainId: params.sidechainId,
        messageRole: params.messageRole ?? 'agent',
        content: params.text,
        createdAt: 100,
        updatedAt: 100,
        provenance: { kind: 'non_dependent', source: 'external' },
    };
}

function createVoiceTurnMutation(params: Readonly<{
    assistantText: string;
}>): VoiceAgentTranscriptTurnMutationV1 {
    return {
        v: 1,
        sessionId: 'session-1',
        mutationId: 'voice-agent-transcript-turn:session-1:turn-1',
        source: 'voice_agent_transcript_turn',
        turnId: 'turn-1',
        user: createTranscriptMutation({
            localId: 'voice-user',
            sidechainId: null,
            text: 'question',
            messageRole: 'user',
        }),
        assistant: createTranscriptMutation({
            localId: 'voice-assistant',
            sidechainId: null,
            text: params.assistantText,
            messageRole: 'agent',
        }),
        observedAt: 100,
    };
}

function createDeferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function createConnectedSocket() {
    return {
        connected: true,
        emit: () => undefined,
        emitWithAck: async (event: string, payload: unknown) => {
            if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                return { ok: true, capability: 'session-transcript-observation-v1' };
            }
            if (event !== SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) return { ok: false };
            return {
                ok: true,
                status: 'observed',
                id: 'message-id',
                seq: 1,
                localId: typeof payload === 'object' && payload && 'localId' in payload
                    ? String(payload.localId)
                    : 'unknown',
                didWrite: true,
                ingestedAt: 200,
            };
        },
    };
}

async function drainAsyncWork(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function createStorageExhaustedError(): NodeJS.ErrnoException {
    const error = new Error('journal storage exhausted') as NodeJS.ErrnoException;
    error.code = 'ENOSPC';
    return error;
}

describe('createRuntimeSessionClientDurableMutationOutbox', () => {
    beforeEach(() => {
        persistenceMocks.appendDeadLetters.mockResolvedValue({
            cappedDeadLetterCount: 0,
            referencedRetainedEntryCount: 0,
            prunedEntryCount: 0,
            referencedPrerequisiteOverflowCount: 0,
        });
        persistenceMocks.loadDeadLetters.mockResolvedValue([]);
        persistenceMocks.load.mockResolvedValue([]);
        persistenceMocks.markRecovered.mockResolvedValue(undefined);
        persistenceMocks.recover.mockResolvedValue([]);
    });

    afterEach(async () => {
        const { resetSessionClientDurableMutationOutboxStateForTests } = await import(
            './createSessionClientDurableMutationOutbox'
        );
        await resetSessionClientDurableMutationOutboxStateForTests();
        persistenceMocks.markRecovered.mockReset();
        persistenceMocks.appendDeadLetters.mockReset();
        persistenceMocks.loadDeadLetters.mockReset();
        persistenceMocks.load.mockReset();
        persistenceMocks.recover.mockReset();
        persistenceMocks.save.mockReset();
    });

    it('reports typed admission backpressure before delivery when durable headroom is unavailable', async () => {
        persistenceMocks.save.mockRejectedValue(createStorageExhaustedError());
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(),
        };
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            flushOnReady: false,
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });
        await outbox.awaitReady();

        await expect(outbox.enqueueSessionTurnMutation({
            v: 1,
            sessionId: 'session-1',
            mutationId: 'turn-begin-capacity',
            action: 'begin',
            turnId: 'turn-1',
            observedAt: 1,
        })).rejects.toMatchObject({
            name: 'SessionMutationJournalAdmissionBlockedError',
            cause: expect.objectContaining({ code: 'ENOSPC' }),
        });
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it('fences a terminal transcript admission held behind outbox readiness before persistence or delivery', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const readiness = createDeferred();
        persistenceMocks.load.mockImplementationOnce(async () => {
            await readiness.promise;
            return [];
        });
        persistenceMocks.save.mockResolvedValue(undefined);
        const socket = createConnectedSocket();
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            flushOnReady: false,
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });
        const admission = new AbortController();
        const emitWithAck = vi.spyOn(socket, 'emitWithAck');
        const enqueue = outbox.enqueueTranscriptMessage(createTranscriptMutation({
            localId: 'replay-held-by-readiness',
            sidechainId: null,
            text: 'must not escape the expired replay admission',
        }), {
            admission: {
                signal: admission.signal,
                deadlineAtMs: 1_001,
            },
        });

        try {
            await vi.advanceTimersByTimeAsync(2);
            readiness.resolve();

            await expect(enqueue).rejects.toThrow('Committed transcript admission expired');
            expect(persistenceMocks.save).not.toHaveBeenCalled();
            expect(emitWithAck).not.toHaveBeenCalled();
        } finally {
            await outbox.close();
            vi.useRealTimers();
        }
    });

    it('fences a terminal transcript admission held behind prior serialized persistence before persistence or delivery', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const priorPersist = createDeferred();
        const priorPersistStarted = createDeferred();
        persistenceMocks.save
            .mockImplementationOnce(async () => {
                priorPersistStarted.resolve();
                await priorPersist.promise;
            })
            .mockResolvedValue(undefined);
        const deliveredLocalIds: string[] = [];
        const socket = {
            ...createConnectedSocket(),
            emitWithAck: vi.fn(async (event: string, payload: unknown) => {
                if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                    return { ok: true, capability: 'session-transcript-observation-v1' };
                }
                const localId = typeof payload === 'object' && payload && 'localId' in payload
                    ? String(payload.localId)
                    : 'unknown';
                deliveredLocalIds.push(localId);
                return {
                    ok: true,
                    status: 'observed',
                    id: `message-${localId}`,
                    seq: 1,
                    localId,
                    didWrite: true,
                    ingestedAt: 2_000,
                };
            }),
        };
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            flushOnReady: false,
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });
        await outbox.setSessionSyncPendingInputServerContract(
            serverContract('session_sync_v2_pending_input_v1'),
        );
        const ordinary = outbox.enqueueTranscriptMessage(createTranscriptMutation({
            localId: 'ordinary-prior-persist',
            sidechainId: null,
            text: 'ordinary mutation remains admitted',
        }));
        await priorPersistStarted.promise;
        const admission = new AbortController();
        const replay = outbox.enqueueTranscriptMessage(createTranscriptMutation({
            localId: 'replay-held-by-prior-persist',
            sidechainId: null,
            text: 'must not escape the expired replay admission',
        }), {
            admission: {
                signal: admission.signal,
                deadlineAtMs: 1_001,
            },
        });

        try {
            await vi.advanceTimersByTimeAsync(2);
            priorPersist.resolve();

            await expect(ordinary).resolves.toMatchObject({ persisted: true });
            await expect(replay).rejects.toThrow('Committed transcript admission expired');
            expect(
                persistenceMocks.save.mock.calls.flatMap(([, mutations]) => mutations as Array<{
                    mutationId: string;
                }>),
            ).not.toContainEqual(expect.objectContaining({
                mutationId: 'transcript:session-1:replay-held-by-prior-persist',
            }));
            expect(deliveredLocalIds).not.toContain('replay-held-by-prior-persist');
        } finally {
            await outbox.close();
            vi.useRealTimers();
        }
    });

    it('keeps durable-required transcript and registered-field mutations queued without transport capability', async () => {
        const previousMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        persistenceMocks.save.mockResolvedValue(undefined);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
        });

        try {
            const transcriptResult = await outbox.enqueueTranscriptMessage(createTranscriptMutation({
                localId: 'offline-required-transcript',
                sidechainId: null,
                text: 'retained output',
            }));
            await outbox.enqueueRegisteredSessionStateFieldMutation(createFieldMutation({
                mutationId: 'offline-required-work-state',
                observedAt: 100,
            }));
            await outbox.flush('flush');

            expect(transcriptResult).toEqual({ persisted: true, delivered: false });
            const persisted = persistenceMocks.save.mock.calls.at(-1)?.[1];
            expect(persisted).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'transcript_message_append',
                    mutationId: 'transcript:session-1:offline-required-transcript',
                    attempts: 0,
                }),
                expect.objectContaining({
                    kind: 'registered_session_state_field',
                    mutationId: 'offline-required-work-state',
                    attempts: 0,
                }),
            ]));
            expect(persisted).toHaveLength(2);
            expect(persistenceMocks.appendDeadLetters.mock.calls.every(([, entries]) => (
                Array.isArray(entries) && entries.length === 0
            ))).toBe(true);
        } finally {
            await outbox.close();
            if (previousMaxAttempts === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = previousMaxAttempts;
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });

    it('negotiates once and drains multiple queued transcript rows through that connection epoch result', async () => {
        persistenceMocks.save.mockResolvedValue(undefined);
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(async (event: string, payload: unknown) => {
                if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                    return { ok: true, capability: 'session-transcript-observation-v1' };
                }
                const localId = typeof payload === 'object' && payload && 'localId' in payload
                    ? String(payload.localId)
                    : 'unknown';
                return {
                    ok: true,
                    status: 'observed',
                    id: `message-${localId}`,
                    seq: Number(localId.slice(-1)),
                    localId,
                    didWrite: true,
                    ingestedAt: 200,
                };
            }),
        };
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            initiallyActive: false,
            flushOnReady: false,
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });

        for (const localId of ['queued-1', 'queued-2', 'queued-3']) {
            await expect(outbox.enqueueTranscriptMessage(createTranscriptMutation({
                localId,
                sidechainId: null,
                text: `retained ${localId}`,
            }))).resolves.toEqual({ persisted: true, delivered: false });
        }
        const connectionContract = await resolveSessionClientConnectionContract({
            serverContract: {
                mode: 'session_sync_v2_pending_input_v1',
                runtimeActivity: 'v2',
                pendingInput: 'v1',
                publisherAuthority: 'indeterminate',
                sessionConnectionEpoch: 1,
                socket,
            },
            sessionId: 'session-1',
            socket,
        });
        await outbox.setSessionSyncPendingInputServerContract(connectionContract);
        await outbox.activateDelivery();

        expect(socket.emitWithAck.mock.calls.filter(([event]) => (
            event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1
        ))).toHaveLength(1);
        expect(socket.emitWithAck.mock.calls.filter(([event]) => (
            event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1
        ))).toHaveLength(3);
        expect(persistenceMocks.save.mock.calls.at(-1)?.[1]).toEqual([]);
        await outbox.close();
    });

    it('keeps an inactive transcript admission unattempted until activation', async () => {
        persistenceMocks.save.mockResolvedValue(undefined);
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(async () => ({
                ok: true,
                status: 'observed',
                id: 'message-inactive-1',
                seq: 1,
                localId: 'inactive-1',
                didWrite: true,
                ingestedAt: 200,
            })),
        };
        const getSocket = vi.fn(() => socket);
        const onTranscriptMessageDeliveryAttempt = vi.fn();
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            initiallyActive: false,
            flushOnReady: false,
            getSocket,
            requestReconnect: () => undefined,
            onTranscriptMessageDeliveryAttempt,
        });

        await expect(outbox.enqueueTranscriptMessage(createTranscriptMutation({
            localId: 'inactive-1',
            sidechainId: null,
            text: 'retained while inactive',
        }))).resolves.toEqual({ persisted: true, delivered: false });
        await outbox.flush('flush');

        const inactiveRows = persistenceMocks.save.mock.calls.at(-1)?.[1] as Array<{
            attempts: number;
            lastAttempt?: { attemptedAt: number };
        }>;
        expect(inactiveRows).toHaveLength(1);
        expect(inactiveRows[0]?.attempts).toBe(0);
        expect(inactiveRows[0]?.lastAttempt?.attemptedAt ?? null).toBeNull();
        expect(getSocket).not.toHaveBeenCalled();
        expect(onTranscriptMessageDeliveryAttempt).not.toHaveBeenCalled();

        await outbox.setSessionSyncPendingInputServerContract(
            serverContract('session_sync_v2_pending_input_v1'),
        );
        await outbox.activateDelivery();

        expect(getSocket).toHaveBeenCalledTimes(1);
        expect(onTranscriptMessageDeliveryAttempt).toHaveBeenCalledTimes(1);
        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(persistenceMocks.save.mock.calls.at(-1)?.[1]).toEqual([]);
        await outbox.close();
    });

    it('recovers a disconnected user row and deduplicates a repeated admission before delivery', async () => {
        const mutation = createTranscriptMutation({
            localId: 'recovered-user-1',
            sidechainId: null,
            text: 'recovered prompt observation',
            messageRole: 'user',
        });
        persistenceMocks.load.mockResolvedValue([{
            kind: 'transcript_message_append',
            mutationId: mutation.mutationId,
            payload: mutation,
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);
        persistenceMocks.save.mockResolvedValue(undefined);
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(async (event: string) => event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1
                ? { ok: true, capability: 'session-transcript-observation-v1' }
                : {
                    ok: true,
                    status: 'observed',
                    id: 'message-recovered-user-1',
                    seq: 8,
                    localId: 'recovered-user-1',
                    didWrite: true,
                    ingestedAt: 200,
                }),
        };
        const onTranscriptMessageDeliveryAttempt = vi.fn();
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            initiallyActive: false,
            flushOnReady: false,
            getSocket: () => socket,
            requestReconnect: () => undefined,
            onTranscriptMessageDeliveryAttempt,
        });
        await outbox.awaitReady();

        await expect(outbox.enqueueTranscriptMessage(mutation)).resolves.toEqual({
            persisted: true,
            delivered: false,
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await outbox.activateDelivery();

        expect(socket.emitWithAck.mock.calls.filter(([event]) => (
            event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1
        ))).toHaveLength(1);
        expect(onTranscriptMessageDeliveryAttempt).toHaveBeenCalledWith(expect.objectContaining({
            localId: 'recovered-user-1',
            messageRole: 'user',
        }));
        expect(persistenceMocks.save.mock.calls.at(-1)?.[1]).toEqual([]);
        await outbox.close();
    });

    it('keeps multiple required rows at zero attempts when the epoch lacks transcript capability', async () => {
        persistenceMocks.save.mockResolvedValue(undefined);
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(),
        };
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            flushOnReady: false,
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });

        await outbox.setSessionSyncPendingInputServerContract({
            mode: 'session_sync_v2_pending_input_v1',
            runtimeActivity: 'v2',
            pendingInput: 'v1',
            publisherAuthority: 'indeterminate',
            sessionConnectionEpoch: 1,
            socket,
            transcriptTransport: {
                mode: 'unavailable',
                reason: 'capability_missing_or_unsupported',
            },
        });
        for (const localId of ['unsupported-1', 'unsupported-2', 'unsupported-3']) {
            await outbox.enqueueTranscriptMessage(createTranscriptMutation({
                localId,
                sidechainId: null,
                text: `retained ${localId}`,
            }));
        }
        await outbox.flush('flush');

        expect(socket.emitWithAck).not.toHaveBeenCalled();
        expect(persistenceMocks.save.mock.calls.at(-1)?.[1]).toEqual([
            expect.objectContaining({ mutationId: 'transcript:session-1:unsupported-1', attempts: 0 }),
            expect.objectContaining({ mutationId: 'transcript:session-1:unsupported-2', attempts: 0 }),
            expect.objectContaining({ mutationId: 'transcript:session-1:unsupported-3', attempts: 0 }),
        ]);
        expect(persistenceMocks.appendDeadLetters).not.toHaveBeenCalledWith(
            'session-1',
            expect.arrayContaining([expect.objectContaining({ kind: 'transcript_message_append' })]),
            expect.anything(),
        );
        await outbox.close();
    });

    it('does not report a definitively invalid transcript dead letter as delivered', async () => {
        persistenceMocks.save.mockResolvedValue(undefined);
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(async (event: string) => (
                event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1
                    ? { ok: true, capability: 'session-transcript-observation-v1' }
                    : { ok: false, error: 'invalid_observation' }
            )),
        };
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });
        await outbox.setSessionSyncPendingInputServerContract(
            serverContract('session_sync_v2_pending_input_v1'),
        );

        const result = await outbox.enqueueTranscriptMessage(createTranscriptMutation({
            localId: 'invalid-transcript',
            sidechainId: null,
            text: 'invalid at canonical route',
        }));

        expect(result).toEqual({ persisted: true, delivered: false });
        expect(persistenceMocks.save.mock.calls.at(-1)?.[1]).toEqual([]);
        expect(persistenceMocks.appendDeadLetters).toHaveBeenCalledWith(
            'session-1',
            [expect.objectContaining({
                mutationId: 'transcript:session-1:invalid-transcript',
                reason: 'transcript_message_invalid_observation',
                attempts: 1,
                firstFailedAt: expect.any(Number),
                lastAttempt: {
                    v: 1,
                    reason: 'transcript_message_invalid_observation',
                    attemptedAt: expect.any(Number),
                },
            })],
            expect.objectContaining({ custody: 'runtime', sessionId: 'session-1' }),
        );
        await outbox.close();
    });

    it('retains terminal queue custody when dead-letter append fails and cuts only after terminal evidence is durable', async () => {
        persistenceMocks.save.mockResolvedValue(undefined);
        persistenceMocks.appendDeadLetters
            .mockRejectedValueOnce(new Error('dead-letter append rejected'))
            .mockResolvedValue({
                cappedDeadLetterCount: 0,
                referencedRetainedEntryCount: 0,
                prunedEntryCount: 0,
                referencedPrerequisiteOverflowCount: 0,
            });
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(async (event: string) => (
                event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1
                    ? { ok: true, capability: 'session-transcript-observation-v1' }
                    : { ok: false, error: 'invalid_observation' }
            )),
        };
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });
        await outbox.setSessionSyncPendingInputServerContract(
            serverContract('session_sync_v2_pending_input_v1'),
        );

        await expect(outbox.enqueueTranscriptMessage(createTranscriptMutation({
            localId: 'append-failure',
            sidechainId: null,
            text: 'terminal row must retain custody',
        }))).resolves.toEqual({ persisted: true, delivered: false });

        expect(persistenceMocks.appendDeadLetters).toHaveBeenCalledTimes(1);
        expect(persistenceMocks.save.mock.calls.at(-1)?.[1]).toEqual([
            expect.objectContaining({ mutationId: 'transcript:session-1:append-failure' }),
        ]);

        await outbox.flush('flush');

        expect(persistenceMocks.appendDeadLetters).toHaveBeenCalledTimes(2);
        expect(persistenceMocks.save.mock.calls.at(-1)?.[1]).toEqual([]);
        const terminalAppendOrder = persistenceMocks.appendDeadLetters.mock.invocationCallOrder[1]
            ?? Number.MAX_SAFE_INTEGER;
        const queueCutOrder = persistenceMocks.save.mock.invocationCallOrder.at(-1) ?? -1;
        expect(terminalAppendOrder).toBeLessThan(queueCutOrder);
        await outbox.close();
    });

    it('reconciles a stale terminal voice row against durable invalid evidence before restart delivery', async () => {
        const mutation = createVoiceTurnMutation({ assistantText: 'already terminal' });
        persistenceMocks.load.mockResolvedValue([{
            kind: 'voice_agent_transcript_turn',
            mutationId: mutation.mutationId,
            payload: mutation,
            createdAt: 100,
            attempts: 1,
            nextAttemptAt: 0,
        }]);
        persistenceMocks.loadDeadLetters.mockResolvedValue([{
            v: 1,
            kind: 'voice_agent_transcript_turn',
            sessionId: 'session-1',
            mutationId: mutation.mutationId,
            reason: 'transcript_message_invalid_observation',
            deadLetteredAt: 200,
        }]);
        persistenceMocks.save.mockResolvedValue(undefined);
        const socket = {
            connected: true,
            emit: vi.fn(),
            emitWithAck: vi.fn(async () => ({ ok: false, error: 'invalid_observation' })),
        };
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            flushOnReady: false,
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });

        await outbox.awaitReady();

        expect(persistenceMocks.save).toHaveBeenCalledWith(
            'session-1',
            [],
            expect.objectContaining({ custody: 'runtime', sessionId: 'session-1' }),
        );
        await outbox.setSessionSyncPendingInputServerContract(
            serverContract('session_sync_v2_pending_input_v1'),
        );
        await outbox.flush('flush');
        expect(socket.emitWithAck).not.toHaveBeenCalled();
        await outbox.close();
    });

    it('persists retained transcript output before recovery delivery and durably removes it afterward', async () => {
        const observedOrder: string[] = [];
        let rejectedSavesRemaining = 2;
        persistenceMocks.save.mockImplementation(async (_sessionId, mutations) => {
            if (rejectedSavesRemaining > 0) {
                rejectedSavesRemaining -= 1;
                observedOrder.push(`persist-rejected:${mutations.length}`);
                throw createStorageExhaustedError();
            }
            observedOrder.push(`persisted:${mutations.length}`);
        });
        const emitWithAck = vi.fn(async (event: string, payload: unknown) => {
            if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                return { ok: true, capability: 'session-transcript-observation-v1' };
            }
            if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                const localId = typeof payload === 'object' && payload && 'localId' in payload
                    ? String(payload.localId)
                    : 'unknown';
                observedOrder.push(`delivered:${localId}`);
                return {
                    ok: true,
                    status: 'observed',
                    id: 'message-id',
                    seq: 1,
                    localId,
                    didWrite: true,
                    ingestedAt: 200,
                };
            }
            return { ok: false };
        });
        const socket = { ...createConnectedSocket(), emitWithAck };
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            flushOnReady: false,
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });
        await outbox.awaitReady();
        await outbox.setSessionSyncPendingInputServerContract(
            serverContract('session_sync_v2_pending_input_v1'),
        );
        const mutation = createTranscriptMutation({
            localId: 'already-emitted-output',
            sidechainId: null,
            text: 'provider output already observed',
        });

        await expect(outbox.enqueueTranscriptMessage(mutation)).rejects.toMatchObject({
            name: 'SessionMutationJournalAdmissionBlockedError',
            cause: expect.objectContaining({ code: 'ENOSPC' }),
        });
        await expect(outbox.flush('flush')).rejects.toMatchObject({ code: 'ENOSPC' });
        expect(emitWithAck.mock.calls.filter(([event]) => (
            event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1
        ))).toHaveLength(0);
        await outbox.flush('flush');
        await outbox.flush('flush');

        expect(observedOrder).toEqual([
            'persist-rejected:1',
            'persist-rejected:1',
            'persisted:1',
            'delivered:already-emitted-output',
            'persisted:0',
        ]);
        expect(emitWithAck.mock.calls.filter(([event]) => (
            event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1
        ))).toHaveLength(1);
    });

    it('persists a retained atomic voice turn before either transcript message is delivered', async () => {
        const observedOrder: string[] = [];
        let failNextSave = true;
        persistenceMocks.save.mockImplementation(async (_sessionId, mutations) => {
            if (failNextSave) {
                failNextSave = false;
                observedOrder.push(`persist-rejected:${mutations.length}`);
                throw createStorageExhaustedError();
            }
            observedOrder.push(`persisted:${mutations.length}`);
        });
        const emitWithAck = vi.fn(async (event: string, payload: unknown) => {
            if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                return { ok: true, capability: 'session-transcript-observation-v1' };
            }
            if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                const localId = typeof payload === 'object' && payload && 'localId' in payload
                    ? String(payload.localId)
                    : 'unknown';
                observedOrder.push(`delivered:${localId}`);
                return {
                    ok: true,
                    status: 'observed',
                    id: `message-${localId}`,
                    seq: localId === 'voice-user' ? 1 : 2,
                    localId,
                    didWrite: true,
                    ingestedAt: 200,
                };
            }
            return { ok: false };
        });
        const socket = { ...createConnectedSocket(), emitWithAck };
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            flushOnReady: false,
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });
        await outbox.awaitReady();
        await outbox.setSessionSyncPendingInputServerContract(
            serverContract('session_sync_v2_pending_input_v1'),
        );

        await expect(outbox.enqueueVoiceAgentTranscriptTurn(createVoiceTurnMutation({
            assistantText: 'answer',
        }))).rejects.toMatchObject({
            name: 'SessionMutationJournalAdmissionBlockedError',
            cause: expect.objectContaining({ code: 'ENOSPC' }),
        });
        await outbox.flush('flush');
        await outbox.flush('flush');

        expect(observedOrder).toEqual([
            'persist-rejected:1',
            'persisted:1',
            'delivered:voice-user',
            'delivered:voice-assistant',
            'persisted:0',
        ]);
        expect(emitWithAck.mock.calls.filter(([event]) => (
            event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1
        ))).toHaveLength(2);
    });

    it('does not clear retained transcript persistence debt when an identical field reuses custody without saving', async () => {
        const activity = createActivityMutation({
            observedAt: 100,
            state: 'active',
            activeCount: 1,
        });
        const observedOrder: string[] = [];
        const emitWithAck = vi.fn(async (event: string, payload: unknown) => {
            if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                return { ok: true, capability: 'session-transcript-observation-v1' };
            }
            if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                const localId = typeof payload === 'object' && payload && 'localId' in payload
                    ? String(payload.localId)
                    : 'unknown';
                observedOrder.push(`delivered:${localId}`);
                return {
                    ok: true,
                    status: 'observed',
                    id: 'message-id',
                    seq: 1,
                    localId,
                    didWrite: true,
                    ingestedAt: 200,
                };
            }
            return { ok: false };
        });
        const socket = { ...createConnectedSocket(), emitWithAck };
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            flushOnReady: false,
            initialRegisteredSessionStateFieldMutations: [activity],
            getSocket: () => socket,
            requestReconnect: () => undefined,
        });
        await outbox.awaitReady();
        persistenceMocks.save.mockReset();
        persistenceMocks.save.mockImplementation(async (_sessionId, mutations) => {
            if (observedOrder.length === 0) {
                observedOrder.push(`persist-rejected:${mutations.length}`);
                throw createStorageExhaustedError();
            }
            observedOrder.push(`persisted:${mutations.length}`);
        });
        const transcript = createTranscriptMutation({
            localId: 'retained-before-field-reuse',
            sidechainId: null,
            text: 'provider output',
        });

        await expect(outbox.enqueueTranscriptMessage(transcript)).rejects.toMatchObject({
            name: 'SessionMutationJournalAdmissionBlockedError',
        });
        await outbox.enqueueRegisteredSessionStateFieldMutation(activity);
        await outbox.flush('flush');
        await outbox.setSessionSyncPendingInputServerContract(
            serverContract('session_sync_v2_pending_input_v1'),
        );

        const deliveredIndex = observedOrder.indexOf('delivered:retained-before-field-reuse');
        expect(observedOrder[0]).toBe('persist-rejected:2');
        expect(observedOrder.slice(1, deliveredIndex)).toContain('persisted:2');
        expect(deliveredIndex).toBeGreaterThan(1);
        expect(observedOrder.at(-1)).toBe('persisted:1');
    });

    it('routes registered-field delivery through the newest capable handle even while it is disconnected', async () => {
        persistenceMocks.save.mockResolvedValue(undefined);
        const deliveredBy: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const oldHandle = createRuntimeSessionClientDurableMutationOutbox({
            token: 'old-token',
            sessionId: 'session-1',
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => {
                deliveredBy.push('old');
                return { delivered: true, settlement: 'applied' };
            },
        });
        const currentHandle = createRuntimeSessionClientDurableMutationOutbox({
            token: 'current-token',
            sessionId: 'session-1',
            getSocket: () => ({ ...createConnectedSocket(), connected: false }),
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => {
                deliveredBy.push('current');
                return { delivered: true, settlement: 'applied' };
            },
        });

        await currentHandle.enqueueRegisteredSessionStateFieldMutation(createFieldMutation({
            mutationId: 'current-handle-field',
            observedAt: 100,
        }));
        await currentHandle.flush('flush');

        expect(deliveredBy).toEqual(['current']);
        await currentHandle.close();
        await oldHandle.close();
    });

    it('serializes a same-session reopen behind final-handle close', async () => {
        const initialLoad = createDeferred();
        persistenceMocks.load.mockImplementationOnce(async () => {
            await initialLoad.promise;
            return [];
        }).mockResolvedValue([]);
        persistenceMocks.save.mockResolvedValue(undefined);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const closingHandle = createRuntimeSessionClientDurableMutationOutbox({
            token: 'closing-token',
            sessionId: 'session-1',
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
        });

        const closePromise = closingHandle.close();
        const reopenedHandle = createRuntimeSessionClientDurableMutationOutbox({
            token: 'reopened-token',
            sessionId: 'session-1',
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
        });

        expect(persistenceMocks.load).toHaveBeenCalledTimes(1);
        initialLoad.resolve();
        await closePromise;
        await reopenedHandle.flush('flush');
        expect(persistenceMocks.load).toHaveBeenCalledTimes(2);
        await reopenedHandle.close();
    });

    it('keeps a reopened enqueue behind blocked final-close persistence', async () => {
        const releaseDelivery = createDeferred();
        const releaseClosePersistence = createDeferred();
        const loaded = createFieldMutation({ mutationId: 'loaded-before-close', observedAt: 100 });
        persistenceMocks.load.mockResolvedValueOnce([{
            kind: 'registered_session_state_field',
            mutationId: loaded.mutationId,
            payload: loaded,
            admissionOrder: 1,
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }]).mockResolvedValue([]);
        persistenceMocks.save
            .mockImplementationOnce(async () => await releaseClosePersistence.promise)
            .mockResolvedValue(undefined);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const closingHandle = createRuntimeSessionClientDurableMutationOutbox({
            token: 'closing-token',
            sessionId: 'session-1',
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => {
                await releaseDelivery.promise;
                return false;
            },
        });
        await closingHandle.awaitReady();
        const closePromise = closingHandle.close();
        const reopenedHandle = createRuntimeSessionClientDurableMutationOutbox({
            token: 'reopened-token',
            sessionId: 'session-1',
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => true,
        });
        const reopenedEnqueue = reopenedHandle.enqueueRegisteredSessionStateFieldMutation(
            createFieldMutation({ mutationId: 'after-close', observedAt: 200 }),
        );

        releaseDelivery.resolve();
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(1));
        expect(persistenceMocks.load).toHaveBeenCalledTimes(1);
        releaseClosePersistence.resolve();
        await closePromise;
        await reopenedEnqueue;
        expect(persistenceMocks.load).toHaveBeenCalledTimes(2);
        await reopenedHandle.close();
    });

    it('fails a same-session reopen closed when final-close persistence rejects', async () => {
        const releaseDelivery = createDeferred();
        const loaded = createFieldMutation({ mutationId: 'loaded-before-close', observedAt: 100 });
        persistenceMocks.load.mockResolvedValue([{
            kind: 'registered_session_state_field',
            mutationId: loaded.mutationId,
            payload: loaded,
            admissionOrder: 1,
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);
        persistenceMocks.save.mockRejectedValue(new Error('final close persistence rejected'));
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const closingHandle = createRuntimeSessionClientDurableMutationOutbox({
            token: 'closing-token',
            sessionId: 'session-1',
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => {
                await releaseDelivery.promise;
                return false;
            },
        });
        await closingHandle.awaitReady();
        const closePromise = closingHandle.close();
        const reopenedHandle = createRuntimeSessionClientDurableMutationOutbox({
            token: 'reopened-token',
            sessionId: 'session-1',
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
        });
        const reopenedEnqueue = reopenedHandle.enqueueRegisteredSessionStateFieldMutation(
            createFieldMutation({ mutationId: 'must-not-open', observedAt: 200 }),
        );
        releaseDelivery.resolve();

        await expect(closePromise).rejects.toThrow('final close persistence rejected');
        await expect(reopenedEnqueue).rejects.toThrow('final close persistence rejected');
        expect(persistenceMocks.load).toHaveBeenCalledTimes(1);
    });

    it('persists caller-supplied initial field snapshots over stale loaded rows before readiness', async () => {
        const stale = createFieldMutation({ mutationId: 'stale-loaded', observedAt: 200 });
        const current = createFieldMutation({ mutationId: 'current-startup', observedAt: 100 });
        const unrelated = createTranscriptMutation({ localId: 'unrelated', sidechainId: null, text: 'keep me' });
        persistenceMocks.load.mockResolvedValue([
            {
                kind: 'registered_session_state_field',
                mutationId: stale.mutationId,
                payload: stale,
                createdAt: 200,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'transcript_message_append',
                mutationId: unrelated.mutationId,
                payload: unrelated,
                createdAt: 100,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ]);
        persistenceMocks.save.mockResolvedValue(undefined);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            initialRegisteredSessionStateFieldMutations: [current],
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => false,
        });

        await outbox.awaitReady();

        expect(persistenceMocks.save).toHaveBeenNthCalledWith(1, 'session-1', [
            expect.objectContaining({ mutationId: 'transcript:session-1:unrelated' }),
            expect.objectContaining({ mutationId: 'current-startup' }),
        ], expect.objectContaining({ custody: 'runtime', sessionId: 'session-1' }));
        expect(persistenceMocks.save.mock.calls[0]?.[1]).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ mutationId: 'stale-loaded' }),
        ]));
        await outbox.close();
    });

    it('fails readiness closed and preserves loaded custody when initial snapshot persistence fails', async () => {
        const stale = createFieldMutation({ mutationId: 'stale-loaded', observedAt: 200 });
        const current = createFieldMutation({ mutationId: 'current-startup', observedAt: 100 });
        persistenceMocks.load.mockResolvedValue([{
            kind: 'registered_session_state_field',
            mutationId: stale.mutationId,
            payload: stale,
            createdAt: 200,
            attempts: 0,
            nextAttemptAt: 0,
        }]);
        persistenceMocks.save.mockRejectedValue(new Error('startup overlay write rejected'));
        const delivered: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            initialRegisteredSessionStateFieldMutations: [current],
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                delivered.push(mutation.mutationId);
                return true;
            },
        });

        await expect(outbox.awaitReady()).rejects.toThrow('startup overlay write rejected');
        await expect(outbox.flush('connect')).rejects.toThrow('startup overlay write rejected');
        expect(delivered).toEqual([]);
    });

    it('applies the construction snapshot after authoritative dead-letter recovery and before marking recovery', async () => {
        const staleRecovered = createFieldMutation({ mutationId: 'stale-recovered', observedAt: 200 });
        const current = createFieldMutation({ mutationId: 'current-startup', observedAt: 100 });
        const unrelated = createTranscriptMutation({ localId: 'unrelated-recovery', sidechainId: null, text: 'keep me' });
        persistenceMocks.load.mockResolvedValue([{
            kind: 'transcript_message_append',
            mutationId: unrelated.mutationId,
            payload: unrelated,
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);
        persistenceMocks.recover.mockResolvedValue([{
            kind: 'registered_session_state_field',
            mutationId: staleRecovered.mutationId,
            payload: staleRecovered,
            createdAt: 200,
            attempts: 1,
            nextAttemptAt: 0,
        }]);
        persistenceMocks.save.mockResolvedValue(undefined);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            initialRegisteredSessionStateFieldMutations: [current],
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => false,
        });

        await outbox.awaitReady();

        expect(persistenceMocks.save).toHaveBeenCalledTimes(1);
        expect(persistenceMocks.save).toHaveBeenLastCalledWith('session-1', [
            expect.objectContaining({ mutationId: unrelated.mutationId }),
            expect.objectContaining({ mutationId: current.mutationId }),
        ], expect.objectContaining({ custody: 'runtime', sessionId: 'session-1' }));
        for (const [, persisted] of persistenceMocks.save.mock.calls) {
            expect(persisted).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ mutationId: staleRecovered.mutationId }),
            ]));
        }
        expect(persistenceMocks.markRecovered).toHaveBeenCalledWith(
            'session-1',
            [staleRecovered.mutationId],
            expect.objectContaining({ custody: 'runtime', sessionId: 'session-1' }),
        );
        expect(persistenceMocks.markRecovered).toHaveBeenCalledTimes(1);
        const saveCallOrder = persistenceMocks.save.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
        const markRecoveredCallOrder = persistenceMocks.markRecovered.mock.invocationCallOrder[0] ?? -1;
        expect(saveCallOrder).toBeLessThan(markRecoveredCallOrder);
        await outbox.close();
    });

    it('validates a deferred transcript enqueue against the prior committed candidate', async () => {
        const firstPersistence = createDeferred();
        persistenceMocks.save
            .mockImplementationOnce(async () => await firstPersistence.promise)
            .mockResolvedValue(undefined);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
        });
        await outbox.setSessionSyncPendingInputServerContract(
            serverContract('session_sync_v2_pending_input_v1'),
        );

        const first = outbox.enqueueTranscriptMessage(createTranscriptMutation({
            localId: 'same-local-id',
            sidechainId: 'tool-a',
            text: 'first',
        }));
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(1));
        const conflicting = outbox.enqueueTranscriptMessage(createTranscriptMutation({
            localId: 'same-local-id',
            sidechainId: 'tool-b',
            text: 'second',
        }));
        firstPersistence.resolve();

        await expect(conflicting).rejects.toThrow(/sidechain/i);
        await expect(first).resolves.toEqual({ persisted: true, delivered: true });
    });

    it('validates a deferred voice-turn enqueue against the prior committed candidate', async () => {
        const firstPersistence = createDeferred();
        persistenceMocks.save
            .mockImplementationOnce(async () => await firstPersistence.promise)
            .mockResolvedValue(undefined);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
        });

        const first = outbox.enqueueVoiceAgentTranscriptTurn(createVoiceTurnMutation({
            assistantText: 'first answer',
        }));
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(1));
        const conflicting = outbox.enqueueVoiceAgentTranscriptTurn(createVoiceTurnMutation({
            assistantText: 'different answer',
        }));
        firstPersistence.resolve();

        await expect(conflicting).rejects.toThrow(/identity/i);
        await expect(first).resolves.toEqual({ persisted: true, delivered: false });
    });

    it('does not publish an enqueue whose persistence rejects into a later flush', async () => {
        persistenceMocks.save
            .mockRejectedValueOnce(new Error('durable write rejected'))
            .mockResolvedValue(undefined);
        const deliveredMutationIds: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredMutationIds.push(mutation.mutationId);
                return { delivered: true, settlement: 'applied' };
            },
        });

        await expect(outbox.enqueueRegisteredSessionStateFieldMutation(createFieldMutation({
            mutationId: 'rejected-enqueue',
            observedAt: 100,
        }))).rejects.toThrow('durable write rejected');

        await outbox.flush('flush');

        expect(deliveredMutationIds).toEqual([]);
    });

    it('assigns stable Activity identity and positive durable admission order only after custody succeeds', async () => {
        persistenceMocks.save
            .mockRejectedValueOnce(new Error('pre-custody failure'))
            .mockResolvedValue(undefined);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const delivered: RegisteredSessionStateFieldMutationV1[] = [];
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                delivered.push(mutation);
                return createExactActivitySettlement(mutation, 'applied', 1);
            },
        });
        const first = createActivityMutation({ observedAt: 900, state: 'active', activeCount: 1 });
        const reoffer = createActivityMutation({ observedAt: 100, state: 'active', activeCount: 1 });

        expect(first.mutationId).toBe('runtime-activity-snapshot:session-1');
        expect(reoffer.mutationId).toBe(first.mutationId);
        await expect(outbox.enqueueRegisteredSessionStateFieldMutation(first))
            .rejects.toThrow('pre-custody failure');
        expect(outbox.readRuntimeActivitySnapshotTail()).toEqual({
            sequence: 0,
            custody: null,
            settlement: null,
        });
        const rejectedSave = persistenceMocks.save.mock.calls[0]?.[1] as Array<{ admissionOrder?: number }>;
        expect(rejectedSave).toHaveLength(1);
        expect(rejectedSave[0]?.admissionOrder).toBeGreaterThan(0);

        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        await outbox.enqueueRegisteredSessionStateFieldMutation(reoffer);
        await outbox.flush('flush');

        const durableSave = persistenceMocks.save.mock.calls.find(([, mutations]) => (
            (mutations as Array<{ admissionOrder?: number }>).some((mutation) => mutation.admissionOrder !== undefined)
        ))?.[1] as Array<{ admissionOrder?: number }> | undefined;
        expect(durableSave?.[0]?.admissionOrder).toBeGreaterThan(0);
        expect(delivered).toEqual([reoffer]);
        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            sequence: 2,
            custody: null,
            settlement: {
                identity: {
                    mutationKey: 'runtime-activity-snapshot:session-1',
                    admissionOrder: 1,
                },
                desiredValue: { state: 'active', activeCount: 1 },
                result: 'applied',
                committedRevision: 1,
            },
        });
    });

    it('uses durable admission order instead of observedAt and ignores an older same-key ACK', async () => {
        persistenceMocks.save.mockResolvedValue(undefined);
        const olderDelivery = createDeferred();
        const deliveredStates: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                const value = mutation.op.kind === 'set'
                    ? mutation.op.value as { state: string }
                    : { state: 'clear' };
                deliveredStates.push(value.state);
                if (value.state === 'active') {
                    await olderDelivery.promise;
                    return createExactActivitySettlement(mutation, 'applied', 1);
                }
                return createExactActivitySettlement(mutation, 'unchanged', 2);
            },
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        const older = createActivityMutation({ observedAt: 900, state: 'active', activeCount: 1 });
        const newer = createActivityMutation({ observedAt: 100, state: 'idle' });
        const olderWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(older);
        await vi.waitFor(() => expect(deliveredStates).toEqual(['active']));
        const newerWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(newer);
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(2));
        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            sequence: 2,
            custody: {
                identity: { admissionOrder: 2 },
                value: { state: 'idle', activeCount: 0 },
            },
            settlement: null,
        });
        olderDelivery.resolve();

        await expect(Promise.all([olderWaiter, newerWaiter])).resolves.toEqual([
            {
                status: 'unchanged',
                committedProjection: {
                    state: 'idle',
                    activeCount: 0,
                    observedAt: 100,
                    revision: 2,
                },
                committedRevision: 2,
            },
            {
                status: 'unchanged',
                committedProjection: {
                    state: 'idle',
                    activeCount: 0,
                    observedAt: 100,
                    revision: 2,
                },
                committedRevision: 2,
            },
        ]);
        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: null,
            settlement: {
                identity: { admissionOrder: 2 },
                desiredValue: { state: 'idle', activeCount: 0 },
                result: 'unchanged',
                committedRevision: 2,
            },
        });
        expect(deliveredStates).toEqual(['active', 'idle']);
    });

    it('keeps an older exact Activity waiter attached to durable custody when a newer admission rejects', async () => {
        const olderDelivery = createDeferred();
        persistenceMocks.save
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('newer admission rejected'))
            .mockResolvedValue(undefined);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                await olderDelivery.promise;
                return createExactActivitySettlement(mutation, 'applied', 1);
            },
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        const olderWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createActivityMutation({ observedAt: 100, state: 'active', activeCount: 1 }),
        );
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(1));

        await expect(outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createActivityMutation({ observedAt: 200, state: 'idle' }),
        )).rejects.toThrow('newer admission rejected');
        await expect(Promise.race([
            olderWaiter.then(() => 'settled' as const),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
        ])).resolves.toBe('pending');
        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            custody: {
                identity: { admissionOrder: 1 },
                value: { state: 'active', activeCount: 1 },
            },
            settlement: null,
        });

        olderDelivery.resolve();
        await expect(olderWaiter).resolves.toEqual({
            status: 'applied',
            committedProjection: {
                state: 'active',
                activeCount: 1,
                observedAt: 100,
                revision: 1,
            },
            committedRevision: 1,
        });
    });

    it('activates identical hydrated Activity backoff custody without allocating a new identity', async () => {
        const hydrated = {
            kind: 'registered_session_state_field',
            mutationId: 'runtime-activity-snapshot:session-1',
            payload: createActivityMutation({ observedAt: 800, state: 'active', activeCount: 1 }),
            admissionOrder: 41,
            createdAt: 800,
            attempts: 3,
            nextAttemptAt: Date.now() + 60_000,
        } as const;
        persistenceMocks.load.mockResolvedValue([hydrated]);
        persistenceMocks.save.mockResolvedValue(undefined);
        const delivered: string[] = [];
        let deliveryEnabled = false;
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            flushOnReady: false,
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                if (!deliveryEnabled) return false;
                delivered.push(mutation.mutationId);
                return createExactActivitySettlement(mutation, 'unchanged', 41);
            },
        });
        await outbox.awaitReady();
        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            sequence: 1,
            custody: {
                identity: {
                    mutationKey: 'runtime-activity-snapshot:session-1',
                    admissionOrder: 41,
                },
                value: { state: 'active', activeCount: 1 },
            },
            settlement: null,
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));
        deliveryEnabled = true;
        await outbox.enqueueRegisteredSessionStateFieldMutation(
            createActivityMutation({ observedAt: 1, state: 'active', activeCount: 1 }),
        );

        await vi.waitFor(() => expect(delivered).toEqual(['runtime-activity-snapshot:session-1']));
        const admittedRows = persistenceMocks.save.mock.calls
            .flatMap(([, mutations]) => mutations as Array<{ admissionOrder?: number }>)
            .filter((mutation) => mutation.admissionOrder !== undefined);
        expect(new Set(admittedRows.map((mutation) => mutation.admissionOrder))).toEqual(new Set([41]));
    });

    it('normalizes a hydrated legacy Activity row to the stable identity before reoffer', async () => {
        const legacy = {
            kind: 'registered_session_state_field',
            mutationId: 'legacy-random-activity-id',
            payload: {
                ...createActivityMutation({ observedAt: 800, state: 'active', activeCount: 1 }),
                mutationId: 'legacy-random-activity-id',
            },
            createdAt: 800,
            attempts: 0,
            nextAttemptAt: 0,
        } as const;
        persistenceMocks.load.mockResolvedValue([legacy]);
        persistenceMocks.save.mockResolvedValue(undefined);
        const delivered: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            flushOnReady: false,
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                delivered.push(mutation.mutationId);
                return createExactActivitySettlement(mutation, 'unchanged', 41);
            },
        });

        await outbox.awaitReady();
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));

        await vi.waitFor(() => expect(delivered).toEqual([
            'runtime-activity-snapshot:session-1',
        ]));
        const persistedRows = persistenceMocks.save.mock.calls
            .flatMap(([, queued]) => queued as Array<{
                mutationId: string;
                admissionOrder?: number;
                payload: { mutationId: string };
            }>);
        expect(persistedRows).toContainEqual(expect.objectContaining({
            mutationId: 'runtime-activity-snapshot:session-1',
            admissionOrder: 1,
            payload: expect.objectContaining({
                mutationId: 'runtime-activity-snapshot:session-1',
            }),
        }));
    });

    it('fails startup closed without marking authoritative recovery when its outbox commit fails', async () => {
        const events: string[] = [];
        const recovered = {
            kind: 'session_end',
            mutationId: 'recovered-session-end',
            payload: {
                v: 1,
                sessionId: 'session-1',
                mutationId: 'recovered-session-end',
                source: 'session_end',
                observedAt: 100,
            },
            createdAt: 100,
            attempts: 1,
            nextAttemptAt: 0,
        } as const;
        persistenceMocks.recover.mockResolvedValue([recovered]);
        persistenceMocks.save
            .mockImplementationOnce(async () => {
                events.push('save-rejected');
                throw new Error('recovery outbox save rejected');
            })
            .mockImplementation(async () => {
                events.push('save-succeeded');
            });
        persistenceMocks.markRecovered.mockImplementation(async () => {
            events.push('marked-recovered');
        });
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: createConnectedSocket,
            requestReconnect: () => undefined,
        });

        await expect(outbox.awaitReady()).rejects.toThrow('recovery outbox save rejected');
        expect(events).toEqual(['save-rejected']);
        expect(persistenceMocks.markRecovered).not.toHaveBeenCalled();
        await expect(outbox.flush('flush')).rejects.toThrow('recovery outbox save rejected');
        expect(events).toEqual(['save-rejected']);
    });

    it('keeps the later durable admission when its observedAt regresses during an in-flight flush', async () => {
        const stalePersistence = createDeferred();
        const flushRecovery = createDeferred();
        const newerDelivery = createDeferred();
        persistenceMocks.recover
            .mockResolvedValueOnce([])
            .mockImplementationOnce(async () => {
                await flushRecovery.promise;
                return [];
            })
            .mockResolvedValue([]);
        persistenceMocks.save
            .mockResolvedValueOnce(undefined)
            .mockImplementationOnce(async () => await stalePersistence.promise)
            .mockResolvedValue(undefined);
        const deliveredMutationIds: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredMutationIds.push(mutation.mutationId);
                if (mutation.mutationId === 'field-newer') await newerDelivery.promise;
                return { delivered: true, settlement: 'applied' };
            },
        });

        await outbox.enqueueRegisteredSessionStateFieldMutation(createFieldMutation({
            mutationId: 'field-newer',
            observedAt: 200,
        }));
        const staleEnqueue = outbox.enqueueRegisteredSessionStateFieldMutation(createFieldMutation({
            mutationId: 'field-stale',
            observedAt: 100,
        }));
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(2));
        flushRecovery.resolve();
        await drainAsyncWork();
        expect(deliveredMutationIds).toEqual([]);
        stalePersistence.resolve();
        await staleEnqueue;
        await vi.waitFor(() => expect(deliveredMutationIds).toEqual(['field-stale']));
        newerDelivery.resolve();
        await outbox.flush('flush');

        expect(deliveredMutationIds).toEqual(['field-stale']);
        expect(persistenceMocks.save).toHaveBeenLastCalledWith(
            'session-1',
            [],
            expect.objectContaining({ custody: 'runtime', sessionId: 'session-1' }),
        );
    });

    it('transfers every exact waiter to the coalesced field mutation final outcome', async () => {
        const firstPersistence = createDeferred();
        persistenceMocks.save
            .mockImplementationOnce(async () => await firstPersistence.promise)
            .mockResolvedValue(undefined);
        const deliveredMutationIds: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredMutationIds.push(mutation.mutationId);
                return { delivered: true, settlement: 'superseded' };
            },
        });

        const olderWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createFieldMutation({ mutationId: 'field-older', observedAt: 100 }),
        );
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(1));
        const newerWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createFieldMutation({ mutationId: 'field-newer', observedAt: 200 }),
        );
        await drainAsyncWork();
        firstPersistence.resolve();

        await expect(Promise.all([olderWaiter, newerWaiter])).resolves.toEqual([
            { status: 'superseded' },
            { status: 'superseded' },
        ]);
        expect(deliveredMutationIds).toEqual(['field-newer']);
    });

    it('detaches a cancelled coalesced waiter without cancelling custody for another observer', async () => {
        const firstPersistence = createDeferred();
        const olderAbort = new AbortController();
        persistenceMocks.save
            .mockImplementationOnce(async () => await firstPersistence.promise)
            .mockResolvedValue(undefined);
        const deliveredMutationIds: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredMutationIds.push(mutation.mutationId);
                return {
                    delivered: true,
                    settlement: {
                        status: 'applied',
                        committedProjection: { mutationId: mutation.mutationId },
                        committedRevision: 1,
                    },
                };
            },
        });

        const olderWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createFieldMutation({ mutationId: 'cancel-older', observedAt: 100 }),
            { signal: olderAbort.signal },
        );
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(1));
        const newerWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createFieldMutation({ mutationId: 'cancel-newer', observedAt: 200 }),
        );
        await drainAsyncWork();
        olderAbort.abort();
        firstPersistence.resolve();
        await expect(olderWaiter).resolves.toEqual({ status: 'cancelled' });

        await expect(newerWaiter).resolves.toMatchObject({
            status: 'applied',
            committedRevision: 1,
        });
        expect(deliveredMutationIds).toEqual(['cancel-newer']);
        expect(persistenceMocks.save).toHaveBeenLastCalledWith(
            'session-1',
            [],
            expect.objectContaining({ custody: 'runtime', sessionId: 'session-1' }),
        );
    });

    it('transfers an in-flight exact waiter when the surviving field mutation is enqueued', async () => {
        const olderDelivery = createDeferred();
        persistenceMocks.save.mockResolvedValue(undefined);
        const deliveredMutationIds: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredMutationIds.push(mutation.mutationId);
                if (mutation.mutationId === 'in-flight-older') {
                    await olderDelivery.promise;
                    return { delivered: false, settlement: 'applied' };
                }
                return { delivered: true, settlement: 'applied' };
            },
        });

        const olderWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createFieldMutation({ mutationId: 'in-flight-older', observedAt: 100 }),
        );
        await vi.waitFor(() => expect(deliveredMutationIds).toEqual(['in-flight-older']));
        const newerWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createFieldMutation({ mutationId: 'in-flight-newer', observedAt: 200 }),
        );
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(2));
        olderDelivery.resolve();

        const outcomes = await Promise.race([
            Promise.all([olderWaiter, newerWaiter]),
            new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
        ]);
        expect(outcomes).toEqual([
            { status: 'applied' },
            { status: 'applied' },
        ]);
        expect(deliveredMutationIds).toEqual(['in-flight-older', 'in-flight-newer']);
    });

    it('does not let a superseded in-flight success settle the surviving exact waiters', async () => {
        const olderDelivery = createDeferred();
        persistenceMocks.save.mockResolvedValue(undefined);
        const deliveredMutationIds: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredMutationIds.push(mutation.mutationId);
                if (mutation.mutationId === 'ownership-older') {
                    await olderDelivery.promise;
                    return {
                        delivered: true,
                        settlement: {
                            status: 'applied',
                            committedProjection: { winner: 'older' },
                            committedRevision: 1,
                        },
                    };
                }
                return {
                    delivered: true,
                    settlement: {
                        status: 'unchanged',
                        committedProjection: { winner: 'newer' },
                        committedRevision: 2,
                    },
                };
            },
        });

        const olderWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createFieldMutation({ mutationId: 'ownership-older', observedAt: 100 }),
        );
        await vi.waitFor(() => expect(deliveredMutationIds).toEqual(['ownership-older']));
        const newerWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createFieldMutation({ mutationId: 'ownership-newer', observedAt: 200 }),
        );
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(2));
        olderDelivery.resolve();

        await expect(Promise.all([olderWaiter, newerWaiter])).resolves.toEqual([
            { status: 'unchanged', committedProjection: { winner: 'newer' }, committedRevision: 2 },
            { status: 'unchanged', committedProjection: { winner: 'newer' }, committedRevision: 2 },
        ]);
        expect(deliveredMutationIds).toEqual(['ownership-older', 'ownership-newer']);
    });

    it('settles a later exact admission after it supersedes a plain in-flight mutation', async () => {
        const survivorDelivery = createDeferred();
        persistenceMocks.save.mockResolvedValue(undefined);
        const deliveredMutationIds: string[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredMutationIds.push(mutation.mutationId);
                await survivorDelivery.promise;
                return {
                    delivered: true,
                    settlement: {
                        status: 'applied',
                        committedProjection: { winner: mutation.mutationId },
                        committedRevision: 1,
                    },
                };
            },
        });

        await outbox.enqueueRegisteredSessionStateFieldMutation(createFieldMutation({
            mutationId: 'plain-survivor',
            observedAt: 200,
        }));
        await vi.waitFor(() => expect(deliveredMutationIds).toEqual(['plain-survivor']));
        const exactWaiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
            createFieldMutation({ mutationId: 'exact-loser', observedAt: 100 }),
        );
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(2));
        survivorDelivery.resolve();

        await expect(Promise.race([
            exactWaiter,
            new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
        ])).resolves.toEqual({
            status: 'applied',
            committedProjection: { winner: 'exact-loser' },
            committedRevision: 1,
        });
        expect(deliveredMutationIds).toEqual(['plain-survivor', 'exact-loser']);
    });

    it('keeps Activity custody and uses bounded backoff for repeated applied-ACK dequeue failures', async () => {
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousMaxRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '50';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = '50';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        persistenceMocks.save
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('first dequeue save rejected'))
            .mockRejectedValueOnce(new Error('second dequeue save rejected'))
            .mockResolvedValue(undefined);
        const deliveredMutationIds: string[] = [];
        const deliveryTimes: number[] = [];
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                deliveredMutationIds.push(mutation.mutationId);
                deliveryTimes.push(Date.now());
                return {
                    delivered: true,
                    settlement: {
                        status: deliveredMutationIds.length === 1 ? 'applied' : 'unchanged',
                        committedProjection: {
                            state: 'idle',
                            activeCount: 0,
                            observedAt: 100,
                            revision: 4,
                        },
                        committedRevision: 4,
                    },
                };
            },
        });
        await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));

        const activityMutation: RegisteredSessionStateFieldMutationV1 = {
            v: 1,
            sessionId: 'session-1',
            mutationId: 'runtime-activity-session-1',
            fieldId: 'runtime.activity',
            deliveryClass: 'durable_best_effort',
            op: {
                kind: 'set',
                value: { state: 'idle', activeCount: 0 },
            },
            source: 'runtime',
            observedAt: 100,
        };

        try {
            const waiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(
                activityMutation,
            );
            await vi.waitFor(() => expect(deliveredMutationIds).toHaveLength(1));
            expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
                sequence: 1,
                custody: {
                    identity: { admissionOrder: 1 },
                    value: { state: 'idle', activeCount: 0 },
                },
                settlement: null,
            });
            await vi.waitFor(() => expect(deliveredMutationIds).toHaveLength(3));
            await expect(waiter).resolves.toMatchObject({
                status: 'unchanged',
                committedRevision: 4,
            });
            expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
                sequence: 2,
                custody: null,
                settlement: {
                    identity: { admissionOrder: 1 },
                    result: 'unchanged',
                    committedProjection: {
                        state: 'idle',
                        activeCount: 0,
                        observedAt: 100,
                        revision: 4,
                    },
                    committedRevision: 4,
                },
            });
            expect(deliveryTimes[1]! - deliveryTimes[0]!).toBeGreaterThanOrEqual(40);
            expect(deliveryTimes[2]! - deliveryTimes[1]!).toBeGreaterThanOrEqual(40);
            expect(new Set(deliveredMutationIds)).toEqual(new Set([
                'runtime-activity-snapshot:session-1',
            ]));
            expect(persistenceMocks.save).toHaveBeenLastCalledWith(
                'session-1',
                [],
                expect.objectContaining({ custody: 'runtime', sessionId: 'session-1' }),
            );
        } finally {
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousMaxRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = previousMaxRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });

    it('does not charge a successful delivery to the retry budget when only the local journal cut fails', async () => {
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        persistenceMocks.save
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('dequeue save rejected'))
            .mockResolvedValue(undefined);
        let deliveryCount = 0;
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => {
                deliveryCount += 1;
                return deliveryCount === 1
                    ? { delivered: true, settlement: 'applied' as const }
                    : false;
            },
        });

        try {
            await outbox.enqueueRegisteredSessionStateFieldMutation(createFieldMutation({
                mutationId: 'local-cut-retry-accounting',
                observedAt: 100,
            }));
            await vi.waitFor(() => expect(deliveryCount).toBe(1));

            await outbox.flush('flush');

            expect(deliveryCount).toBe(2);
            expect(persistenceMocks.save.mock.calls.at(-1)?.[1]).toEqual([
                expect.objectContaining({
                    mutationId: 'local-cut-retry-accounting',
                    attempts: 1,
                    firstFailedAt: expect.any(Number),
                    lastAttempt: {
                        v: 1,
                        reason: 'delivery_not_confirmed',
                        attemptedAt: expect.any(Number),
                    },
                }),
            ]);
        } finally {
            await outbox.close();
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });

    it('records a typed delivery-error reason when the delivery boundary throws', async () => {
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        persistenceMocks.save.mockResolvedValue(undefined);
        let deliveryCount = 0;
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => {
                deliveryCount += 1;
                throw new Error('delivery boundary rejected');
            },
        });

        try {
            await outbox.enqueueRegisteredSessionStateFieldMutation(createFieldMutation({
                mutationId: 'thrown-delivery-attempt',
                observedAt: 100,
            }));
            await vi.waitFor(() => expect(deliveryCount).toBe(1));
            await vi.waitFor(() => expect(persistenceMocks.save.mock.calls.at(-1)?.[1]).toEqual([
                expect.objectContaining({
                    mutationId: 'thrown-delivery-attempt',
                    attempts: 1,
                    firstFailedAt: expect.any(Number),
                    lastAttempt: {
                        v: 1,
                        reason: 'delivery_error',
                        attemptedAt: expect.any(Number),
                    },
                }),
            ]));
        } finally {
            await outbox.close();
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });

    it('keeps Activity custody and exact waiters pending when unsupported retirement persistence rejects', async () => {
        const retirementRetry = createDeferred();
        persistenceMocks.save
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('retirement save rejected'))
            .mockImplementationOnce(async () => await retirementRetry.promise)
            .mockResolvedValue(undefined);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
        });
        const activityMutation: RegisteredSessionStateFieldMutationV1 = {
            v: 1,
            sessionId: 'session-1',
            mutationId: 'unsupported-runtime-activity-session-1',
            fieldId: 'runtime.activity',
            deliveryClass: 'durable_best_effort',
            op: {
                kind: 'set',
                value: { state: 'idle', activeCount: 0 },
            },
            source: 'runtime',
            observedAt: 100,
        };

        const waiter = outbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(activityMutation);
        await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(1));
        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            sequence: 1,
            custody: {
                identity: { admissionOrder: 1 },
                value: { state: 'idle', activeCount: 0 },
            },
            settlement: null,
        });
        await expect(outbox.setSessionSyncPendingInputServerContract(serverContract('released_server_v0_2_1')))
            .rejects.toThrow('retirement save rejected');
        const prematureSettlement = await Promise.race([
            waiter.then(() => 'settled' as const),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
        ]);

        expect(prematureSettlement).toBe('pending');
        expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
            sequence: 1,
            custody: { identity: { admissionOrder: 1 } },
            settlement: null,
        });
        retirementRetry.resolve();
        await expect(waiter).resolves.toEqual({ status: 'failed' });
        expect(outbox.readRuntimeActivitySnapshotTail()).toEqual({
            sequence: 2,
            custody: null,
            settlement: null,
        });
        expect(persistenceMocks.save).toHaveBeenCalledTimes(3);
        expect(persistenceMocks.save).toHaveBeenLastCalledWith(
            'session-1',
            [],
            expect.objectContaining({ custody: 'runtime', sessionId: 'session-1' }),
        );
    });

    it('routes retry-timer flush rejection without an unhandled promise rejection', async () => {
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousMaxRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        persistenceMocks.save
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('timer persistence rejected'))
            .mockResolvedValue(undefined);
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown): void => {
            unhandled.push(error);
        };
        process.on('unhandledRejection', onUnhandled);
        const { createRuntimeSessionClientDurableMutationOutbox } = await import(
            './createRuntimeSessionClientDurableMutationOutbox'
        );
        const outbox = createRuntimeSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'session-1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverRegisteredSessionStateFieldMutation: async () => false,
        });

        try {
            await outbox.enqueueRegisteredSessionStateFieldMutation(createFieldMutation({
                mutationId: 'timer-retry',
                observedAt: 100,
            }));
            await vi.waitFor(() => expect(persistenceMocks.save.mock.calls.length).toBeGreaterThanOrEqual(3));

            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            await outbox.close().catch(() => undefined);
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousMaxRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = previousMaxRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });
});
