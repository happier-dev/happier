import { access, readFile, writeFile } from 'node:fs/promises';

import { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 } from '@happier-dev/protocol';

import { createDaemonSessionClientDurableMutationOutbox } from './createDaemonSessionClientDurableMutationOutbox';
import { createRuntimeSessionClientDurableMutationOutbox } from './createRuntimeSessionClientDurableMutationOutbox';
import {
    appendSessionClientDurableMutationDeadLetters,
    createSessionClientDurableMutationDeadLetterEntry,
    createSessionClientDurableMutationPersistenceContext,
    loadSessionClientDurableMutationOutbox,
    parseDaemonSessionClientDurableMutation,
    saveSessionClientDurableMutationOutbox,
} from './sessionClientDurableMutationPersistence';
import {
    createRegisteredSessionStateFieldMutation,
    createTranscriptMessageAppendMutation,
    type DaemonUsageLimitRecoveryFieldMutation,
    type QueuedSessionClientDurableMutation,
    type SessionClientDurableMutationSocket,
} from './sessionClientDurableMutationTypes';
import { configuration } from '@/configuration';

async function waitForFile(filePath: string): Promise<void> {
    for (;;) {
        try {
            await access(filePath);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
}

function queuedExactEnd(params: Readonly<{
    sessionId: string;
    mutationId: string;
    turnId: string;
    observedAt: number;
}>): Extract<QueuedSessionClientDurableMutation, { kind: 'session_turn_mutation' }> {
    return {
        kind: 'session_turn_mutation',
        mutationId: params.mutationId,
        payload: {
            v: 1,
            sessionId: params.sessionId,
            mutationId: params.mutationId,
            action: 'end_session',
            turnId: params.turnId,
            observedAt: params.observedAt,
        },
        createdAt: params.observedAt,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

async function runLegacyStaleWriter(args: readonly string[]): Promise<void> {
    const [sessionId, writer, readyPath, releasePath] = args;
    if (!sessionId || !writer || !readyPath || !releasePath) throw new Error('Missing legacy writer arguments');
    const staleSnapshot = await loadSessionClientDurableMutationOutbox(sessionId);
    const mutation: QueuedSessionClientDurableMutation = writer === 'runtime'
        ? {
            kind: 'transcript_message_append',
            mutationId: 'legacy-runtime-transcript',
            payload: createTranscriptMessageAppendMutation({
                sessionId,
                localId: 'legacy-local',
                content: 'legacy runtime transcript',
                createdAt: 100,
                provenance: { kind: 'non_dependent', source: 'external' },
            }),
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }
        : queuedExactEnd({
            sessionId,
            mutationId: 'legacy-daemon-exact',
            turnId: 'legacy-turn',
            observedAt: 101,
        });
    await writeFile(readyPath, 'ready');
    await waitForFile(releasePath);
    await saveSessionClientDurableMutationOutbox(sessionId, [...staleSnapshot, mutation]);
}

async function runRuntimeStage(args: readonly string[]): Promise<void> {
    const [sessionId, readyPath, releasePath] = args;
    if (!sessionId || !readyPath || !releasePath) throw new Error('Missing runtime stage arguments');
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
        token: 'runtime-token',
        sessionId,
        initiallyActive: false,
        flushOnReady: false,
        getSocket: () => ({ connected: false, emit: () => undefined }),
        requestReconnect: () => undefined,
    });
    await outbox.awaitReady();
    await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
        sessionId,
        localId: 'runtime-local',
        content: 'runtime transcript',
        createdAt: 200,
        provenance: { kind: 'non_dependent', source: 'external' },
    }));
    await writeFile(readyPath, 'ready');
    await waitForFile(releasePath);
    await outbox.enqueueRegisteredSessionStateFieldMutation(createRegisteredSessionStateFieldMutation({
        sessionId,
        fieldId: 'runtime.activity',
        deliveryClass: 'durable_best_effort',
        source: 'runtime',
        observedAt: 201,
        op: {
            kind: 'set',
            value: { state: 'unknown', activeCount: 0 },
        },
    }));
}

async function runDaemonStage(args: readonly string[]): Promise<void> {
    const [sessionId] = args;
    if (!sessionId) throw new Error('Missing daemon stage session id');
    const outbox = createDaemonSessionClientDurableMutationOutbox({
        token: 'daemon-token',
        sessionId,
        enableExactTurnDelivery: false,
        getSocket: () => null,
        requestReconnect: () => undefined,
        deliverUsageLimitRecovery: async () => false,
    });
    await outbox.awaitReady();
    await outbox.enqueueExactTurnEnd({
        v: 1,
        sessionId,
        mutationId: 'daemon-exact-queued',
        action: 'end_session',
        turnId: 'daemon-turn-queued',
        observedAt: 300,
    });
    await outbox.enqueueUsageLimitRecovery(createRegisteredSessionStateFieldMutation({
        sessionId,
        fieldId: 'runtime.usageLimitRecovery',
        source: 'daemon',
        observedAt: 301,
        op: { kind: 'clear' },
    }) as DaemonUsageLimitRecoveryFieldMutation);
    await outbox.close();

    const persistenceContext = createSessionClientDurableMutationPersistenceContext({
        activeServerDir: configuration.activeServerDir,
        custody: 'daemon',
        sessionId,
        parseQueuedMutation: parseDaemonSessionClientDurableMutation,
    });
    const deadLetterMutation = queuedExactEnd({
        sessionId,
        mutationId: 'daemon-exact-dead-letter',
        turnId: 'daemon-turn-dead-letter',
        observedAt: 302,
    });
    await appendSessionClientDurableMutationDeadLetters(sessionId, [
        createSessionClientDurableMutationDeadLetterEntry({
            sessionId,
            mutation: deadLetterMutation,
            reason: 'retry_exhausted',
        }),
    ], persistenceContext);
}

