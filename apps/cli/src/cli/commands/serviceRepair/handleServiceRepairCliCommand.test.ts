import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonServiceInventoryEntry, DaemonServiceListEntry } from '@/daemon/service/cli';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';

const {
  applyBackgroundServiceRepairPlanMock,
  buildDoctorSnapshotMock,
  isInteractiveTerminalMock,
	  promptInputMock,
	  resolveDaemonServiceCliRuntimeFromEnvMock,
	  resolveDaemonServiceInventoryEntriesMock,
	  resolveDaemonServiceListEntriesMock,
	} = vi.hoisted(() => ({
  applyBackgroundServiceRepairPlanMock: vi.fn(async (_plan: unknown, _runtime: unknown) => ({ executedActions: [] })),
  buildDoctorSnapshotMock: vi.fn(async () => ({
    capturedAt: '2026-04-19T00:00:00.000Z',
    server: {
      activeServerId: 'cloud',
      serverUrl: 'https://relay.example.test',
      publicServerUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
    },
    accountId: 'acct_123',
    settings: {
      activeServerId: 'cloud',
      servers: [],
      knownAccountIds: ['acct_123'],
    },
    daemonStatus: {
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://relay.example.test',
        localServerUrl: null,
        publicServerUrl: 'https://relay.example.test',
        webappUrl: 'https://app.example.test',
        comparableKey: 'https://relay.example.test',
      },
      daemon: {
        running: true,
        pid: 4321,
        httpPort: 7777,
        startedWithCliVersion: '0.0.0-other',
        startedWithPublicReleaseChannel: 'preview',
        startupSource: 'manual',
        serviceManaged: false,
        serviceLabel: null,
      },
      service: {
        installed: true,
        running: true,
      },
      auth: {
        authenticated: true,
        machineRegistered: true,
        machineId: 'machine_123',
        needsAuth: false,
        accountId: 'acct_123',
      },
    },
    relays: {
      happier: {
        relays: [
          {
            id: 'dev:user',
            ring: 'dev',
            scope: 'user',
            installed: true,
            version: '0.2.5-dev.7.1',
            relayUrl: 'http://127.0.0.1:4400',
            healthy: true,
            serviceActive: true,
            serviceEnabled: true,
          },
        ],
      },
    },
  })),
  isInteractiveTerminalMock: vi.fn(() => false),
	  promptInputMock: vi.fn<(prompt: string) => Promise<string>>(async (_prompt: string) => ''),
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
	  resolveDaemonServiceInventoryEntriesMock: vi.fn<(_params?: unknown) => Promise<readonly DaemonServiceInventoryEntry[]>>(async (_params?: unknown) => []),
	  resolveDaemonServiceListEntriesMock: vi.fn<(_runtime: unknown, _options?: unknown) => Promise<DaemonServiceListEntry[]>>(async (_runtime: unknown, _options?: unknown) => []),
	}));

vi.mock('@/daemon/service/cli', () => ({
	  resolveDaemonServiceCliRuntimeFromEnv: (params?: unknown) => resolveDaemonServiceCliRuntimeFromEnvMock(params),
	  resolveDaemonServiceInventoryEntries: (params?: unknown) => resolveDaemonServiceInventoryEntriesMock(params),
	  resolveDaemonServiceListEntries: (runtime: unknown, options?: unknown) => resolveDaemonServiceListEntriesMock(runtime, options),
	}));

vi.mock('@/diagnostics/backgroundServiceRepair', () => ({
  applyBackgroundServiceRepairPlan: (plan: unknown, runtime: unknown) => applyBackgroundServiceRepairPlanMock(plan, runtime),
}));

vi.mock('@/ui/doctorSnapshot', () => ({
  buildDoctorSnapshot: () => buildDoctorSnapshotMock(),
}));

vi.mock('../server/commandUtilities', () => ({
  isInteractiveTerminal: () => isInteractiveTerminalMock(),
  promptInput: (prompt: string) => promptInputMock(prompt),
}));

