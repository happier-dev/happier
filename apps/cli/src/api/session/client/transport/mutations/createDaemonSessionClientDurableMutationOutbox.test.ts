import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';

const { configurationMock } = vi.hoisted(() => ({
    configurationMock: {
        activeServerDir: '',
        apiServerUrl: 'http://server.example.test',
    },
}));

vi.mock('@/configuration', () => ({ configuration: configurationMock }));
vi.mock('axios');

import {
    createDaemonSessionClientDurableMutationOutbox,
    type ExactDaemonSessionTurnEndMutationV1,
} from './createDaemonSessionClientDurableMutationOutbox';
import {
    resetSessionClientDurableMutationOutboxStateForTests,
} from './createSessionClientDurableMutationOutbox';
import {
    createRegisteredSessionStateFieldMutation,
    createTranscriptMessageAppendMutation,
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
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.post).mockRejectedValue(new Error('http unavailable'));
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

    it('reports a persistently blocking authoritative mutation once without changing retry custody', async () => {
        const previousMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const exact: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId: 's1',
            mutationId: 'persistently-blocked-end',
            action: 'end_session',
            turnId: 'turn-blocked',
            observedAt: 100,
        };
        const following = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'following-transcript-row',
            messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event' } } },
            createdAt: 101,
            updatedAt: 101,
            provenance: { kind: 'non_dependent', source: 'background' },
        });
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [
            {
                kind: 'session_turn_mutation',
                mutationId: exact.mutationId,
                payload: exact,
                createdAt: exact.observedAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'transcript_message_append',
                mutationId: following.mutationId,
                payload: following,
                createdAt: following.createdAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ], persistenceContext);
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });

        try {
            await outbox.awaitReady();
            await outbox.flush('flush');
            await outbox.flush('flush');

            expect(infoFileSpy).toHaveBeenCalledTimes(1);
            expect(infoFileSpy).toHaveBeenCalledWith(
                '[API] Authoritative session mutation remains queued and is blocking later mutations',
                expect.objectContaining({
                    sessionId: 's1',
                    mutationId: exact.mutationId,
                    mutationKind: 'session_turn_mutation',
                    action: 'end_session',
                    turnId: 'turn-blocked',
                    attempts: 1,
                    lastAttemptReason: 'delivery_not_confirmed',
                    blockedMutationCount: 1,
                    blockedMutationKinds: { transcript_message_append: 1 },
                }),
            );
            const persisted = JSON.parse(await readFile(persistenceContext.paths.queuePath, 'utf8')) as {
                mutations: Array<{ mutationId?: string; attempts?: number }>;
            };
            expect(persisted.mutations).toEqual([
                expect.objectContaining({ mutationId: exact.mutationId, attempts: 2 }),
                expect.objectContaining({ mutationId: following.mutationId, attempts: 0 }),
            ]);
        } finally {
            infoFileSpy.mockRestore();
            await outbox.close();
            if (previousMaxAttempts === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = previousMaxAttempts;
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });

    it('reports a persistently blocking durable-required usage-limit recovery field once', async () => {
        const previousMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const recoveryField = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.usageLimitRecovery',
            source: 'daemon',
            deliveryClass: 'durable_required',
            observedAt: 100,
            op: {
                kind: 'set',
                value: {
                    v: 1,
                    status: 'cancelled',
                    resumePromptMode: 'standard',
                    issueFingerprint: 'usage-limit:codex:turn-1:1:2',
                    armedAtMs: 1,
                    resetAtMs: 2,
                    nextCheckAtMs: null,
                    attemptCount: 1,
                    maxAttempts: 3,
                    lastProbeError: null,
                    selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
                },
            },
        }) as DaemonUsageLimitRecoveryFieldMutation;
        const following = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'blocked-behind-usage-limit-recovery',
            messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event' } } },
            createdAt: 101,
            updatedAt: 101,
            provenance: { kind: 'non_dependent', source: 'background' },
        });
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [
            {
                kind: 'registered_session_state_field',
                mutationId: recoveryField.mutationId,
                payload: recoveryField,
                createdAt: recoveryField.observedAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'transcript_message_append',
                mutationId: following.mutationId,
                payload: following,
                createdAt: following.createdAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ], persistenceContext);
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery: async () => false,
        });

        try {
            await outbox.awaitReady();
            await outbox.flush('flush');
            await outbox.flush('flush');

            expect(infoFileSpy).toHaveBeenCalledWith(
                '[API] Authoritative session mutation remains queued and is blocking later mutations',
                expect.objectContaining({
                    sessionId: 's1',
                    mutationId: recoveryField.mutationId,
                    mutationKind: 'registered_session_state_field',
                    blockedMutationCount: 1,
                    blockedMutationKinds: { transcript_message_append: 1 },
                }),
            );
        } finally {
            infoFileSpy.mockRestore();
            await outbox.close();
            if (previousMaxAttempts === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = previousMaxAttempts;
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });

    it('retains a daemon transcript event after HTTP delivery failure and replays it once after restart', async () => {
        const failedDelivery = vi.fn(async () => {
            throw new Error('http unavailable');
        });
        const first = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverTranscriptMessage: failedDelivery,
        });
        const mutation = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'connected-service-account-switch:one',
            messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event' } } },
            createdAt: 100,
            updatedAt: 100,
            provenance: { kind: 'non_dependent', source: 'background' },
        });

        await expect(first.enqueueTranscriptMessage(mutation)).resolves.toEqual({
            persisted: true,
            delivered: false,
        });
        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
        });
        await expect(readFile(paths.queuePath, 'utf8')).resolves.toContain(mutation.mutationId);
        await first.close();

        const replayed = vi.fn(async () => true);
        const restarted = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverTranscriptMessage: replayed,
        });
        await restarted.awaitReady();
        await restarted.flush('startup');

        expect(replayed).toHaveBeenCalledTimes(1);
        expect(replayed).toHaveBeenCalledWith(mutation);
        await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await restarted.close();
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