async function runRuntimeRecovery(args: readonly string[]): Promise<void> {
    const [sessionId, resultPath] = args;
    if (!sessionId || !resultPath) throw new Error('Missing runtime recovery arguments');
    const deliveredTranscriptLocalIds: string[] = [];
    const deliveredFieldIds: string[] = [];
    let sequence = 0;
    const socket: SessionClientDurableMutationSocket = {
        connected: true,
        emit: () => undefined,
        emitWithAck: async (event, ...eventArgs) => {
            if (event !== SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                throw new Error(`Unexpected runtime socket event: ${event}`);
            }
            const payload = eventArgs[0] as { localId?: unknown };
            const localId = typeof payload.localId === 'string' ? payload.localId : null;
            if (localId) deliveredTranscriptLocalIds.push(localId);
            sequence += 1;
            return {
                ok: true,
                status: 'observed',
                id: `message-${sequence}`,
                seq: sequence,
                localId,
                didWrite: true,
                ingestedAt: Date.now(),
            };
        },
    };
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
        token: 'runtime-token',
        sessionId,
        flushOnReady: false,
        getSocket: () => socket,
        requestReconnect: () => undefined,
        deliverRegisteredSessionStateFieldMutation: async (mutation) => {
            deliveredFieldIds.push(mutation.fieldId);
            if (mutation.fieldId === 'runtime.activity') {
                return {
                    delivered: true,
                    settlement: {
                        status: 'applied',
                        committedProjection: {
                            state: 'unknown',
                            activeCount: 0,
                            observedAt: mutation.observedAt,
                            revision: 1,
                        },
                        committedRevision: 1,
                    },
                };
            }
            return true;
        },
    });
    await outbox.awaitReady();
    await outbox.setSessionSyncPendingInputServerContract({
        mode: 'session_sync_v2_pending_input_v1',
        runtimeActivity: 'v2',
        pendingInput: 'v1',
        publisherAuthority: 'indeterminate',
        sessionConnectionEpoch: 1,
        socket,
        transcriptTransport: { mode: 'session_transcript_observation_v1' },
    });
    await outbox.flush('flush');
    await writeFile(resultPath, JSON.stringify({ deliveredTranscriptLocalIds, deliveredFieldIds }));
    await outbox.close();
}

async function runDaemonRecovery(args: readonly string[]): Promise<void> {
    const [sessionId, resultPath] = args;
    if (!sessionId || !resultPath) throw new Error('Missing daemon recovery arguments');
    const deliveredExactMutationIds: string[] = [];
    const deliveredUsageMutationIds: string[] = [];
    const socket: SessionClientDurableMutationSocket = {
        connected: true,
        emit: () => undefined,
        emitWithAck: async (event, ...eventArgs) => {
            if (event !== 'session-turn-mutation') throw new Error(`Unexpected daemon socket event: ${event}`);
            const mutation = eventArgs[0] as {
                v: 1;
                sessionId: string;
                mutationId: string;
                action: 'end_session';
                turnId: string;
                observedAt: number;
            };
            deliveredExactMutationIds.push(mutation.mutationId);
            return {
                receipt: {
                    v: mutation.v,
                    sessionId: mutation.sessionId,
                    mutationId: mutation.mutationId,
                    action: mutation.action,
                    turnId: mutation.turnId,
                    observedAt: mutation.observedAt,
                    decision: 'applied',
                    appliedAt: mutation.observedAt + 1,
                },
            };
        },
    };
    const exact = createDaemonSessionClientDurableMutationOutbox({
        token: 'daemon-token',
        sessionId,
        enableExactTurnDelivery: true,
        getSocket: () => socket,
        requestReconnect: () => undefined,
    });
    await exact.awaitReady();
    const usage = createDaemonSessionClientDurableMutationOutbox({
        token: 'daemon-token',
        sessionId,
        getSocket: () => null,
        requestReconnect: () => undefined,
        deliverUsageLimitRecovery: async (mutation) => {
            deliveredUsageMutationIds.push(mutation.mutationId);
            return true;
        },
    });
    await usage.awaitReady();
    await exact.flush('startup');
    await writeFile(resultPath, JSON.stringify({ deliveredExactMutationIds, deliveredUsageMutationIds }));
    await usage.close();
    await exact.close();
}

const [mode, ...args] = process.argv.slice(2);

if (mode === 'legacy-stale-writer') await runLegacyStaleWriter(args);
else if (mode === 'runtime-stage') await runRuntimeStage(args);
else if (mode === 'daemon-stage') await runDaemonStage(args);
else if (mode === 'runtime-recovery') await runRuntimeRecovery(args);
else if (mode === 'daemon-recovery') await runDaemonRecovery(args);
else throw new Error(`Unknown custody process fixture mode: ${String(mode)}`);
