import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let lastRunLoggedCommandCwd: string | null = null;
let runLoggedCommandFailure: Error | null = null;
let runLoggedCommandStdout = '{"ok":true,"kind":"result","data":{"answer":42}}\n';

vi.mock('../process/cliLaunchSpec', () => ({
    resolveCliTestLaunchSpec: vi.fn(async (params: { testDir: string }) => ({
        command: process.execPath,
        args: [resolve(params.testDir, 'fake-cli.mjs')],
        cwd: resolve(params.testDir, 'launch-cwd'),
        env: {},
    })),
    resolveCliTestLaunchSpecOrOverride: vi.fn(async (
        override: unknown,
        resolveDefault: () => Promise<unknown>,
    ) => override ?? await resolveDefault()),
}));

vi.mock('../process/spawnProcess', () => ({
    readLoggedCommandProcessOutcome: (error: unknown) => (
        error && typeof error === 'object' && 'process' in error
            ? (error as { process: unknown }).process
            : null
    ),
    runLoggedCommandWithOutcome: vi.fn(async (params: {
        cwd: string;
        stdoutPath: string;
        stderrPath: string;
    }) => {
        lastRunLoggedCommandCwd = params.cwd;
        await writeFile(params.stdoutPath, runLoggedCommandStdout, 'utf8');
        await writeFile(params.stderrPath, '', 'utf8');
        if (runLoggedCommandFailure) throw runLoggedCommandFailure;
        return { exitCode: 0, signal: null };
    }),
}));

import { runCliJson, writeRedactedResultArtifact } from './cliJson';

afterEach(() => {
    vi.restoreAllMocks();
    lastRunLoggedCommandCwd = null;
    runLoggedCommandFailure = null;
    runLoggedCommandStdout = '{"ok":true,"kind":"result","data":{"answer":42}}\n';
});

