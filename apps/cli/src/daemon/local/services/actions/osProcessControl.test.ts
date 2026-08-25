import { describe, expect, it, vi } from 'vitest';

import { createOsProcessControl } from './osProcessControl';
import type { NormalizedLocalServiceInventoryEntry, NormalizedLocalServiceInventorySnapshot } from '../inventory/scanner';

function entry(
    overrides: Partial<NormalizedLocalServiceInventoryEntry> = {},
): NormalizedLocalServiceInventoryEntry {
    return {
        id: 'entry-a',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5_173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 1_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        provenance: {
            process: {
                pid: 4_321,
                ppid: 300,
                processStartTimeMs: 1_717_171_717_000,
                lineagePids: [4_321, 300],
                command: 'npm run dev',
                cwd: '/repo',
                redacted: true,
            },
        },
        ...overrides,
    };
}

function snapshot(
    overrides: Partial<NormalizedLocalServiceInventorySnapshot> = {},
): NormalizedLocalServiceInventorySnapshot {
    return {
        v: 1,
        machineId: 'machine-a',
        generatedAt: 5_000,
        refreshState: 'idle',
        entries: [entry()],
        diagnostics: [],
        ...overrides,
    };
}

function errnoError(code: string): NodeJS.ErrnoException {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

describe('createOsProcessControl.probeListener', () => {
    it('resolves the live listener identity from the shared inventory refresh', async () => {
        const refreshInventory = vi.fn(async () => snapshot());
        const control = createOsProcessControl({ platform: 'darwin', refreshInventory });

        await expect(control.probeListener({ host: '127.0.0.1', port: 5_173 })).resolves.toEqual({
            status: 'held',
            identity: {
                pid: 4_321,
                startTime: 1_717_171_717_000,
                command: 'npm run dev',
                cwd: '/repo',
            },
        });
        expect(refreshInventory).toHaveBeenCalledTimes(1);
    });

    it('reports a failed listener scan as indeterminate, never as a released port', async () => {
        // A non-authoritative refresh retains the previous entries verbatim, still `listening`.
        const control = createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot({ refreshState: 'error' }),
        });

        await expect(control.probeListener({ host: '127.0.0.1', port: 5_173 })).resolves.toEqual({
            status: 'indeterminate',
        });
    });

    it('reports an unattributed listener as indeterminate rather than free', async () => {
        const control = createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot({ entries: [entry({ provenance: {} })] }),
        });

        await expect(control.probeListener({ host: '127.0.0.1', port: 5_173 })).resolves.toEqual({
            status: 'indeterminate',
        });
    });

    it('reports an authoritative empty scan as free', async () => {
        const control = createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot({ entries: [] }),
        });

        await expect(control.probeListener({ host: '127.0.0.1', port: 5_173 })).resolves.toEqual({
            status: 'free',
        });
    });

    it('re-reads once when the coalesced refresh pre-dates the request, then gives up', async () => {
        const refreshInventory = vi.fn(async () => snapshot({ generatedAt: 4_000 }));
        const control = createOsProcessControl({ platform: 'darwin', refreshInventory });

        await expect(
            control.probeListener({ host: '127.0.0.1', port: 5_173, notBefore: 4_500 }),
        ).resolves.toEqual({ status: 'indeterminate' });
        expect(refreshInventory).toHaveBeenCalledTimes(2);
    });

    it('accepts the second read when it is fresh enough', async () => {
        const generatedAt = [4_000, 5_000];
        let index = 0;
        const control = createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot({ generatedAt: generatedAt[index++] ?? 5_000 }),
        });

        await expect(
            control.probeListener({ host: '127.0.0.1', port: 5_173, notBefore: 4_500 }),
        ).resolves.toMatchObject({ status: 'held' });
    });
});

describe('createOsProcessControl.signal', () => {
    function control(kill: (pid: number, signal: NodeJS.Signals | 0) => void) {
        return createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot(),
            kill,
        });
    }

    it('signals the listener pid and every descendant individually, never a process group', async () => {
        const kill = vi.fn();

        await expect(control(kill).signal({
            pid: 4_321,
            signal: 'SIGTERM',
            descendantPids: [4_322, 4_323],
        })).resolves.toEqual({ status: 'delivered', deliveredPids: [4_321, 4_322, 4_323] });

        expect(kill.mock.calls).toEqual([
            [4_321, 'SIGTERM'],
            [4_322, 'SIGTERM'],
            [4_323, 'SIGTERM'],
        ]);
        expect(kill.mock.calls.some(([pid]) => (pid as number) < 0)).toBe(false);
    });

    it('treats ESRCH on ONE addressed pid as that process having already exited', async () => {
        // The listener raced us out; its descendants are still there and must still be killed.
        const kill = vi.fn((pid: number) => {
            if (pid === 4_321) throw errnoError('ESRCH');
        });

        await expect(control(kill).signal({
            pid: 4_321,
            signal: 'SIGTERM',
            descendantPids: [4_322],
        })).resolves.toEqual({ status: 'delivered', deliveredPids: [4_322] });
    });

    it('reports an all-ESRCH round as no_process_signaled instead of swallowing it as delivered', async () => {
        // This is the shape the previous `kill(-pid)` group addressing produced on every
        // run-wrapped dev server: nothing exists at the address, nothing is signalled.
        const kill = vi.fn(() => {
            throw errnoError('ESRCH');
        });

        await expect(control(kill).signal({
            pid: 4_321,
            signal: 'SIGTERM',
            descendantPids: [4_322],
        })).resolves.toEqual({ status: 'no_process_signaled' });
    });

    it('surfaces a refused signal on the listener pid as permission_denied', async () => {
        for (const code of ['EPERM', 'EACCES']) {
            const kill = vi.fn((pid: number) => {
                if (pid === 4_321) throw errnoError(code);
            });

            await expect(control(kill).signal({
                pid: 4_321,
                signal: 'SIGTERM',
                descendantPids: [],
            })).resolves.toEqual({ status: 'permission_denied' });
        }
    });

    it('surfaces any other signal errno as failed', async () => {
        const kill = vi.fn(() => {
            throw errnoError('EINVAL');
        });

        await expect(control(kill).signal({
            pid: 4_321,
            signal: 'SIGKILL',
            descendantPids: [],
        })).resolves.toEqual({ status: 'failed' });
    });

    it('never signals the daemon itself, pid 0, or pid 1 even if they appear as descendants', async () => {
        const kill = vi.fn();

        await control(kill).signal({
            pid: 4_321,
            signal: 'SIGTERM',
            descendantPids: [process.pid, 1, 0, -4_321, 4_322],
        });

        expect(kill.mock.calls).toEqual([[4_321, 'SIGTERM'], [4_322, 'SIGTERM']]);
    });
});

