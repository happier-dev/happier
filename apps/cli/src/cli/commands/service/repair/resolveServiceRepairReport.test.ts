import { describe, expect, it, vi } from 'vitest';

const {
  buildHappierRuntimeWarningsMock,
  discoverHappierInstallationsMock,
  discoverHappierServicesMock,
  listDaemonStatusesForAllKnownServersMock,
  readCredentialsMock,
  readDaemonStatusSnapshotMock,
  readStatusMock,
  resolveBackgroundServiceRepairPlanForCurrentRuntimeMock,
  validateStoredAuthTokenAgainstActiveServerMock,
} = vi.hoisted(() => ({
  buildHappierRuntimeWarningsMock: vi.fn((_params: unknown) => []),
  discoverHappierInstallationsMock: vi.fn(async (_params: unknown) => ({
    activeInvocation: null,
    installations: [],
  })),
  discoverHappierServicesMock: vi.fn(async (_params: unknown) => ({
    services: [],
  })),
  listDaemonStatusesForAllKnownServersMock: vi.fn(async () => [
    {
      serverId: 'cloud',
      name: 'Cloud',
      serverUrl: 'https://relay.example.test',
      comparableKey: 'https://relay.example.test',
      daemonStatePath: '/tmp/daemon-state.json',
      auth: {
        authenticated: true,
        needsAuth: false,
        machineRegistered: true,
        machineId: 'machine-1',
        accountId: 'account-1',
      },
      drift: {
        activeComparableKey: 'https://relay.example.test',
        matchesActiveRelay: true,
      },
      service: {
        installed: true,
        running: false,
      },
      daemon: {
        pid: null,
        httpPort: null,
        running: false,
        staleStateFile: false,
      },
    },
  ]),
  readDaemonStatusSnapshotMock: vi.fn(async () => null),
  readCredentialsMock: vi.fn(async () => ({
    token: 'token-1',
    encryption: { type: 'plain' },
  })),
  readStatusMock: vi.fn(async (_params: unknown) => ({
    installed: false,
    baseUrl: null,
    service: { active: false },
    healthy: null,
    version: null,
    warnings: [],
  })),
  resolveBackgroundServiceRepairPlanForCurrentRuntimeMock: vi.fn(async (_params: unknown) => ({
    runtime: {
      platform: 'linux',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'cloud',
      uid: 1000,
      userHomeDir: '/home/test',
      happierHomeDir: '/home/test/.happier',
      serverUrl: 'https://relay.example.test',
      publicServerUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
      nodePath: '/usr/bin/node',
      entryPath: '/opt/happier/index.mjs',
    },
    services: [],
    scannedModes: ['user'],
    plan: {
      currentReleaseChannel: 'stable',
      existingServices: [
        {
          name: 'Happier',
          label: 'happier-daemon.default',
          mode: 'user',
          releaseChannel: 'preview',
          targetMode: 'default-following',
          serverId: 'cloud',
          installed: true,
          path: '/home/test/.config/systemd/user/happier-daemon.default.service',
          platform: 'linux',
        },
      ],
      actions: [],
      manualWarnings: [],
    },
  })),
  validateStoredAuthTokenAgainstActiveServerMock: vi.fn(async (_token: string): Promise<
    | Readonly<{ state: 'valid'; httpStatus: number }>
    | Readonly<{ state: 'invalid'; httpStatus: number; reasonCode: string }>
  > => ({
    state: 'valid' as const,
    httpStatus: 200,
  })),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', () => ({
  buildHappierRuntimeWarnings: (params: unknown) => buildHappierRuntimeWarningsMock(params),
  discoverHappierInstallations: (params: unknown) => discoverHappierInstallationsMock(params),
  discoverHappierServices: (params: unknown) => discoverHappierServicesMock(params),
}));

vi.mock('@happier-dev/cli-common/relayHost', () => ({
  createRelayHostEngine: () => ({
    readStatus: (params: unknown) => readStatusMock(params),
  }),
}));

vi.mock('@/daemon/multiDaemon', () => ({
  listDaemonStatusesForAllKnownServers: () => listDaemonStatusesForAllKnownServersMock(),
}));

vi.mock('@/daemon/statusSnapshot', () => ({
  readDaemonStatusSnapshot: () => readDaemonStatusSnapshotMock(),
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: (token: string) =>
    validateStoredAuthTokenAgainstActiveServerMock(token),
}));

vi.mock('@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime', () => ({
  resolveBackgroundServiceRepairPlanForCurrentRuntime: (params: unknown) =>
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock(params),
}));

vi.mock('@/persistence', () => ({
  readCredentials: () => readCredentialsMock(),
}));

import { resolveServiceRepairReport } from './resolveServiceRepairReport';

describe('resolveServiceRepairReport', () => {
  it('uses repair-plan service release channels when building active stack findings', async () => {
    const resolution = await resolveServiceRepairReport({
      preferredMode: 'user',
      includeAllModes: true,
      systemUser: '',
    });

    expect(resolution.report.stacks).toEqual([
      expect.objectContaining({
        id: 'cloud',
        releaseChannel: 'preview',
        active: true,
      }),
    ]);
    expect(resolution.report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'channel_switch_recommended',
        actions: [
          {
            kind: 'switch-release-channel',
            releaseChannel: 'preview',
            command: 'happier self release-channel use preview',
          },
        ],
      }),
    ]));
  });

  it('reports expired auth when active Relay credentials are rejected', async () => {
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValueOnce({
      state: 'invalid',
      httpStatus: 401,
      reasonCode: 'not_authenticated',
    });

    const resolution = await resolveServiceRepairReport({
      preferredMode: 'user',
      includeAllModes: true,
      systemUser: '',
    });

    expect(validateStoredAuthTokenAgainstActiveServerMock).toHaveBeenCalledWith('token-1');
    expect(resolution.report.authProfiles).toEqual([
      expect.objectContaining({
        id: 'cloud',
        active: true,
        authenticated: true,
        authState: 'expired',
      }),
    ]);
    expect(resolution.report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'auth_expired_for_active_profile',
      }),
    ]));
  });
});
