import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configurationMock, writeJsonAtomicMock } = vi.hoisted(() => ({
    configurationMock: {
        activeServerDir: '',
    },
    writeJsonAtomicMock: vi.fn<(path: string, value: unknown) => Promise<void>>(),
}));

vi.mock('@/configuration', () => ({
    configuration: configurationMock,
}));

vi.mock('@/utils/fs/writeJsonAtomic', () => ({
    writeJsonAtomic: writeJsonAtomicMock,
}));

import {
    loadSessionClientDurableMutationDeadLetters,
    loadSessionClientDurableMutationOutbox,
    resolveSessionClientDurableMutationDeadLetterPath,
    resolveSessionClientDurableMutationOutboxPath,
} from './sessionClientDurableMutationPersistence';

function createPersistedSessionEndRow(
    mutationId: string,
    overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
    return {
        kind: 'session_end',
        mutationId,
        payload: {
            v: 1,
            sessionId: 'session-1',
            mutationId,
            source: 'session_end',
            observedAt: 100,
        },
        createdAt: 100,
        attempts: 0,
        nextAttemptAt: 0,
        ...overrides,
    };
}

function createInvalidPersistedRow(): Record<string, unknown> {
    return {
        ...createPersistedSessionEndRow('invalid-attempt-metadata'),
        attempts: 1,
        firstFailedAt: 150,
        privateDiagnostic: 'must-not-enter-the-dead-letter',
    };
}

async function writeRawOutbox(mutations: readonly unknown[]): Promise<void> {
    const queuePath = resolveSessionClientDurableMutationOutboxPath('session-1');
    await mkdir(dirname(queuePath), { recursive: true });
    await writeFile(queuePath, JSON.stringify({ v: 1, mutations }), 'utf8');
}

async function readRawOutbox(): Promise<unknown> {
    return JSON.parse(await readFile(
        resolveSessionClientDurableMutationOutboxPath('session-1'),
        'utf8',
    )) as unknown;
}

describe('invalid durable mutation startup quarantine', () => {
    beforeEach(async () => {
        configurationMock.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-invalid-startup-quarantine-'));
        const actual = await vi.importActual<typeof import('@/utils/fs/writeJsonAtomic')>(
            '@/utils/fs/writeJsonAtomic',
        );
        writeJsonAtomicMock.mockReset().mockImplementation(actual.writeJsonAtomic);
    });

    afterEach(async () => {
        await rm(configurationMock.activeServerDir, { recursive: true, force: true });
    });

    it('preserves the original queue when durable quarantine append fails', async () => {
        const validRow = createPersistedSessionEndRow('valid-session-end');
        const invalidRow = createInvalidPersistedRow();
        await writeRawOutbox([validRow, invalidRow]);

        const actual = await vi.importActual<typeof import('@/utils/fs/writeJsonAtomic')>(
            '@/utils/fs/writeJsonAtomic',
        );
        const deadLetterPath = resolveSessionClientDurableMutationDeadLetterPath('session-1');
        writeJsonAtomicMock.mockImplementation(async (path, value) => {
            if (path === deadLetterPath) throw new Error('simulated durable quarantine append failure');
            await actual.writeJsonAtomic(path, value);
        });

        await expect(loadSessionClientDurableMutationOutbox('session-1')).rejects.toThrow(
            'simulated durable quarantine append failure',
        );
        await expect(readRawOutbox()).resolves.toEqual({ v: 1, mutations: [validRow, invalidRow] });
    });

    it('reconciles a post-append queue-cut failure on restart without duplicating quarantine evidence', async () => {
        const validRow = createPersistedSessionEndRow('valid-session-end', {
            attempts: 2,
            firstFailedAt: 110,
            lastAttempt: {
                v: 1,
                reason: 'delivery_error',
                attemptedAt: 120,
            },
        });
        const invalidRow = createInvalidPersistedRow();
        await writeRawOutbox([validRow, invalidRow]);

        const actual = await vi.importActual<typeof import('@/utils/fs/writeJsonAtomic')>(
            '@/utils/fs/writeJsonAtomic',
        );
        const queuePath = resolveSessionClientDurableMutationOutboxPath('session-1');
        writeJsonAtomicMock.mockImplementation(async (path, value) => {
            if (path === queuePath) throw new Error('simulated post-append queue-cut failure');
            await actual.writeJsonAtomic(path, value);
        });

        await expect(loadSessionClientDurableMutationOutbox('session-1')).rejects.toThrow(
            'simulated post-append queue-cut failure',
        );
        await expect(readRawOutbox()).resolves.toEqual({ v: 1, mutations: [validRow, invalidRow] });
        await expect(loadSessionClientDurableMutationDeadLetters('session-1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_end',
                mutationId: 'invalid-attempt-metadata',
                reason: 'invalid_mutation_attempt_metadata',
            }),
        ]);

        writeJsonAtomicMock.mockReset().mockImplementation(actual.writeJsonAtomic);

        await expect(loadSessionClientDurableMutationOutbox('session-1')).resolves.toEqual([
            expect.objectContaining({
                mutationId: 'valid-session-end',
                attempts: 2,
                firstFailedAt: 110,
                lastAttempt: {
                    v: 1,
                    reason: 'delivery_error',
                    attemptedAt: 120,
                },
            }),
        ]);
        await expect(readRawOutbox()).resolves.toEqual({ v: 1, mutations: [validRow] });
        const deadLetters = await loadSessionClientDurableMutationDeadLetters('session-1');
        expect(deadLetters).toEqual([
            expect.objectContaining({
                kind: 'session_end',
                mutationId: 'invalid-attempt-metadata',
                reason: 'invalid_mutation_attempt_metadata',
                payloadSummary: {
                    keys: expect.arrayContaining([
                        'attempts',
                        'firstFailedAt',
                        'kind',
                        'mutationId',
                        'nextAttemptAt',
                        'payload',
                        'privateDiagnostic',
                    ]),
                    mutationId: 'invalid-attempt-metadata',
                },
            }),
        ]);
        expect(JSON.stringify(deadLetters)).not.toContain('must-not-enter-the-dead-letter');
    });
});
