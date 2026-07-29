import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configurationMock } = vi.hoisted(() => ({
    configurationMock: { activeServerDir: '' },
}));

vi.mock('@/configuration', () => ({ configuration: configurationMock }));

import {
    createDaemonSessionClientDurableMutationOutbox,
    type ExactDaemonSessionTurnEndMutationV1,
} from './createDaemonSessionClientDurableMutationOutbox';
import {
    resetSessionClientDurableMutationOutboxStateForTests,
} from './createSessionClientDurableMutationOutbox';
import {
    createRegisteredSessionStateFieldMutation,
    type DaemonUsageLimitRecoveryFieldMutation,
} from './sessionClientDurableMutationTypes';
import {
    createSessionClientDurableMutationPersistenceContext,
    parseDaemonSessionClientDurableMutation,
    resolveSessionClientDurableMutationJournalPaths,
    saveSessionClientDurableMutationOutbox,
} from './sessionClientDurableMutationPersistence';

describe('daemon session client durable mutation outbox', () => {
    beforeEach(async () => {
        configurationMock.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-daemon-session-mutations-'));
    });

    afterEach(async () => {
        await resetSessionClientDurableMutationOutboxStateForTests();
        await rm(configurationMock.activeServerDir, { recursive: true, force: true });
    });

    it('durably accepts an exact turn end only in the daemon journal', async () => {
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });
        const exact: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId: 's1',
            mutationId: 'end-turn-1',
            action: 'end_session',
            turnId: 'turn-1',
            observedAt: 100,
        };

        await outbox.enqueueExactTurnEnd(exact);

        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
        });
        const persisted = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ mutationId?: string; payload?: { turnId?: string } }>;
        };
        expect(persisted.mutations).toEqual([
            expect.objectContaining({
                mutationId: 'end-turn-1',
                payload: expect.objectContaining({ turnId: 'turn-1' }),
            }),
        ]);
        const runtimePaths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'runtime',
            sessionId: 's1',
        });
        await expect(readFile(runtimePaths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await outbox.close();
    });

    it('rejects casted broad or decorated terminal rows before persistence', async () => {
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });
        const invalidRows = [
            {
                v: 1,
                sessionId: 's1',
                mutationId: 'broad',
                action: 'end_session',
                observedAt: 100,
            },
            {
                v: 1,
                sessionId: 's1',
                mutationId: 'decorated',
                action: 'end_session',
                turnId: 'turn-1',
                observedAt: 100,
                provider: 'codex',
            },
        ];

        for (const invalid of invalidRows) {
            await expect(outbox.enqueueExactTurnEnd(
                invalid as unknown as ExactDaemonSessionTurnEndMutationV1,
            )).rejects.toThrow(/exact end/);
        }
        await outbox.close();
    });

    it('does not let a newer usage-only handle take exact-turn socket delivery authority', async () => {
        const exactSocket = vi.fn(() => ({ connected: false, emit: () => undefined }));
        const usageSocket = vi.fn(() => null);
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: exactSocket,
            requestReconnect: () => undefined,
        });
        const usage = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: usageSocket,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery: async () => true,
        });

        await exact.enqueueExactTurnEnd({
            v: 1,
            sessionId: 's1',
            mutationId: 'end-turn-1',
            action: 'end_session',
            turnId: 'turn-1',
            observedAt: 100,
        });
        await exact.flush('flush');

        expect(exactSocket).toHaveBeenCalled();
        expect(usageSocket).not.toHaveBeenCalled();
        await usage.close();
        await exact.close();
    });

    it('does not let a newer exact-only handle shadow usage delivery authority', async () => {
        const deliverUsageLimitRecovery = vi.fn(async () => true);
        const usage = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery,
        });
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });
        const usageMutation = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.usageLimitRecovery',
            source: 'daemon',
            observedAt: 100,
            op: { kind: 'clear' },
        }) as DaemonUsageLimitRecoveryFieldMutation;

        await usage.enqueueUsageLimitRecovery(usageMutation);
        await exact.flush('flush');

        expect(deliverUsageLimitRecovery).toHaveBeenCalledOnce();
        expect(deliverUsageLimitRecovery).toHaveBeenCalledWith(usageMutation);
        await exact.close();
        await usage.close();
    });

    it('retains capability-blocked usage while delivering later exact terminal evidence, then delivers usage exactly once', async () => {
        const deliveredExactMutationIds: string[] = [];
        const usageMutation = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.usageLimitRecovery',
            source: 'daemon',
            observedAt: 100,
            op: { kind: 'clear' },
        }) as DaemonUsageLimitRecoveryFieldMutation;
        const exactMutation: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId: 's1',
            mutationId: 'end-turn-after-usage',
            action: 'end_session',
            turnId: 'turn-after-usage',
            observedAt: 101,
        };
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [
            {
                kind: 'registered_session_state_field',
                mutationId: usageMutation.mutationId,
                payload: usageMutation,
                createdAt: usageMutation.observedAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn_mutation',
                mutationId: exactMutation.mutationId,
                payload: exactMutation,
                createdAt: exactMutation.observedAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ], persistenceContext);
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({
                connected: true,
                emit: () => undefined,
                emitWithAck: async (_event, mutationValue) => {
                    const deliveredMutation = mutationValue as ExactDaemonSessionTurnEndMutationV1;
                    deliveredExactMutationIds.push(deliveredMutation.mutationId);
                    return {
                        receipt: {
                            ...deliveredMutation,
                            decision: 'applied',
                            appliedAt: deliveredMutation.observedAt + 1,
                        },
                    };
                },
            }),
            requestReconnect: () => undefined,
        });

        await exact.awaitReady();
        await exact.flush('flush');

        const paths = persistenceContext.paths;
        const retained = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ mutationId?: string; attempts?: number }>;
        };
        expect(retained.mutations).toEqual([
            expect.objectContaining({ mutationId: usageMutation.mutationId, attempts: 0 }),
        ]);
        expect(deliveredExactMutationIds).toEqual([exactMutation.mutationId]);

        const deliverUsageLimitRecovery = vi.fn(async () => true);
        const usage = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery,
        });
        await usage.flush('connect');
        await usage.flush('connect');

        expect(deliverUsageLimitRecovery).toHaveBeenCalledOnce();
        expect(deliverUsageLimitRecovery).toHaveBeenCalledWith(usageMutation);
        await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await usage.close();
        await exact.close();
    });

    it('retains durable-required daemon usage past retry exhaustion until a capable handle binds', async () => {
        const previousMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousMaxRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '0';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = '0';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        try {
            const deliveredExactMutationIds: string[] = [];
            const usageMutation = createRegisteredSessionStateFieldMutation({
                sessionId: 's1',
                fieldId: 'runtime.usageLimitRecovery',
                source: 'daemon',
                observedAt: 100,
                op: { kind: 'clear' },
            }) as DaemonUsageLimitRecoveryFieldMutation;
            const exactMutation: ExactDaemonSessionTurnEndMutationV1 = {
                v: 1,
                sessionId: 's1',
                mutationId: 'end-turn-after-real-failure',
                action: 'end_session',
                turnId: 'turn-after-real-failure',
                observedAt: 101,
            };
            const persistenceContext = createSessionClientDurableMutationPersistenceContext({
                activeServerDir: configurationMock.activeServerDir,
                custody: 'daemon',
                sessionId: 's1',
                parseQueuedMutation: parseDaemonSessionClientDurableMutation,
            });
            await saveSessionClientDurableMutationOutbox('s1', [
                {
                    kind: 'registered_session_state_field',
                    mutationId: usageMutation.mutationId,
                    payload: usageMutation,
                    createdAt: usageMutation.observedAt,
                    attempts: 0,
                    nextAttemptAt: 0,
                },
                {
                    kind: 'session_turn_mutation',
                    mutationId: exactMutation.mutationId,
                    payload: exactMutation,
                    createdAt: exactMutation.observedAt,
                    attempts: 0,
                    nextAttemptAt: 0,
                },
            ], persistenceContext);
            const failingUsage = createDaemonSessionClientDurableMutationOutbox({
                token: 'token',
                sessionId: 's1',
                getSocket: () => ({
                    connected: true,
                    emit: () => undefined,
                    emitWithAck: async (_event, mutationValue) => {
                        const deliveredMutation = mutationValue as ExactDaemonSessionTurnEndMutationV1;
                        deliveredExactMutationIds.push(deliveredMutation.mutationId);
                        return {
                            receipt: {
                                ...deliveredMutation,
                                decision: 'applied',
                                appliedAt: deliveredMutation.observedAt + 1,
                            },
                        };
                    },
                }),
                requestReconnect: () => undefined,
                deliverUsageLimitRecovery: async () => false,
                enableExactTurnDelivery: true,
            });

            await failingUsage.awaitReady();
            await failingUsage.flush('flush');

            const paths = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir: configurationMock.activeServerDir,
                custody: 'daemon',
                sessionId: 's1',
            });
            const retained = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
                mutations: Array<{ mutationId?: string; attempts?: number }>;
            };
            expect(retained.mutations).toEqual([
                expect.objectContaining({ mutationId: usageMutation.mutationId }),
                expect.objectContaining({ mutationId: exactMutation.mutationId, attempts: 0 }),
            ]);
            expect(retained.mutations[0]?.attempts).toBeGreaterThanOrEqual(1);
            expect(deliveredExactMutationIds).toEqual([]);

            const deliverUsageLimitRecovery = vi.fn(async () => true);
            const usage = createDaemonSessionClientDurableMutationOutbox({
                token: 'token',
                sessionId: 's1',
                getSocket: () => null,
                requestReconnect: () => undefined,
                deliverUsageLimitRecovery,
            });
            await usage.flush('flush');

            expect(deliverUsageLimitRecovery).toHaveBeenCalledOnce();
            expect(deliveredExactMutationIds).toEqual([exactMutation.mutationId]);
            await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            await usage.close();
            await failingUsage.close();
        } finally {
            if (previousMaxAttempts === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = previousMaxAttempts;
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousMaxRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = previousMaxRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });

    it('does not deliver persisted daemon work before coordinated bindings explicitly flush', async () => {
        const usageMutation = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.usageLimitRecovery',
            source: 'daemon',
            observedAt: 100,
            op: { kind: 'clear' },
        });
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [{
            kind: 'registered_session_state_field',
            mutationId: usageMutation.mutationId,
            payload: usageMutation,
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }], persistenceContext);
        const deliverUsageLimitRecovery = vi.fn(async () => true);
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });
        await exact.awaitReady();
        const usage = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery,
        });
        await usage.awaitReady();

        expect(deliverUsageLimitRecovery).not.toHaveBeenCalled();
        await exact.flush('startup');
        expect(deliverUsageLimitRecovery).toHaveBeenCalledOnce();

        await usage.close();
        await exact.close();
    });

    it('does not eagerly deliver a persisted exact end before the coordinated startup flush', async () => {
        const persistedExact: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId: 's1',
            mutationId: 'persisted-exact',
            action: 'end_session',
            turnId: 'turn-persisted',
            observedAt: 400,
        };
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [{
            kind: 'session_turn_mutation',
            mutationId: persistedExact.mutationId,
            payload: persistedExact,
            createdAt: persistedExact.observedAt,
            attempts: 0,
            nextAttemptAt: 0,
        }], persistenceContext);
        const delivered: string[] = [];
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({
                connected: true,
                emit: () => undefined,
                emitWithAck: async (_event, mutationValue) => {
                    const mutation = mutationValue as ExactDaemonSessionTurnEndMutationV1;
                    delivered.push(mutation.mutationId);
                    return {
                        receipt: {
                            ...mutation,
                            decision: 'applied',
                            appliedAt: mutation.observedAt + 1,
                        },
                    };
                },
            }),
            requestReconnect: () => undefined,
        });

        await exact.awaitReady();
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(delivered).toEqual([]);

        await exact.flush('startup');
        expect(delivered).toEqual(['persisted-exact']);
        await exact.close();
    });

    it('retains a failed admitted startup flush without retrying while quiescing', async () => {
        const persistedExact: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId: 's1',
            mutationId: 'persisted-quiesced-retry',
            action: 'end_session',
            turnId: 'turn-quiesced-retry',
            observedAt: 500,
        };
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [{
            kind: 'session_turn_mutation',
            mutationId: persistedExact.mutationId,
            payload: persistedExact,
            createdAt: persistedExact.observedAt,
            attempts: 0,
            nextAttemptAt: 0,
        }], persistenceContext);
        let quiescing = false;
        const delivered: string[] = [];
        const usage = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery: async () => true,
        });
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({
                connected: true,
                emit: () => undefined,
                emitWithAck: async (_event, mutationValue) => {
                    const mutation = mutationValue as ExactDaemonSessionTurnEndMutationV1;
                    delivered.push(mutation.mutationId);
                    if (delivered.length === 1) {
                        quiescing = true;
                        throw new Error('replacement publication gap');
                    }
                    return {
                        receipt: {
                            ...mutation,
                            decision: 'applied',
                            appliedAt: mutation.observedAt + 1,
                        },
                    };
                },
            }),
            requestReconnect: () => undefined,
            isShuttingDown: () => quiescing,
        });
        const realSetImmediate = setImmediate;

        vi.useFakeTimers();
        try {
            await exact.awaitReady();
            await exact.flush('startup');
            expect(delivered).toEqual(['persisted-quiesced-retry']);
            expect(vi.getTimerCount()).toBeGreaterThan(0);

            await vi.runAllTimersAsync();
            for (let index = 0; index < 20 && delivered.length === 1; index += 1) {
                await new Promise<void>((resolve) => realSetImmediate(resolve));
            }

            expect(delivered).toEqual(['persisted-quiesced-retry']);
            await expect(readFile(persistenceContext.paths.queuePath, 'utf8'))
                .resolves.toContain(persistedExact.mutationId);

            quiescing = false;
            await exact.flush('startup');
            expect(delivered).toEqual([
                'persisted-quiesced-retry',
                'persisted-quiesced-retry',
            ]);
            await expect(readFile(persistenceContext.paths.queuePath, 'utf8'))
                .rejects.toMatchObject({ code: 'ENOENT' });
            await exact.close();
            await usage.close();
        } finally {
            vi.useRealTimers();
        }
    });
});
