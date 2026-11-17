import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDaemonTerminalLaunch } from './launch';

describe('resolveDaemonTerminalLaunch', () => {
  it('resolves manifest login commands and initial input on the daemon', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-login-'));
    try {
    for (const agentId of ['claude', 'codex']) {
      const file = join(dir, agentId);
      await writeFile(file, '#!/bin/sh\nexit 0\n');
      await chmod(file, 0o755);
      const launch = await resolveDaemonTerminalLaunch(
        { kind: 'agent_login', agentId },
        { env: { ...process.env, [`HAPPIER_${agentId.toUpperCase()}_PATH`]: file } },
      );
      expect(launch.file).toBe(file);
      expect(launch.args).toEqual(agentId === 'codex' ? ['login'] : []);
      expect(launch.initialInput).toBe(agentId === 'claude' ? '/login\r' : undefined);
    }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the Happier CLI auth owner for ACP login and refuses unsupported native login', async () => {
    const launch = await resolveDaemonTerminalLaunch({ kind: 'agent_login', agentId: 'antigravity' });
    expect(launch.args.slice(-4)).toEqual(['agents', 'auth', 'login', 'antigravity']);
    await expect(resolveDaemonTerminalLaunch({ kind: 'agent_login', agentId: 'gemini' }))
      .rejects.toThrow(expect.objectContaining({ code: 'agent_login_unsupported' }));
    await expect(resolveDaemonTerminalLaunch({ kind: 'agent_login', agentId: 'claude', launchId: 'device_code' }))
      .rejects.toThrow(expect.objectContaining({ code: 'agent_login_unsupported' }));
  });

  it('launches a Windows shell shim through the canonical binary-safe runner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-login-windows-'));
    try {
      const file = join(dir, 'codex.cmd');
      await writeFile(file, '@echo off\r\nexit /b 0\r\n');
      await chmod(file, 0o755);
      const launch = await resolveDaemonTerminalLaunch({ kind: 'agent_login', agentId: 'codex' }, {
        platform: 'win32', env: { ...process.env, HAPPIER_CODEX_PATH: file },
      });
      expect(launch.file).not.toBe(file);
      expect(launch.args.slice(-2)).toEqual([file, 'login']);
      expect(launch.args[0]).toMatch(/agent_cli_windows_shim_runner\.cjs$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delegates attached-session launch argv to the canonical Happier CLI runtime owner', async () => {
    const buildLaunchSpec = vi.fn(() => ({
      runtime: 'binary' as const,
      filePath: '/opt/happier/bin/happier',
      args: ['attach', 'session-1'],
    }));

    expect(await resolveDaemonTerminalLaunch(
      { kind: 'session_attach', sessionId: 'session-1' },
      { buildLaunchSpec },
    )).toEqual({
      file: '/opt/happier/bin/happier',
      args: ['attach', 'session-1'],
      env: undefined,
    });
    expect(buildLaunchSpec).toHaveBeenCalledWith(['attach', 'session-1']);
  });

  it('delegates a typed Happier CLI launch to the same canonical runtime owner', async () => {
    const buildLaunchSpec = vi.fn(() => ({
      runtime: 'binary' as const,
      filePath: '/opt/happier/bin/happier',
      args: ['agents', 'auth', 'login', 'antigravity'],
      env: { HAPPIER_HOME_DIR: '/tmp/happier' },
    }));

    expect(await resolveDaemonTerminalLaunch({
      kind: 'happier_cli',
      args: ['agents', 'auth', 'login', 'antigravity'],
    }, { buildLaunchSpec })).toEqual({
      file: '/opt/happier/bin/happier',
      args: ['agents', 'auth', 'login', 'antigravity'],
      env: { HAPPIER_HOME_DIR: '/tmp/happier' },
    });
    expect(buildLaunchSpec).toHaveBeenCalledWith(['agents', 'auth', 'login', 'antigravity']);
  });
});
