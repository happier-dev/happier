import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  augmentCodexDaemonSpawnEnv,
  resolveCodexDaemonSpawnPrerequisites,
} from './spawnHooks.js';

async function createExecutableShim(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-spawn-hooks-'));
  const path = join(root, process.platform === 'win32' ? `${name}.cmd` : name);
  await writeFile(path, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
  if (process.platform !== 'win32') {
    await chmod(path, 0o755);
  }
  return path;
}

describe('resolveCodexDaemonSpawnPrerequisites', () => {
  it('uses canonical Agent identity for a provider-bound nonliteral runtime target', async () => {
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      stdout: 'codex-cli 0.146.0',
      stderr: '',
    }));

    await expect(resolveCodexDaemonSpawnPrerequisites({
      payload: {
        agentId: 'codex',
        targetRef: { kind: 'backend', backendId: 'codex-acp-proxy', sourceKind: 'plugin' },
        runtimeSelection: {
          agentRuntimeSelection: { codexBackendMode: 'appServer' },
          hasExternalModelBinding: true,
        },
      },
    }, {
      tools: { resolveManagedInstallable: vi.fn(), runSystemTool },
    })).resolves.toEqual({ decision: 'allow' });
    expect(runSystemTool).toHaveBeenCalledTimes(1);
  });

  it('checks the installed Codex version for a provider-bound app-server spawn', async () => {
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      stdout: 'codex-cli 0.144.3',
      stderr: '',
    }));

    await expect(resolveCodexDaemonSpawnPrerequisites({
      payload: {
        agentId: 'codex',
        targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        runtimeSelection: {
          agentRuntimeSelection: { codexBackendMode: 'appServer' },
          hasExternalModelBinding: true,
        },
      },
    }, {
      tools: {
        resolveManagedInstallable: vi.fn(),
        runSystemTool,
      },
    })).resolves.toEqual({ decision: 'allow' });
    expect(runSystemTool).toHaveBeenCalledTimes(1);

    runSystemTool.mockResolvedValueOnce({ ok: true, stdout: 'codex-cli 0.145.0', stderr: '' });
    await expect(resolveCodexDaemonSpawnPrerequisites({
      payload: {
        agentId: 'codex',
        targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        runtimeSelection: { hasExternalModelBinding: true },
      },
    }, {
      tools: { resolveManagedInstallable: vi.fn(), runSystemTool },
    })).resolves.toEqual({ decision: 'allow' });

    runSystemTool.mockResolvedValueOnce({ ok: true, stdout: 'codex-cli 0.146.0', stderr: '' });
    await expect(resolveCodexDaemonSpawnPrerequisites({
      payload: {
        agentId: 'codex',
        targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        runtimeSelection: { hasExternalModelBinding: true },
      },
    }, {
      tools: { resolveManagedInstallable: vi.fn(), runSystemTool },
    })).resolves.toEqual({ decision: 'allow' });

    runSystemTool.mockResolvedValueOnce({ ok: true, stdout: 'codex-cli 0.147.0', stderr: '' });
    await expect(resolveCodexDaemonSpawnPrerequisites({
      payload: {
        agentId: 'codex',
        targetRef: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        runtimeSelection: { hasExternalModelBinding: true },
      },
    }, {
      tools: { resolveManagedInstallable: vi.fn(), runSystemTool },
    })).resolves.toEqual({ decision: 'allow' });
  });

  it('requests Codex ACP through the daemon tool-resolution context', async () => {
    const commandPath = await createExecutableShim('codex-acp');
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: true as const,
      command: commandPath,
      args: [],
    }));
    try {
      await expect(resolveCodexDaemonSpawnPrerequisites({
        payload: {
          runtimeSelection: {
            agentRuntimeSelection: { codexBackendMode: 'acp' },
          },
        },
      }, {
        tools: { resolveManagedInstallable },
      })).resolves.toEqual({ decision: 'allow' });

      expect(resolveManagedInstallable).toHaveBeenCalledWith(expect.objectContaining({
        installableId: 'codex-acp',
        sourcePreference: 'system-first',
      }));
    } finally {
      await rm(dirname(commandPath), { recursive: true, force: true });
    }
  });

  it('fails closed when ACP mode lacks daemon tool-resolution context', async () => {
    await expect(resolveCodexDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          agentRuntimeSelection: { codexBackendMode: 'acp' },
        },
      },
    })).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'codex_acp_unavailable',
    });
  });

  it('returns typed prerequisite diagnostics from daemon tool resolution failures', async () => {
    await expect(resolveCodexDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          agentRuntimeSelection: { codexBackendMode: 'acp' },
        },
      },
    }, {
      tools: {
        resolveManagedInstallable: async () => ({
          ok: false as const,
          errorMessage: 'codex-acp managed install unavailable',
        }),
      },
    })).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'codex_acp_unavailable',
      errorMessage: expect.stringContaining('codex-acp managed install unavailable'),
    });
  });

  it('allows app-server mode without resolving Codex ACP', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: false as const,
      errorMessage: 'unexpected call',
    }));

    await expect(resolveCodexDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          agentRuntimeSelection: { codexBackendMode: 'appServer' },
        },
      },
    }, {
      tools: { resolveManagedInstallable },
    })).resolves.toEqual({ decision: 'allow' });
    expect(resolveManagedInstallable).not.toHaveBeenCalled();
  });
});

describe('augmentCodexDaemonSpawnEnv', () => {
  it('publishes canonical Codex backend mode env for ACP and app-server modes', () => {
    expect(augmentCodexDaemonSpawnEnv({
      payload: {
        runtimeSelection: {
          agentRuntimeSelection: { codexBackendMode: 'acp' },
        },
      },
    })).toEqual({ HAPPIER_CODEX_BACKEND_MODE: 'acp' });

    expect(augmentCodexDaemonSpawnEnv({
      payload: {
        runtimeSelection: {
          agentRuntimeSelection: { codexBackendMode: 'appServer' },
        },
      },
    })).toEqual({ HAPPIER_CODEX_BACKEND_MODE: 'appServer' });
  });
});
