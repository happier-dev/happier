import { tmpdir } from 'node:os';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';
import type { RpcHandlerContext } from '@/api/rpc/types';

import { registerBashHandler } from './bash';

function createRegistrar() {
    const handlers = new Map<string, (payload: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method: string, handler: (payload: unknown, context?: RpcHandlerContext) => Promise<unknown>) {
                handlers.set(method, handler);
            },
        },
    };
}

/** A marker with no shell metacharacters, so `sh -c` parses the probe commands verbatim. */
const SHELL_MARKER = 'FOREGROUND-5199';

/**
 * Settle-or-give-up, so a handler that never answers fails with a readable assertion rather than
 * a bare vitest timeout (which under this machine's load is not a distinguishable signal).
 */
async function settleWithin<T>(
    pending: Promise<T>,
    capMs: number,
): Promise<{ kind: 'settled'; value: T } | { kind: 'still-waiting' }> {
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<{ kind: 'still-waiting' }>((resolve) => {
        capTimer = setTimeout(() => resolve({ kind: 'still-waiting' }), capMs);
    });
    try {
        return await Promise.race([
            pending.then((value) => ({ kind: 'settled' as const, value })),
            cap,
        ]);
    } finally {
        if (capTimer) clearTimeout(capTimer);
    }
}

describe('registerBashHandler', () => {
    it('passes env values verbatim into argv execution while retaining the machine environment', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        const value = 'quoted "value"; $(printf injected) & <literal>\nnext line';
        await expect(handlers.get(RPC_METHODS.BASH)!({
            argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ value: process.env.HB_COMMAND_VALUE, path: process.env.PATH }))'],
            env: { HB_COMMAND_VALUE: value },
        })).resolves.toMatchObject({
            success: true,
            stdout: JSON.stringify({ value, path: process.env.PATH }),
        });
    });

    it.skipIf(process.platform === 'win32')('runs fixed shell text in the selected workspace and retains env values and failed output', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        const workspace = await realpath(tmpdir());
        const value = '$(printf injected); "quoted" & <literal>\nnext line';
        await expect(handlers.get(RPC_METHODS.BASH)!({
            command: 'printf "%s" "$HB_COMMAND_VALUE"; printf "%s" "$PWD" >&2; exit 7',
            env: { HB_COMMAND_VALUE: value },
            cwd: workspace,
            timeout: 0,
        })).resolves.toMatchObject({ success: false, stdout: value, stderr: workspace, exitCode: 7 });
    });

    it.each(['argv', 'shell'] as const)('cancels running %s work through the RPC signal and retains partial output', async (mode) => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        const directory = await mkdtemp(join(tmpdir(), 'happier-bash-cancel-'));
        const marker = join(directory, 'started');
        const controller = new AbortController();
        try {
            const script = "process.stdout.write('partial'); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(() => {}, 2000)";
            const pending = handlers.get(RPC_METHODS.BASH)!({
                ...(mode === 'argv'
                    ? { argv: [process.execPath, '-e', script, marker] }
                    : { command: `"${process.execPath}" -e "${script}" "${marker}"` }),
                timeout: 0,
            }, { signal: controller.signal });
            await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('ready'));
            controller.abort();
            await expect(pending).resolves.toMatchObject({ success: false, stdout: 'partial', error: 'Command cancelled' });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('lets explicit zero delegate the command lifetime to the caller', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        const directory = await mkdtemp(join(tmpdir(), 'happier-bash-lifetime-'));
        const marker = join(directory, 'started');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const pending = handlers.get(RPC_METHODS.BASH)!({
                argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "ready"); setTimeout(() => process.stdout.write("finished"), 500)', marker],
                timeout: 0,
            });
            await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('ready'));
            await vi.advanceTimersByTimeAsync(30_001);
            await expect(pending).resolves.toMatchObject({ success: true, stdout: 'finished', exitCode: 0 });
        } finally {
            vi.useRealTimers();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('preserves shell output beyond the buffered-execution default', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        const output = 'x'.repeat(1_200_000);
        const result = await handlers.get(RPC_METHODS.BASH)!({
            command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(${output.length}))"`,
            timeout: 0,
        }) as { success: boolean; stdout: string; stderr: string; exitCode: number };
        expect(result.success).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.length).toBe(output.length);
        expect(result.stderr).toBe('');
    });

    it.skipIf(process.platform === 'win32')('honors an explicit filesystem-root workspace while retaining the detection sentinel', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, await realpath(tmpdir()));
        const argv = [process.execPath, '-e', 'process.stdout.write(process.cwd())'];
        await expect(handlers.get(RPC_METHODS.BASH)!({ argv, cwd: '/', cwdMode: 'explicit' }))
            .resolves.toMatchObject({ success: true, stdout: '/' });
        await expect(handlers.get(RPC_METHODS.BASH)!({ argv, cwd: '/' }))
            .resolves.toMatchObject({ success: true, stdout: await realpath(process.cwd()) });
    });

    it('runs argv payloads without going through the default shell', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        const handler = handlers.get(RPC_METHODS.BASH);
        expect(handler).toBeDefined();

        const argument = 'C:/repo/feature branch; $(shell-input)';
        await expect(handler!({
            argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', argument],
            cwd: process.cwd(),
        })).resolves.toEqual({
            success: true,
            stdout: argument,
            stderr: '',
            exitCode: 0,
        });
    });

    it('allows cwd outside the default directory under the os-user filesystem policy', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, '/work/default', { accessPolicy: { kind: 'osUser' } });
        const handler = handlers.get(RPC_METHODS.BASH);
        expect(handler).toBeDefined();

        const outsideDirectory = await realpath(tmpdir());
        await expect(handler!({ argv: [process.execPath, '-e', 'process.stdout.write(process.cwd())'], cwd: outsideDirectory })).resolves.toMatchObject({
            success: true,
            stdout: outsideDirectory,
        });
    });
    // A shell RPC whose caller backgrounds a process is normal, expected use — and `sh` forks for
    // anything that is not a single exec-replaceable command, so the survivor holding the stdout
    // pipe is the common shape, not an exotic one. The handler owes the caller the FOREGROUND
    // command's output and status; it does not owe them a wait on a pipe a `sleep` inherited.
    it.skipIf(process.platform === 'win32')(
        'answers as soon as the command exits, even when the command left a process holding its output pipe',
        async () => {
            const { handlers, registrar } = createRegistrar();
            registerBashHandler(registrar as never, process.cwd());
            const handler = handlers.get(RPC_METHODS.BASH)!;

            const outcome = await settleWithin(
                handler({ command: `echo ${SHELL_MARKER}; sleep 20 & exit 0`, cwd: process.cwd() }),
                3_000,
            );

            expect(outcome.kind).toBe('settled');
            expect((outcome as { value: { success: boolean; stdout: string } }).value).toMatchObject({
                success: true,
                exitCode: 0,
            });
            // Never an empty "success": the command ran and this is what it printed.
            expect((outcome as { value: { stdout: string } }).value.stdout).toContain(SHELL_MARKER);
        },
    );

    it.skipIf(process.platform === 'win32')(
        'reports a genuinely hung command as timed out instead of waiting on the pipe its survivor holds',
        async () => {
            const { handlers, registrar } = createRegistrar();
            registerBashHandler(registrar as never, process.cwd());
            const handler = handlers.get(RPC_METHODS.BASH)!;

            const outcome = await settleWithin(
                handler({ command: `echo ${SHELL_MARKER}; sleep 20 & sleep 20`, cwd: process.cwd(), timeout: 500 }),
                3_000,
            );

            expect(outcome.kind).toBe('settled');
            expect((outcome as { value: { success: boolean; error?: string } }).value).toMatchObject({
                success: false,
                error: 'Command timed out',
            });
            // The timeout keeps what the command had already printed rather than reporting nothing.
            expect((outcome as { value: { stdout: string } }).value.stdout).toContain(SHELL_MARKER);
        },
    );

    it.skipIf(process.platform === 'win32')(
        'answers an argv payload when the command exits, not when a process it left running releases the pipe',
        async () => {
            const { handlers, registrar } = createRegistrar();
            registerBashHandler(registrar as never, process.cwd());
            const handler = handlers.get(RPC_METHODS.BASH)!;

            const outcome = await settleWithin(
                handler({
                    argv: ['sh', '-c', `echo ${SHELL_MARKER}; sleep 20 & exit 0`],
                    cwd: process.cwd(),
                    timeout: 1_000,
                }),
                3_000,
            );

            // Waiting on the survivor's pipe made this worse than slow: past its own budget the
            // argv path reported `success: false, error: 'Command timed out'` for a command that
            // exited 0 in ten milliseconds — a false FAILURE, the mirror of the false success.
            expect(outcome.kind).toBe('settled');
            expect((outcome as { value: { success: boolean } }).value).toMatchObject({
                success: true,
                exitCode: 0,
            });
            expect((outcome as { value: { stdout: string } }).value.stdout).toContain(SHELL_MARKER);
        },
    );

    it.skipIf(process.platform === 'win32')('preserves successful argv output when the host event loop stalls past its deadline', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        const pending = handlers.get(RPC_METHODS.BASH)!({ argv: ['/bin/echo', SHELL_MARKER], timeout: 200 });
        const until = Date.now() + 1_500;
        while (Date.now() < until) { /* Reproduce a stalled daemon timers phase. */ }
        await expect(pending).resolves.toMatchObject({ success: true, exitCode: 0, stdout: `${SHELL_MARKER}\n` });
    });

    it('preserves argv output larger than the buffered-execution default', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        const output = 'x'.repeat(1_200_000);
        await expect(handlers.get(RPC_METHODS.BASH)!({
            argv: [process.execPath, '-e', `process.stdout.write('x'.repeat(${output.length}))`],
        })).resolves.toEqual({ success: true, stdout: output, stderr: '', exitCode: 0 });
    });

    it.each(['', 'refused'])('preserves a completed argv failure and its partial output (stderr: %s)', async (stderr) => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        await expect(handlers.get(RPC_METHODS.BASH)!({
            argv: [process.execPath, '-e', `process.stdout.write('partial'); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 7;`],
        })).resolves.toEqual({ success: false, stdout: 'partial', stderr: stderr || 'Command failed', exitCode: 7, error: stderr || 'Command failed' });
    });

    it('retains the invalid executable response instead of treating it as a spawn failure', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        await expect(handlers.get(RPC_METHODS.BASH)!({ argv: [''] })).resolves.toMatchObject({ success: false, exitCode: 1 });
    });

    it('reports an executable that cannot be spawned as a failure', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        await expect(handlers.get(RPC_METHODS.BASH)!({ argv: ['happier-missing-executable-fixture'] })).resolves.toMatchObject({ success: false, stdout: '', exitCode: -1 });
    });

    it.skipIf(process.platform === 'win32')('reports argv deadline interruption even when the command traps SIGTERM and exits zero', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        await expect(handlers.get(RPC_METHODS.BASH)!({
            argv: ['/bin/sh', '-c', 'trap "exit 0" TERM; echo started; while :; do sleep 0.1; done'],
            timeout: 250,
        })).resolves.toEqual({ success: false, stdout: 'started\n', stderr: '', exitCode: 0, error: 'Command timed out' });
    });
});
