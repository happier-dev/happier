import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    v: 1,
    activeCount: 1,
    observedAtMs: 1_000,
    expiresAtMs: 2_000,
    sourceClass: 'provider_detached_task',
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
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }]);

        const loaded = await loadSessionClientDurableMutationOutbox(sessionId);

        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toEqual(expect.objectContaining({
            kind: 'registered_session_state_field',
            payload: expect.objectContaining({
                fieldId: 'runtime.activity',
                op: { kind: 'set', value: runtimeActivityProjection },
            }),
        }));
        await expect(loadSessionClientDurableMutationDeadLetters(sessionId)).resolves.toEqual([]);
    });

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
});
