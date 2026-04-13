import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InstalledDaemonServiceEntry } from './discoverInstalledDaemonServiceEntries';
import { createEnvKeyScope } from '../../testkit/env/envScope';
import { captureStdoutJsonOutput } from '../../testkit/logger/captureOutput';

const {
  discoverInstalledDaemonServiceEntriesMock,
  uninstallDaemonServiceMock,
  readSettingsMock,
} = vi.hoisted(() => ({
  discoverInstalledDaemonServiceEntriesMock: vi.fn<() => Promise<readonly InstalledDaemonServiceEntry[]>>(async () => []),
  uninstallDaemonServiceMock: vi.fn(async () => undefined),
  readSettingsMock: vi.fn(async () => ({ servers: {} })),
}));

function createInstalledEntry(params: Readonly<{
  serverId: string;
  label: string;
  releaseChannel: InstalledDaemonServiceEntry['releaseChannel'];
  path: string;
  mode?: InstalledDaemonServiceEntry['mode'];
}>): InstalledDaemonServiceEntry {
  return {
    serverId: params.serverId,
    name: params.serverId,
    installed: true,
    path: params.path,
    platform: 'linux',
    mode: params.mode,
    releaseChannel: params.releaseChannel,
    label: params.label,
    targetMode: 'pinned',
  };
}

vi.mock('./discoverInstalledDaemonServiceEntries', async () => {
  const actual = await vi.importActual<typeof import('./discoverInstalledDaemonServiceEntries')>('./discoverInstalledDaemonServiceEntries');
  return {
    ...actual,
    discoverInstalledDaemonServiceEntries: discoverInstalledDaemonServiceEntriesMock,
  };
});

vi.mock('./installer', async () => {
  const actual = await vi.importActual<typeof import('./installer')>('./installer');
  return {
    ...actual,
    uninstallDaemonService: uninstallDaemonServiceMock,
  };
});

vi.mock('@/persistence', async () => {
  const actual = await vi.importActual<typeof import('@/persistence')>('@/persistence');
  return {
    ...actual,
    readSettings: readSettingsMock,
  };
});

