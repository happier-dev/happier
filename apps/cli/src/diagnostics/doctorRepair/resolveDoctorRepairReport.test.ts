import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const runtimeFixture = {
  platform: 'linux' as const,
  channel: 'preview' as const,
  targetMode: 'default-following' as const,
  instanceId: 'cloud',
  uid: 1000,
  userHomeDir: '/tmp/user',
  happierHomeDir: '/tmp/user/.happier',
  serverUrl: 'https://api.happier.dev',
  publicServerUrl: 'https://api.happier.dev',
  webappUrl: 'https://app.happier.dev',
  nodePath: '/usr/bin/node',
  entryPath: '',
};

const {
  readDoctorRuntimeInventoryMock,
  resolveBackgroundServiceRepairPlanForCurrentRuntimeMock,
  resolveDaemonServiceCliRuntimeFromEnvMock,
  resolveDaemonServiceInventoryEntriesMock,
  resolveInvokerNameMock,
} = vi.hoisted(() => ({
  readDoctorRuntimeInventoryMock: vi.fn(),
  resolveBackgroundServiceRepairPlanForCurrentRuntimeMock: vi.fn(),
  resolveDaemonServiceCliRuntimeFromEnvMock: vi.fn(),
  resolveDaemonServiceInventoryEntriesMock: vi.fn(),
  resolveInvokerNameMock: vi.fn(() => 'hprev'),
}));

vi.mock('@/daemon/service/cli', () => ({
  resolveDaemonServiceCliRuntimeFromEnv: (params?: unknown) => resolveDaemonServiceCliRuntimeFromEnvMock(params),
  resolveDaemonServiceInventoryEntries: (params?: unknown) => resolveDaemonServiceInventoryEntriesMock(params),
}));

vi.mock('@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime', () => ({
  resolveBackgroundServiceRepairPlanForCurrentRuntime: (params?: unknown) =>
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock(params),
}));

vi.mock('@/doctor/inv/runtime', () => ({
  readDoctorRuntimeInventory: () => readDoctorRuntimeInventoryMock(),
}));

vi.mock('@/cli/runtime/resolveInvokerName', () => ({
  resolveInvokerName: () => resolveInvokerNameMock(),
}));

describe('resolveDoctorRepairReport', () => {
  const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

  afterEach(() => {
    envScope.restore();
    resolveDaemonServiceCliRuntimeFromEnvMock.mockReset();
    resolveDaemonServiceInventoryEntriesMock.mockReset();
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockReset();
    readDoctorRuntimeInventoryMock.mockReset();
    resolveInvokerNameMock.mockClear();
    vi.resetModules();
  });

  it('reads the installed CLI version directly from a daemon binary path snapshot', async () => {
    await withTempDir('doctor-repair-cli-version-binary-path-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });

      const binaryPath = join(homeDir, 'cli-preview', 'current', 'happier');
      mkdirSync(join(homeDir, 'cli-preview', 'current'), { recursive: true });
      writeFileSync(binaryPath, '#!/bin/sh\necho 9.9.9-preview\n', 'utf8');
      chmodSync(binaryPath, 0o755);

      await writeDaemonSettingsFixture(homeDir, {
        activeServerId: 'cloud',
        servers: {
          cloud: {
            id: 'cloud',
            name: 'Happier Cloud',
            serverUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
      });

      resolveDaemonServiceCliRuntimeFromEnvMock.mockReturnValue(runtimeFixture);
      resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockResolvedValue({
        runtime: runtimeFixture,
        plan: {
          currentReleaseChannel: 'preview',
          existingServices: [],
          actions: [],
          manualWarnings: [],
        },
      });
      resolveDaemonServiceInventoryEntriesMock.mockResolvedValue([]);
      readDoctorRuntimeInventoryMock.mockResolvedValue({
        settings: {
          schemaVersion: 5,
          onboardingCompleted: false,
          activeServerId: 'cloud',
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Happier Cloud',
              serverUrl: 'https://api.happier.dev',
              publicServerUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
              createdAt: 0,
              updatedAt: 0,
              lastUsedAt: 0,
            },
          },
        },
        credentials: null,
        daemonStatus: {
          server: {
            activeServerId: 'cloud',
            serverUrl: 'https://api.happier.dev',
            localServerUrl: 'http://127.0.0.1:3005',
            publicServerUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
            comparableKey: 'https://api.happier.dev',
          },
          daemon: {
            running: false,
            pid: 1234,
            httpPort: 3005,
            startedWithCliVersion: '9.9.9-preview',
            startedWithPublicReleaseChannel: 'preview',
            startupSource: 'background-service',
            serviceManaged: true,
            serviceLabel: 'com.happier.cli.daemon.preview.default',
            binaryPath,
          },
          service: {
            installed: true,
            running: false,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine_1',
            needsAuth: false,
            accountId: 'acct_1',
          },
        },
        installations: {
          activeInvocation: null,
          installations: [],
        },
        services: {
          services: [],
        },
        warnings: [],
        localRelays: {
          relays: [],
        },
      });

      const { resolveDoctorRepairReport } = await import('./resolveDoctorRepairReport');
      const result = await resolveDoctorRepairReport({
        preferredMode: 'user',
        systemUser: 'tester',
      });

      expect(result.report.currentCli.binaryPath).toBe(binaryPath);
      expect(result.report.currentCli.version).toBe('9.9.9-preview');
      expect(readDoctorRuntimeInventoryMock).toHaveBeenCalledTimes(1);
    });
  });
});