describe('createOsProcessControl.resolveDescendantPids', () => {
    it('walks the real process table transitively and excludes the daemon itself', async () => {
        const execFile = vi.fn(async () => ({
            stdout: [
                '  4321   300',
                '  4322  4321',
                '  4323  4322',
                `  ${process.pid}  4321`,
                '  9999     1',
                '',
            ].join('\n'),
        }));
        const control = createOsProcessControl({
            platform: 'linux',
            refreshInventory: async () => snapshot(),
            execFile,
        });

        await expect(control.resolveDescendantPids(4_321)).resolves.toEqual({
            status: 'resolved',
            pids: [4_322, 4_323],
        });
        expect(execFile).toHaveBeenCalledWith('ps', ['-A', '-o', 'pid=,ppid='], expect.objectContaining({
            timeout: 2_000,
        }));
    });

    it('reports the process table as unavailable rather than as an empty descendant set', async () => {
        // "No children" and "we could not look" must not collapse: the caller acts on the first
        // and has to refuse the second, or a failed lookup becomes a partial kill.
        const control = createOsProcessControl({
            platform: 'linux',
            refreshInventory: async () => snapshot(),
            execFile: async () => {
                throw new Error('ps missing');
            },
        });

        await expect(control.resolveDescendantPids(4_321)).resolves.toEqual({ status: 'unavailable' });
    });

    it('reports unavailable when the process-table query times out with partial stdout', async () => {
        // The observed failure: on a loaded machine the 2s `ps` timeout fires. execFile rejects
        // and carries whatever it had captured. Accepting that prefix would hand the caller a
        // silently short descendant list — the truncated table below omits the grandchild.
        const control = createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot(),
            execFile: async () => {
                const error = new Error('ps ETIMEDOUT') as NodeJS.ErrnoException & { stdout: string };
                error.code = 'ETIMEDOUT';
                error.stdout = '  4321   300\n  4322  4321\n';
                throw error;
            },
        });

        await expect(control.resolveDescendantPids(4_321)).resolves.toEqual({ status: 'unavailable' });
    });

    it('reports unavailable when `ps` exits cleanly but its output is unparseable', async () => {
        // A busybox `ps` ignores `-o` and prints its own columns. Every line fails the
        // `pid ppid` match, so the table reads as empty — which, allowed through as "resolved
        // with no descendants", is the timeout defect again behind a success exit code.
        const control = createOsProcessControl({
            platform: 'linux',
            refreshInventory: async () => snapshot(),
            execFile: async () => ({
                stdout: 'PID   USER     TIME  COMMAND\n    1 root      0:00 init\n 4321 root      0:00 node\n',
            }),
        });

        await expect(control.resolveDescendantPids(4_321)).resolves.toEqual({ status: 'unavailable' });
    });

    it('resolves nothing on Windows, where taskkill /T owns the subtree', async () => {
        const execFile = vi.fn(async () => ({ stdout: '' }));
        const control = createOsProcessControl({
            platform: 'win32',
            refreshInventory: async () => snapshot(),
            execFile,
        });

        await expect(control.resolveDescendantPids(4_321)).resolves.toEqual({ status: 'resolved', pids: [] });
        expect(execFile).not.toHaveBeenCalled();
    });
});

describe('createOsProcessControl.isProcessAlive', () => {
    it('counts a process we may not signal as alive on both POSIX and Windows errnos', async () => {
        for (const code of ['EPERM', 'EACCES']) {
            const control = createOsProcessControl({
                platform: 'darwin',
                refreshInventory: async () => snapshot(),
                kill: () => {
                    throw errnoError(code);
                },
            });
            await expect(control.isProcessAlive(4_321)).resolves.toBe(true);
        }
    });

    it('counts ESRCH as gone', async () => {
        const control = createOsProcessControl({
            platform: 'darwin',
            refreshInventory: async () => snapshot(),
            kill: () => {
                throw errnoError('ESRCH');
            },
        });
        await expect(control.isProcessAlive(4_321)).resolves.toBe(false);
    });
});
