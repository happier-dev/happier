import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
    createSessionMutationPersistenceContext,
    appendSessionMutationDeadLetters,
    createSessionMutationDeadLetterEntry,
    loadSessionMutationOutbox,
    parseDaemonTerminalQueuedSessionMutation,
    parseQueuedSessionMutation,
    resolveSessionMutationJournalPaths,
    saveSessionMutationOutbox,
    type SessionMutationJournalPaths,
} from './sessionMutationPersistence';
import { createSessionTurnMutation, createTranscriptMessageAppendMutation } from './sessionMutationTypes';

const children = new Set<ChildProcess>();
const socketCalls = new WeakMap<ChildProcess, unknown[]>();
let tempDir: string | null = null;

function queuedTranscript(sessionId: string, localId: string, nextAttemptAt: number) {
    const payload = createTranscriptMessageAppendMutation({
        sessionId,
        provenance: { kind: 'non_dependent', source: 'external' },
        localId,
        sidechainId: 'seed-sidechain',
        content: localId,
        createdAt: 1_000,
        updatedAt: 1_000,
    });
    return { kind: 'transcript_message_append' as const, mutationId: payload.mutationId, payload, intentOrder: 1, createdAt: 1_000, attempts: 0, nextAttemptAt };
}

function waitFor(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let stderr = '';
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}: ${stderr}`)), 60_000);
        child.once('exit', (code, signal) => reject(new Error(`Worker exited before ${type}: ${code}/${signal}: ${stderr}`)));
        const listener = (message: Record<string, unknown>) => {
            if (message.type === 'worker-error') {
                clearTimeout(timer);
                reject(new Error(String(message.message)));
            } else if (message.type === type) {
                clearTimeout(timer);
                child.off('message', listener);
                resolve(message);
            }
        };
        child.on('message', listener);
    });
}

function spawnWorker(role: 'runtime' | 'daemon', sessionId: string, paths: SessionMutationJournalPaths): ChildProcess {
    const worker = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sessionMutationCustodyProcessWorker.ts');
    const child = fork(worker, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(child);
    const calls: unknown[] = [];
    socketCalls.set(child, calls);
    child.on('message', (message: Record<string, unknown>) => {
        if (message.type === 'socket-call') calls.push(message);
    });
    child.send({ type: 'init', role, sessionId, paths });
    return child;
}

async function waitForSocketCall(child: ChildProcess): Promise<void> {
    if ((socketCalls.get(child)?.length ?? 0) > 0) return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for socket-call')), 10_000);
        const listener = (message: Record<string, unknown>) => {
            if (message.type !== 'socket-call') return;
            clearTimeout(timer);
            child.off('message', listener);
            resolve();
        };
        child.on('message', listener);
    });
}

async function inspectFresh(
    sessionId: string,
    custody: 'runtime' | 'daemon-terminal',
    paths: SessionMutationJournalPaths,
    admission?: 'broad',
): Promise<string[]> {
    const worker = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sessionMutationCustodyProcessWorker.ts');
    const child = fork(worker, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(child);
    child.send({ type: 'inspect', custody, sessionId, paths, admission });
    const result = await waitFor(child, 'parsed-persisted-mutation-ids');
    await waitForCleanExit(child);
    return result.ids as string[];
}

async function waitForCleanExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) {
        expect(child.exitCode).toBe(0);
        expect(child.signalCode).toBeNull();
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for worker exit')), 10_000);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            try {
                expect(code).toBe(0);
                expect(signal).toBeNull();
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function recoverFresh(
    sessionId: string,
    custody: 'runtime' | 'daemon-terminal',
    paths: SessionMutationJournalPaths,
): Promise<Readonly<{ ids: string[]; recoveredIds: string[] }>> {
    const worker = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sessionMutationCustodyProcessWorker.ts');
    const child = fork(worker, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(child);
    child.send({ type: 'recover', custody, sessionId, paths });
    const result = await waitFor(child, 'recovery-persisted');
    await waitForCleanExit(child);
    return { ids: result.ids as string[], recoveredIds: result.recoveredIds as string[] };
}

async function runResurrectionSchedule(mode: 'legacy-shared' | 'split-custody'): Promise<Readonly<{
    runtimeIds: string[];
    daemonIds: string[];
}>> {
    tempDir = await mkdtemp(join(tmpdir(), `happier-session-custody-${mode}-`));
    const sessionId = 'process-custody-s1';
    const runtimePaths = resolveSessionMutationJournalPaths({ activeServerDir: tempDir, sessionId, custody: 'runtime' });
    const daemonPaths = mode === 'legacy-shared'
        ? runtimePaths
        : resolveSessionMutationJournalPaths({ activeServerDir: tempDir, sessionId, custody: 'daemon-terminal' });
    const runtimeContext = createSessionMutationPersistenceContext({
        activeServerDir: tempDir,
        sessionId,
        custody: 'runtime',
        parseQueuedMutation: parseQueuedSessionMutation,
    });
    const daemonContext = {
        custody: mode === 'legacy-shared' ? 'runtime' as const : 'daemon-terminal' as const,
        sessionId,
        paths: daemonPaths,
        parseQueuedMutation: parseQueuedSessionMutation,
    };
    const farFuture = Date.now() + 60_000;
    await saveSessionMutationOutbox(runtimeContext, [
        queuedTranscript(sessionId, 'acked-mutation', farFuture),
        queuedTranscript(sessionId, 'runtime-readiness-probe', farFuture),
        ...(mode === 'legacy-shared' ? [queuedTranscript(sessionId, 'daemon-readiness-probe', farFuture)] : []),
    ]);
    if (mode === 'split-custody') {
        await saveSessionMutationOutbox(daemonContext, [queuedTranscript(sessionId, 'daemon-readiness-probe', farFuture)]);
    }
    const runtime = spawnWorker('runtime', sessionId, runtimePaths);
    const daemon = spawnWorker('daemon', sessionId, daemonPaths);
    await Promise.all([waitFor(runtime, 'owner-ready'), waitFor(daemon, 'owner-ready')]);
    const selectedPaths = [runtimePaths.queuePath, daemonPaths.queuePath];
    const preRelease = await Promise.all(selectedPaths.map(async (path) => ({
        path,
        bytes: await readFile(path, 'utf8'),
        metadata: await stat(path).then(({ size, mtimeMs }) => ({ size, mtimeMs })),
    })));
    socketCalls.get(runtime)?.splice(0);
    socketCalls.get(daemon)?.splice(0);
    for (const snapshot of preRelease) {
        expect(await readFile(snapshot.path, 'utf8')).toBe(snapshot.bytes);
        expect(await stat(snapshot.path).then(({ size, mtimeMs }) => ({ size, mtimeMs }))).toEqual(snapshot.metadata);
    }
    expect(socketCalls.get(runtime)).toEqual([]);
    expect(socketCalls.get(daemon)).toEqual([]);

    runtime.send({ type: 'ack-baseline' });
    await waitFor(runtime, 'ack-persisted');
    expect((await loadSessionMutationOutbox(runtimeContext)).map((row) => row.mutationId)).not.toContain(
        'transcript:process-custody-s1:acked-mutation',
    );

    daemon.send({ type: 'persist-new' });
    await waitFor(daemon, 'new-persisted');
    await waitForSocketCall(daemon);
    expect(socketCalls.get(runtime)?.length).toBeGreaterThan(0);
    expect(socketCalls.get(daemon)?.length).toBeGreaterThan(0);
    runtime.send({ type: 'exit-without-close' });
    daemon.send({ type: 'exit-without-close' });
    await Promise.all([waitForCleanExit(runtime), waitForCleanExit(daemon)]);

    const [runtimeIds, daemonIds] = await Promise.all([
        inspectFresh(sessionId, 'runtime', runtimePaths, 'broad'),
        inspectFresh(sessionId, mode === 'legacy-shared' ? 'runtime' : 'daemon-terminal', daemonPaths, 'broad'),
    ]);
    return { runtimeIds, daemonIds };
}

afterEach(async () => {
    await Promise.all([...children].map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            child.kill('SIGKILL');
        });
    }));
    children.clear();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
});

describe('session mutation custody across processes', () => {
    it('characterizes stale-ACK resurrection when both producers share the legacy path', async () => {
        const { runtimeIds, daemonIds } = await runResurrectionSchedule('legacy-shared');
        expect(runtimeIds).toContain('transcript:process-custody-s1:acked-mutation');
        expect(daemonIds).toContain('transcript:process-custody-s1:acked-mutation');
    }, 60_000);

    it('prevents stale-snapshot resurrection with split runtime and daemon custody', async () => {
        const { runtimeIds, daemonIds } = await runResurrectionSchedule('split-custody');
        expect(daemonIds).toContain('daemon-new-mutation');
        expect(runtimeIds).not.toContain('transcript:process-custody-s1:acked-mutation');
        expect(daemonIds).not.toContain('transcript:process-custody-s1:acked-mutation');
    }, 60_000);

    it('isolates queue and dead-letter recovery in both custody directions across restart', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'happier-session-custody-dead-letter-'));
        const sessionId = 'process-custody-dead-letter-s1';
        const runtimeContext = createSessionMutationPersistenceContext({
            activeServerDir: tempDir,
            custody: 'runtime',
            sessionId,
            parseQueuedMutation: parseQueuedSessionMutation,
        });
        const daemonContext = createSessionMutationPersistenceContext({
            activeServerDir: tempDir,
            custody: 'daemon-terminal',
            sessionId,
            parseQueuedMutation: parseDaemonTerminalQueuedSessionMutation,
        });
        const runtimeRecoveredPayload = createSessionTurnMutation({
            sessionId,
            mutationId: 'runtime-recovered',
            action: 'begin',
            turnId: 'runtime-turn',
            observedAt: 2,
        });
        const daemonRecoveredPayload = createSessionTurnMutation({
            sessionId,
            mutationId: 'daemon-recovered',
            action: 'end_session',
            turnId: 'daemon-turn',
            observedAt: 3,
        });
        const daemonSeedPayload = createSessionTurnMutation({
            sessionId,
            mutationId: 'daemon-seed',
            action: 'end_session',
            turnId: 'daemon-seed-turn',
            observedAt: 1,
        });
        await saveSessionMutationOutbox(runtimeContext, [queuedTranscript(sessionId, 'runtime-seed', Date.now() + 60_000)]);
        await saveSessionMutationOutbox(daemonContext, [{
            kind: 'session_turn',
            mutationId: daemonSeedPayload.mutationId,
            payload: daemonSeedPayload,
            createdAt: 1,
            attempts: 0,
            nextAttemptAt: 0,
        }]);
        await appendSessionMutationDeadLetters(runtimeContext, [createSessionMutationDeadLetterEntry({
            sessionId,
            mutation: {
                kind: 'session_turn',
                mutationId: runtimeRecoveredPayload.mutationId,
                payload: runtimeRecoveredPayload,
                createdAt: 2,
                attempts: 1,
                nextAttemptAt: 0,
            },
            reason: 'retry_exhausted',
        })]);
        await appendSessionMutationDeadLetters(daemonContext, [createSessionMutationDeadLetterEntry({
            sessionId,
            mutation: {
                kind: 'session_turn',
                mutationId: daemonRecoveredPayload.mutationId,
                payload: daemonRecoveredPayload,
                createdAt: 3,
                attempts: 1,
                nextAttemptAt: 0,
            },
            reason: 'retry_exhausted',
        })]);

        const daemonQueueBeforeRuntimeRecovery = await readFile(daemonContext.paths.queuePath, 'utf8');
        const daemonDeadLetterBeforeRuntimeRecovery = await readFile(daemonContext.paths.deadLetterPath, 'utf8');
        const runtimeRecovery = await recoverFresh(sessionId, 'runtime', runtimeContext.paths);
        expect(runtimeRecovery.recoveredIds).toEqual(['runtime-recovered']);
        expect(runtimeRecovery.ids).toEqual(expect.arrayContaining([
            'transcript:process-custody-dead-letter-s1:runtime-seed',
            'runtime-recovered',
        ]));
        expect(runtimeRecovery.ids).not.toContain('daemon-recovered');
        expect(await readFile(daemonContext.paths.queuePath, 'utf8')).toBe(daemonQueueBeforeRuntimeRecovery);
        expect(await readFile(daemonContext.paths.deadLetterPath, 'utf8')).toBe(daemonDeadLetterBeforeRuntimeRecovery);

        const runtimeQueueBeforeDaemonRecovery = await readFile(runtimeContext.paths.queuePath, 'utf8');
        const runtimeDeadLetterBeforeDaemonRecovery = await readFile(runtimeContext.paths.deadLetterPath, 'utf8');
        const daemonRecovery = await recoverFresh(sessionId, 'daemon-terminal', daemonContext.paths);
        expect(daemonRecovery.recoveredIds).toEqual(['daemon-recovered']);
        expect(daemonRecovery.ids).toEqual(expect.arrayContaining(['daemon-seed', 'daemon-recovered']));
        expect(daemonRecovery.ids).not.toContain('runtime-recovered');
        expect(await readFile(runtimeContext.paths.queuePath, 'utf8')).toBe(runtimeQueueBeforeDaemonRecovery);
        expect(await readFile(runtimeContext.paths.deadLetterPath, 'utf8')).toBe(runtimeDeadLetterBeforeDaemonRecovery);

        const [runtimeIds, daemonIds] = await Promise.all([
            inspectFresh(sessionId, 'runtime', runtimeContext.paths),
            inspectFresh(sessionId, 'daemon-terminal', daemonContext.paths),
        ]);
        expect(runtimeIds).toEqual(expect.arrayContaining([
            'transcript:process-custody-dead-letter-s1:runtime-seed',
            'runtime-recovered',
        ]));
        expect(runtimeIds).not.toContain('daemon-recovered');
        expect(daemonIds).toEqual(expect.arrayContaining(['daemon-seed', 'daemon-recovered']));
        expect(daemonIds).not.toContain('runtime-recovered');
    }, 60_000);
});
