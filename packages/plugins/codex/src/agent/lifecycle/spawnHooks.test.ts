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
            providerRuntimeSelection: { codexBackendMode: 'acp' },
          },
        },
      }, {
        tools: { resolveManagedInstallable },
      })).resolves.toEqual({ allowed: true });

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
          providerRuntimeSelection: { codexBackendMode: 'acp' },
        },
      },
    })).resolves.toMatchObject({
      allowed: false,
      reasonCode: 'codex_acp_unavailable',
    });
  });

  it('returns typed prerequisite diagnostics from daemon tool resolution failures', async () => {
    await expect(resolveCodexDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { codexBackendMode: 'acp' },
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
      allowed: false,
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
          providerRuntimeSelection: { codexBackendMode: 'appServer' },
        },
      },
    }, {
      tools: { resolveManagedInstallable },
    })).resolves.toEqual({ allowed: true });
    expect(resolveManagedInstallable).not.toHaveBeenCalled();
  });
});

describe('augmentCodexDaemonSpawnEnv', () => {
  it('publishes canonical Codex backend mode env for ACP and app-server modes', () => {
    expect(augmentCodexDaemonSpawnEnv({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { codexBackendMode: 'acp' },
        },
      },
    })).toEqual({ HAPPIER_CODEX_BACKEND_MODE: 'acp' });

    expect(augmentCodexDaemonSpawnEnv({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { codexBackendMode: 'appServer' },
        },
      },
    })).toEqual({ HAPPIER_CODEX_BACKEND_MODE: 'appServer' });
  });
});
