import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHomeDir: string | null = null;
const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;

async function useTempHappyHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'happier-cli-session-mutation-persistence-'));
    tempHomeDir = dir;
    process.env.HAPPIER_HOME_DIR = dir;
    return dir;
}

async function createRuntimePersistenceContext(sessionId: string) {
    const { configuration } = await import('@/configuration');
    const { createSessionMutationPersistenceContext, parseQueuedSessionMutation } = await import('./sessionMutationPersistence');
    return createSessionMutationPersistenceContext({
        activeServerDir: configuration.activeServerDir,
        custody: 'runtime',
        sessionId,
        parseQueuedMutation: parseQueuedSessionMutation,
    });
}

async function resolveOutboxFilePath(sessionId: string): Promise<string> {
    const { configuration } = await import('@/configuration');
    return join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.json`);
}

async function readDeadLetterEntries(sessionId: string): Promise<unknown[]> {
    const { configuration } = await import('@/configuration');
    const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.dead-letter.json`);
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { entries?: unknown[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
}

describe('session mutation persistence', () => {
    beforeEach(async () => {
        vi.resetModules();
        await useTempHappyHome();
    });

    afterEach(async () => {
        process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
        if (tempHomeDir) {
            await rm(tempHomeDir, { recursive: true, force: true });
            tempHomeDir = null;
        }
    });

    it('resolves exact paired runtime and daemon-terminal journal filenames with required custody', async () => {
        const { resolveSessionMutationJournalPaths } = await import('./sessionMutationPersistence');
        const activeServerDir = await useTempHappyHome();

        expect(resolveSessionMutationJournalPaths({ activeServerDir, sessionId: 's1', custody: 'runtime' })).toEqual({
            queuePath: join(activeServerDir, 'session-mutations', 'session-s1.json'),
            deadLetterPath: join(activeServerDir, 'session-mutations', 'session-s1.dead-letter.json'),
        });
        expect(resolveSessionMutationJournalPaths({ activeServerDir, sessionId: 's1', custody: 'daemon-terminal' })).toEqual({
            queuePath: join(activeServerDir, 'session-mutations', 'session-s1.daemon-terminal.json'),
            deadLetterPath: join(activeServerDir, 'session-mutations', 'session-s1.daemon-terminal.dead-letter.json'),
        });
    });

    it('rejects lossy session identifiers before returning a journal path', async () => {
        const { resolveSessionMutationJournalPaths } = await import('./sessionMutationPersistence');
        const activeServerDir = await useTempHappyHome();
        expect(() => resolveSessionMutationJournalPaths({ activeServerDir, sessionId: 'a/b', custody: 'runtime' })).toThrow();
        expect(() => resolveSessionMutationJournalPaths({ activeServerDir, sessionId: 'a?b', custody: 'runtime' })).toThrow();
        expect(() => resolveSessionMutationJournalPaths({ activeServerDir, sessionId: '', custody: 'runtime' })).toThrow();
    });

    it('rejects every current-valid non-exact daemon-terminal row at the admission boundary', async () => {
        const { parseDaemonTerminalQueuedSessionMutation, parseQueuedSessionMutation } = await import('./sessionMutationPersistence');
        const {
            createSessionTurnMutation,
            createTranscriptMessageAppendMutation,
        } = await import('./sessionMutationTypes');
        const transcript = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'l1',
            content: 'text',
            provenance: { kind: 'non_dependent', source: 'external' },
        });
        const exactPayload = createSessionTurnMutation({ sessionId: 's1', mutationId: 'exact', action: 'end_session', turnId: 't1', observedAt: 1 });
        const exactRow = { kind: 'session_turn', mutationId: exactPayload.mutationId, payload: exactPayload, createdAt: 1, attempts: 0, nextAttemptAt: 0 };
        expect(parseDaemonTerminalQueuedSessionMutation(exactRow, 's1').ok).toBe(true);
        expect(parseQueuedSessionMutation({
            ...exactRow,
            payload: { ...exactPayload, provider: 'codex' },
        }, 's1').ok).toBe(false);
        expect(parseDaemonTerminalQueuedSessionMutation({ unknown: true }, 's1').ok).toBe(false);
        const rows: readonly unknown[] = [
            { kind: 'transcript_message_append', mutationId: transcript.mutationId, payload: transcript, createdAt: 1, attempts: 0, nextAttemptAt: 0 },
            ...[
                createSessionTurnMutation({ sessionId: 's1', mutationId: 'begin', action: 'begin', turnId: 't1', observedAt: 1 }),
                createSessionTurnMutation({ sessionId: 's1', mutationId: 'touch', action: 'touch_active', turnId: 't1', observedAt: 2 }),
                createSessionTurnMutation({ sessionId: 's1', mutationId: 'complete', action: 'complete', turnId: 't1', observedAt: 3 }),
                createSessionTurnMutation({
                    sessionId: 's1',
                    mutationId: 'fail',
                    action: 'fail',
                    turnId: 't2',
                    observedAt: 4,
                    issue: {
                        v: 1,
                        scope: 'primary_session',
                        status: 'failed',
                        code: 'provider_session_error',
                        source: 'provider_session_error',
                        occurredAt: 4,
                        provider: 'test',
                        sanitizedPreview: 'failed',
                    },
                }),
                createSessionTurnMutation({ sessionId: 's1', mutationId: 'cancel', action: 'cancel', turnId: 't3', observedAt: 5 }),
                createSessionTurnMutation({ sessionId: 's1', mutationId: 'broad-end', action: 'end_session', observedAt: 1 }),
                createSessionTurnMutation({ sessionId: 's1', mutationId: 'provider-end', action: 'end_session', provider: 'codex', providerTurnId: 'p1', observedAt: 1 }),
            ].map((payload) => ({ kind: 'session_turn', mutationId: payload.mutationId, payload, createdAt: 1, attempts: 0, nextAttemptAt: 0 })),
            {
                kind: 'session_turn',
                mutationId: 'wrapper-mismatch',
                payload: createSessionTurnMutation({ sessionId: 's1', mutationId: 'payload-id', action: 'end_session', turnId: 't1', observedAt: 1 }),
                createdAt: 1,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn',
                mutationId: 'path-mismatch',
                payload: createSessionTurnMutation({ sessionId: 'other-session', mutationId: 'path-mismatch', action: 'end_session', turnId: 't1', observedAt: 1 }),
                createdAt: 1,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ];

        for (const row of rows) {
            const broad = parseQueuedSessionMutation(row, 's1');
            const payload = typeof row === 'object' && row !== null && 'payload' in row
                ? row.payload as { action?: unknown; turnId?: unknown }
                : null;
            const isBroadSessionEnd = payload?.action === 'end_session'
                && (typeof payload.turnId !== 'string' || payload.turnId.length === 0);
            const mutationId = payload && 'mutationId' in payload ? String(payload.mutationId) : 'unknown';
            expect(broad.ok, mutationId).toBe(!isBroadSessionEnd);
            expect.soft(parseDaemonTerminalQueuedSessionMutation(row, 's1').ok).toBe(false);
        }
    });

    it('rekeys the legacy daemon exit identity to include its observation timestamp', async () => {
        const { parseDaemonTerminalQueuedSessionMutation } = await import('./sessionMutationPersistence');
        const legacyMutationId = `daemon-observed-exit:${createHash('sha256')
            .update(JSON.stringify({ sessionId: 's1', turnId: 't1' }))
            .digest('hex')}`;
        const expectedMutationId = `daemon-observed-exit:${createHash('sha256')
            .update(JSON.stringify({ sessionId: 's1', turnId: 't1', observedAt: 1234 }))
            .digest('hex')}`;

        const parsed = parseDaemonTerminalQueuedSessionMutation({
            kind: 'session_turn',
            mutationId: legacyMutationId,
            payload: {
                v: 1,
                sessionId: 's1',
                mutationId: legacyMutationId,
                action: 'end_session',
                turnId: 't1',
                observedAt: 1234,
            },
            createdAt: 1234,
            attempts: 7000,
            nextAttemptAt: 5678,
        }, 's1');

        expect(parsed).toMatchObject({
            ok: true,
            mutation: {
                mutationId: expectedMutationId,
                payload: { mutationId: expectedMutationId, observedAt: 1234 },
                attempts: 7000,
                nextAttemptAt: 5678,
            },
        });
    });

    it('keeps every repeated daemon parser quarantine bounded without changing runtime dead-letter append behavior', async () => {
        const {
            createSessionMutationPersistenceContext,
            loadSessionMutationOutbox,
            parseDaemonTerminalQueuedSessionMutation,
            parseQueuedSessionMutation,
        } = await import('./sessionMutationPersistence');
        const { configuration } = await import('@/configuration');
        const daemonContext = createSessionMutationPersistenceContext({
            activeServerDir: configuration.activeServerDir,
            custody: 'daemon-terminal',
            sessionId: 's-quarantine',
            parseQueuedMutation: parseDaemonTerminalQueuedSessionMutation,
        });
        const runtimeContext = createSessionMutationPersistenceContext({
            activeServerDir: configuration.activeServerDir,
            custody: 'runtime',
            sessionId: 's-runtime-quarantine',
            parseQueuedMutation: parseQueuedSessionMutation,
        });
        const strictInvalidContext = createSessionMutationPersistenceContext({
            activeServerDir: configuration.activeServerDir,
            custody: 'daemon-terminal',
            sessionId: 's-strict-invalid',
            parseQueuedMutation: parseDaemonTerminalQueuedSessionMutation,
        });
        const invalidJsonContext = createSessionMutationPersistenceContext({
            activeServerDir: configuration.activeServerDir,
            custody: 'daemon-terminal',
            sessionId: 's-invalid-json',
            parseQueuedMutation: parseDaemonTerminalQueuedSessionMutation,
        });
        const unknownAlpha = { kind: 'future-kind', evidence: 'alpha' };
        const unknownBeta = { kind: 'future-kind', evidence: 'beta' };
        const malformedTurn = {
            kind: 'session_turn',
            mutationId: 'malformed-turn',
            payload: {
                v: 1,
                sessionId: 's-quarantine',
                mutationId: 'malformed-turn',
                action: 'fail',
                turnId: 'turn-1',
                observedAt: 1,
            },
        };
        await mkdir(join(daemonContext.paths.queuePath, '..'), { recursive: true });
        await writeFile(daemonContext.paths.queuePath, JSON.stringify({
            v: 1,
            mutations: [unknownAlpha, unknownBeta, malformedTurn],
        }));
        await writeFile(runtimeContext.paths.queuePath, JSON.stringify({ v: 1, mutations: [unknownAlpha] }));
        await writeFile(strictInvalidContext.paths.queuePath, JSON.stringify({
            v: 1,
            mutations: [{
                kind: 'transcript_message_append',
                mutationId: 'transcript:s-strict-invalid:strict-invalid',
                payload: {
                    v: 1,
                    source: 'transcript_message_append',
                    sessionId: 's-strict-invalid',
                    mutationId: 'transcript:s-strict-invalid:strict-invalid',
                    localId: 'strict-invalid',
                    content: 'strict-invalid',
                    createdAt: 1,
                    updatedAt: 1,
                },
                createdAt: 1,
                attempts: 0,
                nextAttemptAt: 0,
            }],
        }));
        await writeFile(invalidJsonContext.paths.queuePath, '{invalid-json-alpha');

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
        await expect(loadSessionMutationOutbox(daemonContext)).resolves.toEqual([]);
        await expect(loadSessionMutationOutbox(runtimeContext)).resolves.toEqual([]);
        await expect(loadSessionMutationOutbox(strictInvalidContext)).resolves.toEqual([]);
        await expect(loadSessionMutationOutbox(invalidJsonContext)).resolves.toEqual([]);
        vi.setSystemTime(new Date('2026-07-13T10:00:01.000Z'));
        await expect(loadSessionMutationOutbox(daemonContext)).resolves.toEqual([]);
        await expect(loadSessionMutationOutbox(runtimeContext)).resolves.toEqual([]);
        await expect(loadSessionMutationOutbox(strictInvalidContext)).resolves.toEqual([]);
        await expect(loadSessionMutationOutbox(invalidJsonContext)).resolves.toEqual([]);
        vi.useRealTimers();

        const daemonDeadLetters = JSON.parse(await readFile(daemonContext.paths.deadLetterPath, 'utf8')) as {
            entries: Array<{ reason?: string; payloadSummary?: { fingerprint?: string } }>;
        };
        expect(daemonDeadLetters.entries).toHaveLength(3);
        expect(daemonDeadLetters.entries.map((entry) => entry.reason).sort()).toEqual([
            'invalid_session_turn_payload',
            'unknown_queued_mutation_kind',
            'unknown_queued_mutation_kind',
        ]);
        expect(daemonDeadLetters.entries
            .filter((entry) => entry.reason === 'unknown_queued_mutation_kind')
            .map((entry) => entry.payloadSummary?.fingerprint)
            .filter((fingerprint): fingerprint is string => typeof fingerprint === 'string'))
            .toHaveLength(2);
        expect(new Set(daemonDeadLetters.entries
            .filter((entry) => entry.reason === 'unknown_queued_mutation_kind')
            .map((entry) => entry.payloadSummary?.fingerprint)).size).toBe(2);
        const runtimeDeadLetters = JSON.parse(await readFile(runtimeContext.paths.deadLetterPath, 'utf8')) as { entries: unknown[] };
        expect(runtimeDeadLetters.entries).toHaveLength(2);
        expect(runtimeDeadLetters.entries).toEqual([
            expect.objectContaining({
                reason: 'unknown_queued_mutation_kind',
                payloadSummary: { keys: ['evidence', 'kind'] },
            }),
            expect.objectContaining({
                reason: 'unknown_queued_mutation_kind',
                payloadSummary: { keys: ['evidence', 'kind'] },
            }),
        ]);
        const strictInvalidDeadLetters = JSON.parse(await readFile(strictInvalidContext.paths.deadLetterPath, 'utf8')) as {
            entries: Array<{ reason?: string }>;
        };
        expect(strictInvalidDeadLetters.entries).toEqual([
            expect.objectContaining({ reason: 'invalid_daemon_terminal_mutation' }),
        ]);
        const invalidJsonDeadLetters = JSON.parse(await readFile(invalidJsonContext.paths.deadLetterPath, 'utf8')) as {
            entries: Array<{ reason?: string; payloadSummary?: { fingerprint?: string } }>;
        };
        expect(invalidJsonDeadLetters.entries).toEqual([
            expect.objectContaining({
                reason: 'invalid_outbox_json',
                payloadSummary: expect.objectContaining({ fingerprint: expect.any(String) }),
            }),
        ]);
    });

    it('quarantines schema-invalid session turn rows while loading valid rows', async () => {
        const { loadSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const outboxPath = await resolveOutboxFilePath('s1');
        const validTranscript = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'valid-row',
            content: 'valid',
            provenance: { kind: 'non_dependent', source: 'external' },
            createdAt: 2_000,
            updatedAt: 2_000,
        });
        await mkdir(join(outboxPath, '..'), { recursive: true });
        await writeFile(outboxPath, JSON.stringify({
            v: 1,
            mutations: [
                {
                    kind: 'session_turn',
                    mutationId: 'bad-fail',
                    payload: {
                        v: 1,
                        sessionId: 's1',
                        mutationId: 'bad-fail',
                        action: 'fail',
                        turnId: 'turn-1',
                        observedAt: 1_000,
                    },
                    createdAt: 1_000,
                    attempts: 2,
                    nextAttemptAt: 0,
                },
                {
                    kind: 'transcript_message_append',
                    mutationId: validTranscript.mutationId,
                    payload: validTranscript,
                    createdAt: 2_000,
                    attempts: 0,
                    nextAttemptAt: 0,
                },
            ],
        }), 'utf8');

        await expect(loadSessionMutationOutbox(await createRuntimePersistenceContext('s1'))).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: validTranscript.mutationId,
            }),
        ]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'session_turn',
                mutationId: 'bad-fail',
                reason: 'invalid_session_turn_payload',
                attempts: 2,
                payloadSummary: expect.objectContaining({
                    action: 'fail',
                    sessionId: 's1',
                }),
            }),
        ]);
    });

    it('quarantines unreadable outbox JSON instead of silently dropping it', async () => {
        const { loadSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const outboxPath = await resolveOutboxFilePath('s1');
        await mkdir(join(outboxPath, '..'), { recursive: true });
        await writeFile(outboxPath, '{not-json', 'utf8');

        await expect(loadSessionMutationOutbox(await createRuntimePersistenceContext('s1'))).resolves.toEqual([]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'outbox_file',
                sessionId: 's1',
                reason: 'invalid_outbox_json',
            }),
        ]);
    });

    it('quarantines transcript append rows whose mutation id is not the canonical session/localId key', async () => {
        const { loadSessionMutationOutbox } = await import('./sessionMutationPersistence');
        const outboxPath = await resolveOutboxFilePath('s1');
        await mkdir(join(outboxPath, '..'), { recursive: true });
        await writeFile(outboxPath, JSON.stringify({
            v: 1,
            mutations: [
                {
                    kind: 'transcript_message_append',
                    mutationId: 'transcript:s1:segment-1',
                    payload: {
                        v: 1,
                        source: 'transcript_message_append',
                        sessionId: 's1',
                        mutationId: 'transcript:s1:segment-1',
                        localId: 'segment-1',
                        sidechainId: 'sc-1',
                        messageRole: 'agent',
                        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'canonical' } } },
                        createdAt: 1_000,
                        updatedAt: 1_100,
                    },
                    createdAt: 1_000,
                    attempts: 0,
                    nextAttemptAt: 0,
                },
                {
                    kind: 'transcript_message_append',
                    mutationId: 'transcript:segment-1',
                    payload: {
                        v: 1,
                        source: 'transcript_message_append',
                        sessionId: 's1',
                        mutationId: 'transcript:segment-1',
                        localId: 'segment-1',
                        sidechainId: 'sc-2',
                        messageRole: 'agent',
                        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'bypass' } } },
                        createdAt: 1_000,
                        updatedAt: 1_200,
                    },
                    createdAt: 1_000,
                    attempts: 0,
                    nextAttemptAt: 0,
                },
            ],
        }), 'utf8');

        await expect(loadSessionMutationOutbox(await createRuntimePersistenceContext('s1'))).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:s1:segment-1',
                payload: expect.objectContaining({
                    localId: 'segment-1',
                    sidechainId: 'sc-1',
                }),
            }),
        ]);
        await expect(readDeadLetterEntries('s1')).resolves.toEqual([
            expect.objectContaining({
                kind: 'transcript_message_append',
                mutationId: 'transcript:segment-1',
                reason: 'invalid_transcript_message_append_payload',
                payloadSummary: expect.objectContaining({
                    localId: 'segment-1',
                    mutationId: 'transcript:segment-1',
                }),
            }),
        ]);
    });

    it('preserves exact canonical queue bytes when atomic replacement conflicts persist', async () => {
        const activeServerDir = await useTempHappyHome();
        const queuePath = join(activeServerDir, 'session-mutations', 'session-conflict.json');
        const oldBytes = '{"v":1,"mutations":[],"sentinel":"old"}\n';
        await mkdir(join(queuePath, '..'), { recursive: true });
        await writeFile(queuePath, oldBytes, 'utf8');
        vi.doMock('node:fs/promises', async () => {
            const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            return {
                ...actual,
                rename: async () => {
                    const error = new Error('persistent replacement conflict') as NodeJS.ErrnoException;
                    error.code = 'EPERM';
                    throw error;
                },
            };
        });
        const {
            createSessionMutationPersistenceContext,
            parseQueuedSessionMutation,
            saveSessionMutationOutbox,
        } = await import('./sessionMutationPersistence');
        const { createTranscriptMessageAppendMutation } = await import('./sessionMutationTypes');
        const context = createSessionMutationPersistenceContext({
            activeServerDir,
            custody: 'runtime',
            sessionId: 'conflict',
            parseQueuedMutation: parseQueuedSessionMutation,
        });
        const payload = createTranscriptMessageAppendMutation({
            sessionId: 'conflict',
            localId: 'conflict-row',
            content: 'conflict',
            provenance: { kind: 'non_dependent', source: 'external' },
            createdAt: 1,
            updatedAt: 1,
        });

        await expect(saveSessionMutationOutbox(context, [{
            kind: 'transcript_message_append',
            mutationId: payload.mutationId,
            payload,
            createdAt: 1,
            attempts: 0,
            nextAttemptAt: 0,
        }])).rejects.toMatchObject({ code: 'EPERM' });
        await expect(readFile(queuePath, 'utf8')).resolves.toBe(oldBytes);
        vi.doUnmock('node:fs/promises');
    });
});