describe('runDaemonServiceCliCommand uninstall selection', () => {
  const envKeys = [
    'HAPPIER_DAEMON_SERVICE_PLATFORM',
    'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
    'HAPPIER_DAEMON_SERVICE_CHANNEL',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('previews multi-service removal when --all is used without --yes', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
    });
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValue([
      createInstalledEntry({
        serverId: 'cloud',
        label: 'happier-daemon.stable.cloud',
        releaseChannel: 'stable',
        path: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.service',
        mode: 'user',
      }),
      createInstalledEntry({
        serverId: 'company',
        label: 'happier-daemon.stable.company',
        releaseChannel: 'stable',
        path: '/home/tester/.config/systemd/user/happier-daemon.stable.company.service',
        mode: 'user',
      }),
    ]);

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      executed: boolean;
      selectedServices: Array<{ id: string; mode?: string; definitionPath?: string }>;
    }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      await runDaemonServiceCliCommand({ argv: ['uninstall', '--ring', 'stable', '--all', '--json'] });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        executed: false,
        selectedServices: [
          expect.objectContaining({
            id: 'systemd-user:happier-daemon.stable.cloud',
            mode: 'user',
            definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.service',
          }),
          expect.objectContaining({
            id: 'systemd-user:happier-daemon.stable.company',
            mode: 'user',
            definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.company.service',
          }),
        ],
      }));
      expect(uninstallDaemonServiceMock).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('executes selected services when --all and --yes are provided', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
    });
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValue([
      createInstalledEntry({
        serverId: 'cloud',
        label: 'happier-daemon.stable.cloud',
        releaseChannel: 'stable',
        path: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.service',
        mode: 'user',
      }),
      createInstalledEntry({
        serverId: 'company',
        label: 'happier-daemon.stable.company',
        releaseChannel: 'stable',
        path: '/home/tester/.config/systemd/user/happier-daemon.stable.company.service',
        mode: 'user',
      }),
    ]);

    const output = captureStdoutJsonOutput<{ ok: boolean; executed: boolean }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      await runDaemonServiceCliCommand({ argv: ['uninstall', '--ring', 'stable', '--all', '--yes', '--json'] });

      expect(output.json()).toEqual(expect.objectContaining({ ok: true, executed: true }));
      expect(uninstallDaemonServiceMock).toHaveBeenCalledTimes(2);
      expect(uninstallDaemonServiceMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        instanceId: 'cloud',
        installedPath: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.service',
        runCommands: true,
      }));
      expect(uninstallDaemonServiceMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        instanceId: 'company',
        installedPath: '/home/tester/.config/systemd/user/happier-daemon.stable.company.service',
        runCommands: true,
      }));
    } finally {
      output.restore();
    }
  });

  it('treats --all without explicit filters as all services for the current mode/platform', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
    });
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValue([
      createInstalledEntry({
        serverId: 'cloud',
        label: 'happier-daemon.stable.cloud',
        releaseChannel: 'stable',
        path: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.service',
        mode: 'user',
      }),
      createInstalledEntry({
        serverId: 'preview1',
        label: 'happier-daemon.preview.preview1',
        releaseChannel: 'preview',
        path: '/home/tester/.config/systemd/user/happier-daemon.preview.preview1.service',
        mode: 'user',
      }),
    ]);

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      executed: boolean;
      selectedServices: Array<{ id: string; mode?: string; definitionPath?: string }>;
    }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      await runDaemonServiceCliCommand({ argv: ['uninstall', '--all', '--json'] });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        executed: false,
        selectedServices: [
          expect.objectContaining({
            id: 'systemd-user:happier-daemon.stable.cloud',
            mode: 'user',
            definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.service',
          }),
          expect.objectContaining({
            id: 'systemd-user:happier-daemon.preview.preview1',
            mode: 'user',
            definitionPath: '/home/tester/.config/systemd/user/happier-daemon.preview.preview1.service',
          }),
        ],
      }));
      expect(uninstallDaemonServiceMock).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('treats --all without --yes as a preview even when only one service matches', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
    });
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValue([
      createInstalledEntry({
        serverId: 'preview1',
        label: 'happier-daemon.preview.preview1',
        releaseChannel: 'preview',
        path: '/home/tester/.config/systemd/user/happier-daemon.preview.preview1.service',
        mode: 'user',
      }),
    ]);

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      executed: boolean;
      selectedServices: Array<{ id: string; mode?: string; definitionPath?: string }>;
    }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      await runDaemonServiceCliCommand({ argv: ['uninstall', '--ring', 'preview', '--all', '--json'] });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        executed: false,
        selectedServices: [expect.objectContaining({
          id: 'systemd-user:happier-daemon.preview.preview1',
          mode: 'user',
          definitionPath: '/home/tester/.config/systemd/user/happier-daemon.preview.preview1.service',
        })],
      }));
      expect(uninstallDaemonServiceMock).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('fails when explicit selectors match multiple services without --all', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
    });
    discoverInstalledDaemonServiceEntriesMock.mockResolvedValue([
      createInstalledEntry({
        serverId: 'cloud',
        label: 'happier-daemon.stable.cloud',
        releaseChannel: 'stable',
        path: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.service',
        mode: 'user',
      }),
      createInstalledEntry({
        serverId: 'cloud',
        label: 'happier-daemon.preview.cloud',
        releaseChannel: 'preview',
        path: '/home/tester/.config/systemd/user/happier-daemon.preview.cloud.service',
        mode: 'user',
      }),
    ]);

    const { runDaemonServiceCliCommand } = await import('./cli.js');
    await expect(runDaemonServiceCliCommand({ argv: ['uninstall', '--instance', 'cloud', '--json'] })).rejects.toThrow(
      'Multiple background services matched the requested uninstall target. Re-run with --all or add more specific filters.',
    );
  });
});
