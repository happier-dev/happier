import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

let lastRunLoggedCommandCwd: string | null = null;

vi.mock('../process/cliLaunchSpec', () => ({
    resolveCliTestLaunchSpec: vi.fn(async (params: { testDir: string }) => ({
        command: process.execPath,
        args: [resolve(params.testDir, 'fake-cli.mjs')],
        cwd: resolve(params.testDir, 'launch-cwd'),
        env: {},
    })),
}));

vi.mock('../process/spawnProcess', () => ({
    runLoggedCommand: vi.fn(async (params: {
        cwd: string;
        stdoutPath: string;
        stderrPath: string;
    }) => {
        lastRunLoggedCommandCwd = params.cwd;
        await writeFile(params.stdoutPath, '{"ok":true,"kind":"result","data":{"answer":42}}\n', 'utf8');
        await writeFile(params.stderrPath, '', 'utf8');
    }),
}));

import { runCliJson } from './cliJson';

afterEach(() => {
    vi.restoreAllMocks();
    lastRunLoggedCommandCwd = null;
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
                env: {},
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
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
