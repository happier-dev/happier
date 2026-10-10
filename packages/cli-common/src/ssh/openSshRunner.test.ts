import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawn, spawnSync } = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn,
  spawnSync,
}));

import {
  OpenSshExecutionError,
  runOpenSshRemoteCommand,
  sshKeyscanSync,
  transferOpenSshFile,
} from './index.js';

beforeEach(() => {
  spawn.mockReset();
  spawnSync.mockReset();
});

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe('runOpenSshRemoteCommand', () => {
  it('rejects signal termination even when a caller inspects nonzero JSON results', async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    const pending = runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['happier', 'auth', 'status', '--json'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      rejectOnNonZero: false,
    });
    child.stdout.end('{"v":1,"ok":false,"kind":"auth_status","error":{"code":"not_authenticated"}}\n');
    child.stderr.end('');
    child.emit('close', null, 'SIGTERM');
    await expect(pending).rejects.toMatchObject({ code: 'command_failed' });
  });

  it('writes ephemeral approval input to stdin without placing it in SSH argv', async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    const input = 'happier-personal-home-approval-v1\nconfirmed:yes\n';
    const received: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => received.push(chunk));

    const pending = runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['happier', 'home', 'erase', '--approval-stdin'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      input,
    });
    child.stdout.end('{}\n');
    child.stderr.end('');
    child.emit('close', 0, null);

    await expect(pending).resolves.toMatchObject({ status: 0 });
    expect(Buffer.concat(received).toString('utf8')).toBe(input);
    expect(JSON.stringify(spawn.mock.calls[0]?.[1] ?? [])).not.toContain('confirmed:yes');
  });

  it('rejects oversized ephemeral input before spawning SSH', async () => {
    await expect(runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['happier', 'home', 'erase', '--approval-stdin'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      input: 'x'.repeat(65),
      maxInputBytes: 64,
    })).rejects.toMatchObject({ code: 'input_limit_exceeded' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns bounded captured output from the asynchronous OpenSSH launch path', async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);

    const pending = runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['happier', 'auth', 'status', '--json'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      timeoutMs: 1_000,
      maxStdoutBytes: 128,
      maxStderrBytes: 128,
    });
    child.stdout.end('{"ok":true}\n');
    child.stderr.end('');
    child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({ status: 0, stdout: '{"ok":true}\n', stderr: '' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('forwards explicitly authorized stdout chunks while retaining bounded capture', async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    const onStdoutChunk = vi.fn();
    const pending = runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['happier', 'home', 'pair-device', '--copy-link'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      timeoutMs: 1_000,
      maxStdoutBytes: 128,
      onStdoutChunk,
    });
    child.stdout.write('happier://pair/short-lived\n');
    expect(onStdoutChunk).toHaveBeenCalledWith('happier://pair/short-lived\n');
    child.stdout.end('Device paired.\n');
    child.stderr.end('');
    child.emit('close', 0, null);
    await expect(pending).resolves.toMatchObject({ status: 0 });
  });

  it('does not reflect explicitly streamed pairing output into a command failure', async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    const link = 'happier://pair/short-lived-secret';
    const pending = runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['happier', 'home', 'pair-device', '--copy-link'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      includeStdoutInError: false,
    });
    child.stdout.end(`${link}\n`);
    child.stderr.end('');
    child.emit('close', 1, null);
    const error = await pending.catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(link);
    expect(error).toMatchObject({ code: 'command_failed' });
  });

  it('aborts the child through AbortSignal with a typed failure', async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    const controller = new AbortController();
    const pending = runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['happier', 'auth', 'status', '--json'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('enforces one overall timeout and reports a typed redacted failure', async () => {
    vi.useFakeTimers();
    try {
      const child = createFakeChild();
      spawn.mockReturnValue(child);
      const pending = runOpenSshRemoteCommand({
        target: 'dev@example.test',
        remoteCommand: ['happier', 'auth', 'status', '--json'],
        knownHostsMode: 'system',
        auth: { mode: 'agent' },
        timeoutMs: 50,
      });
      const failure = expect(pending).rejects.toMatchObject({ code: 'timed_out' });

      await vi.advanceTimersByTimeAsync(51);

      await failure;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an explicitly unbounded command alive beyond the default timeout', async () => {
    vi.useFakeTimers();
    try {
      const child = createFakeChild();
      spawn.mockReturnValue(child);
      const pending = runOpenSshRemoteCommand({
        target: 'dev@example.test',
        remoteCommand: ['happier', 'home', 'erase', '--approval-stdin'],
        knownHostsMode: 'system',
        auth: { mode: 'agent' },
        timeoutMs: null,
      });

      await vi.advanceTimersByTimeAsync(60_001);
      expect(child.kill).not.toHaveBeenCalled();
      child.stdout.end('{"ok":true}\n');
      child.stderr.end('');
      child.emit('close', 0, null);

      await expect(pending).resolves.toMatchObject({ status: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills output-flooding children without reflecting captured pairing secrets', async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    const pairingSecret = 'pairing-secret-must-not-escape';
    const pending = runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['happier', 'auth', 'request', '--json'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      timeoutMs: 1_000,
      maxStdoutBytes: 16,
    });

    child.stdout.write(`{"pairing":{"secretB64Url":"${pairingSecret}"}}`);

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenSshExecutionError);
    expect(error).toMatchObject({ code: 'output_limit_exceeded' });
    expect(String(error)).not.toContain(pairingSecret);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('redacts terminal pairing and claim secrets from typed command failures', async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    const pairingSecret = 'pairing-secret-must-not-escape';
    const claimSecret = 'claim-secret-must-not-escape';
    const pending = runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['happier', 'auth', 'request', '--json'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      timeoutMs: 1_000,
    });
    child.stderr.end(JSON.stringify({
      claimSecret,
      pairing: { secretB64Url: pairingSecret },
    }));
    child.stdout.end('');
    child.emit('close', 1, null);

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'command_failed', status: 1 });
    expect(String(error)).not.toContain(pairingSecret);
    expect(String(error)).not.toContain(claimSecret);
    expect(String(error)).toContain('[redacted-secret]');
  });

  it('normalizes synchronous process-launch failures to the typed SSH error', async () => {
    spawn.mockImplementation(() => {
      throw new Error('invalid spawn options');
    });

    await expect(runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['true'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
    })).rejects.toMatchObject({ code: 'spawn_failed' });
  });

  it('redacts captured nonzero results when the executor is allowed to inspect them', async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    const pending = runOpenSshRemoteCommand({
      target: 'dev@example.test',
      remoteCommand: ['happier', 'auth', 'status', '--json'],
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      rejectOnNonZero: false,
    });
    child.stdout.end('{"claimSecret":"must-not-escape"}\n');
    child.stderr.end('');
    child.emit('close', 1, null);

    await expect(pending).resolves.toMatchObject({
      status: 1,
      stdout: expect.not.stringContaining('must-not-escape'),
    });
  });
});

