/**
 * Opt-in tmux integration tests.
 *
 * These tests start isolated tmux servers (via `-S` or `TMUX_TMPDIR`) and must
 * never interact with a user's existing tmux sessions.
 *
 * Enable with: `HAPPIER_CLI_TMUX_INTEGRATION=1`
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TmuxUtilities } from './TmuxUtilities';

function isTmuxInstalled(): boolean {
    const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
    return result.status === 0;
}

function shouldRunTmuxIntegration(): boolean {
    return process.env.HAPPIER_CLI_TMUX_INTEGRATION === '1' && isTmuxInstalled();
}

function mkShortTempDir(prefix: string): string {
    const root = existsSync('/tmp') ? '/tmp' : tmpdir();
    return mkdtempSync(join(root, prefix));
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
            '  },',
            '};',
            "const pendingOutFile = `${outFile}.${process.pid}.tmp`;",
            'fs.writeFileSync(pendingOutFile, JSON.stringify(payload));',
            'fs.renameSync(pendingOutFile, outFile);',
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

function isolatedTmuxEnvironment(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    // Never inherit the user's existing tmux context (TMUX/TMUX_PANE) or TMUX_TMPDIR.
    // These tests must only ever talk to isolated servers created by the test itself.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.TMUX_TMPDIR;

    return { ...env, ...overrides };
}

function runTmux(args: string[], options?: { env?: Record<string, string | undefined> }): TmuxRunResult {

    const result = spawnSync('tmux', args, {
        encoding: 'utf8',
        env: isolatedTmuxEnvironment(options?.env),
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

function removeIsolatedTmuxTempDir(dir: string): void {
    // tmux kill-server can return while its pane processes are still retiring.
    // Let Node retry the transient ENOTEMPTY/EBUSY cleanup race instead of
    // turning a successful integration scenario into a teardown failure.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

describe.skipIf(!shouldRunTmuxIntegration())('tmux (real) integration tests (opt-in)', { timeout: 20_000 }, () => {
    it('delivers once when provider staging and consumption outlast the terminal write budget', async () => {
        const dir = mkShortTempDir('hp-tmux-delivery-');
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);
        const { createTmuxTerminalHostAdapter } = await import('./adapter');
        const { createClaudePromptSubmitVerificationPolicy } = await import('@/backends/claude/unifiedTerminal/claudePromptSubmitVerification');
        const adapter = createTmuxTerminalHostAdapter({ tmux: utils, promptSubmitVerification: createClaudePromptSubmitVerificationPolicy() });
        const fixture = join(dir, 'slow-provider.cjs');
        const receipt = join(dir, 'receipt.json');
        const ready = join(dir, 'ready');
        // The external TUI boundary consumes real bracketed paste and Enter over an isolated
        // tmux PTY. Its delayed redraw reproduces the observed 20s staging / 10s consumption.
        writeFileSync(fixture, [
            "const fs = require('node:fs');",
            'process.stdin.setRawMode(true); process.stdin.resume();',
            'process.stdout.write("\\x1b[?2004h");',
            'let input = "", prompt = "", enters = 0;',
            'const draw = text => process.stdout.write("\\x1b[2J\\x1b[HClaude Code\\r\\n──────────\\r\\n❯ " + text + "\\r\\n──────────\\r\\n  ⏵⏵ bypass permissions on");',
            'draw(""); fs.writeFileSync(process.argv[3], "ready");',
            'process.stdin.on("data", bytes => {',
            '  input += bytes.toString();',
            '  const end = input.indexOf("\\x1b[201~");',
            '  if (end >= 0) {',
            '    prompt = input.slice(input.indexOf("\\x1b[200~") + 6, end); input = input.slice(end + 6);',
            '    setTimeout(() => draw(prompt), 20_000);',
            '  }',
            '  if (input.includes("\\r")) {',
            '    enters += input.split("\\r").length - 1; input = "";',
            '    setTimeout(() => { fs.writeFileSync(process.argv[2], JSON.stringify({prompt, enters})); draw(""); }, 10_000);',
            '  }',
            '});',
        ].join('\n'));
        const lifetime = new AbortController();
        try {
            const handle = await adapter.createOrAttachHost({
                sessionName: 'slow-provider', workingDirectory: dir,
                spawnArgv: [process.execPath, fixture, receipt, ready], spawnEnv: {}, isolatedEnv: true,
            });
            await waitForFile(ready, 5_000);
            const input = { text: 'loaded prompt', multiline: false,
                origin: { kind: 'ui_pending' as const, nonce: 'slow-delivery' },
                scheduling: { timeoutMs: 15_000 }, signal: lifetime.signal };
            const result = await adapter.injectUserPrompt(handle, input);
            expect(result).toMatchObject({ status: 'injected' });
            expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ prompt: input.text, enters: 1 });
        } finally {
            lifetime.abort();
            killIsolatedTmuxServer(socketPath);
            removeIsolatedTmuxTempDir(dir);
        }
    }, 60_000);

    it.each([
        [true, 'latest', false], [false, 'latest', false],
        [true, 'smallest', false], [false, 'smallest', true],
    ] as const)('uses configured detached geometry without borrowing another session client (exclusive=%s, policy=%s, local=%s)', async (requireNewSession, policy, localLatest) => {
        const dir = mkShortTempDir('hp-tmux-size-');
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);
        const prefix = ['-S', socketPath];
        const smallSession = 'small-client';
        let client: ReturnType<typeof spawn> | undefined;
        try {
            expect(runTmux([...prefix, 'new-session', '-d', '-s', smallSession]).status).toBe(0);
            expect(runTmux([...prefix, 'set-option', '-g', 'default-size', '110x32']).status).toBe(0);
            expect(runTmux([...prefix, 'set-option', '-gw', 'window-size', policy]).status).toBe(0);
            if (localLatest) {
                expect(runTmux([...prefix, 'set-hook', '-g', 'after-new-window', 'set-option -w window-size latest']).status).toBe(0);
            }
            expect(runTmux([...prefix, 'set-option', '-w', '-t', smallSession, 'window-size', 'latest']).status).toBe(0);
            client = spawn('tmux', [...prefix, '-C', 'attach-session', '-t', smallSession], {
                env: isolatedTmuxEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
            });
            let clientOutput = '';
            client.stdout?.on('data', chunk => { clientOutput += String(chunk); });
            client.stderr?.on('data', chunk => { clientOutput += String(chunk); });
            await waitForCondition(() => clientOutput.includes('%session-changed'), {
                timeoutMs: 5_000, label: 'isolated control client attachment', debug: () => clientOutput,
            });
            client.stdin?.write('refresh-client -C 52,10\n');
            const size = (target: string) => runTmux([...prefix, 'display-message', '-p', '-t', target, '#{window_width}x#{window_height}']).stdout.trim();
            await waitForCondition(() => size(smallSession) === '52x10', {
                timeoutMs: 5_000, label: 'small isolated client geometry', debug: () => clientOutput,
            });

            const result = await utils.spawnInTmux([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
                sessionName: 'detached-agent', requireNewSession,
            });
            expect(result.success).toBe(true);
            expect(size(result.windowId ?? 'detached-agent')).toBe('110x32');
            expect(runTmux([...prefix, 'show-options', '-wAv', '-t', result.windowId ?? 'detached-agent', 'window-size']).stdout.trim()).toBe(localLatest ? 'latest' : policy);
            expect(size(smallSession)).toBe('52x10');
            expect(runTmux([...prefix, 'show-options', '-w', '-t', result.windowId ?? 'detached-agent', 'window-size']).stdout.trim()).toBe(localLatest ? 'window-size latest' : '');
            // Shared creation also creates the session's initial placeholder through ensureSessionExists.
            if (!requireNewSession) {
                expect(runTmux([...prefix, 'list-windows', '-t', 'detached-agent', '-F', '#{window_width}x#{window_height}']).stdout.trim().split('\n')).toEqual(['110x32', '110x32']);
            }
            client.stdin?.write(`switch-client -t detached-agent\nselect-window -t ${result.windowId}\nrefresh-client -C 52,10\n`);
            await waitForCondition(() => size(result.windowId ?? 'detached-agent') === '52x10', {
                timeoutMs: 5_000, label: 'attached client resizing after detached creation', debug: () => clientOutput,
            });
            expect(runTmux([...prefix, 'show-options', '-w', '-t', result.windowId ?? 'detached-agent', 'window-size']).stdout.trim()).toBe(localLatest ? 'window-size latest' : '');
        } finally {
            client?.stdin?.end();
            client?.kill();
            killIsolatedTmuxServer(socketPath);
            removeIsolatedTmuxTempDir(dir);
        }
    });

    it('rejects recycled window ownership after the tmux server restarts', async () => {
        const dir = mkShortTempDir('hp-tmux-recycle-');
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);
        const { createTmuxTerminalHostAdapter } = await import('./adapter');
        const adapter = createTmuxTerminalHostAdapter({ tmux: utils });
        const options = {
            workingDirectory: dir,
            spawnArgv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
            spawnEnv: {},
            isolatedEnv: true,
        };
        try {
            const stale = await adapter.createOrAttachHost({ ...options, sessionName: 'retired-owner' });
            expect((await adapter.evaluateLiveness(stale)).paneAlive).toBe(true);
            killIsolatedTmuxServer(socketPath);
            await waitForCondition(() => runTmux(['-S', socketPath, 'has-session']).status !== 0, {
                timeoutMs: 2_000, label: 'isolated tmux server exit',
            });
            const foreign = await adapter.createOrAttachHost({ ...options, sessionName: 'other-owner' });
            expect(foreign.paneId).toBe(stale.paneId);

            expect(await adapter.evaluateLiveness(stale)).toMatchObject({ paneAlive: false, paneDead: true });
            await expect(adapter.adoptExistingHost!(stale)).rejects.toThrow();
            expect(await adapter.injectUserPrompt(stale, {
                text: 'must-not-reach-other-owner',
                multiline: false,
                origin: { kind: 'ui_pending', nonce: 'recycled-window' },
                scheduling: {},
            })).toMatchObject({ status: 'failed', reason: 'pane_dead' });
            await expect(adapter.interruptTurn(stale)).rejects.toThrow();
            const control = adapter.createControlPort!(stale);
            expect(control).not.toBeNull();
            expect(await control!.sendLiteralText('must-not-reach-other-owner')).toMatchObject({ status: 'host_dead' });
            expect(await control!.captureScreen()).toMatchObject({ status: 'host_dead' });
            for (const topology of ['exclusive', 'shared'] as const) {
                await expect(adapter.dispose({
                    ...stale, attachMetadata: { ...stale.attachMetadata, topology },
                })).rejects.toThrow();
                expect((await adapter.evaluateLiveness(foreign)).paneAlive).toBe(true);
            }
        } finally {
            killIsolatedTmuxServer(socketPath);
            removeIsolatedTmuxTempDir(dir);
        }
    });

    it('does not adopt an absent window using another live window in the same session', async () => {
        const dir = mkShortTempDir('hp-tmux-missing-');
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);
        const { createTmuxTerminalHostAdapter } = await import('./adapter');
        const adapter = createTmuxTerminalHostAdapter({ tmux: utils });
        try {
            const handle = await adapter.createOrAttachHost({
                sessionName: 'live-owner', workingDirectory: dir,
                spawnArgv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
                spawnEnv: {}, isolatedEnv: true,
            });
            const absent = { ...handle, paneId: 'missing.0' };
            expect(await adapter.evaluateLiveness(absent)).toMatchObject({ paneAlive: false, paneDead: true });
            await expect(adapter.adoptExistingHost!(absent)).rejects.toThrow();
            expect((await adapter.evaluateLiveness(handle)).paneAlive).toBe(true);
        } finally {
            killIsolatedTmuxServer(socketPath);
            removeIsolatedTmuxTempDir(dir);
        }
    });

    it('refuses stale foreground attach instead of linking another owners window', async () => {
        const dir = mkShortTempDir('hp-tmux-attach-');
        const socketPath = join(dir, 'tmux.sock');
        const { runTmuxAttach } = await import('@/terminal/attachment/tmuxAttach');
        try {
            expect(runTmux(['-S', socketPath, 'new-session', '-d', '-s', 'retired-owner-new', 'sleep 120']).status).toBe(0);
            const result = await runTmuxAttach({
                sessionId: 'stale-attachment',
                terminal: { mode: 'tmux', tmux: { target: 'retired-owner:@0' } },
            }, {
                isTmuxAvailableFn: async () => true,
                insideTmux: false,
                spawnTmuxFn: async ({ args, stdio }) => stdio === 'inherit' ? 0
                    : runTmux(['-S', socketPath, ...args]).status ?? 1,
            });
            expect(result).not.toBe(0);
            expect(runTmux(['-S', socketPath, 'has-session', '-t', '=retired-owner-new']).status).toBe(0);
        } finally {
            killIsolatedTmuxServer(socketPath);
            removeIsolatedTmuxTempDir(dir);
        }
    });

    it('owns only the optional client window in an existing selected tmux session', async () => {
        const dir = mkShortTempDir('hp-tmux-presenter-');
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);
        const { createTmuxTerminalHostAdapter } = await import('./adapter');
        const adapter = createTmuxTerminalHostAdapter({ tmux: utils });
        const sessionName = `presenter-${process.pid}`;
        try {
            const original = await utils.spawnInTmux([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
                sessionName, windowName: 'original', cwd: dir,
            }, {});
            expect(original.success).toBe(true);
            const before = await utils.executeTmuxCommand(['list-windows', '-t', sessionName, '-F', '#{window_id}']);
            const options = { sessionName, label: 'optional-client', topology: 'shared' as const,
                workingDirectory: dir, spawnArgv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
                spawnEnv: {}, isolatedEnv: true };
            const handle = await adapter.createOrAttachHost(options);
            expect(handle.attachMetadata.topology).toBe('shared');
            expect(handle.paneId).not.toBe(original.windowId);
            await adapter.dispose(handle);
            const windows = await utils.executeTmuxCommand(['list-windows', '-t', sessionName, '-F', '#{window_id}']);
            if (!windows || !before) throw new Error('Isolated tmux window listing failed');
            expect(windows.stdout.trim().split('\n')).toEqual(before.stdout.trim().split('\n'));
        } finally {
            killIsolatedTmuxServer(socketPath);
            removeIsolatedTmuxTempDir(dir);
        }
    });
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
            await Promise.all(Array.from({ length: 12 }, (_, i) =>
                waitForFile(join(dir, `out-w${i + 1}.json`), 10_000)));
        } finally {
            killIsolatedTmuxServer(socketPath);
            removeIsolatedTmuxTempDir(dir);
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
            expect(typeof result.pid).toBe('number');
            expect(result.pid).toBeGreaterThan(0);
            expect(result.windowId).toMatch(/^@\d+$/);

            // Ground truth: query tmux directly for the pane pid.
            const panes = runTmux(['-S', socketPath, 'list-panes', '-t', `${sessionName}:${windowName}`, '-F', '#{pane_pid}']);
            expect(panes.status).toBe(0);
            const listedPid = Number.parseInt(panes.stdout.trim(), 10);
            expect(listedPid).toBe(result.pid);
            const listedWindowId = runTmux(['-S', socketPath, 'display-message', '-p', '-t', `${sessionName}:${windowName}`, '#{window_id}']);
            expect(listedWindowId.status).toBe(0);
            expect(listedWindowId.stdout.trim()).toBe(result.windowId);

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
            removeIsolatedTmuxTempDir(dir);
        }
    });

    it('spawnInTmux parses -P/-F output when the client environment has no UTF-8 locale (regression: daemon launched over SSH)', async () => {
        // tmux flags a command client as non-UTF-8 unless TMUX is set or LC_ALL/LC_CTYPE/LANG
        // mention UTF-8, and then passes printed output through utf8_sanitize(), which turns
        // the TAB separator in `#{pane_pid}\t#{window_id}` into `_`. A daemon started over SSH
        // (no locale forwarded) reproduced this as `Failed to extract PID from tmux output: 5266_@9`.
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-nolocale-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', { LANG: '', LC_ALL: '', LC_CTYPE: '' }, socketPath);

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');
            const sessionName = `happy-it-nolocale-${process.pid}-${Date.now()}`;
            const windowName = 'pid';

            const result = await utils.spawnInTmux(
                [process.execPath, scriptPath, outFile, '5000', 'no-locale'],
                { sessionName, windowName, cwd: dir },
                {},
            );

            expect(result.error).toBeUndefined();
            expect(result.success).toBe(true);
            expect(result.pid).toBeGreaterThan(0);
            expect(result.windowId).toMatch(/^@\d+$/);

            const panes = runTmux(['-S', socketPath, 'list-panes', '-t', `${sessionName}:${windowName}`, '-F', '#{pane_pid}']);
            expect(panes.status).toBe(0);
            expect(Number.parseInt(panes.stdout.trim(), 10)).toBe(result.pid);
        } finally {
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('captureCursorPosition returns the live pane cursor for a window-id target (regression: display-message operand order)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-cursor-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);

        try {
            const scriptPath = writeDumpScript(dir);
            const outFile = join(dir, 'out.json');
            const sessionName = `happy-it-cursor-${process.pid}-${Date.now()}`;
            const result = await utils.spawnInTmux(
                [process.execPath, scriptPath, outFile, '5000', 'cursor'],
                { sessionName, windowName: 'cursor', cwd: dir },
                {},
            );
            expect(result.success).toBe(true);

            const cursor = await utils.captureCursorPosition(result.windowId!);
            expect(cursor).toEqual({ x: expect.any(Number), y: expect.any(Number) });
        } finally {
            killIsolatedTmuxServer(socketPath);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('creates and disposes an owned terminal host as one exact tmux session', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-owned-it-'));
        const socketPath = join(dir, 'tmux.sock');
        const utils = new TmuxUtilities('happy', undefined, socketPath);
        const { createTmuxTerminalHostAdapter } = await import('./adapter');
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
            removeIsolatedTmuxTempDir(dir);
        }
    });

    it('spawnInTmux passes -e KEY=VALUE env values literally (regression: PR107 quoting/escaping)', async () => {
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
            removeIsolatedTmuxTempDir(dir);
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
            removeIsolatedTmuxTempDir(dir);
        }
    });

    it('creates native hosts in the requested socket root rather than the ambient server', async () => {
        const ambientRoot = mkShortTempDir('hp-ambient-');
        const dir = mkShortTempDir('hp-selected-');
        const selectedRoot = join(dir, 'socket-root');
        const sessionName = 'isolated-probe';
        const { createTmuxTerminalHostAdapter } = await import('./adapter');
        const adapter = createTmuxTerminalHostAdapter();
        try {
            await withCleanTmuxClientEnv(async () => {
                process.env.TMUX_TMPDIR = ambientRoot;
                expect(runTmux(['new-session', '-d', '-s', 'ambient-sentinel'], {
                    env: { TMUX_TMPDIR: ambientRoot },
                }).status).toBe(0);
                const ambientIdentity = runTmux(['display-message', '-p', '#{socket_path},#{pid},0'], {
                    env: { TMUX_TMPDIR: ambientRoot },
                });
                expect(ambientIdentity.status).toBe(0);
                process.env.TMUX = ambientIdentity.stdout.trim();
                process.env.TMUX_PANE = '%0';
                const outFile = join(dir, 'native.json');
                const handle = await adapter.createOrAttachHost({
                    sessionName, label: 'native-client', workingDirectory: dir,
                    spawnArgv: [process.execPath, writeDumpScript(dir), outFile, '60000', 'native-client'],
                    spawnEnv: { TMUX_TMPDIR: selectedRoot }, isolatedEnv: true, topology: 'shared',
                });
                expect(handle.socketDir).toBe(selectedRoot);
                await waitForFile(outFile, 2_000);
                expect(readDumpPayload(outFile).argv).toEqual(['native-client']);
                expect(runTmux(['has-session', '-t', `=${sessionName}`], {
                    env: { TMUX_TMPDIR: selectedRoot },
                }).status).toBe(0);
                expect(runTmux(['has-session', '-t', `=${sessionName}`], {
                    env: { TMUX_TMPDIR: ambientRoot },
                }).status).not.toBe(0);
                expect(await adapter.evaluateLiveness(handle)).toMatchObject({ paneAlive: true });
                await adapter.dispose(handle);
                const remainingWindows = runTmux(['list-windows', '-t', `=${sessionName}`, '-F', '#{window_id}'], {
                    env: { TMUX_TMPDIR: selectedRoot },
                });
                expect(remainingWindows.status).toBe(0);
                expect(handle.paneId).toMatch(/^@\d+$/);
                expect(remainingWindows.stdout.trim().split(/\r?\n/)).not.toContain(handle.paneId);
                expect(runTmux(['has-session', '-t', '=ambient-sentinel'], {
                    env: { TMUX_TMPDIR: ambientRoot },
                }).status).toBe(0);
            });
        } finally {
            for (const root of [selectedRoot, ambientRoot]) {
                runTmux(['kill-server'], { env: { TMUX_TMPDIR: root } });
            }
            removeIsolatedTmuxTempDir(ambientRoot);
            removeIsolatedTmuxTempDir(dir);
        }
    });

    it('TMUX_TMPDIR affects which tmux server commands talk to (regression: PR107 wrong-server assumptions)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-cli-tmux-it-'));
        // IMPORTANT: keep the socket path short to avoid unix domain socket length limits (common on macOS).
        // tmux will create tmux-<uid>/default within this directory.
        const tmuxTmpDir = mkShortTempDir('happier-tmux-');

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
            removeIsolatedTmuxTempDir(tmuxTmpDir);
            removeIsolatedTmuxTempDir(dir);
        }
    });
});
