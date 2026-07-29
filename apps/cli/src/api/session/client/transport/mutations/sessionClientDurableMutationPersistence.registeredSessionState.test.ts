import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configurationMock } = vi.hoisted(() => ({
    configurationMock: {
        activeServerDir: '',
    },
}));

vi.mock('@/configuration', () => ({
    configuration: configurationMock,
}));

import { createRegisteredSessionStateFieldMutation } from './sessionClientDurableMutationTypes';
import {
    loadSessionClientDurableMutationDeadLetters,
    loadSessionClientDurableMutationOutbox,
    recoverAuthoritativeSessionClientDurableMutationDeadLetters,
    resolveSessionClientDurableMutationDeadLetterPath,
    saveSessionClientDurableMutationOutbox,
} from './sessionClientDurableMutationPersistence';

const runtimeState = {
    v: 1,
    sessionId: 'sess-1',
    machineId: 'machine-1',
    daemonId: 'daemon-1',
    observedAtMs: 100,
    runner: {
        pid: 4242,
        runtimeId: 'version:1.2.3',
        cliVersion: '1.2.3',
        entrypointVersion: '1.2.3',
        processCommandHash: 'hash-1',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
    },
    daemon: {
        cliVersion: '1.2.4',
        startedWithCliVersion: '1.2.4',
        currentEntrypointVersion: 'version:1.2.4',
        currentEntrypointSource: 'launch_spec',
    },
    versionState: 'stale',
    statusSource: 'process_command_inferred',
    plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
    },
} as const;

const runtimeActivityProjection = {
    state: 'active',
    activeCount: 1,
} as const;