describe('handleServiceRepairCliCommand', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_PUBLIC_RELEASE_CHANNEL',
    'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
    'SUDO_USER',
  ]);

  afterEach(() => {
    envScope.restore();
    vi.restoreAllMocks();
    applyBackgroundServiceRepairPlanMock.mockClear();
    buildDoctorSnapshotMock.mockClear();
    isInteractiveTerminalMock.mockClear();
    promptInputMock.mockClear();
    resolveDaemonServiceCliRuntimeFromEnvMock.mockClear();
    resolveDaemonServiceListEntriesMock.mockClear();
  });

  it('fails closed when executing system-scoped repair on linux without root privileges', async () => {
    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required for system mode automatic startup repair');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('fails closed for system-scoped json repair on linux without root privileges', async () => {
    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes', '--json'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required for system mode automatic startup repair');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('rejects system-scoped repair on unsupported platforms', async () => {
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation(() => ({
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
    }));
    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes'],
      commandPath: 'happier service',
    })).rejects.toThrow('System mode background services are only supported on Linux');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('surfaces a manually-started daemon via the report (no warning field)', async () => {
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

        // The legacy ownership-note `warning` string was retired — its info
        // now lives in the structured `report` via the running-daemon section
        // and per-finding prompts. The JSON envelope keeps the `warning` key
        // for back-compat with older installer shells but no longer sets it.
        const json = output.json() as { ok: boolean; warning?: string };
        expect(json).toEqual(expect.objectContaining({
          ok: true,
          defaultFollowingMatchesSelectedReleaseChannel: null,
          daemonStatus: expect.objectContaining({
            daemon: expect.objectContaining({
              running: true,
              pid: 4321,
            }),
          }),
          relays: [
            expect.objectContaining({
              ring: 'dev',
              relayUrl: 'http://127.0.0.1:4400',
            }),
          ],
        }));
        expect(json.warning).toBeUndefined();
      } finally {
        output.restore();
      }
    });
  });

  it('emits default-following channel matching in json preflight output', async () => {
    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, _options?: unknown) => [{
      serverId: 'default',
      name: 'Default background service',
      installed: true,
      path: '/tmp/user/.config/systemd/user/happier-daemon.default.service',
      platform: 'linux',
      mode: 'user',
      happierHomeDir: '/tmp/user/.happier',
      releaseChannel: 'stable',
      label: 'happier-daemon.default',
      targetMode: 'default-following',
    }]);

    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');
    const output = captureConsoleJsonOutput<{ defaultFollowingMatchesSelectedReleaseChannel: boolean | null }>();
    try {
      await handleServiceRepairCliCommand({
        argv: ['repair', '--json'],
        commandPath: 'happier doctor',
      });
    } finally {
      output.restore();
    }

    expect(output.json()).toEqual(expect.objectContaining({
      defaultFollowingMatchesSelectedReleaseChannel: true,
    }));
  });

  it('resolves doctor repair --server URLs to existing server profiles', async () => {
    await withTempDir('happier-service-repair-server-url-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
      });
      vi.resetModules();

      const [{ addServerProfile }, { handleServiceRepairCliCommand }] = await Promise.all([
        import('@/server/serverProfiles'),
        import('./handleServiceRepairCliCommand'),
      ]);

      const created = await addServerProfile({
        name: 'remote-dev-tui',
        serverUrl: 'http://127.0.0.1:52753',
        webappUrl: 'http://127.0.0.1:52753',
        use: false,
      });

      const output = captureConsoleJsonOutput<{
        report: {
          findings: Array<{ kind: string; serverId?: string }>;
          authProfiles: Array<{ serverId: string; isActive: boolean }>;
        };
      }>();
      try {
        await handleServiceRepairCliCommand({
          argv: ['repair', '--server', 'http://127.0.0.1:52753', '--json'],
          commandPath: 'happier service',
        });

        const json = output.json();
        expect(json.report.findings).not.toContainEqual(expect.objectContaining({
          kind: 'server_profile_missing',
        }));
        expect(json.report.authProfiles).toContainEqual(expect.objectContaining({
          serverId: created.id,
          isActive: true,
        }));
      } finally {
        output.restore();
      }
    });
  });

  it('renders doctor repair preflight with automatic startup, current daemon status, and local relays', async () => {
    resolveDaemonServiceInventoryEntriesMock.mockImplementation(async () => [{
      serviceType: 'daemon',
      platform: 'linux',
      serverId: 'default',
      name: 'Default background service',
      path: '/tmp/user/.config/systemd/user/happier-daemon.default.service',
      mode: 'user',
      label: 'happier-daemon.default',
      ring: 'stable',
      targetMode: 'default-following',
      installed: true,
      running: false,
      configuredCliVersion: '0.2.5-dev.14.1',
      runningCliVersion: null,
      relayUrl: 'https://relay.example.test',
    }]);
    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');
    const output = captureConsoleText();
    try {
      await handleServiceRepairCliCommand({
        argv: ['repair'],
        commandPath: 'happier doctor',
      });

      // New unified renderer: automatic-startup entries + manually-started daemons
      // are both listed under a single 'Background services' section. The fixture
      // uses a legacy service name ('Default background service') — the renderer
      // surfaces that faithfully; fresh installs emit 'Default automatic startup'
      // via discoverInstalledDaemonServiceEntries.ts.
      expect(output.text()).toContain('Background services');
      expect(output.text()).toMatch(/Default (automatic startup|background service)/);
      expect(output.text()).toContain('https://relay.example.test');
      expect(output.text()).toContain('pid 4321');
      expect(output.text()).toContain('Local relays');
      expect(output.text()).toContain('http://127.0.0.1:4400');
    } finally {
      output.restore();
    }
  });

  it('renders report-only mode without prompting even when repair actions exist', async () => {
    isInteractiveTerminalMock.mockReturnValue(true);
    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [];
      }
      return [{
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/tmp/user/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        happierHomeDir: '/tmp/user/.happier',
        releaseChannel: 'preview',
        label: 'happier-daemon.default',
        targetMode: 'pinned',
      }];
    });

    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');
    const output = captureConsoleText();
    try {
      await handleServiceRepairCliCommand({
        argv: ['repair', '--report-only'],
        commandPath: 'happier doctor',
      });

      expect(output.text()).toContain('Background services');
      expect(output.text()).not.toContain('Automatic startup repair');
      expect(promptInputMock).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
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
          happierHomeDir: '/tmp/user/.happier',
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
        happierHomeDir: '/tmp/user/.happier',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }];
    });

    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');
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

    expect(resolveDaemonServiceListEntriesMock).toHaveBeenNthCalledWith(1, expect.anything(), { mode: 'user', systemUser: '' });
    expect(resolveDaemonServiceListEntriesMock).toHaveBeenNthCalledWith(2, expect.anything(), { mode: 'system', systemUser: '' });
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
          happierHomeDir: '/tmp/user/.happier',
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
        happierHomeDir: '/tmp/user/.happier',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }];
    });

    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--yes', '--json'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required to apply system mode automatic startup repair actions');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('aggregates user and system services even when system mode is explicitly preferred on linux', async () => {
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'linux',
        channel: 'stable',
        targetMode: 'default-following',
        instanceId: 'default',
        uid: 0,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://example.test',
        publicServerUrl: 'https://example.test',
        webappUrl: 'https://app.example.test',
        nodePath: '/usr/bin/node',
        entryPath: '/opt/happier/index.mjs',
        mode: normalizedParams?.mode ?? 'system',
      };
    });
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
          happierHomeDir: '/tmp/user/.happier',
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
        happierHomeDir: '/tmp/user/.happier',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
      }];
    });

    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');
    const output = captureConsoleJsonOutput<{
      ok: boolean;
      existingServices: Array<{ mode?: 'user' | 'system'; label: string }>;
      actions: Array<{ kind: string; service?: { mode?: 'user' | 'system'; label: string } }>;
    }>();
    try {
      await handleServiceRepairCliCommand({
        argv: ['repair', '--mode', 'system', '--json'],
        commandPath: 'happier service',
      });
    } finally {
      output.restore();
    }

    expect(resolveDaemonServiceListEntriesMock).toHaveBeenNthCalledWith(1, expect.anything(), { mode: 'user', systemUser: '' });
    expect(resolveDaemonServiceListEntriesMock).toHaveBeenNthCalledWith(2, expect.anything(), { mode: 'system', systemUser: '' });
    expect(output.json()).toEqual(expect.objectContaining({
      ok: true,
      existingServices: [
        expect.objectContaining({ mode: 'user', label: 'happier-daemon.default' }),
        expect.objectContaining({ mode: 'system', label: 'happier-daemon.default' }),
      ],
      actions: [
        expect.objectContaining({
          kind: 'remove-service',
          service: expect.objectContaining({ mode: 'user', label: 'happier-daemon.default' }),
        }),
      ],
    }));
  });

  it('fails before apply when a system-mode repair install lacks a system user', async () => {
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system'; systemUser?: string } | undefined;
      return {
        platform: 'linux',
        channel: 'stable',
        targetMode: 'default-following',
        instanceId: 'default',
        uid: 0,
        userHomeDir: normalizedParams?.systemUser ? `/home/${normalizedParams.systemUser}` : '/root',
        happierHomeDir: normalizedParams?.systemUser ? `/home/${normalizedParams.systemUser}/.happier` : '/root/.happier',
        serverUrl: 'https://example.test',
        publicServerUrl: 'https://example.test',
        webappUrl: 'https://app.example.test',
        nodePath: '/usr/bin/node',
        entryPath: '/opt/happier/index.mjs',
      };
    });
    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode !== 'system') {
        return [];
      }
      return [{
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/etc/systemd/system/happier-daemon.default.service',
        platform: 'linux',
        mode: 'system',
        releaseChannel: 'preview',
        label: 'happier-daemon.default',
        targetMode: 'pinned',
      }];
    });

    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes', '--json'],
      commandPath: 'happier service',
    })).rejects.toThrow('System mode automatic startup repair requires --system-user (or SUDO_USER / HAPPIER_DAEMON_SERVICE_SYSTEM_USER)');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('reuses the sudo invoker as system user for system-mode repair installs', async () => {
    envScope.patch({
      SUDO_USER: 'developer',
    });
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system'; systemUser?: string } | undefined;
      return {
        platform: 'linux',
        channel: 'stable',
        targetMode: 'default-following',
        instanceId: 'default',
        uid: 0,
        userHomeDir: normalizedParams?.systemUser ? `/home/${normalizedParams.systemUser}` : '/root',
        happierHomeDir: normalizedParams?.systemUser ? `/home/${normalizedParams.systemUser}/.happier` : '/root/.happier',
        serverUrl: 'https://example.test',
        publicServerUrl: 'https://example.test',
        webappUrl: 'https://app.example.test',
        nodePath: '/usr/bin/node',
        entryPath: '/opt/happier/index.mjs',
      };
    });
    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode !== 'system') {
        return [];
      }
      return [{
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/etc/systemd/system/happier-daemon.default.service',
        platform: 'linux',
        mode: 'system',
        releaseChannel: 'preview',
        label: 'happier-daemon.default',
        targetMode: 'pinned',
      }];
    });

    const { handleServiceRepairCliCommand } = await import('./handleServiceRepairCliCommand');
    const output = captureConsoleJsonOutput<{ ok: boolean }>();
    try {
      await handleServiceRepairCliCommand({
        argv: ['repair', '--mode', 'system', '--yes', '--json'],
        commandPath: 'happier service',
      });
    } finally {
      output.restore();
    }

    expect(resolveDaemonServiceCliRuntimeFromEnvMock).toHaveBeenNthCalledWith(1, {
      mode: 'system',
      systemUser: 'developer',
    });
    expect(applyBackgroundServiceRepairPlanMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        systemUser: 'developer',
        userHomeDir: '/home/developer',
        happierHomeDir: '/home/developer/.happier',
      }),
    );
    expect(applyBackgroundServiceRepairPlanMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({
        nodePath: expect.anything(),
        entryPath: expect.anything(),
      }),
    );
  });
});
