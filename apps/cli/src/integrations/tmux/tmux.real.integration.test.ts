/**
 * Opt-in tmux integration tests.
 *
 * These tests start isolated tmux servers (via `-S` or `TMUX_TMPDIR`) and must
 * never interact with a user's existing tmux sessions.
 *
 * Enable with: `HAPPIER_CLI_TMUX_INTEGRATION=1`
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTmuxTerminalHostAdapter, TmuxUtilities } from '@/integrations/tmux';

function isTmuxInstalled(): boolean {
    const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
    return result.status === 0;
}

function shouldRunTmuxIntegration(): boolean {
    return process.env.HAPPIER_CLI_TMUX_INTEGRATION === '1' && isTmuxInstalled();
}

type WaitForOptions = {
    timeoutMs: number;
    intervalMs?: number;
    label: string;
    debug?: () => string;
};

async function waitForCondition(condition: () => boolean, opts: WaitForOptions): Promise<void> {
    const pollIntervalMs = opts.intervalMs ?? 50;
    const start = Date.now();
    while (Date.now() - start <= opts.timeoutMs) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    const debug = opts.debug ? `\n${opts.debug()}` : '';
    throw new Error(`Timed out waiting for ${opts.label} after ${opts.timeoutMs}ms${debug}`);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
    const parentDir = dirname(path);
    await waitForCondition(
        () => existsSync(path),
        {
            timeoutMs,
            intervalMs: 50,
            label: `file ${path}`,
            debug: () => {
                if (!existsSync(parentDir)) return `parent directory does not exist: ${parentDir}`;
                const list = runTmux(['list-sessions']);
                return `tmux list-sessions status=${list.status} stderr=${list.stderr.trim()}`;
            },
        },
    );
}

function writeDumpScript(dir: string): string {
    const scriptPath = join(dir, 'happier-cli-tmux-dump.cjs');
    writeFileSync(
        scriptPath,
        [
            "const fs = require('fs');",
            "const outFile = process.argv[2];",
            "const keepAliveMs = Number(process.argv[3] || '0');",
            'const payload = {',
            '  argv: process.argv.slice(4),',
            '  env: {',
            '    FOO: process.env.FOO,',
            '    BAR: process.env.BAR,',
            '    TMUX: process.env.TMUX,',
            '    TMUX_PANE: process.env.TMUX_PANE,',
            '    TMUX_TMPDIR: process.env.TMUX_TMPDIR,',
            '    HAPPIER_TMUX_UNSET_CANARY: process.env.HAPPIER_TMUX_UNSET_CANARY,',
            '  },',
            '};',
            'fs.writeFileSync(outFile, JSON.stringify(payload));',
            'if (keepAliveMs > 0) setTimeout(() => {}, keepAliveMs);',
            '',
        ].join('\n'),
        'utf8',
    );
    return scriptPath;
}

type DumpScriptPayload = {
    argv: string[];
    env: {
        FOO?: string;
        BAR?: string;
        TMUX?: string;
        TMUX_PANE?: string;
        TMUX_TMPDIR?: string;
        HAPPIER_TMUX_UNSET_CANARY?: string;
    };
};

function readDumpPayload(outFile: string): DumpScriptPayload {
    return JSON.parse(readFileSync(outFile, 'utf8')) as DumpScriptPayload;
}

async function withCleanTmuxClientEnv<T>(fn: () => Promise<T>): Promise<T> {
    const originalTmux = process.env.TMUX;
    const originalTmuxPane = process.env.TMUX_PANE;
    const originalTmuxTmpDir = process.env.TMUX_TMPDIR;

    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    delete process.env.TMUX_TMPDIR;

    try {
        return await fn();
    } finally {
        if (originalTmux === undefined) delete process.env.TMUX;
        else process.env.TMUX = originalTmux;

        if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
        else process.env.TMUX_PANE = originalTmuxPane;

        if (originalTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR;
        else process.env.TMUX_TMPDIR = originalTmuxTmpDir;
    }
}

type TmuxRunResult = {
    status: number | null;
    stdout: string;
    stderr: string;
    error: Error | undefined;
};

function runTmux(args: string[], options?: { env?: Record<string, string | undefined> }): TmuxRunResult {
    // Never inherit the user's existing tmux context (TMUX/TMUX_PANE) or TMUX_TMPDIR.
    // These tests must only ever talk to isolated servers created by the test itself.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.TMUX_TMPDIR;

    const result = spawnSync('tmux', args, {
        encoding: 'utf8',
        env: {
            ...env,
            ...(options?.env ?? {}),
        } as NodeJS.ProcessEnv,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error,
    };
}

function killIsolatedTmuxServer(socketPath: string): void {
    const result = runTmux(['-S', socketPath, 'kill-server']);
    if (result.status !== 0 && process.env.DEBUG) {
        // Cleanup should never fail the test run, but debug logging can help diagnose flakes.
        console.error('[tmux-it] Failed to kill isolated tmux server', {
            socketPath,
            status: result.status,
            stderr: result.stderr,
            error: result.error?.message,
        });
    }
}

function resolveRealTmuxPath(): string {
    const result = spawnSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout.trim()) {
        throw new Error(`Failed to resolve real tmux path: ${result.stderr}`);
    }
    return result.stdout.trim();
}

function shellSingleQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

describe.skipIf(!shouldRunTmuxIntegration())('tmux (real) integration tests (opt-in)', { timeout: 20_000 }, () => {
    it('spawnInTmux can start many windows concurrently without index-conflict failures', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);

        try {
            const scriptPath = writeDumpScript(dir);
            const sessionName = `happy-it-${process.pid}-${Date.now()}`;

            const results = await Promise.all(
                Array.from({ length: 12 }).map(async (_, i) => {
                    const windowName = `w${i + 1}`;
                    const outFile = join(dir, `out-${windowName}.json`);
                    return utils.spawnInTmux(
                        [process.execPath, scriptPath, outFile, '2000', 'concurrency-check', windowName],
                        { sessionName, windowName, cwd: dir },
                        {},
                    );
                }),
            );

            expect(results.every((r) => r.success)).toBe(true);
        } finally {
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('spawnInTmux returns a real pane PID via -P/-F (regression: PR107 option ordering)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');

            const sessionName = `happy-it-${process.pid}-${Date.now()}`;
            const windowName = 'pid';

            const result = await utils.spawnInTmux(
                [process.execPath, scriptPath, outFile, '5000', 'pid-check'],
                { sessionName, windowName, cwd: dir },
                {},
            );

            expect(result.success).toBe(true);
            if (!result.success) throw new Error(result.error ?? 'expected tmux launch to succeed');
            expect(typeof result.pid).toBe('number');
            expect(result.pid).toBeGreaterThan(0);

            // Ground truth: query tmux directly for the pane pid.
            const panes = runTmux(['-S', socketPath, 'list-panes', '-t', `${sessionName}:${windowName}`, '-F', '#{pane_pid}']);
            expect(panes.status).toBe(0);
            const listedPid = Number.parseInt(panes.stdout.trim(), 10);
            expect(listedPid).toBe(result.pid);

            await waitForFile(outFile, 2_000);
            const payload = readDumpPayload(outFile);
            expect(payload.argv).toEqual(['pid-check']);

            // Validate the TMUX env format: socket_path,server_pid,pane (not session/window).
            expect(typeof payload.env?.TMUX).toBe('string');
            const parts = String(payload.env.TMUX).split(',');
            expect(parts.length).toBeGreaterThanOrEqual(3);
            expect(parts[0]!.length).toBeGreaterThan(0);
            expect(/^\d+$/.test(parts[1]!)).toBe(true);
        } finally {
            // Kill only the isolated server (never touch the user's default tmux server).
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('creates and disposes an owned terminal host as one exact tmux session', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-owned-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);
        const adapter = createTmuxTerminalHostAdapter({ tmux: utils });

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'owned.json');
            const sessionName = `happy-owned-it-${process.pid}-${Date.now()}`;
            const handle = await adapter.createOrAttachHost({
                sessionName,
                workingDirectory: dir,
                spawnArgv: [process.execPath, scriptPath, outFile, '5000', 'owned-host'],
                spawnEnv: { FOO: 'owned-value' },
                isolatedEnv: true,
            });

            await waitForFile(outFile, 2_000);
            const payload = readDumpPayload(outFile);
            expect(payload.argv).toEqual(['owned-host']);
            expect(payload.env?.FOO).toBe('owned-value');

            const windows = runTmux(['-S', socketPath, 'list-windows', '-t', sessionName, '-F', '#{window_name}']);
            expect(windows.status).toBe(0);
            expect(windows.stdout.trim().split('\n')).toEqual([sessionName]);
            expect(handle.attachMetadata.topology).toBe('exclusive');

            await expect(adapter.createOrAttachHost({
                sessionName,
                workingDirectory: dir,
                spawnArgv: [process.execPath, scriptPath, join(dir, 'duplicate.json'), '5000', 'duplicate-host'],
                spawnEnv: {},
                isolatedEnv: true,
            })).rejects.toThrow(/Failed to create tmux session/);
            const afterDuplicateRefusal = runTmux([
                '-S',
                socketPath,
                'list-windows',
                '-t',
                sessionName,
                '-F',
                '#{window_name}',
            ]);
            expect(afterDuplicateRefusal.status).toBe(0);
            expect(afterDuplicateRefusal.stdout.trim().split('\n')).toEqual([sessionName]);

            await adapter.dispose(handle);

            const afterDispose = runTmux(['-S', socketPath, 'has-session', '-t', sessionName]);
            expect(afterDispose.status).not.toBe(0);
        } finally {
            if (runTmux(['-S', socketPath, 'list-sessions']).status === 0) {
                killIsolatedTmuxServer(socketPath);
            }
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('spawnInTmux delivers exact window environment values through the private launcher', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');

            const sessionName = `happy-it-${process.pid}-${Date.now()}`;
            const windowName = 'env';

            const env = {
                FOO: 'a$b',
                BAR: 'quote"back\\tick`',
            };

            const result = await utils.spawnInTmux(
                [process.execPath, scriptPath, outFile, '5000', 'env-check'],
                { sessionName, windowName, cwd: dir },
                env,
            );

            expect(result.success).toBe(true);

            await waitForFile(outFile, 2_000);
            const payload = readDumpPayload(outFile);

            expect(payload.env?.FOO).toBe(env.FOO);
            expect(payload.env?.BAR).toBe(env.BAR);
        } finally {
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('spawnInTmux removes explicitly unset variables inherited by the tmux server', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const inheritedKey = 'HAPPIER_TMUX_UNSET_CANARY';
        const utils = new TmuxUtilities('happy', { [inheritedKey]: 'server-value' }, socketPath);

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');
            const result = await utils.spawnInTmux(
                [process.execPath, scriptPath, outFile, '5000', 'unset-check'],
                {
                    sessionName: `happy-it-${process.pid}-${Date.now()}`,
                    windowName: 'unset-env',
                    cwd: dir,
                    unsetEnvKeys: [inheritedKey],
                },
                {},
            );

            expect(result.success).toBe(true);
            if (!result.success) throw new Error(result.error ?? 'expected tmux launch to succeed');
            await waitForFile(outFile, 2_000);
            const payload = readDumpPayload(outFile);
            expect(payload.env?.[inheritedKey]).toBeUndefined();
        } finally {
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('spawnInTmux quotes command tokens safely (regression: PR107 args.join(\" \") injection/splitting)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');
            const sentinelFile = join(dir, 'injection-sentinel');

            const sessionName = `happy-it-${process.pid}-${Date.now()}`;
            const windowName = 'quote';

            const argWithSpaces = 'a b';
            const argWithSingleQuote = "c'd";
            const injectionArg = `$(touch ${sentinelFile})`;

            const result = await utils.spawnInTmux(
                [process.execPath, scriptPath, outFile, '5000', argWithSpaces, argWithSingleQuote, injectionArg],
                { sessionName, windowName, cwd: dir },
                {},
            );

            expect(result.success).toBe(true);

            await waitForFile(outFile, 2_000);
            const payload = readDumpPayload(outFile);
            expect(payload.argv).toEqual([argWithSpaces, argWithSingleQuote, injectionArg]);

            // If quoting were broken, the shell would execute `touch <sentinel>` and create the file.
            expect(existsSync(sentinelFile)).toBe(false);
        } finally {
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does not execute the target when the real window readiness helper fails', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const helperDir = join(dir, 'helper-bin');
        const helperPath = join(helperDir, 'tmux');
        const targetMarker = join(dir, 'target-executed');
        const sessionName = `happy-it-${process.pid}-${Date.now()}`;
        const originalTimeout = process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS;

        try {
            mkdirSync(helperDir, { recursive: true });
            writeFileSync(helperPath, [
                '#!/bin/sh',
                'if [ -n "$TMUX" ]; then exit 23; fi',
                `exec ${shellSingleQuote(resolveRealTmuxPath())} "$@"`,
                '',
            ].join('\n'), { encoding: 'utf8', mode: 0o700 });
            const utils = new TmuxUtilities('happy', {
                PATH: `${helperDir}:${process.env.PATH ?? ''}`,
            }, socketPath);
            process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS = '300';

            const result = await utils.spawnInTmux(
                ['/bin/sh', '-c', `printf executed > ${shellSingleQuote(targetMarker)}`],
                { sessionName, windowName: 'failed-ready', cwd: dir },
                {},
            );

            expect(result).toMatchObject({
                success: false,
                creationDisposition: 'created_and_absent',
            });
            expect(existsSync(targetMarker)).toBe(false);
        } finally {
            if (originalTimeout === undefined) delete process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS;
            else process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS = originalTimeout;
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('recovers the exact live pane when delayed readiness outlives the tmux client', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const helperDir = join(dir, 'helper-bin');
        const helperPath = join(helperDir, 'tmux');
        const targetMarker = join(dir, 'target-executed');
        const sessionName = `happy-it-${process.pid}-${Date.now()}`;
        const windowName = `delayed-ready-${process.pid}-${Date.now()}`;
        const originalTimeout = process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS;

        try {
            mkdirSync(helperDir, { recursive: true });
            writeFileSync(helperPath, [
                '#!/bin/sh',
                'if [ -n "$TMUX" ]; then sleep 0.5; fi',
                `exec ${shellSingleQuote(resolveRealTmuxPath())} "$@"`,
                '',
            ].join('\n'), { encoding: 'utf8', mode: 0o700 });
            const utils = new TmuxUtilities('happy', {
                PATH: `${helperDir}:${process.env.PATH ?? ''}`,
            }, socketPath);
            process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS = '150';

            const result = await utils.spawnInTmux(
                ['/bin/sh', '-c', `printf executed > ${shellSingleQuote(targetMarker)}; sleep 2`],
                { sessionName, windowName, windowNameIsUnique: true, cwd: dir },
                {},
            );

            expect(result).toMatchObject({
                success: true,
                sessionId: `${sessionName}:${windowName}`,
            });
            if (!result.success) throw new Error(result.error ?? 'expected recovered tmux launch');
            await waitForFile(targetMarker, 2_000);
            const panes = runTmux(['-S', socketPath, 'list-panes', '-t', `${sessionName}:${windowName}`, '-F', '#{pane_pid}']);
            expect(panes.status).toBe(0);
            expect(panes.stdout.trim()).toBe(String(result.pid));
        } finally {
            if (originalTimeout === undefined) delete process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS;
            else process.env.HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS = originalTimeout;
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('unsets owned inherited keys before the real window readiness helper runs', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const helperDir = join(dir, 'helper-bin');
        const helperPath = join(helperDir, 'tmux');
        const readinessObservation = join(dir, 'readiness-observation');
        const targetObservation = join(dir, 'target-observation');
        const inheritedKey = 'HAPPIER_TMUX_READY_UNSET_CANARY';
        const sessionName = `happy-it-${process.pid}-${Date.now()}`;

        try {
            mkdirSync(helperDir, { recursive: true });
            writeFileSync(helperPath, [
                '#!/bin/sh',
                'if [ -n "$TMUX" ]; then',
                `  if [ "\${${inheritedKey}+x}" = x ]; then`,
                '    printf inherited > "$HAPPIER_TMUX_READY_OBSERVATION"',
                '  else',
                '    printf unset > "$HAPPIER_TMUX_READY_OBSERVATION"',
                '  fi',
                'fi',
                `exec ${shellSingleQuote(resolveRealTmuxPath())} "$@"`,
                '',
            ].join('\n'), { encoding: 'utf8', mode: 0o700 });
            const utils = new TmuxUtilities('happy', {
                PATH: `${helperDir}:${process.env.PATH ?? ''}`,
                [inheritedKey]: 'ambient-native-secret',
                HAPPIER_TMUX_READY_OBSERVATION: readinessObservation,
            }, socketPath);

            const result = await utils.spawnInTmux(
                [
                    '/bin/sh',
                    '-c',
                    `printf "%s" "\${${inheritedKey}-unset}" > "$TARGET_OBSERVATION"`,
                ],
                {
                    sessionName,
                    windowName: 'pre-ready-unset',
                    cwd: dir,
                    unsetEnvKeys: [inheritedKey],
                },
                { TARGET_OBSERVATION: targetObservation },
            );

            expect(result.success).toBe(true);
            await waitForFile(readinessObservation, 2_000);
            await waitForFile(targetObservation, 2_000);
            expect(readFileSync(readinessObservation, 'utf8')).toBe('unset');
            expect(readFileSync(targetObservation, 'utf8')).toBe('unset');
        } finally {
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('TMUX_TMPDIR affects which tmux server commands talk to (regression: PR107 wrong-server assumptions)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-it-'));
        // IMPORTANT: keep the socket path short to avoid unix domain socket length limits (common on macOS).
        // tmux will create tmux-<uid>/default within this directory.
        const tmuxTmpDir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-tmpdir-it-'));

        const utils = new TmuxUtilities('happy', { TMUX_TMPDIR: tmuxTmpDir });

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');

            const sessionName = `happy-it-${process.pid}-${Date.now()}`;
            const windowName = 'tmpdir';

            const result = await withCleanTmuxClientEnv(() =>
                utils.spawnInTmux(
                    [process.execPath, scriptPath, outFile, '5000', 'tmpdir-check'],
                    { sessionName, windowName, cwd: dir },
                    {},
                ),
            );

            if (!result.success) {
                throw new Error(`spawnInTmux failed: ${result.error ?? 'unknown error'}`);
            }

            // Without TMUX_TMPDIR, a fresh tmux client should not see the isolated session.
            const defaultList = runTmux(['list-sessions']);
            expect(defaultList.stdout.includes(sessionName)).toBe(false);

            // With TMUX_TMPDIR, tmux should see our isolated session.
            const isolatedList = runTmux(['list-sessions'], { env: { TMUX_TMPDIR: tmuxTmpDir } });
            expect(isolatedList.status).toBe(0);
            expect(isolatedList.stdout.includes(sessionName)).toBe(true);

            await waitForFile(outFile, 2_000);
            const payload = readDumpPayload(outFile);
            expect(payload.argv).toEqual(['tmpdir-check']);
        } finally {
            // Kill only the isolated server identified by TMUX_TMPDIR.
            const result = runTmux(['kill-server'], { env: { TMUX_TMPDIR: tmuxTmpDir } });
            if (result.status !== 0 && process.env.DEBUG) {
                console.error('[tmux-it] Failed to kill isolated tmux server via TMUX_TMPDIR', {
                    tmuxTmpDir,
                    status: result.status,
                    stderr: result.stderr,
                    error: result.error?.message,
                });
            }
            rmSync(tmuxTmpDir, { recursive: true, force: true });
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
