import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const {
  discoverHappierInstallationsMock,
  discoverHappierServicesMock,
  uninstallManagedFirstPartyComponentMock,
  uninstallDaemonServiceMock,
} = vi.hoisted(() => ({
  discoverHappierInstallationsMock: vi.fn(),
  discoverHappierServicesMock: vi.fn(),
  uninstallManagedFirstPartyComponentMock: vi.fn(async () => ({ removedPaths: ['/Users/tester/.happier/cli', '/Users/tester/.happier/bin/happier'] })),
  uninstallDaemonServiceMock: vi.fn(async () => undefined),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/cli-common/happierRuntime')>('@happier-dev/cli-common/happierRuntime');
  return {
    ...actual,
    discoverHappierInstallations: discoverHappierInstallationsMock,
    discoverHappierServices: discoverHappierServicesMock,
  };
});

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/cli-common/firstPartyRuntime')>('@happier-dev/cli-common/firstPartyRuntime');
  return {
    ...actual,
    uninstallManagedFirstPartyComponent: uninstallManagedFirstPartyComponentMock,
  };
});

vi.mock('@/daemon/service/installer', () => ({
  uninstallDaemonService: uninstallDaemonServiceMock,
}));

describe('happier uninstall', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('previews managed CLI uninstall by default and includes matching daemon services', async () => {
    discoverHappierInstallationsMock.mockResolvedValue({
      activeInvocation: {
        path: '/Users/tester/.happier/bin/happier',
        realPath: '/Users/tester/.happier/cli/current/happier',
        invokerName: 'happier',
        ring: 'stable',
        version: '1.2.3',
        installationId: 'managed:stable:/Users/tester/.happier/cli/current',
      },
      installations: [
        {
          id: 'managed:stable:/Users/tester/.happier/cli/current',
          source: 'firstPartyManaged',
          components: ['happier-cli', 'happier-daemon'],
          ring: 'stable',
          version: '1.2.3',
          path: '/Users/tester/.happier/cli/current',
          realPath: '/Users/tester/.happier/cli/current',
          shimName: 'happier',
          onPath: true,
          managedRoot: '/Users/tester/.happier/cli',
        },
      ],
    });
    discoverHappierServicesMock.mockResolvedValue({
      services: [
        {
          id: 'systemd-user:happier-daemon.stable.cloud',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.stable.cloud',
          verification: 'verified',
          ring: 'stable',
          instanceId: 'cloud',
          scope: 'user',
          definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.service',
          executablePath: '/Users/tester/.happier/cli/current/happier',
          installed: true,
          running: true,
        },
        {
          id: 'systemd-user:happier-daemon.preview.preview1',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.preview.preview1',
          verification: 'verified',
          ring: 'preview',
          instanceId: 'preview1',
          scope: 'user',
          definitionPath: '/home/tester/.config/systemd/user/happier-daemon.preview.preview1.service',
          executablePath: '/Users/tester/.happier/cli-preview/current/happier',
          installed: true,
          running: false,
        },
      ],
    });

    const output = captureStdoutJsonOutput<{ ok: boolean; executed: boolean; serviceTargets: Array<{ id: string }> }>();
    try {
      const { handleUninstallCliCommand } = await import('./uninstall.js');
      await handleUninstallCliCommand({
        args: ['uninstall', '--json'],
        rawArgv: ['node', 'happier', 'uninstall', '--json'],
        terminalRuntime: null,
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        executed: false,
        serviceTargets: [
          expect.objectContaining({ id: 'systemd-user:happier-daemon.stable.cloud' }),
        ],
      }));
      expect(uninstallManagedFirstPartyComponentMock).not.toHaveBeenCalled();
      expect(uninstallDaemonServiceMock).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('executes managed CLI uninstall and removes matching daemon services when --yes is provided', async () => {
    discoverHappierInstallationsMock.mockResolvedValue({
      activeInvocation: {
        path: '/Users/tester/.happier/bin/happier',
        realPath: '/Users/tester/.happier/cli/current/happier',
        invokerName: 'happier',
        ring: 'stable',
        version: '1.2.3',
        installationId: 'managed:stable:/Users/tester/.happier/cli/current',
      },
      installations: [
        {
          id: 'managed:stable:/Users/tester/.happier/cli/current',
          source: 'firstPartyManaged',
          components: ['happier-cli', 'happier-daemon'],
          ring: 'stable',
          version: '1.2.3',
          path: '/Users/tester/.happier/cli/current',
          realPath: '/Users/tester/.happier/cli/current',
          shimName: 'happier',
          onPath: true,
          managedRoot: '/Users/tester/.happier/cli',
        },
      ],
    });
    discoverHappierServicesMock.mockResolvedValue({
      services: [
        {
          id: 'systemd-user:happier-daemon.stable.cloud',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.stable.cloud',
          verification: 'verified',
          ring: 'stable',
          instanceId: 'cloud',
          scope: 'user',
          definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.service',
          executablePath: '/Users/tester/.happier/cli/current/happier',
          installed: true,
          running: true,
        },
      ],
    });

    const output = captureStdoutJsonOutput<{ ok: boolean; executed: boolean }>();
    try {
      const { handleUninstallCliCommand } = await import('./uninstall.js');
      await handleUninstallCliCommand({
        args: ['uninstall', '--yes', '--json'],
        rawArgv: ['node', 'happier', 'uninstall', '--yes', '--json'],
        terminalRuntime: null,
      });

      expect(output.json()).toEqual(expect.objectContaining({ ok: true, executed: true }));
      expect(uninstallManagedFirstPartyComponentMock).toHaveBeenCalledWith(expect.objectContaining({
        componentId: 'happier-cli',
        channel: 'stable',
      }));
      expect(uninstallDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        instanceId: 'cloud',
        runCommands: true,
      }));
    } finally {
      output.restore();
    }
  });

  it('returns unsupported source guidance when the active invocation is from a source checkout', async () => {
    discoverHappierInstallationsMock.mockResolvedValue({
      activeInvocation: {
        path: '/repo/apps/cli/bin/happier.mjs',
        realPath: '/repo/apps/cli/bin/happier.mjs',
        invokerName: 'happier',
        ring: 'stable',
        version: '1.2.3-dev',
        installationId: 'fromSource:/repo/apps/cli/bin/happier.mjs',
      },
      installations: [],
    });
    discoverHappierServicesMock.mockResolvedValue({ services: [] });

    const output = captureStdoutJsonOutput<{ ok: boolean; error: string; source: string; manualCommands: string[] }>();
    try {
      const { handleUninstallCliCommand } = await import('./uninstall.js');
      await handleUninstallCliCommand({
        args: ['uninstall', '--json'],
        rawArgv: ['node', 'happier', 'uninstall', '--json'],
        terminalRuntime: null,
      });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: false,
        error: 'unsupported_install_source',
        source: 'fromSource',
        manualCommands: [
          'Remove the binary or checkout manually, then run `happier daemon service list --json` to inspect leftover services.',
        ],
      }));
      expect(uninstallManagedFirstPartyComponentMock).not.toHaveBeenCalled();
      expect(uninstallDaemonServiceMock).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });
});
