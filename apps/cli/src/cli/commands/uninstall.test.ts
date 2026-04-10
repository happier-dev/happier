import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const {
  discoverHappierInstallationsMock,
  discoverHappierServicesMock,
  applyCliUninstallPlanMock,
} = vi.hoisted(() => ({
  discoverHappierInstallationsMock: vi.fn(),
  discoverHappierServicesMock: vi.fn(),
  applyCliUninstallPlanMock: vi.fn(async ({ plan }) => (
    plan.kind === 'npm-global-installation'
      ? {
          removedPaths: [plan.installation.path],
          serviceTargets: [],
          actions: [{
            command: [plan.command.cmd, ...plan.command.args].join(' '),
            reason: 'npm-global-installation',
          }],
        }
      : {
          removedPaths: ['/Users/tester/.happier/cli', '/Users/tester/.happier/bin/happier'],
          serviceTargets: [],
        }
  )),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/cli-common/happierRuntime')>('@happier-dev/cli-common/happierRuntime');
  return {
    ...actual,
    discoverHappierInstallations: discoverHappierInstallationsMock,
    discoverHappierServices: discoverHappierServicesMock,
    applyCliUninstallPlan: applyCliUninstallPlanMock,
  };
});

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
      expect(applyCliUninstallPlanMock).not.toHaveBeenCalled();
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
      expect(applyCliUninstallPlanMock).toHaveBeenCalledWith(expect.objectContaining({
        plan: expect.objectContaining({
          channel: 'stable',
        }),
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
          'Remove the binary or checkout manually, then run `happier service list --json` to inspect leftover services.',
        ],
      }));
      expect(applyCliUninstallPlanMock).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('executes npm-global uninstall directly when the active invocation resolves to a canonical npm install', async () => {
    discoverHappierInstallationsMock.mockResolvedValue({
      activeInvocation: {
        path: '/opt/homebrew/bin/happier',
        realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli/bin/happier.mjs',
        invokerName: 'happier',
        ring: 'stable',
        version: '0.1.0-preview.1771774953.99369',
        installationId: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
      },
      installations: [
        {
          id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
          source: 'npmGlobal',
          components: ['happier-cli', 'happier-daemon'],
          ring: 'stable',
          version: '0.1.0-preview.1771774953.99369',
          path: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
          realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
          shimName: 'happier',
          onPath: true,
          managedRoot: '/opt/homebrew',
          packageManager: {
            kind: 'npmGlobal',
            executablePath: '/opt/homebrew/bin/npm',
            packageName: '@happier-dev/cli',
          },
        },
      ],
    });
    discoverHappierServicesMock.mockResolvedValue({ services: [] });

    const output = captureStdoutJsonOutput<{ ok: boolean; executed: boolean; removedPaths: string[]; actions: Array<{ command: string }> }>();
    try {
      const { handleUninstallCliCommand } = await import('./uninstall.js');
      await handleUninstallCliCommand({
        args: ['uninstall', '--yes', '--json'],
        rawArgv: ['node', 'happier', 'uninstall', '--yes', '--json'],
        terminalRuntime: null,
      });

      expect(output.json()).toEqual({
        ok: true,
        executed: true,
        removedPaths: ['/opt/homebrew/lib/node_modules/@happier-dev/cli'],
        actions: [
          { command: '/opt/homebrew/bin/npm uninstall -g @happier-dev/cli', reason: 'npm-global-installation' },
        ],
      });
      expect(applyCliUninstallPlanMock).toHaveBeenCalledTimes(1);
    } finally {
      output.restore();
    }
  });

  it('reports a root-required error instead of uninstalling a system-scoped service as a non-root user', async () => {
    const processWithGetuid = process as NodeJS.Process & { getuid?: () => number };
    const originalGetuid = processWithGetuid.getuid;
    if (typeof originalGetuid === 'function') {
      processWithGetuid.getuid = () => 501;
    }
    discoverHappierInstallationsMock.mockResolvedValue({
      activeInvocation: {
        path: '/Users/tester/.happier/bin/happier',
        realPath: '/Users/tester/.happier/cli/current/happier',
        invokerName: 'happier',
        ring: 'stable',
        version: '0.2.0',
        installationId: 'managed:stable:/Users/tester/.happier/cli/current',
      },
      installations: [
        {
          id: 'managed:stable:/Users/tester/.happier/cli/current',
          source: 'firstPartyManaged',
          components: ['happier-cli', 'happier-daemon'],
          ring: 'stable',
          version: '0.2.0',
          path: '/Users/tester/.happier/cli/current',
          realPath: '/Users/tester/.happier/cli/current',
          shimName: 'happier',
          onPath: true,
          managedRoot: '/Users/tester/.happier/cli',
          packageManager: null,
        },
      ],
    });
    discoverHappierServicesMock.mockResolvedValue({
      services: [
        {
          id: 'systemd-system:happier-daemon.stable.cloud',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-system',
          label: 'happier-daemon.stable.cloud',
          verification: 'verified',
          targetMode: 'default-following',
          ring: 'stable',
          instanceId: 'cloud',
          scope: 'system',
          definitionPath: '/etc/systemd/system/happier-daemon.stable.cloud.service',
          executablePath: '/Users/tester/.happier/cli/current/happier',
          installed: true,
          running: true,
        },
      ],
    });

    const output = captureStdoutJsonOutput<{
      ok: boolean;
      error: string;
      manualCommands: string[];
    }>();
    try {
      const { handleUninstallCliCommand } = await import('./uninstall.js');
      await handleUninstallCliCommand({
        args: ['uninstall', '--yes', '--json'],
        rawArgv: ['node', 'happier', 'uninstall', '--yes', '--json'],
        terminalRuntime: null,
      });

      expect(output.json()).toEqual({
        ok: false,
        error: 'root_privileges_required',
        manualCommands: ['sudo happier uninstall --yes'],
      });
      expect(applyCliUninstallPlanMock).not.toHaveBeenCalled();
    } finally {
      processWithGetuid.getuid = originalGetuid;
      output.restore();
    }
  });
});
