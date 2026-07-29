import {
    mkdir,
    mkdtemp,
    readFile,
    rename as renameMock,
    rm,
    unlink as unlinkMock,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actual,
        rename: vi.fn(actual.rename),
        unlink: vi.fn(actual.unlink),
    };
});

import type { QueuedSessionClientDurableMutation } from './sessionClientDurableMutationTypes';
import {
    appendSessionClientDurableMutationDeadLetters,
    createSessionClientDurableMutationDeadLetterEntry,
    createSessionClientDurableMutationPersistenceContext,
    parseDaemonSessionClientDurableMutation,
    parseRuntimeSessionClientDurableMutation,
    saveSessionClientDurableMutationOutbox,
} from './sessionClientDurableMutationPersistence';

function createQueuedTurnMutation(params: Readonly<{
    sessionId: string;
    mutationId: string;
    turnId: string;
}>): QueuedSessionClientDurableMutation {
    return {
        kind: 'session_turn_mutation',
        mutationId: params.mutationId,
        payload: {
            v: 1,
            sessionId: params.sessionId,
            mutationId: params.mutationId,
            action: 'begin',
            turnId: params.turnId,
            observedAt: 1,
        },
        createdAt: 1,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

describe('session durable mutation persistence on Windows replacement failure', () => {
    beforeEach(async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(renameMock).mockReset().mockImplementation(actual.rename);
        vi.mocked(unlinkMock).mockReset().mockImplementation(actual.unlink);
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    });

    afterEach(() => vi.restoreAllMocks());

    it('rejects replacement without destroying prior runtime queue or daemon dead-letter custody', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-session-journal-win-replace-'));
        const sessionId = 'session/windows-replacement';
        const runtimeContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir,
            sessionId,
            custody: 'runtime',
            parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
        });
        const daemonContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir,
            sessionId,
            custody: 'daemon',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        const oldRuntimeMutation = createQueuedTurnMutation({
            sessionId,
            mutationId: 'runtime-old',
            turnId: 'turn-runtime-old',
        });
        const oldDaemonMutation = createQueuedTurnMutation({
            sessionId,
            mutationId: 'daemon-old',
            turnId: 'turn-daemon-old',
        });
        const oldDaemonDeadLetter = createSessionClientDurableMutationDeadLetterEntry({
            sessionId,
            mutation: oldDaemonMutation,
            reason: 'existing_authoritative_custody',
        });

        try {
            await mkdir(join(activeServerDir, 'session-mutations'), { recursive: true });
            await writeFile(
                runtimeContext.paths.queuePath,
                JSON.stringify({ v: 1, mutations: [oldRuntimeMutation] }),
                { encoding: 'utf8', mode: 0o600 },
            );
            await writeFile(
                daemonContext.paths.deadLetterPath,
                JSON.stringify({ v: 1, entries: [oldDaemonDeadLetter] }),
                { encoding: 'utf8', mode: 0o600 },
            );
            vi.mocked(renameMock).mockImplementation(async () => {
                const error = new Error('persistent Windows replacement failure') as NodeJS.ErrnoException;
                error.code = 'EEXIST';
                throw error;
            });

            await expect(saveSessionClientDurableMutationOutbox(sessionId, [
                createQueuedTurnMutation({
                    sessionId,
                    mutationId: 'runtime-new',
                    turnId: 'turn-runtime-new',
                }),
            ], runtimeContext)).rejects.toMatchObject({ code: 'EEXIST' });
            await expect(appendSessionClientDurableMutationDeadLetters(sessionId, [
                createSessionClientDurableMutationDeadLetterEntry({
                    sessionId,
                    mutation: createQueuedTurnMutation({
                        sessionId,
                        mutationId: 'daemon-new',
                        turnId: 'turn-daemon-new',
                    }),
                    reason: 'new_authoritative_custody',
                }),
            ], daemonContext)).rejects.toMatchObject({ code: 'EEXIST' });

            expect(JSON.parse(await readFile(runtimeContext.paths.queuePath, 'utf8'))).toEqual({
                v: 1,
                mutations: [oldRuntimeMutation],
            });
            expect(JSON.parse(await readFile(daemonContext.paths.deadLetterPath, 'utf8'))).toEqual({
                v: 1,
                entries: [oldDaemonDeadLetter],
            });
            expect(unlinkMock).not.toHaveBeenCalledWith(runtimeContext.paths.queuePath);
            expect(unlinkMock).not.toHaveBeenCalledWith(daemonContext.paths.deadLetterPath);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