describe('runCliJson', () => {
    it('launches the CLI from the resolved snapshot cwd', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-json-cwd-'));
        const cliHomeDir = resolve(testDir, 'cli-home');

        try {
            await mkdir(cliHomeDir, { recursive: true });

            const result = await runCliJson({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                env: { NODE_ENV: 'test' },
                label: 'cwd',
                args: ['auth', 'whoami', '--json'],
            });

            expect(lastRunLoggedCommandCwd).toBe(resolve(testDir, 'launch-cwd'));
            expect(result).toEqual({
                ok: true,
                kind: 'result',
                data: {
                    answer: 42,
                },
            });
            expect(await readFile(resolve(testDir, 'cli.cwd.stdout.log'), 'utf8')).toContain('"answer":42');
            const resultArtifactText = await readFile(resolve(testDir, 'cli.cwd.result.json'), 'utf8');
            expect(JSON.parse(resultArtifactText)).toEqual({
                v: 1,
                label: 'cwd',
                process: { exitCode: 0, signal: null },
                outcome: { ok: true, resultKind: 'result' },
            });
            expect(resultArtifactText).not.toContain('answer');
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it.each([
        ['exit code', { exitCode: 7, signal: null }, 'fake CLI exited with code 7'],
        ['signal', { exitCode: null, signal: 'SIGTERM' }, 'fake CLI exited with signal SIGTERM'],
    ] as const)('persists the actual %s outcome when the CLI command fails', async (_case, processOutcome, message) => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-json-failure-'));
        const cliHomeDir = resolve(testDir, 'cli-home');

        try {
            await mkdir(cliHomeDir, { recursive: true });
            runLoggedCommandFailure = Object.assign(new Error(message), {
                process: processOutcome,
            });

            await expect(runCliJson({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                env: { NODE_ENV: 'test' },
                label: 'failed',
                args: ['auth', 'whoami', '--json'],
            })).rejects.toThrow(message);

            expect(JSON.parse(await readFile(resolve(testDir, 'cli.failed.result.json'), 'utf8'))).toEqual({
                v: 1,
                label: 'failed',
                process: processOutcome,
                outcome: { commandSucceeded: false, jsonEnvelopeParsed: false },
            });
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('returns an expected non-zero JSON envelope and records its real process outcome', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-json-expected-nonzero-'));
        const cliHomeDir = resolve(testDir, 'cli-home');

        try {
            await mkdir(cliHomeDir, { recursive: true });
            runLoggedCommandStdout = '{"ok":false,"kind":"plugins_install","error":{"code":"review_required"}}\n';
            runLoggedCommandFailure = Object.assign(new Error('fake CLI exited with code 1'), {
                process: { exitCode: 1, signal: null },
            });

            await expect(runCliJson({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                env: { NODE_ENV: 'test' },
                label: 'review-required',
                args: ['plugins', 'install', 'plugin.tgz', '--json'],
                acceptedExitCodes: [1],
            })).resolves.toEqual({
                ok: false,
                kind: 'plugins_install',
                error: { code: 'review_required' },
            });

            expect(JSON.parse(await readFile(resolve(testDir, 'cli.review-required.result.json'), 'utf8'))).toEqual({
                v: 1,
                label: 'review-required',
                process: { exitCode: 1, signal: null },
                outcome: { ok: false, resultKind: 'plugins_install' },
            });
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('does not call an accepted non-zero process successful when its JSON envelope is malformed', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-json-expected-nonzero-malformed-'));
        const cliHomeDir = resolve(testDir, 'cli-home');

        try {
            await mkdir(cliHomeDir, { recursive: true });
            runLoggedCommandStdout = 'not a JSON envelope\n';
            runLoggedCommandFailure = Object.assign(new Error('fake CLI exited with code 1'), {
                process: { exitCode: 1, signal: null },
            });

            await expect(runCliJson({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                env: { NODE_ENV: 'test' },
                label: 'malformed-review-required',
                args: ['plugins', 'install', 'plugin.tgz', '--json'],
                acceptedExitCodes: [1],
            })).rejects.toThrow('Failed to parse JSON envelope');

            expect(JSON.parse(await readFile(
                resolve(testDir, 'cli.malformed-review-required.result.json'),
                'utf8',
            ))).toEqual({
                v: 1,
                label: 'malformed-review-required',
                process: { exitCode: 1, signal: null },
                outcome: { commandSucceeded: false, jsonEnvelopeParsed: false },
            });
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('rejects nested result payloads instead of persisting them as redacted evidence', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-json-redaction-'));

        try {
            await expect(writeRedactedResultArtifact({
                testDir,
                artifactName: 'nested.result.json',
                label: 'nested',
                outcome: {
                    payload: { token: 'must-not-persist' },
                } as never,
            })).rejects.toThrow(/scalar/i);
            await expect(readFile(resolve(testDir, 'nested.result.json'), 'utf8')).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('persists a scalar failure summary when successful CLI output has no JSON envelope', async () => {
        const testDir = await mkdtemp(join(tmpdir(), 'happier-cli-json-parse-failure-'));
        const cliHomeDir = resolve(testDir, 'cli-home');

        try {
            await mkdir(cliHomeDir, { recursive: true });
            runLoggedCommandStdout = 'raw diagnostic payload: token=must-stay-in-raw-log\n';

            await expect(runCliJson({
                testDir,
                cliHomeDir,
                serverUrl: 'http://127.0.0.1:4011',
                webappUrl: 'http://127.0.0.1:19006',
                env: { NODE_ENV: 'test' },
                label: 'parse-failed',
                args: ['auth', 'whoami', '--json'],
            })).rejects.toThrow('Failed to parse JSON envelope');

            const rawLog = await readFile(resolve(testDir, 'cli.parse-failed.stdout.log'), 'utf8');
            const resultArtifact = await readFile(resolve(testDir, 'cli.parse-failed.result.json'), 'utf8');
            expect(rawLog).toContain('must-stay-in-raw-log');
            expect(JSON.parse(resultArtifact)).toEqual({
                v: 1,
                label: 'parse-failed',
                process: { exitCode: 0, signal: null },
                outcome: { commandSucceeded: true, jsonEnvelopeParsed: false },
            });
            expect(resultArtifact).not.toContain('must-stay-in-raw-log');
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
