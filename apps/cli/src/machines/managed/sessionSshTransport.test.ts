import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
// SSH is the OS boundary. Keep real stream behavior beneath the spawn fixture.
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn }));
import { createManagedSshSessionTransport } from './sessionSshTransport';

beforeEach(() => spawn.mockReset());
function child() {
    return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
    });
}
function transport(lifetime = new AbortController().signal) {
    return createManagedSshSessionTransport({ carrier: { kind: 'ssh', address: '192.0.2.7', user: 'guest', port: 2222,
        credentialRef: { kind: 'shared_resource', resourceId: 'retained' } }, credentialPath: '/private/key',
        knownHostsPath: '/private/known_hosts', lifetime });
}

it('keeps Session command content in stdin and preserves the guest exit result', async () => {
    const process = child(); spawn.mockReturnValue(process);
    const sent: Buffer[] = []; process.stdin.on('data', bytes => sent.push(bytes));
    const pending = transport().io.exec({ command: 'exec sh -s', input: 'agent TOKEN=private-value', timeoutMs: null });
    process.stdout.end('guest-result'); process.stderr.end('guest-error'); process.emit('close', 7, null);
    await expect(pending).resolves.toEqual({ status: 7, stdout: 'guest-result', stderr: 'guest-error' });
    expect(Buffer.concat(sent).toString()).toBe('agent TOKEN=private-value');
    expect(JSON.stringify(spawn.mock.calls[0]?.[1])).not.toContain('private-value');
});

it('delivers binary files through the stream without the finite-command stdin ceiling', async () => {
    const process = child(); spawn.mockReturnValue(process);
    const sent: Buffer[] = []; process.stdin.on('data', bytes => sent.push(bytes));
    const bytes = Buffer.alloc(128 * 1024, 255); bytes[0] = 0;
    const pending = transport().io.putFile({ path: "/home/guest/a'b", bytes });
    process.stdout.end(); process.stderr.end(); process.emit('close', 0, null);
    await pending;
    expect(Buffer.concat(sent)).toEqual(bytes);
    expect(spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['-T', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile=/private/known_hosts']));
});

it('ends an open holder carrier with the admitted Session lifetime', async () => {
    const process = child(); spawn.mockReturnValue(process);
    const lifetime = new AbortController();
    const channel = transport(lifetime.signal).openChannel(['/home/guest/holder', 'attach']);
    channel.resume(); lifetime.abort();
    await new Promise<void>(resolve => channel.once('close', resolve));
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
    process.emit('close', null, 'SIGTERM');
    await expect(channel.completion).resolves.toEqual({ status: null, signal: 'SIGTERM' });
});
