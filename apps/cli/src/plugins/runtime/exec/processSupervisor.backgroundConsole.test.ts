import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { spawnSupervisedPluginProcess } from './processSupervisor';

// Observe the OS boundary while retaining the real child and supervisor lifecycle.
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe('supervised plugin background commands', () => {
    it('captures a command without creating a Windows console', async () => {
        const source = 'process.stdout.write("completed")';
        const supervised = spawnSupervisedPluginProcess({
            command: process.execPath,
            args: ['-e', source],
            env: process.env,
        });
        try {
            const result = await supervised.handle.wait();
            expect(Buffer.from(result.stdout).toString()).toBe('completed');
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            const launch = vi.mocked(spawn).mock.calls.find(([command, args]) =>
                command === process.execPath && Array.isArray(args) && args.includes(source));
            expect(launch?.[2]?.windowsHide).toBe(true);
        } finally {
            await supervised.dispose();
        }
    });
});
