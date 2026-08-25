import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileWithDeadlineMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    return {
        ...actual,
        spawn: spawnMock,
    };
});

// The shell path runs through the deadline-owning subprocess boundary rather than
// `child_process.exec`, whose own `timeout` reports a killed command as a success with empty
// output. That boundary is the process-spawn seam this test replaces.
vi.mock('@happier-dev/cli-common/process', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/cli-common/process')>(
        '@happier-dev/cli-common/process',
    );
    return {
        ...actual,
        execFileWithDeadline: execFileWithDeadlineMock,
    };
});

import { registerBashHandler } from './bash';

function createRegistrar() {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method: string, handler: (payload: unknown) => Promise<unknown>) {
                handlers.set(method, handler);
            },
        },
    };
}

function createSpawnProcess() {
    const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    return child;
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

/** Run the handler against the real subprocess boundary instead of the spawn mocks. */
async function useRealSubprocessBoundary(): Promise<void> {
    const childProcess = await vi.importActual<typeof import('child_process')>('child_process');
    const cliCommonProcess = await vi.importActual<typeof import('@happier-dev/cli-common/process')>(
        '@happier-dev/cli-common/process',
    );
    spawnMock.mockImplementation(childProcess.spawn as never);
    execFileWithDeadlineMock.mockImplementation(cliCommonProcess.execFileWithDeadline as never);
}

describe('registerBashHandler', () => {
    beforeEach(() => {
        execFileWithDeadlineMock.mockReset();
        spawnMock.mockReset();
    });

    it('runs argv payloads without going through the default shell', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, process.cwd());
        const handler = handlers.get(RPC_METHODS.BASH);
        expect(handler).toBeDefined();

        const child = createSpawnProcess();
        spawnMock.mockReturnValueOnce(child);

        const resultPromise = handler!({
            argv: ['git', 'worktree', 'remove', '--force', '--', 'C:/repo/.dev/worktree/feature branch'],
            cwd: process.cwd(),
        });

        child.stdout.write('ok');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);

        await expect(resultPromise).resolves.toEqual({
            success: true,
            stdout: 'ok',
            stderr: '',
            exitCode: 0,
        });
        expect(spawnMock).toHaveBeenCalledWith(
            'git',
            ['worktree', 'remove', '--force', '--', 'C:/repo/.dev/worktree/feature branch'],
            expect.objectContaining({
                cwd: process.cwd(),
                windowsHide: true,
                shell: false,
            }),
        );
        // The argv path must not reach the shell boundary at all.
        expect(execFileWithDeadlineMock).not.toHaveBeenCalled();
    });

    it('allows cwd outside the default directory under the os-user filesystem policy', async () => {
        const { handlers, registrar } = createRegistrar();
        registerBashHandler(registrar as never, '/work/default', { accessPolicy: { kind: 'osUser' } });
        const handler = handlers.get(RPC_METHODS.BASH);
        expect(handler).toBeDefined();

        execFileWithDeadlineMock.mockResolvedValueOnce({ stdout: 'ok', stderr: '' });

        await expect(handler!({ command: 'pwd', cwd: '/outside/project' })).resolves.toMatchObject({
            success: true,
        });
        expect(execFileWithDeadlineMock).toHaveBeenCalledWith(
            'pwd',
            [],
            expect.objectContaining({ cwd: '/outside/project', shell: true }),
        );
    });
    // A shell RPC whose caller backgrounds a process is normal, expected use — and `sh` forks for
    // anything that is not a single exec-replaceable command, so the survivor holding the stdout
    // pipe is the common shape, not an exotic one. The handler owes the caller the FOREGROUND
    // command's output and status; it does not owe them a wait on a pipe a `sleep` inherited.
    it.skipIf(process.platform === 'win32')(
        'answers as soon as the command exits, even when the command left a process holding its output pipe',
        async () => {
            await useRealSubprocessBoundary();
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
            await useRealSubprocessBoundary();
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
            await useRealSubprocessBoundary();
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
});
