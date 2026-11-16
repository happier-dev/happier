import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { startSimulatorLogs } from './logs';
import type { SimulatorOperationChild, SimulatorOperationSpawn } from './process';

function processBoundary() {
    const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true),
    }) satisfies SimulatorOperationChild;
    const calls: { command: string; args: readonly string[] }[] = [];
    const spawn: SimulatorOperationSpawn = (command, args) => { calls.push({ command, args }); return child; };
    return { child, spawn, calls };
}

describe('simulator log process owner', () => {
    it.each(['ios', 'android'] as const)('pushes %s device logs and stops only its own process', async platform => {
        const boundary = processBoundary();
        const messages: unknown[] = [];
        const failures: string[] = [];
        const session = startSimulatorLogs({ platform, deviceId: 'lane-device', simulatorId: 'lane-sim',
            command: platform === 'ios' ? 'xcrun' : 'adb', maxLineBytes: 1024, spawn: boundary.spawn,
            emit: message => messages.push(message), failed: reason => failures.push(reason), now: () => 123 });
        boundary.child.emit('spawn');
        boundary.child.stdout.write(Buffer.from('I/App: hé'));
        boundary.child.stdout.write(Buffer.from('llo\nE/App: failure\n'));
        expect(messages).toEqual([
            { v: 1, kind: 'logs', simulatorId: 'lane-sim', emittedAtMs: 123, level: 'info', message: 'I/App: héllo' },
            { v: 1, kind: 'logs', simulatorId: 'lane-sim', emittedAtMs: 123, level: 'error', message: 'E/App: failure' },
        ]);
        expect(boundary.calls).toHaveLength(1);
        expect(boundary.calls[0]?.args).toContain('lane-device');
        expect(boundary.calls[0]?.args).toContain(platform === 'ios' ? 'stream' : 'logcat');
        session.stop(); session.stop();
        boundary.child.stdout.write('I/App: after close\n');
        boundary.child.emit('close', 0);
        expect(boundary.child.kill).toHaveBeenCalledTimes(1);
        expect(messages).toHaveLength(2);
        expect(failures).toEqual([]);
    });

    it('bounds unterminated output by the containing stream budget and exposes process failure', () => {
        const boundary = processBoundary();
        const messages: { message: string }[] = [];
        const failures: string[] = [];
        startSimulatorLogs({ platform: 'android', deviceId: 'device', simulatorId: 'sim', command: 'adb',
            maxLineBytes: 16, spawn: boundary.spawn, emit: message => messages.push(message), failed: reason => failures.push(reason) });
        boundary.child.stdout.write('x'.repeat(128));
        boundary.child.stdout.write('\nI/App: next\n');
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.every(message => Buffer.byteLength(message.message) <= 16)).toBe(true);
        boundary.child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
        boundary.child.emit('close', 1);
        expect(failures).toEqual(['simulator_logs_process_ENOENT']);
    });
});
