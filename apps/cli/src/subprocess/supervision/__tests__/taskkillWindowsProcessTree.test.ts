import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { isPidAlive } from '@/testkit/process/spawn';

import { taskkillWindowsProcessTree } from '../taskkillWindowsProcessTree';

/**
 * `taskkill` failure classification (RU2 surfaces finalization, R1 finding F-1).
 *
 * This is the Windows half of the one destructive local-services action, so "already gone" and
 * "refused" must not collapse. They used to: the classifier tested `/not found|128/` against
 * **stderr as a substring**, and taskkill puts the pid in that same stderr — so any pid
 * containing `128` turned an access-denied refusal into a silent idempotent success. The exit
 * code carries the answer, it is a number, and it is locale-independent; stderr is none of those.
 *
 * The spawn boundary is injected in every case, so no real `taskkill` is ever invoked.
 */

function execFileError(input: Readonly<{ code: number | string; stderr: string }>): Error {
    return Object.assign(new Error('Command failed: taskkill'), {
        code: input.code,
        stderr: input.stderr,
    });
}

describe('taskkillWindowsProcessTree', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('stops a hung tool at the caller budget rather than leaving its process running', async () => {
        const abort = new AbortController();
        let toolPid: number | undefined;
        const execFile = async (_command: string, _args: readonly string[], options: Parameters<typeof execFileWithDeadline>[2] = {}) => {
            try {
                return await execFileWithDeadline(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], {
                    ...options, signal: abort.signal,
                });
            } catch (error) {
                if (error && typeof error === 'object' && 'stdout' in error) {
                    toolPid = Number.parseInt(String(error.stdout).trim(), 10);
                }
                throw error;
            }
        };
        const input = { pid: 4_321, force: false, timeoutMs: 500, execFile };
        const result = taskkillWindowsProcessTree(input).then(() => 'success', (error: unknown) => error);
        let observer: ReturnType<typeof setTimeout> | undefined;
        try {
            const outcome = await Promise.race([
                result,
                new Promise<'pending'>((resolve) => { observer = setTimeout(() => resolve('pending'), 2_000); }),
            ]);
            expect(outcome).toMatchObject({ killed: true });
            expect(toolPid).toBeGreaterThan(0);
            expect(isPidAlive(toolPid!)).toBe(false);
        } finally {
            if (observer) clearTimeout(observer);
            abort.abort();
            await result;
        }
    });

    it('resolves when taskkill terminates the tree', async () => {
        const execFile = vi.fn(async () => ({ stdout: 'SUCCESS', stderr: '' }));

        await expect(taskkillWindowsProcessTree({ pid: 4_321, force: false, timeoutMs: 1_000, execFile }))
            .resolves.toBeUndefined();
        expect(execFile).toHaveBeenCalledWith(expect.stringMatching(/taskkill(\.exe)?$/u), ['/PID', '4321', '/T'], expect.objectContaining({ timeout: 1_000 }));
    });

    it('adds /F only when forcing', async () => {
        const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));

        await taskkillWindowsProcessTree({ pid: 4_321, force: true, timeoutMs: 1_000, execFile });

        expect(execFile).toHaveBeenCalledWith(expect.stringMatching(/taskkill(\.exe)?$/u), ['/PID', '4321', '/T', '/F'], expect.objectContaining({ timeout: 1_000 }));
    });

    // Cancellation must terminate through the SAME executable the launch and inventory steps used.
    // A bare `taskkill` is whatever the daemon's inherited `PATH` resolves at kill time, which is
    // not necessarily the System32 tool the rest of the custody path talked to.
    it('terminates through the installed System32 taskkill rather than an ambient one', async () => {
        vi.stubEnv('SystemRoot', 'C:\\WINDOWS');
        const execFile = vi.fn(async () => ({ stdout: '', stderr: '' }));

        await taskkillWindowsProcessTree({ pid: 4_321, force: true, timeoutMs: 1_000, execFile });

        expect(execFile).toHaveBeenCalledWith(
            'C:\\WINDOWS\\System32\\taskkill.exe',
            ['/PID', '4321', '/T', '/F'],
            expect.objectContaining({ timeout: 1_000 }),
        );
    });

    it('treats exit code 128 as the process already having exited', async () => {
        const execFile = vi.fn(async () => {
            throw execFileError({
                code: 128,
                stderr: 'ERROR: The process "4321" not found.',
            });
        });

        await expect(taskkillWindowsProcessTree({ pid: 4_321, force: false, timeoutMs: 1_000, execFile }))
            .resolves.toBeUndefined();
    });

    it('does NOT swallow an access-denied refusal for a pid whose digits contain 128', async () => {
        // The F-1 regression, verbatim: stderr carries the pid, so a substring test for `128`
        // matched `PID 1284` and reported a refused kill as a success.
        const execFile = vi.fn(async () => {
            throw execFileError({
                code: 1,
                stderr: 'ERROR: The process with PID 1284 could not be terminated.\nReason: Access is denied.',
            });
        });

        await expect(taskkillWindowsProcessTree({ pid: 1_284, force: true, timeoutMs: 1_000, execFile }))
            .rejects.toThrow(/Command failed/u);
    });

    it('rethrows a spawn failure rather than reading it as an exited process', async () => {
        const execFile = vi.fn(async () => {
            throw execFileError({ code: 'ENOENT', stderr: '' });
        });

        await expect(taskkillWindowsProcessTree({ pid: 4_321, force: false, timeoutMs: 1_000, execFile }))
            .rejects.toThrow(/Command failed/u);
    });
});
