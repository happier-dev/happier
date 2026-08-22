import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { SessionIndexedIdentifierMaxLengthV1 } from '@happier-dev/protocol/sessions';

import { createRegisteredSessionStateFieldMutation } from './sessionClientDurableMutationTypes';
import {
    discoverDaemonSessionClientDurableMutationJournalSessionIds,
    parseDaemonSessionClientDurableMutation,
    resolveSessionClientDurableMutationJournalPaths,
} from './sessionClientDurableMutationPersistence';

function queued(payload: Record<string, unknown>, kind = 'session_turn_mutation') {
    return {
        kind,
        mutationId: payload.mutationId,
        payload,
        createdAt: 1,
        attempts: 0,
        nextAttemptAt: 0,
    };
}

describe('session client durable mutation custody', () => {
    it('resolves disjoint paired runtime and daemon journal paths', () => {
        const activeServerDir = '/active-server';

        expect(resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: 's1',
            custody: 'runtime',
        })).toEqual({
            queuePath: join(activeServerDir, 'session-mutations', 'session-s1.json'),
            deadLetterPath: join(activeServerDir, 'session-mutations', 'session-s1.dead-letter.json'),
        });
        expect(() => resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: '',
            custody: 'daemon',
        })).toThrow(/empty/);
        expect(resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: 's1',
            custody: 'daemon',
        })).toEqual({
            queuePath: join(activeServerDir, 'session-mutations', 'session-s1.daemon.json'),
            deadLetterPath: join(activeServerDir, 'session-mutations', 'session-s1.daemon.dead-letter.json'),
        });
        expect(resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: 'a/b?c * % ☃',
            custody: 'daemon',
        })).toEqual({
            queuePath: join(activeServerDir, 'session-mutations', 'session-a%2Fb%3Fc%20%2A%20%25%20%E2%98%83.daemon.json'),
            deadLetterPath: join(activeServerDir, 'session-mutations', 'session-a%2Fb%3Fc%20%2A%20%25%20%E2%98%83.daemon.dead-letter.json'),
        });
    });

    it('keeps custody suffixes and case-only session ids disjoint on case-insensitive filesystems', () => {
        const activeServerDir = '/active-server';
        const runtimeSuffixId = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: 'foo.daemon',
            custody: 'runtime',
        });
        const daemonBaseId = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: 'foo',
            custody: 'daemon',
        });
        const upperCaseId = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: 'CaseOnly',
            custody: 'runtime',
        });
        const lowerCaseId = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: 'caseonly',
            custody: 'runtime',
        });

        expect(runtimeSuffixId.queuePath.toLowerCase()).not.toBe(daemonBaseId.queuePath.toLowerCase());
        expect(runtimeSuffixId.deadLetterPath.toLowerCase()).not.toBe(daemonBaseId.deadLetterPath.toLowerCase());
        expect(upperCaseId.queuePath.toLowerCase()).not.toBe(lowerCaseId.queuePath.toLowerCase());
        expect(upperCaseId.deadLetterPath.toLowerCase()).not.toBe(lowerCaseId.deadLetterPath.toLowerCase());
        expect(runtimeSuffixId.queuePath).toContain('foo%2Edaemon');
        expect(upperCaseId.queuePath).toContain('%43ase%4Fnly');

        const serverGeneratedCuidShape = 'cmrlsj7bf007jtmiu7kxe7hpk';
        const generatedPaths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: serverGeneratedCuidShape,
            custody: 'daemon',
        });
        expect(basename(generatedPaths.deadLetterPath)).toBe(
            `session-${serverGeneratedCuidShape}.daemon.dead-letter.json`,
        );
        expect(basename(generatedPaths.deadLetterPath).length).toBeLessThan(255);

        const maxLengthProducerAlphabetPaths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: 'c'.repeat(SessionIndexedIdentifierMaxLengthV1),
            custody: 'daemon',
        });
        expect(basename(maxLengthProducerAlphabetPaths.deadLetterPath).length).toBeLessThan(255);

        const encodedDotText = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir,
            sessionId: 'foo%2Edaemon',
            custody: 'runtime',
        });
        expect(encodedDotText.queuePath.toLowerCase()).not.toBe(runtimeSuffixId.queuePath.toLowerCase());
    });

    it('discovers daemon sessions losslessly from queue-only and dead-letter-only canonical filenames', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-daemon-journal-discovery-'));
        const journalDir = join(activeServerDir, 'session-mutations');
        await mkdir(journalDir, { recursive: true });
        try {
            const queueOnly = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir,
                sessionId: 'queue/only',
                custody: 'daemon',
            });
            const deadLetterOnly = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir,
                sessionId: 'dead?letter',
                custody: 'daemon',
            });
            const both = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir,
                sessionId: 'both',
                custody: 'daemon',
            });
            const astralUnicode = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir,
                sessionId: 'emoji-🚀',
                custody: 'daemon',
            });
            await Promise.all([
                writeFile(queueOnly.queuePath, '{}'),
                writeFile(deadLetterOnly.deadLetterPath, '{}'),
                writeFile(both.queuePath, '{}'),
                writeFile(both.deadLetterPath, '{}'),
                writeFile(astralUnicode.queuePath, '{}'),
                writeFile(join(journalDir, 'session-runtime.json'), '{}'),
                writeFile(join(journalDir, 'session-%2f.daemon.json'), '{}'),
                writeFile(join(journalDir, 'session-%ZZ.daemon.dead-letter.json'), '{}'),
                mkdir(join(journalDir, 'session-directory.daemon.json')),
            ]);

            await expect(
                discoverDaemonSessionClientDurableMutationJournalSessionIds(activeServerDir),
            ).resolves.toEqual(['both', 'dead?letter', 'emoji-🚀', 'queue/only']);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('does not discover a runtime suffix-like session id as daemon custody', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-daemon-journal-custody-discovery-'));
        const journalDir = join(activeServerDir, 'session-mutations');
        await mkdir(journalDir, { recursive: true });
        try {
            const runtimePaths = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir,
                sessionId: 'foo.daemon',
                custody: 'runtime',
            });
            await writeFile(runtimePaths.queuePath, '{}');

            await expect(
                discoverDaemonSessionClientDurableMutationJournalSessionIds(activeServerDir),
            ).resolves.toEqual([]);
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });

    it('admits exact-turn settlement, usage-limit recovery, and canonical transcript rows at the daemon parsed seam', () => {
        const exactTurnEnd = queued({
            v: 1,
            sessionId: 's1',
            mutationId: 'exact-end',
            action: 'end_session',
            turnId: 'turn-1',
            observedAt: 1,
        });
        const broadTurnEnd = queued({
            v: 1,
            sessionId: 's1',
            mutationId: 'broad-end',
            action: 'end_session',
            observedAt: 1,
        });
        const ordinaryTurn = queued({
            v: 1,
            sessionId: 's1',
            mutationId: 'begin',
            action: 'begin',
            turnId: 'turn-1',
            observedAt: 1,
        });
        const usageMutation = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.usageLimitRecovery',
            source: 'daemon',
            observedAt: 1,
            op: { kind: 'clear' },
        });
        const activityMutation = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.activity',
            source: 'runtime',
            observedAt: 1,
            op: { kind: 'set', value: { state: 'unknown', activeCount: 0, sourceClass: 'runtime_unknown' } },
        });
        const nonDaemonUsageMutation = { ...usageMutation, source: 'runtime' as const };
        const transcript = queued({
            v: 1,
            sessionId: 's1',
            mutationId: 'transcript:s1:l1',
            source: 'transcript_message_append',
            localId: 'l1',
            content: 'text',
            createdAt: 1,
            updatedAt: 1,
            provenance: { kind: 'non_dependent', source: 'background' },
        }, 'transcript_message_append');

        expect(parseDaemonSessionClientDurableMutation(exactTurnEnd, 's1').mutations).toHaveLength(1);
        expect(parseDaemonSessionClientDurableMutation(queued(usageMutation as unknown as Record<string, unknown>, 'registered_session_state_field'), 's1').mutations).toHaveLength(1);
        expect(parseDaemonSessionClientDurableMutation(transcript, 's1').mutations).toHaveLength(1);
        for (const rejected of [
            broadTurnEnd,
            ordinaryTurn,
            queued(activityMutation as unknown as Record<string, unknown>, 'registered_session_state_field'),
            queued(nonDaemonUsageMutation as unknown as Record<string, unknown>, 'registered_session_state_field'),
            { ...exactTurnEnd, dependsOn: [{ mutationId: 'other', relationship: 'same_turn_prerequisite' }] },
            { ...exactTurnEnd, paused: { reason: 'runtime_auth_recovery', pausedAt: 1 } },
            {
                ...exactTurnEnd,
                payload: { ...(exactTurnEnd.payload as Record<string, unknown>), provider: 'codex' },
            },
            { ...transcript, kind: 'unknown_mutation_kind' },
        ]) {
            const parsed = parseDaemonSessionClientDurableMutation(rejected, 's1');
            expect(parsed.mutations).toEqual([]);
            expect(parsed.deadLetters).toHaveLength(1);
        }
    });
});
