import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    discoverDaemonSessionClientDurableMutationJournalSessionIds,
    resolveSessionClientDurableMutationJournalPaths,
} from './sessionClientDurableMutationPersistence';

const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    'sessionClientDurableMutationCustody.child.ts',
);

type RunningChild = Readonly<{
    child: ChildProcess;
    completion: Promise<void>;
}>;

function startChild(params: Readonly<{
    mode: string;
    args: readonly string[];
    homeDir: string;
}>): RunningChild {
    const child = spawn(process.execPath, ['--import', 'tsx', fixturePath, params.mode, ...params.args], {
        cwd: join(dirname(fixturePath), '../../../../../..'),
        env: {
            ...process.env,
            HAPPIER_HOME_DIR: params.homeDir,
            HAPPIER_ACTIVE_SERVER_ID: 'custody-process',
            HAPPIER_SERVER_URL: 'http://127.0.0.1:9',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const completion = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(
                `Custody fixture ${params.mode} exited with code ${String(code)} signal ${String(signal)}\n${stdout}\n${stderr}`,
            ));
        });
    });
    return { child, completion };
}

async function waitForFile(filePath: string): Promise<void> {
    const deadline = Date.now() + 45_000;
    for (;;) {
        try {
            await access(filePath);
            return;
        } catch {
            if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
}

async function readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

describe('session client durable mutation custody across processes', () => {
    it('characterizes legacy stale-snapshot loss then preserves disjoint journals through restart and ACK', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-custody-process-'));
        const controlDir = await mkdtemp(join(tmpdir(), 'happier-custody-control-'));
        const activeServerDir = join(homeDir, 'servers', 'custody-process');
        const sessionId = 'process/session?*';
        const legacyReadyRuntime = join(controlDir, 'legacy-runtime.ready');
        const legacyReadyDaemon = join(controlDir, 'legacy-daemon.ready');
        const legacyReleaseRuntime = join(controlDir, 'legacy-runtime.release');
        const legacyReleaseDaemon = join(controlDir, 'legacy-daemon.release');
        const runtimeReady = join(controlDir, 'runtime.ready');
        const runtimeRelease = join(controlDir, 'runtime.release');
        const runtimeResult = join(controlDir, 'runtime-result.json');
        const daemonResult = join(controlDir, 'daemon-result.json');

        try {
            const legacyRuntime = startChild({
                mode: 'legacy-stale-writer',
                args: [sessionId, 'runtime', legacyReadyRuntime, legacyReleaseRuntime],
                homeDir,
            });
            const legacyDaemon = startChild({
                mode: 'legacy-stale-writer',
                args: [sessionId, 'daemon', legacyReadyDaemon, legacyReleaseDaemon],
                homeDir,
            });
            await Promise.all([waitForFile(legacyReadyRuntime), waitForFile(legacyReadyDaemon)]);
            await writeFile(legacyReleaseRuntime, 'release');
            await legacyRuntime.completion;
            await writeFile(legacyReleaseDaemon, 'release');
            await legacyDaemon.completion;

            const legacyPaths = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir,
                custody: 'runtime',
                sessionId,
            });
            const legacyFinal = await readJson<{ mutations: Array<{ mutationId: string }> }>(legacyPaths.queuePath);
            expect(legacyFinal.mutations.map((mutation) => mutation.mutationId)).toEqual(['legacy-daemon-exact']);
            await rm(legacyPaths.queuePath);

            const runtimeStage = startChild({
                mode: 'runtime-stage',
                args: [sessionId, runtimeReady, runtimeRelease],
                homeDir,
            });
            await waitForFile(runtimeReady);
            await startChild({ mode: 'daemon-stage', args: [sessionId], homeDir }).completion;
            await writeFile(runtimeRelease, 'release');
            await runtimeStage.completion;

            const runtimePaths = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir,
                custody: 'runtime',
                sessionId,
            });
            const daemonPaths = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir,
                custody: 'daemon',
                sessionId,
            });
            const runtimeBeforeRestart = await readJson<{
                mutations: Array<{ kind: string; mutationId: string; payload: { fieldId?: string } }>;
            }>(runtimePaths.queuePath);
            const daemonBeforeRestart = await readJson<{
                mutations: Array<{ kind: string; mutationId: string; payload: { fieldId?: string } }>;
            }>(daemonPaths.queuePath);
            expect(runtimeBeforeRestart.mutations.map((mutation) => [mutation.kind, mutation.payload.fieldId ?? mutation.mutationId])).toEqual([
                ['transcript_message_append', 'transcript:process/session?*:runtime-local'],
                ['registered_session_state_field', 'runtime.activity'],
            ]);
            expect(daemonBeforeRestart.mutations.map((mutation) => [mutation.kind, mutation.payload.fieldId ?? mutation.mutationId])).toEqual([
                ['session_turn_mutation', 'daemon-exact-queued'],
                ['registered_session_state_field', 'runtime.usageLimitRecovery'],
            ]);
            const daemonDeadLettersBeforeRestart = await readJson<{
                entries: Array<{ mutationId?: string; recoveryAttemptedAt?: number }>;
            }>(daemonPaths.deadLetterPath);
            expect(daemonDeadLettersBeforeRestart.entries).toEqual([
                expect.objectContaining({ mutationId: 'daemon-exact-dead-letter' }),
            ]);
            expect(await discoverDaemonSessionClientDurableMutationJournalSessionIds(activeServerDir)).toEqual([sessionId]);

            await Promise.all([
                startChild({ mode: 'runtime-recovery', args: [sessionId, runtimeResult], homeDir }).completion,
                startChild({ mode: 'daemon-recovery', args: [sessionId, daemonResult], homeDir }).completion,
            ]);

            const runtimeRecovered = await readJson<{
                deliveredTranscriptLocalIds: string[];
                deliveredFieldIds: string[];
            }>(runtimeResult);
            const daemonRecovered = await readJson<{
                deliveredExactMutationIds: string[];
                deliveredUsageMutationIds: string[];
            }>(daemonResult);
            expect(runtimeRecovered).toEqual({
                deliveredTranscriptLocalIds: ['runtime-local'],
                deliveredFieldIds: ['runtime.activity'],
            });
            expect(daemonRecovered.deliveredExactMutationIds.sort()).toEqual([
                'daemon-exact-dead-letter',
                'daemon-exact-queued',
            ]);
            expect(daemonRecovered.deliveredUsageMutationIds).toHaveLength(1);
            const daemonDeadLettersAfterRestart = await readJson<{
                entries: Array<{ mutationId?: string; recoveryAttemptedAt?: number }>;
            }>(daemonPaths.deadLetterPath);
            expect(daemonDeadLettersAfterRestart.entries).toEqual([
                expect.objectContaining({
                    mutationId: 'daemon-exact-dead-letter',
                    recoveryAttemptedAt: expect.any(Number),
                }),
            ]);
            await expect(access(runtimePaths.queuePath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(access(daemonPaths.queuePath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(controlDir, { recursive: true, force: true });
            await rm(homeDir, { recursive: true, force: true });
        }
    }, 180_000);
});
