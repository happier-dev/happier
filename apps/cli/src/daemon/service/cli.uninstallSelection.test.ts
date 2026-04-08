import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const {
  discoverHappierServicesMock,
  uninstallDaemonServiceMock,
} = vi.hoisted(() => ({
  discoverHappierServicesMock: vi.fn(),
  uninstallDaemonServiceMock: vi.fn(async () => undefined),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/cli-common/happierRuntime')>('@happier-dev/cli-common/happierRuntime');
  return {
    ...actual,
    discoverHappierServices: discoverHappierServicesMock,
  };
});

vi.mock('./installer', async () => {
  const actual = await vi.importActual<typeof import('./installer')>('./installer');
  return {
    ...actual,
    uninstallDaemonService: uninstallDaemonServiceMock,
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
          executablePath: '/home/tester/.happier/cli/current/happier',
          installed: true,
          running: true,
        },
        {
          id: 'systemd-user:happier-daemon.stable.company',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.stable.company',
          verification: 'verified',
          ring: 'stable',
          instanceId: 'company',
          scope: 'user',
          definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.company.service',
          executablePath: '/home/tester/.happier/cli/current/happier',
          installed: true,
          running: false,
        },
        {
          id: 'systemd-user:unverified',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.stable.candidate',
          verification: 'candidate',
          ring: 'stable',
          instanceId: 'candidate',
          scope: 'user',
          definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.candidate.service',
          executablePath: '/tmp/candidate',
          installed: true,
          running: false,
        },
      ],
    });

    const output = captureStdoutJsonOutput<{ ok: boolean; executed: boolean; selectedServices: Array<{ id: string }> }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      await runDaemonServiceCliCommand({ argv: ['uninstall', '--ring', 'stable', '--all', '--json'] });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        executed: false,
        selectedServices: [
          expect.objectContaining({ id: 'systemd-user:happier-daemon.stable.cloud' }),
          expect.objectContaining({ id: 'systemd-user:happier-daemon.stable.company' }),
        ],
      }));
      expect(uninstallDaemonServiceMock).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('executes selected verified services when --all and --yes are provided', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
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
          executablePath: '/home/tester/.happier/cli/current/happier',
          installed: true,
          running: true,
        },
        {
          id: 'systemd-user:happier-daemon.stable.company',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.stable.company',
          verification: 'verified',
          ring: 'stable',
          instanceId: 'company',
          scope: 'user',
          definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.company.service',
          executablePath: '/home/tester/.happier/cli/current/happier',
          installed: true,
          running: false,
        },
      ],
    });

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
        runCommands: true,
      }));
      expect(uninstallDaemonServiceMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        instanceId: 'company',
        runCommands: true,
      }));
    } finally {
      output.restore();
    }
  });

  it('treats --all without explicit filters as all verified services for the current mode/platform', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
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
          executablePath: '/home/tester/.happier/cli/current/happier',
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
          executablePath: '/home/tester/.happier/cli-preview/current/happier',
          installed: true,
          running: false,
        },
        {
          id: 'systemd-system:happier-daemon.dev.system1',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-system',
          label: 'happier-daemon.dev.system1',
          verification: 'verified',
          ring: 'dev',
          instanceId: 'system1',
          scope: 'system',
          definitionPath: '/etc/systemd/system/happier-daemon.dev.system1.service',
          executablePath: '/home/tester/.happier/cli-dev/current/happier',
          installed: true,
          running: false,
        },
      ],
    });

    const output = captureStdoutJsonOutput<{ ok: boolean; executed: boolean; selectedServices: Array<{ id: string }> }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      await runDaemonServiceCliCommand({ argv: ['uninstall', '--all', '--json'] });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        executed: false,
        selectedServices: [
          expect.objectContaining({ id: 'systemd-user:happier-daemon.stable.cloud' }),
          expect.objectContaining({ id: 'systemd-user:happier-daemon.preview.preview1' }),
        ],
      }));
      expect(uninstallDaemonServiceMock).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('treats --all without --yes as a preview even when only one verified service matches', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
    });
    discoverHappierServicesMock.mockResolvedValue({
      services: [
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
          executablePath: '/home/tester/.happier/cli-preview/current/happier',
          installed: true,
          running: false,
        },
      ],
    });

    const output = captureStdoutJsonOutput<{ ok: boolean; executed: boolean; selectedServices: Array<{ id: string }> }>();
    try {
      const { runDaemonServiceCliCommand } = await import('./cli.js');
      await runDaemonServiceCliCommand({ argv: ['uninstall', '--ring', 'preview', '--all', '--json'] });

      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        executed: false,
        selectedServices: [expect.objectContaining({ id: 'systemd-user:happier-daemon.preview.preview1' })],
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
          executablePath: '/home/tester/.happier/cli/current/happier',
          installed: true,
          running: true,
        },
        {
          id: 'systemd-user:happier-daemon.preview.cloud',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.preview.cloud',
          verification: 'verified',
          ring: 'preview',
          instanceId: 'cloud',
          scope: 'user',
          definitionPath: '/home/tester/.config/systemd/user/happier-daemon.preview.cloud.service',
          executablePath: '/home/tester/.happier/cli-preview/current/happier',
          installed: true,
          running: true,
        },
      ],
    });

    const { runDaemonServiceCliCommand } = await import('./cli.js');
    await expect(runDaemonServiceCliCommand({ argv: ['uninstall', '--instance', 'cloud', '--json'] })).rejects.toThrow(
      'Multiple verified background services matched the requested uninstall target. Re-run with --all or add more specific filters.',
    );
  });
});
