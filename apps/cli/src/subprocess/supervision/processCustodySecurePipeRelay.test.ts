import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    return { ...original, spawn: spawnMock };
});

vi.mock('./processCustody', () => ({
    resolveProcessCustodyPeerIdentityExecutable: () => 'C:\\happier-process-custody.exe',
}));

import {
    createProcessCustodySecurePipeRelayPreamble,
    startProcessCustodySecurePipeRelay,
} from './processCustodySecurePipeRelay';

afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
});

async function canConnectToLoopbackPort(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

describe('process-custody secure named-pipe relay contract', () => {
    it('authenticates the exact peer PID witness with the inherited launch secret', () => {
        const secret = Buffer.alloc(32, 0x31);
        const nonce = Buffer.alloc(16, 0x42);
        const preamble = createProcessCustodySecurePipeRelayPreamble(secret, 4242, nonce);

        expect(preamble.subarray(0, 8).toString('ascii')).toBe('HWSPIPE1');
        expect(preamble.readUInt32BE(8)).toBe(4242);
        expect(preamble.subarray(12, 28)).toEqual(nonce);
        expect(preamble.subarray(28)).toEqual(
            createHmac('sha256', secret).update(preamble.subarray(0, 28)).digest(),
        );
    });

    it('refuses malformed secrets, nonces, and PIDs before producing a witness', () => {
        expect(() => createProcessCustodySecurePipeRelayPreamble(Buffer.alloc(31), 1)).toThrow(TypeError);
        expect(() => createProcessCustodySecurePipeRelayPreamble(Buffer.alloc(32), 0)).toThrow(TypeError);
        expect(() => createProcessCustodySecurePipeRelayPreamble(Buffer.alloc(32), 1, Buffer.alloc(15))).toThrow(TypeError);
    });

    it('rejects and closes the loopback server when the helper exits during secret delivery', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        const child = new EventEmitter() as EventEmitter & {
            stdin: Writable;
            stdout: PassThrough;
            stderr: PassThrough;
            exitCode: number | null;
            signalCode: NodeJS.Signals | null;
            kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.signalCode = null;
        child.kill = vi.fn();
        child.stdin = new Writable({
            write(_chunk, _encoding, callback) {
                const error = Object.assign(new Error('broken helper stdin'), { code: 'EPIPE' });
                child.exitCode = 1;
                child.emit('close', 1, null);
                this.emit('error', error);
                callback();
            },
        });
        let targetPort: number | null = null;
        spawnMock.mockImplementation((_executablePath: string, args: readonly string[]) => {
            const portArgument = args.find((argument) => argument.startsWith('--target-port='));
            targetPort = portArgument ? Number(portArgument.slice('--target-port='.length)) : null;
            return child as unknown as ChildProcess;
        });

        await expect(startProcessCustodySecurePipeRelay({
            pipeName: '\\\\.\\pipe\\happier-workspace-sync-test',
            onConnection: () => undefined,
        })).rejects.toThrow('secure pipe relay secret delivery failed');

        expect(targetPort).not.toBeNull();
        await expect(canConnectToLoopbackPort(targetPort!)).resolves.toBe(false);
    });
    it('admits only the closed owner-only pipe prefixes before launching the helper', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        const launched: string[] = [];
        spawnMock.mockImplementation((_executablePath: string, args: readonly string[]) => {
            launched.push(args.find((argument) => argument.startsWith('--pipe-name=')) ?? '');
            throw Object.assign(new Error('helper launch observed'), { code: 'ENOENT' });
        });
        await expect(startProcessCustodySecurePipeRelay({
            pipeName: '\\\\.\\pipe\\happier-session-rpc-test', onConnection: () => undefined,
        })).rejects.toThrow();
        expect(launched).toEqual(['--pipe-name=\\\\.\\pipe\\happier-session-rpc-test']);
        await expect(startProcessCustodySecurePipeRelay({
            pipeName: '\\\\.\\pipe\\happier-session-target-test', onConnection: () => undefined,
        })).rejects.toThrow();
        expect(launched.at(-1)).toBe('--pipe-name=\\\\.\\pipe\\happier-session-target-test');
        await expect(startProcessCustodySecurePipeRelay({
            pipeName: '\\\\.\\pipe\\happier-other-test', onConnection: () => undefined,
        })).rejects.toThrow(TypeError);
        expect(launched).toHaveLength(2);
    });
});
