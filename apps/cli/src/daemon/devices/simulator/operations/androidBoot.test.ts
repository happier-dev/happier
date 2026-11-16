import { Buffer } from 'node:buffer';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type { SimulatorOperationRunner } from '../process';
import { bootAndroidSimulator } from './androidBoot';

describe('Android emulator boot identity', () => {
    it('adopts the native reported console port and waits for that exact adb transport without polling', async () => {
        const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
        const spawn = vi.fn((_command: string, args: readonly string[]) => {
            const report = args[args.indexOf('-report-console') + 1];
            const port = Number(report?.split(':')[1]);
            const socket = connect(port, '127.0.0.1', () => socket.end('5682'));
            return child;
        });
        const run = vi.fn<SimulatorOperationRunner>(async () => ({ exitCode: 0, stdout: Buffer.from('Phone_AVD\nOK\n'), stderr: '' }));
        const serial = await bootAndroidSimulator({ emulator: '/sdk/emulator', adb: '/sdk/adb', avdName: 'Phone_AVD', run, spawn });
        expect(serial).toBe('emulator-5682');
        expect(run.mock.calls.map(([input]) => input.args)).toEqual([
            ['-s', 'emulator-5682', 'wait-for-device'],
            ['-s', 'emulator-5682', 'emu', 'avd', 'name'],
        ]);
        expect(child.kill).not.toHaveBeenCalled();
        expect(child.unref).toHaveBeenCalled();
    });

    it('cleans up only its child on cancellation and preserves native launch errors', async () => {
        const controller = new AbortController();
        const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
        const run = vi.fn<SimulatorOperationRunner>(async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: '' }));
        const promise = bootAndroidSimulator({ emulator: 'emulator', adb: 'adb', avdName: 'Phone', run, signal: controller.signal, spawn: () => {
            queueMicrotask(() => controller.abort());
            return child;
        } });
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        const missing = bootAndroidSimulator({ emulator: 'missing', adb: 'adb', avdName: 'Phone', run, spawn: () => {
            queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
            return child;
        } });
        await expect(missing).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
