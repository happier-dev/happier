import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync,
}));

import {
  runOpenSshPosixShellCommandSync,
  sshKeyscanSync,
} from './index.js';

beforeEach(() => {
  spawnSync.mockReset();
});

describe('runOpenSshPosixShellCommandSync', () => {
  it('invokes ssh with a bash -lc wrapper and askpass env when using password auth', () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: '{"ok":true}\n',
      stderr: '',
      error: undefined,
    });

    const { result, parsed } = runOpenSshPosixShellCommandSync<{ ok: boolean }>({
      target: 'dev@example.test',
      shellCommand: 'echo ok',
      knownHostsMode: 'system',
      auth: { mode: 'password', password: 'super-secret' },
      connectTimeoutSec: 10,
      serverAliveIntervalSec: 15,
      serverAliveCountMax: 2,
      parseJson: true,
    });

    expect(result.status).toBe(0);
    expect(parsed).toEqual({ ok: true });
    expect(spawnSync).toHaveBeenCalledTimes(1);

    const [command, args, options] = spawnSync.mock.calls[0] ?? [];
    expect(command).toBe('ssh');
    expect(args).toEqual(expect.arrayContaining([
      'dev@example.test',
      'bash',
      '-lc',
      "'echo ok'",
    ]));
    expect(String(args).includes('super-secret')).toBe(false);
    expect(options).toMatchObject({
      windowsHide: true,
      encoding: 'utf8',
      env: expect.objectContaining({
        HAPPIER_SSH_PASSWORD: 'super-secret',
        SSH_ASKPASS_REQUIRE: 'force',
        SSH_ASKPASS: expect.stringContaining('happier-ssh-askpass'),
      }),
    });
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
});
