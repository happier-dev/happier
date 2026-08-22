import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

import {
    loadSessionClientDurableMutationDeadLetters,
    loadSessionClientDurableMutationOutbox,
    resolveSessionClientDurableMutationOutboxPath,
} from './sessionClientDurableMutationPersistence';

function createPersistedSessionEndRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        kind: 'session_end',
        mutationId: 'end-session-1',
        payload: {
            v: 1,
            sessionId: 'session-1',
            mutationId: 'end-session-1',
            source: 'session_end',
            observedAt: 100,
        },
        createdAt: 100,
        attempts: 1,
        nextAttemptAt: 200,
        ...overrides,
    };
}

async function writeRawOutbox(mutations: readonly unknown[]): Promise<void> {
    const filePath = resolveSessionClientDurableMutationOutboxPath('session-1');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ v: 1, mutations }), 'utf8');
}

describe('durable mutation attempt-accounting persistence', () => {
    beforeEach(async () => {
        configurationMock.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-session-attempt-accounting-'));
    });

    afterEach(async () => {
        await rm(configurationMock.activeServerDir, { recursive: true, force: true });
    });

    it('continues to accept legacy queued rows without typed attempt metadata', async () => {
        await writeRawOutbox([createPersistedSessionEndRow()]);

        await expect(loadSessionClientDurableMutationOutbox('session-1')).resolves.toEqual([
            expect.objectContaining({
                mutationId: 'end-session-1',
                attempts: 1,
                nextAttemptAt: 200,
            }),
        ]);
        await expect(loadSessionClientDurableMutationDeadLetters('session-1')).resolves.toEqual([]);
    });

    it('round-trips typed first-failure and last-attempt metadata across restart', async () => {
        await writeRawOutbox([createPersistedSessionEndRow({
            firstFailedAt: 150,
            lastAttempt: {
                v: 1,
                reason: 'delivery_not_confirmed',
                attemptedAt: 175,
            },
        })]);

        await expect(loadSessionClientDurableMutationOutbox('session-1')).resolves.toEqual([
            expect.objectContaining({
                mutationId: 'end-session-1',
                attempts: 1,
                firstFailedAt: 150,
                lastAttempt: {
                    v: 1,
                    reason: 'delivery_not_confirmed',
                    attemptedAt: 175,
                },
            }),
        ]);
        await expect(loadSessionClientDurableMutationDeadLetters('session-1')).resolves.toEqual([]);
    });

    it('preserves attempt chronology when the wall clock moves backward between failures', async () => {
        await writeRawOutbox([createPersistedSessionEndRow({
            attempts: 2,
            firstFailedAt: 200,
            lastAttempt: {
                v: 1,
                reason: 'delivery_error',
                attemptedAt: 150,
            },
        })]);

        await expect(loadSessionClientDurableMutationOutbox('session-1')).resolves.toEqual([
            expect.objectContaining({
                attempts: 2,
                firstFailedAt: 200,
                lastAttempt: {
                    v: 1,
                    reason: 'delivery_error',
                    attemptedAt: 150,
                },
            }),
        ]);
        await expect(loadSessionClientDurableMutationDeadLetters('session-1')).resolves.toEqual([]);
    });

    it.each([
        { firstFailedAt: 'not-a-time' },
        { firstFailedAt: 150 },
        { lastAttempt: { v: 1, reason: 'delivery_not_confirmed', attemptedAt: 175 } },
        { lastAttempt: { v: 1, reason: 'unknown_reason', attemptedAt: 175 } },
        { lastAttempt: { v: 1, reason: 'delivery_not_confirmed', attemptedAt: Number.NaN } },
    ])('fails closed when known attempt metadata is malformed: %j', async (attemptMetadata) => {
        await writeRawOutbox([createPersistedSessionEndRow(attemptMetadata)]);

        await expect(loadSessionClientDurableMutationOutbox('session-1')).resolves.toEqual([]);
        await expect(loadSessionClientDurableMutationDeadLetters('session-1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_end',
                mutationId: 'end-session-1',
                reason: 'invalid_mutation_attempt_metadata',
            }),
        ]);
    });
});
