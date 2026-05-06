import { describe, expect, it, vi } from 'vitest';

import * as sshExports from './index.js';
import type {
  OpenSshLocalPortForwardDeps,
  OpenSshLocalPortForwardHandle,
  OpenSshLocalPortForwardRequest,
} from './openSshLocalPortForward.js';

type TestLocalPortForwardDeps = Readonly<{
  spawnSync: NonNullable<OpenSshLocalPortForwardDeps['spawnSync']> & ReturnType<typeof vi.fn>;
  mkdirSync: NonNullable<OpenSshLocalPortForwardDeps['mkdirSync']> & ReturnType<typeof vi.fn>;
  now: () => number;
  pid: number;
}>;

function exportedFunction<TFunction>(name: string): TFunction {
  const value = (sshExports as unknown as Record<string, unknown>)[name];
  expect(value).toEqual(expect.any(Function));
  return value as TFunction;
}

function createDeps() {
  const spawnSync = vi.fn<NonNullable<OpenSshLocalPortForwardDeps['spawnSync']>>(() => ({
    status: 0,
    stdout: '',
    stderr: '',
    error: undefined,
    signal: null,
    output: [],
    pid: 123,
  }));
  const mkdirSync = vi.fn<NonNullable<OpenSshLocalPortForwardDeps['mkdirSync']>>();
  return {
    spawnSync,
    mkdirSync,
    now: () => 123456,
    pid: 4321,
  } satisfies TestLocalPortForwardDeps;
}

function spawnResult(params: Readonly<{
  status: number;
  stdout?: string;
  stderr?: string;
}>) {
  return {
    status: params.status,
    stdout: params.stdout ?? '',
    stderr: params.stderr ?? '',
    error: undefined,
    signal: null,
    output: [],
    pid: 123,
  };
}

describe('openSshLocalPortForward', () => {
  it('opens an OpenSSH ControlMaster local forward before the target argument', () => {
    const openSshLocalPortForward = exportedFunction<(
      request: OpenSshLocalPortForwardRequest,
      deps: TestLocalPortForwardDeps,
    ) => OpenSshLocalPortForwardHandle>('openSshLocalPortForward');
    const deps = createDeps();

    const handle = openSshLocalPortForward({
      sshBin: 'ssh',
      target: 'dev@example.test',
      port: 2202,
      sshConfigFile: '/tmp/ssh.config',
      knownHostsPath: '/tmp/known_hosts',
      auth: { mode: 'keyFile', privateKeyPath: '/Users/alex/.ssh/id_ed25519' },
      localPort: 49152,
      remotePort: 8787,
      controlDir: '/tmp/happier-ssh-control',
      connectTimeoutSec: 10,
      serverAliveIntervalSec: 15,
      serverAliveCountMax: 2,
    }, deps);

    expect(handle).toMatchObject({
      localPort: 49152,
      remoteHost: '127.0.0.1',
      remotePort: 8787,
      controlPath: '/tmp/happier-ssh-control/tunnel-4321-123456-49152.sock',
    });
    expect(deps.mkdirSync).toHaveBeenCalledWith('/tmp/happier-ssh-control', { recursive: true });

    const [command, args, options] = deps.spawnSync.mock.calls[0] ?? [];
    expect(command).toBe('ssh');
    expect(options).toMatchObject({ encoding: 'utf8', windowsHide: true });
    expect(args).toEqual([
      '-F', '/tmp/ssh.config',
      '-p', '2202',
      '-o', 'BatchMode=yes',
      '-o', 'LogLevel=ERROR',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=2',
      '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'UserKnownHostsFile=/tmp/known_hosts',
      '-o', 'StrictHostKeyChecking=yes',
      '-i', '/Users/alex/.ssh/id_ed25519',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ControlMaster=yes',
      '-o', 'ControlPath=/tmp/happier-ssh-control/tunnel-4321-123456-49152.sock',
      '-o', 'ControlPersist=60',
      '-f',
      '-N',
      '-L', '49152:127.0.0.1:8787',
      'dev@example.test',
    ]);
  });

  it('closes the OpenSSH ControlMaster using the same ControlPath', () => {
    const openSshLocalPortForward = exportedFunction<(
      request: OpenSshLocalPortForwardRequest,
      deps: TestLocalPortForwardDeps,
    ) => OpenSshLocalPortForwardHandle>('openSshLocalPortForward');
    const deps = createDeps();
    const handle = openSshLocalPortForward({
      target: 'dev@example.test',
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      localPort: 49152,
      remotePort: 8787,
      controlDir: '/tmp/happier-ssh-control',
    }, deps);

    handle.close();

    const [, closeArgs] = deps.spawnSync.mock.calls[1] ?? [];
    expect(closeArgs).toEqual(expect.arrayContaining([
      '-o', 'ControlPath=/tmp/happier-ssh-control/tunnel-4321-123456-49152.sock',
      '-O', 'exit',
      'dev@example.test',
    ]));
    expect(closeArgs.indexOf('-O')).toBeLessThan(closeArgs.indexOf('dev@example.test'));
  });

  it('closes an adopted OpenSSH ControlMaster using a persisted ControlPath', () => {
    const closeOpenSshLocalPortForward = exportedFunction<(
      request: { target: string; controlPath: string; auth: { mode: 'agent' } },
      deps: Pick<TestLocalPortForwardDeps, 'spawnSync'>,
    ) => void>('closeOpenSshLocalPortForward');
    const deps = createDeps();

    closeOpenSshLocalPortForward({
      target: 'dev@example.test',
      controlPath: '/tmp/happier-ssh-control/adopted.sock',
      auth: { mode: 'agent' },
    }, deps);

    const [command, args, options] = deps.spawnSync.mock.calls[0] ?? [];
    expect(command).toBe('ssh');
    expect(args).toEqual(expect.arrayContaining([
      '-o', 'ControlPath=/tmp/happier-ssh-control/adopted.sock',
      '-O', 'exit',
      'dev@example.test',
    ]));
    expect(args.indexOf('-O')).toBeLessThan(args.indexOf('dev@example.test'));
    expect(options).toEqual(expect.objectContaining({ encoding: 'utf8', windowsHide: true }));
  });

  it('redacts SSH-sensitive stderr when opening the forward fails', () => {
    const openSshLocalPortForward = exportedFunction<(
      request: OpenSshLocalPortForwardRequest,
      deps: TestLocalPortForwardDeps,
    ) => OpenSshLocalPortForwardHandle>('openSshLocalPortForward');
    const deps = createDeps();
    deps.spawnSync.mockReturnValueOnce(spawnResult({
      status: 255,
      stderr: 'Identity file /Users/alex/.ssh/id_ed25519 not accessible password: hunter2\n',
    }));

    expect(() => openSshLocalPortForward({
      target: 'dev@example.test',
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      localPort: 49152,
      remotePort: 8787,
      controlDir: '/tmp/happier-ssh-control',
    }, deps)).toThrow('SSH tunnel failed: Identity file [redacted-path] not accessible password: [redacted-secret]');
  });
});

