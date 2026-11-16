import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createSimulatorOperationRunner, type SimulatorOperationSpawn } from '../process';

describe('simulator operation process boundary', () => {
    it('preserves binary screenshots and streams push input without a shell or inherited cutoff', async () => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
        });
        const spawn = vi.fn<SimulatorOperationSpawn>(() => child);
        const run = createSimulatorOperationRunner({ spawn });
        const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 0]);
        const promise = run({ command: 'xcrun', args: ['simctl', 'io', 'device', 'screenshot', '-'], stdin: 'payload' });
        child.stdout.end(png);
        child.emit('close', 0, null);
        expect(await promise).toEqual({ exitCode: 0, stdout: png, stderr: '' });
        expect(spawn).toHaveBeenCalledWith('xcrun', ['simctl', 'io', 'device', 'screenshot', '-'], expect.objectContaining({ shell: false }));
        expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty('timeout');
        expect(child.stdin.read()?.toString()).toBe('payload');
    });

    it('retains native exit and launch failure causes and cancels its own child', async () => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
        });
        const controller = new AbortController();
        const run = createSimulatorOperationRunner({ spawn: () => child });
        const promise = run({ command: 'adb', args: [], signal: controller.signal });
        controller.abort();
        child.stderr.end('native error');
        child.emit('close', 7, 'SIGTERM');
        expect(await promise).toMatchObject({ exitCode: 7, stderr: 'native error', aborted: true, signal: 'SIGTERM' });
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        const launch = run({ command: 'missing', args: [] });
        child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
        expect(await launch).toMatchObject({ exitCode: null, errorCode: 'ENOENT' });
    });
});
