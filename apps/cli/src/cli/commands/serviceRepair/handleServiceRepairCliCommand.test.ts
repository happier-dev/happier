import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '../../../testkit/logger/captureOutput';

type RepairRuntime = Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  channel: 'stable' | 'preview' | 'publicdev';
  targetMode: 'default-following' | 'pinned';
  instanceId: string;
  uid: number | null;
  userHomeDir: string;
  happierHomeDir: string;
  serverUrl: string;
  publicServerUrl: string;
  webappUrl: string;
  nodePath: string;
  entryPath: string;
}>;

type RepairPlan = Readonly<{
  currentReleaseChannel: string;
  existingServices: readonly unknown[];
  actions: readonly unknown[];
  manualWarnings: readonly string[];
}>;

type RepairResolution = Readonly<{
  runtime: RepairRuntime;
  services: readonly unknown[];
  scannedModes: readonly ('user' | 'system')[];
  plan: RepairPlan;
}>;

const {
  applyBackgroundServiceRepairPlanMock,
  evaluateCurrentDaemonOwnerMock,
  renderDaemonServiceRepairOwnershipNoteMock,
  resolveBackgroundServiceRepairPlanForCurrentRuntimeMock,
} = vi.hoisted(() => ({
  applyBackgroundServiceRepairPlanMock: vi.fn(async (_plan: unknown, _runtime: unknown): Promise<Readonly<{ executedActions: readonly string[] }>> => ({
    executedActions: [],
  })),
  evaluateCurrentDaemonOwnerMock: vi.fn(async (): Promise<Readonly<{ kind: 'none' | 'manual' }>> => ({
    kind: 'none',
  })),
  renderDaemonServiceRepairOwnershipNoteMock: vi.fn((_: unknown): Readonly<{ title: string; lines: readonly string[] } | null> => null),
  resolveBackgroundServiceRepairPlanForCurrentRuntimeMock: vi.fn(async (_: unknown): Promise<RepairResolution> => ({
    runtime: {
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
    },
    services: [],
    scannedModes: ['user'],
    plan: {
      currentReleaseChannel: 'stable',
      existingServices: [],
      actions: [],
      manualWarnings: [],
    },
  })),
}));

vi.mock('../../../diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime', () => ({
  resolveBackgroundServiceRepairPlanForCurrentRuntime: (params: unknown) => resolveBackgroundServiceRepairPlanForCurrentRuntimeMock(params),
}));

vi.mock('../../../diagnostics/backgroundServiceRepair', () => ({
  applyBackgroundServiceRepairPlan: (plan: unknown, runtime: unknown) => applyBackgroundServiceRepairPlanMock(plan, runtime),
}));

vi.mock('../../../daemon/ownership/evaluateCurrentDaemonOwner', () => ({
  evaluateCurrentDaemonOwner: () => evaluateCurrentDaemonOwnerMock(),
}));

vi.mock('../../../daemon/ownership/evaluateServiceLifecycleOwnership', () => ({
  renderDaemonServiceRepairOwnershipNote: (params: unknown) => renderDaemonServiceRepairOwnershipNoteMock(params),
}));

vi.mock('../server/commandUtilities', () => ({
  isInteractiveTerminal: () => false,
  promptInput: vi.fn(async () => ''),
}));

import { handleServiceRepairCliCommand } from './handleServiceRepairCliCommand';

describe('happier service repair', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    applyBackgroundServiceRepairPlanMock.mockClear();
    evaluateCurrentDaemonOwnerMock.mockClear();
    renderDaemonServiceRepairOwnershipNoteMock.mockClear();
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockClear();
  });

  it('infers systemUser from SUDO_USER for linux system-mode repair when not explicitly provided', async () => {
    const originalSudoUser = process.env.SUDO_USER;
    process.env.SUDO_USER = 'alice';

    try {
      resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockResolvedValueOnce({
        runtime: {
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
        },
        services: [],
        scannedModes: ['system'],
        plan: {
          currentReleaseChannel: 'stable',
          existingServices: [],
          actions: [],
          manualWarnings: [],
        },
      });

      await handleServiceRepairCliCommand({
        argv: ['repair', '--mode', 'system'],
        commandPath: 'happier service',
      });

      expect(resolveBackgroundServiceRepairPlanForCurrentRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
        preferredMode: 'system',
        systemUser: 'alice',
      }));
    } finally {
      process.env.SUDO_USER = originalSudoUser;
    }
  });

  it('fails closed when a system-mode repair plan needs systemUser but none is available', async () => {
    const originalSudoUser = process.env.SUDO_USER;
    delete process.env.SUDO_USER;

    try {
      resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockResolvedValueOnce({
        runtime: {
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
        },
        services: [],
        scannedModes: ['system'],
        plan: {
          currentReleaseChannel: 'stable',
          existingServices: [],
          actions: [{ kind: 'install-default-following-service', mode: 'system' }],
          manualWarnings: [],
        },
      });

      await expect(handleServiceRepairCliCommand({
        argv: ['repair', '--mode', 'system', '--yes'],
        commandPath: 'happier service',
      })).rejects.toThrow('System mode background-service repair requires --system-user');

      expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
    } finally {
      process.env.SUDO_USER = originalSudoUser;
    }
  });

  it('fails closed when executing system-scoped repair on linux without root privileges', async () => {
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockResolvedValueOnce({
      runtime: {
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
      },
      services: [],
      scannedModes: ['system'],
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
    });

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required for system mode background-service repair');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('fails closed for system-scoped json repair on linux without root privileges', async () => {
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockResolvedValueOnce({
      runtime: {
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
      },
      services: [],
      scannedModes: ['system'],
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
    });

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes', '--json'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required for system mode background-service repair');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('rejects system-scoped repair on unsupported platforms', async () => {
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockResolvedValueOnce({
      runtime: {
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
      },
      services: [],
      scannedModes: ['user'],
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
    });

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--mode', 'system', '--yes'],
      commandPath: 'happier service',
    })).rejects.toThrow('System mode background services are only supported on Linux');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });

  it('reports a manual relay owner warning in JSON output', async () => {
    evaluateCurrentDaemonOwnerMock.mockResolvedValueOnce({ kind: 'manual' });
    renderDaemonServiceRepairOwnershipNoteMock.mockReturnValueOnce({
      title: 'Ownership note',
      lines: ['Repairing background services will not stop the current relay owner.'],
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

  it('fails closed when a mixed user and system repair plan would require root', async () => {
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockResolvedValueOnce({
      runtime: {
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
      },
      services: [],
      scannedModes: ['user', 'system'],
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [
          {
            kind: 'remove-service',
            service: {
              label: 'happier-daemon.default',
              installedPath: '/etc/systemd/system/happier-daemon.default.service',
              mode: 'system',
              releaseChannel: 'stable',
              targetMode: 'default-following',
              instanceId: 'default',
            },
          },
        ],
        manualWarnings: [],
      },
    });

    await expect(handleServiceRepairCliCommand({
      argv: ['repair', '--yes', '--json'],
      commandPath: 'happier service',
    })).rejects.toThrow('Root privileges are required to apply system mode background-service repair actions');

    expect(applyBackgroundServiceRepairPlanMock).not.toHaveBeenCalled();
  });
});
