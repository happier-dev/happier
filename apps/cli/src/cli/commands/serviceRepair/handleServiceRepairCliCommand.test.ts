import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonServiceListEntry } from '@/daemon/service/cli';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const {
  applyBackgroundServiceRepairPlanMock,
  resolveDaemonServiceCliRuntimeFromEnvMock,
  resolveDaemonServiceListEntriesMock,
} = vi.hoisted(() => ({
  applyBackgroundServiceRepairPlanMock: vi.fn(async (_plan: unknown, _runtime: unknown) => ({ executedActions: [] })),
  resolveDaemonServiceCliRuntimeFromEnvMock: vi.fn((_params?: unknown) => ({
    platform: 'linux',
    channel: 'stable',
    targetMode: 'default-following',
    instanceId: 'default',
    uid: 1000,
    userHomeDir: '/tmp/user',
    happierHomeDir: '/tmp/user/.happier',
    serverUrl: 'https://example.test',
    publicServerUrl: 'https://example.test',
    webappUrl: 'https://app.example.test',
    nodePath: '/usr/bin/node',
    entryPath: '/opt/happier/index.mjs',
  })),
  resolveDaemonServiceListEntriesMock: vi.fn<(_runtime: unknown, _options?: unknown) => Promise<DaemonServiceListEntry[]>>(async () => []),
}));

vi.mock('@/daemon/service/cli', () => ({
  resolveDaemonServiceCliRuntimeFromEnv: (params?: unknown) => resolveDaemonServiceCliRuntimeFromEnvMock(params),
  resolveDaemonServiceListEntries: (runtime: unknown, options?: unknown) => resolveDaemonServiceListEntriesMock(runtime, options),
}));

vi.mock('@/diagnostics/backgroundServiceRepair', () => ({
  applyBackgroundServiceRepairPlan: (plan: unknown, runtime: unknown) => applyBackgroundServiceRepairPlanMock(plan, runtime),
}));

import { handleServiceRepairCliCommand } from './handleServiceRepairCliCommand';

describe('happier service repair', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_PUBLIC_RELEASE_CHANNEL',
  ]);

  afterEach(() => {
    envScope.restore();
    vi.restoreAllMocks();
    applyBackgroundServiceRepairPlanMock.mockClear();
    resolveDaemonServiceCliRuntimeFromEnvMock.mockClear();
    resolveDaemonServiceListEntriesMock.mockClear();
  });

  it('fails closed when executing system-scoped repair on linux without root privileges', async () => {
    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required for system mode background-service repair');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('fails closed for system-scoped json repair on linux without root privileges', async () => {
    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes', '--json'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required for system mode background-service repair');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('rejects system-scoped repair on unsupported platforms', async () => {
    resolveDaemonServiceCliRuntimeFromEnvMock.mockReturnValueOnce({
      platform: 'darwin',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      uid: 501,
      userHomeDir: '/tmp/user',
      happierHomeDir: '/tmp/user/.happier',
      serverUrl: 'https://example.test',
      publicServerUrl: 'https://example.test',
      webappUrl: 'https://app.example.test',
      nodePath: '/usr/bin/node',
      entryPath: '/opt/happier/index.mjs',
    });

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes'],
      commandPath: 'happier service',
    })).rejects.toThrow('System mode background services are only supported on Linux');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('reports a manual relay owner warning in JSON output', async () => {
    await withTempDir('happier-service-repair-owner-warning-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
      });
      vi.resetModules();

      const [{ writeDaemonState }, { handleServiceRepairCliCommand }] = await Promise.all([
        import('@/persistence'),
        import('./handleServiceRepairCliCommand'),
      ]);

      writeDaemonState({
        pid: process.pid,
        httpPort: 43121,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'preview',
        startupSource: 'manual',
        runtimeId: 'runtime-manual',
      });

      const output = captureConsoleJsonOutput<{ ok: boolean; warning?: string }>();
      try {
        await handleServiceRepairCliCommand({
          argv: ['repair', '--json'],
          commandPath: 'happier service',
        });

        expect(output.json()).toEqual(expect.objectContaining({
          ok: true,
          warning: expect.stringContaining('Repairing background services will not stop the current relay owner.'),
        }));
      } finally {
        output.restore();
      }
    });
  });

  it('aggregates user and system services when no explicit mode is provided', async () => {
    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'default',
          name: 'Default background service',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.default.service',
          platform: 'linux',
          mode: 'system',
          releaseChannel: 'stable',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        }];
      }
      return [{
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/tmp/user/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }];
    });

    const output = captureConsoleJsonOutput<{
      ok: boolean;
      existingServices: Array<{ mode?: 'user' | 'system'; label: string }>;
      actions: Array<{ kind: string; service?: { mode?: 'user' | 'system'; label: string } }>;
    }>();
    try {
      await handleServiceRepairCliCommand({
        argv: ['repair', '--json'],
        commandPath: 'happier service',
      });
    } finally {
      output.restore();
    }

    expect(resolveDaemonServiceListEntriesMock).toHaveBeenNthCalledWith(1, expect.anything(), { mode: 'user' });
    expect(resolveDaemonServiceListEntriesMock).toHaveBeenNthCalledWith(2, expect.anything(), { mode: 'system' });
    expect(output.json()).toEqual(expect.objectContaining({
      ok: true,
      existingServices: [
        expect.objectContaining({ mode: 'user', label: 'happier-daemon.default' }),
        expect.objectContaining({ mode: 'system', label: 'happier-daemon.default' }),
      ],
      actions: [
        expect.objectContaining({
          kind: 'remove-service',
          service: expect.objectContaining({ mode: 'system', label: 'happier-daemon.default' }),
        }),
      ],
    }));
  });

  it('fails closed when a mixed user and system repair plan would require root', async () => {
    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'default',
          name: 'Default background service',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.default.service',
          platform: 'linux',
          mode: 'system',
          releaseChannel: 'stable',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        }];
      }
      return [{
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/tmp/user/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }];
    });

    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--yes', '--json'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required to apply system mode background-service repair actions');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });
});
