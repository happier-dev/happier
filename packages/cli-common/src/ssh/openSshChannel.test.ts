import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
// The SSH subprocess is the OS boundary; its byte pipes remain real streams.
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn }));
import { openOpenSshRemoteChannel } from './index.js';

beforeEach(() => spawn.mockReset());
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
}
const request = { target: 'guest@example.test', remoteCommand: ['holder', 'attach'],
  knownHostsPath: '/private/known_hosts', auth: { mode: 'keyFile', privateKeyPath: '/private/key' } } as const;

it('carries arbitrary bytes in both directions without a PTY and reports carrier termination only', async () => {
  const process = child(); spawn.mockReturnValue(process);
  const channel = openOpenSshRemoteChannel(request);
  const sent: Buffer[] = []; process.stdin.on('data', bytes => sent.push(bytes));
  const received: Buffer[] = []; channel.on('data', bytes => received.push(bytes));
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  channel.write(bytes);
  channel.end();
  process.stderr.write('carrier diagnostic must not enter the protocol');
  process.stdout.end(bytes);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(process.kill).not.toHaveBeenCalled();
  process.emit('close', 255, null);
  await expect(channel.completion).resolves.toEqual({ status: 255, signal: null });
  await new Promise<void>(resolve => channel.once('close', resolve));
  expect(Buffer.concat(sent)).toEqual(bytes);
  expect(Buffer.concat(received)).toEqual(bytes);
  expect(spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['-T', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile=/private/known_hosts', '-i', '/private/key']));
});

it('stops only its carrier on cancellation and settles after the observed process close', async () => {
  const process = child(); spawn.mockReturnValue(process);
  const controller = new AbortController();
  const channel = openOpenSshRemoteChannel({ ...request, signal: controller.signal });
  channel.resume(); controller.abort();
  await new Promise<void>(resolve => channel.once('close', resolve));
  expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  process.emit('close', null, 'SIGTERM');
  await expect(channel.completion).resolves.toEqual({ status: null, signal: 'SIGTERM' });
  expect(() => openOpenSshRemoteChannel({ ...request, signal: controller.signal })).toThrow();
  expect(spawn).toHaveBeenCalledTimes(1);
});
