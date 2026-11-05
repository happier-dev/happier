import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';

import { createSessionMutationJournal } from '../createSessionMutationOutbox';
import {
    loadSessionMutationOutbox,
    parseDaemonTerminalQueuedSessionMutation,
    parseQueuedSessionMutation,
    recoverAuthoritativeSessionMutationDeadLetters,
    saveSessionMutationOutbox,
    type SessionMutationJournalPaths,
} from '../sessionMutationPersistence';
import { createSessionTurnMutation, createTranscriptMessageAppendMutation } from '../sessionMutationTypes';

type Init = Readonly<{
    type: 'init';
    role: 'runtime' | 'daemon';
    sessionId: string;
    paths: SessionMutationJournalPaths;
    failFirstRead?: boolean;
}>;

type Inspect = Readonly<{
    type: 'inspect';
    custody: 'runtime' | 'daemon-terminal';
    sessionId: string;
    paths: SessionMutationJournalPaths;
    admission?: 'broad';
}>;

type Recover = Readonly<{
    type: 'recover';
    custody: 'runtime' | 'daemon-terminal';
    sessionId: string;
    paths: SessionMutationJournalPaths;
}>;

function send(message: unknown): void {
    process.send?.(message);
}

function persistenceContext(raw: Inspect | Recover) {
    return {
        custody: raw.custody,
        sessionId: raw.sessionId,
        paths: raw.paths,
        parseQueuedMutation: raw.custody === 'daemon-terminal'
            && (!('admission' in raw) || raw.admission !== 'broad')
            ? parseDaemonTerminalQueuedSessionMutation
            : parseQueuedSessionMutation,
    } as const;
}

process.once('message', (raw: Init | Inspect | Recover) => {
    if (raw.type === 'inspect') {
        void loadSessionMutationOutbox(persistenceContext(raw)).then((mutations) => {
            send({ type: 'parsed-persisted-mutation-ids', ids: mutations.map((mutation) => mutation.mutationId) });
            setImmediate(() => process.exit(0));
        });
        return;
    }
    if (raw.type === 'recover') {
        const context = persistenceContext(raw);
        void loadSessionMutationOutbox(context).then(async (queued) => {
            const byMutationId = new Map(queued.map((mutation) => [mutation.mutationId, mutation]));
            const recovered = await recoverAuthoritativeSessionMutationDeadLetters(context, async (candidateMutations) => {
                for (const mutation of candidateMutations) byMutationId.set(mutation.mutationId, mutation);
                await saveSessionMutationOutbox(context, [...byMutationId.values()]);
            });
            send({
                type: 'recovery-persisted',
                ids: [...byMutationId.keys()],
                recoveredIds: recovered.map((mutation) => mutation.mutationId),
            });
            setImmediate(() => process.exit(0));
        }).catch((error: unknown) => {
            send({ type: 'worker-error', message: error instanceof Error ? error.message : String(error) });
        });
        return;
    }
    let transportMode: 'retry' | 'success' | 'hold' = 'retry';
    if (raw.failFirstRead) {
        const originalReadFile = fs.readFile;
        fs.readFile = async () => {
            fs.readFile = originalReadFile;
            syncBuiltinESMExports();
            throw Object.assign(new Error('injected journal read failure'), { code: 'EBUSY' });
        };
        syncBuiltinESMExports();
    }
    const outbox = createSessionMutationJournal({
        custody: raw.role === 'runtime' ? 'runtime' : 'daemon-terminal',
        sessionId: raw.sessionId,
        paths: raw.paths,
        admission: parseQueuedSessionMutation,
        token: 'test-token',
        getSocket: () => ({
            connected: true,
            emit: () => undefined,
            emitWithAck: async (event, payload) => {
                send({ type: 'socket-call', role: raw.role, event });
                if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                    return { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 };
                }
                if (transportMode === 'hold') return await new Promise<never>(() => {});
                if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
                    if (transportMode === 'retry') return { ok: false, error: 'internal' };
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
                return { ok: false, error: 'internal' };
            },
        }),
        requestReconnect: () => {},
    });

    if (raw.failFirstRead) {
        void (async () => {
            let code: unknown;
            try {
                await outbox.awaitReady();
            } catch (error) {
                code = error && typeof error === 'object' && 'code' in error ? error.code : null;
            }
            await outbox.close().catch(() => {});
            send({ type: 'startup-read-result', code });
            setImmediate(() => process.exit(0));
        })();
        return;
    }

    void outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
        sessionId: raw.sessionId,
        provenance: { kind: 'non_dependent', source: 'external' },
        localId: `${raw.role}-readiness-probe`,
        sidechainId: 'conflicting-sidechain',
        content: 'probe',
    })).then(
        () => send({ type: 'worker-error', message: 'readiness probe unexpectedly succeeded' }),
        (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('sidechain')) {
                send({ type: 'worker-error', message });
                return;
            }
            void outbox.flush('flush').then(
                () => send({ type: 'owner-ready', role: raw.role }),
                (flushError: unknown) => send({
                    type: 'worker-error',
                    message: flushError instanceof Error ? flushError.message : String(flushError),
                }),
            );
        },
    );

    process.on('message', (command: { type: string }) => {
        if (command.type === 'ack-baseline') {
            transportMode = 'success';
            void outbox.flush('flush').then(() => send({ type: 'ack-persisted' }));
        }
        if (command.type === 'persist-new') {
            transportMode = 'hold';
            void outbox.enqueueSessionTurn(createSessionTurnMutation({
                sessionId: raw.sessionId,
                mutationId: 'daemon-new-mutation',
                action: 'begin',
                turnId: 'turn-1',
                observedAt: 2_000,
            })).then(() => send({ type: 'new-persisted' }));
        }
        if (command.type === 'exit-without-close') process.exit(0);
    });
});