describe('registered session-state durable mutation persistence', () => {
    beforeEach(async () => {
        configurationMock.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-session-runner-mutations-'));
    });

    afterEach(async () => {
        await rm(configurationMock.activeServerDir, { recursive: true, force: true });
    });

    it('loads queued runtime.sessionRunner set mutations instead of dead-lettering them', async () => {
        const sessionId = 'sess-runtime-runner';
        const mutation = createRegisteredSessionStateFieldMutation({
            sessionId,
            fieldId: 'runtime.sessionRunner',
            deliveryClass: 'durable_best_effort',
            source: 'daemon',
            observedAt: 100,
            op: { kind: 'set', value: runtimeState },
        });

        await saveSessionClientDurableMutationOutbox(sessionId, [{
            kind: 'registered_session_state_field',
            mutationId: mutation.mutationId,
            payload: mutation,
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);

        const loaded = await loadSessionClientDurableMutationOutbox(sessionId);

        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toEqual(expect.objectContaining({
            kind: 'registered_session_state_field',
            payload: expect.objectContaining({
                fieldId: 'runtime.sessionRunner',
                op: { kind: 'set', value: runtimeState },
            }),
        }));
        await expect(loadSessionClientDurableMutationDeadLetters(sessionId)).resolves.toEqual([]);
    });

    it('loads queued runtime.activity set mutations instead of dead-lettering them', async () => {
        const sessionId = 'sess-runtime-activity';
        const mutation = createRegisteredSessionStateFieldMutation({
            sessionId,
            fieldId: 'runtime.activity',
            deliveryClass: 'durable_best_effort',
            source: 'runtime',
            observedAt: 100,
            op: { kind: 'set', value: runtimeActivityProjection },
        });

        await saveSessionClientDurableMutationOutbox(sessionId, [{
            kind: 'registered_session_state_field',
            mutationId: mutation.mutationId,
            payload: mutation,
            admissionOrder: 37,
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);

        const loaded = await loadSessionClientDurableMutationOutbox(sessionId);

        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toEqual(expect.objectContaining({
            kind: 'registered_session_state_field',
            mutationId: `runtime-activity-snapshot:${sessionId}`,
            admissionOrder: 37,
            payload: expect.objectContaining({
                fieldId: 'runtime.activity',
                op: { kind: 'set', value: runtimeActivityProjection },
            }),
        }));
        await expect(loadSessionClientDurableMutationDeadLetters(sessionId)).resolves.toEqual([]);
    });

    it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5])(
        'quarantines a present invalid registered-field admission order (%s)',
        async (admissionOrder) => {
            const sessionId = `sess-invalid-admission-${String(admissionOrder).replaceAll('.', '-')}`;
            const mutation = createRegisteredSessionStateFieldMutation({
                sessionId,
                fieldId: 'runtime.activity',
                deliveryClass: 'durable_best_effort',
                source: 'runtime',
                observedAt: 100,
                op: { kind: 'set', value: runtimeActivityProjection },
            });

            await saveSessionClientDurableMutationOutbox(sessionId, [{
                kind: 'registered_session_state_field',
                mutationId: mutation.mutationId,
                payload: mutation,
                admissionOrder,
                createdAt: 100,
                attempts: 0,
                nextAttemptAt: 0,
            }]);

            await expect(loadSessionClientDurableMutationOutbox(sessionId)).resolves.toEqual([]);
            await expect(loadSessionClientDurableMutationDeadLetters(sessionId)).resolves.toEqual([
                expect.objectContaining({
                    kind: 'registered_session_state_field',
                    mutationId: mutation.mutationId,
                    reason: 'invalid_registered_session_state_field_admission_order',
                }),
            ]);
        },
    );

    it('loads queued canonical display-title mutations instead of dead-lettering them', async () => {
        const sessionId = 'sess-display-title';
        const value = {
            title: 'Persisted title',
            updatedAt: 123,
            staleBehavior: 'bump-if-value-changed',
        } as const;
        const mutation = createRegisteredSessionStateFieldMutation({
            sessionId,
            fieldId: 'display.title',
            deliveryClass: 'durable_best_effort',
            source: 'runtime',
            observedAt: 100,
            op: { kind: 'set', value },
        });

        await saveSessionClientDurableMutationOutbox(sessionId, [{
            kind: 'registered_session_state_field',
            mutationId: mutation.mutationId,
            payload: mutation,
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);

        const loaded = await loadSessionClientDurableMutationOutbox(sessionId);

        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toEqual(expect.objectContaining({
            kind: 'registered_session_state_field',
            payload: expect.objectContaining({
                fieldId: 'display.title',
                deliveryClass: 'durable_best_effort',
                op: { kind: 'set', value },
            }),
        }));
        await expect(loadSessionClientDurableMutationDeadLetters(sessionId)).resolves.toEqual([]);
    });

    it('does not consume authoritative dead-letter recovery before the outbox commit', async () => {
        const sessionId = 'sess-authoritative-recovery-order';
        const deadLetterPath = resolveSessionClientDurableMutationDeadLetterPath(sessionId);
        await mkdir(dirname(deadLetterPath), { recursive: true });
        await writeFile(deadLetterPath, JSON.stringify({
            v: 1,
            entries: [{
                v: 1,
                kind: 'session_end',
                sessionId,
                mutationId: 'recover-session-end',
                reason: 'retry_exhausted',
                deadLetteredAt: 100,
                queuedMutation: {
                    kind: 'session_end',
                    mutationId: 'recover-session-end',
                    payload: {
                        v: 1,
                        sessionId,
                        mutationId: 'recover-session-end',
                        source: 'session_end',
                        observedAt: 100,
                    },
                    createdAt: 100,
                    attempts: 1,
                    nextAttemptAt: 0,
                },
            }],
        }), 'utf8');

        await expect(recoverAuthoritativeSessionClientDurableMutationDeadLetters(sessionId)).resolves.toEqual([
            expect.objectContaining({ mutationId: 'recover-session-end' }),
        ]);

        const persisted = JSON.parse(await readFile(deadLetterPath, 'utf8')) as { entries: unknown[] };
        expect(persisted.entries).toEqual([
            expect.not.objectContaining({ recoveryAttemptedAt: expect.any(Number) }),
        ]);
    });
});