describe('withOpenSshLocalPortForward', () => {
  it('closes the forward after the callback rejects without masking the original error', async () => {
    const withOpenSshLocalPortForward = exportedFunction<(
      request: OpenSshLocalPortForwardRequest,
      fn: (handle: OpenSshLocalPortForwardHandle) => Promise<void>,
      deps: TestLocalPortForwardDeps,
    ) => Promise<void>>('withOpenSshLocalPortForward');
    const deps = createDeps();

    await expect(withOpenSshLocalPortForward({
      target: 'dev@example.test',
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      localPort: 49152,
      remotePort: 8787,
      controlDir: '/tmp/happier-ssh-control',
    }, async () => {
      throw new Error('callback failed');
    }, deps)).rejects.toThrow('callback failed');

    expect(deps.spawnSync).toHaveBeenCalledTimes(2);
    const [, closeArgs] = deps.spawnSync.mock.calls[1] ?? [];
    expect(closeArgs).toEqual(expect.arrayContaining(['-O', 'exit']));
  });

  it('preserves a falsy callback rejection when close fails', async () => {
    const withOpenSshLocalPortForward = exportedFunction<(
      request: OpenSshLocalPortForwardRequest,
      fn: (handle: OpenSshLocalPortForwardHandle) => Promise<void>,
      deps: TestLocalPortForwardDeps,
    ) => Promise<void>>('withOpenSshLocalPortForward');
    const deps = createDeps();
    deps.spawnSync
      .mockReturnValueOnce(spawnResult({ status: 0 }))
      .mockReturnValueOnce(spawnResult({ status: 255, stderr: 'close failed' }));

    await expect(withOpenSshLocalPortForward({
      target: 'dev@example.test',
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      localPort: 49152,
      remotePort: 8787,
      controlDir: '/tmp/happier-ssh-control',
    }, async () => Promise.reject(undefined), deps)).rejects.toBeUndefined();

    expect(deps.spawnSync).toHaveBeenCalledTimes(2);
  });
});