describe('transferOpenSshFile', () => {
  it.each([
    ['upload', ['/work/home.tar', 'dev@example.test:/tmp/home.tar']],
    ['download', ['dev@example.test:/tmp/home.tar', '/work/home.tar']],
  ] as const)('runs an asynchronous bounded %s transfer in the canonical direction', async (direction, endpoints) => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    const pending = transferOpenSshFile({
      direction,
      target: 'dev@example.test',
      localPath: '/work/home.tar',
      remotePath: '/tmp/home.tar',
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
    });
    child.stdout.end('');
    child.stderr.end('');
    child.emit('close', 0, null);

    await expect(pending).resolves.toBeUndefined();
    const argv = spawn.mock.calls[0]?.[1] as string[];
    expect(argv.slice(-2)).toEqual(endpoints);
    expect(argv).not.toContain('-r');
  });

  it('passes recursive directory intent to scp and aborts an in-flight boundary process', async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    const controller = new AbortController();
    const pending = transferOpenSshFile({
      direction: 'upload',
      target: 'dev@example.test',
      localPath: '/work/payload',
      remotePath: '/tmp/payload',
      recursive: true,
      knownHostsMode: 'system',
      auth: { mode: 'agent' },
      signal: controller.signal,
    });

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[1]).toContain('-r');
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('sshKeyscanSync', () => {
  it('invokes ssh-keyscan with the expected defaults', () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: 'example.test ssh-ed25519 AAAA\n',
      stderr: '',
      error: undefined,
    });

    const output = sshKeyscanSync({ host: 'example.test' });
    expect(output).toContain('ssh-ed25519');

    const [command, args] = spawnSync.mock.calls.at(-1) ?? [];
    expect(command).toBe('ssh-keyscan');
    expect(args).toEqual(expect.arrayContaining(['-t', 'ed25519', 'example.test']));
  });

  it('rejects hosts that could be interpreted as flags', () => {
    expect(() => sshKeyscanSync({ host: '-f' })).toThrow(/must not start/i);
    expect(spawnSync).toHaveBeenCalledTimes(0);
  });
});
