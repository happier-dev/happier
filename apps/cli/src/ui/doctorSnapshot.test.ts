import { describe, expect, it, vi } from 'vitest';

const inventoryInstallationsFixture = {
  activeInvocation: {
    path: '/mock/inventory/hprev',
    realPath: '/mock/inventory/hprev',
    invokerName: 'hprev',
    ring: 'preview',
    version: '9.9.9-preview.1',
    installationId: 'firstPartyManaged:preview',
  },
  installations: [
    {
      id: 'firstPartyManaged:preview',
      source: 'firstPartyManaged',
      components: ['happier-cli'],
      ring: 'preview',
      version: '9.9.9-preview.1',
      path: '/mock/inventory/hprev',
      realPath: '/mock/inventory/hprev',
      shimName: 'hprev',
      onPath: true,
      managedRoot: '/mock/inventory',
    },
  ],
} as const;

const inventoryServicesFixture = {
  services: [
    {
      id: 'mock-service',
      serviceType: 'daemon',
      platform: 'darwin',
      backend: 'launchd',
      label: 'com.happier.cli.daemon.preview.default',
      verification: 'verified',
      targetMode: 'default-following',
      ring: 'preview',
      instanceId: 'stack_main__id_default',
      scope: 'user',
      definitionPath: '/mock/LaunchAgents/com.happier.cli.daemon.preview.default.plist',
      executablePath: null,
      serverUrl: null,
      publicServerUrl: null,
      installed: true,
      running: true,
      configuredCliVersion: '9.9.9-preview.1',
      runningCliVersion: '9.9.9-preview.1',
    },
  ],
} as const;

const inventoryWarningsFixture = [
  {
    code: 'inventoryWarning',
    severity: 'warning',
    message: 'Inventory warning',
    repairCommands: ['happier doctor repair'],
  },
] as const;

const { readCredentialsMock, readSettingsMock } = vi.hoisted(() => ({
  readCredentialsMock: vi.fn(async () => null as { token: string } | null),
  readSettingsMock: vi.fn(async () => ({
    schemaVersion: 5,
    onboardingCompleted: false,
    activeServerId: 'cloud',
    servers: {
      cloud: {
        id: 'cloud',
        name: 'Happier Cloud',
        serverUrl: 'https://api.happier.dev?token=abc',
        publicServerUrl: 'https://api.happier.dev?token=abc',
        webappUrl: 'https://app.happier.dev?token=abc',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
      },
    },
    lastChangesCursorByServerIdByAccountId: {
      cloud: {
        acct_old: 10,
      },
    },
  })),
}));

const { readDaemonStatusSnapshotMock } = vi.hoisted(() => ({
  readDaemonStatusSnapshotMock: vi.fn(async () => ({
    server: {
      activeServerId: 'stack_main__id_default',
      serverUrl: 'http://127.0.0.1:3005',
      localServerUrl: 'http://127.0.0.1:3005',
      publicServerUrl: 'https://relay.happier.dev?token=abc',
      webappUrl: 'https://app.happier.dev?token=abc',
      comparableKey: 'https://relay.happier.dev',
    },
    daemon: {
      running: true,
      pid: 7777,
      httpPort: 3005,
      startedWithCliVersion: '1.2.3',
      startedWithPublicReleaseChannel: 'preview',
      startupSource: 'background-service',
      serviceManaged: true,
      serviceLabel: 'com.happier.cli.daemon.default',
    },
    service: {
      installed: true,
      running: true,
    },
    auth: {
      authenticated: true,
      machineRegistered: false,
      machineId: null,
      needsAuth: true,
      accountId: 'acct_123',
    },
  })),
}));

const {
  discoverHappierInstallationsMock,
  discoverHappierServicesMock,
  buildHappierRuntimeWarningsMock,
} = vi.hoisted(() => ({
  discoverHappierInstallationsMock: vi.fn(async (_args: unknown) => ({
    activeInvocation: null,
    installations: [],
  })),
  discoverHappierServicesMock: vi.fn(async (_args: unknown) => ({ services: [] })),
  buildHappierRuntimeWarningsMock: vi.fn((_args: unknown) => []),
}));

const {
  readDoctorInstallationsMock,
  readDoctorServicesMock,
  readDoctorWarningsMock,
  readDoctorRelaysMock,
} = vi.hoisted(() => ({
  readDoctorInstallationsMock: vi.fn(async () => inventoryInstallationsFixture),
  readDoctorServicesMock: vi.fn(async () => inventoryServicesFixture),
  readDoctorWarningsMock: vi.fn(async (_args: unknown) => inventoryWarningsFixture),
  readDoctorRelaysMock: vi.fn(async () => ({ relays: [] })),
}));

const { resolveServiceRepairReportMock } = vi.hoisted(() => ({
  resolveServiceRepairReportMock: vi.fn(async (_args: unknown) => ({
    report: {
      currentCli: {
        releaseChannel: 'preview',
        happierHomeDir: '/Users/tester/.happier',
        serverUrl: 'http://127.0.0.1:3005?token=abc',
        publicServerUrl: 'https://relay.happier.dev?token=abc',
      },
      daemonStatus: null,
      automaticStartup: [
        {
          id: 'launchd:com.happier.cli.daemon.preview.default',
          label: 'com.happier.cli.daemon.preview.default',
          platform: 'darwin',
          backend: 'launchd',
          scope: 'user',
          releaseChannel: 'preview',
          targetMode: 'default-following',
          instanceId: 'default',
          definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.default.plist',
          installed: true,
          running: true,
        },
      ],
      currentlyRunning: [],
      localRelays: [
        {
          id: 'local-relay-preview',
          releaseChannel: 'preview',
          url: 'http://127.0.0.1:3025?token=abc',
          active: true,
          installed: true,
          running: false,
          healthy: false,
          version: '0.2.1-preview.1',
          serviceEnabled: true,
        },
      ],
      authProfiles: [],
      stacks: [
        {
          id: 'stack_main__id_default',
          releaseChannel: 'preview',
          active: true,
        },
      ],
      findings: [
        {
          id: 'finding-1',
          kind: 'background_service_not_running',
          severity: 'warning',
          title: 'Background service is stopped',
          diagnostic: null,
          warningCode: null,
          entry: null,
          targetMode: null,
          actions: [
            {
              kind: 'run-command',
              command: 'happier service start',
            },
          ],
        },
      ],
      manualWarnings: ['Manual review needed.'],
    },
  })),
}));

const { resolveDoctorRepairReportMock } = vi.hoisted(() => ({
  resolveDoctorRepairReportMock: vi.fn(async (_args: unknown) => ({
    report: {
      currentCli: {
        releaseChannel: 'preview',
        ringId: 'preview',
        version: '0.2.1-preview.1',
        binaryPath: '/Users/tester/.happier/cli-preview/current/package-dist/index.mjs',
        shim: 'hprev',
        invoker: 'hprev',
        pathWinnerShim: 'hprev',
        pathWinnerResolvesToThisBinary: true,
      },
      automaticStartup: [
        {
          serverId: 'default',
          name: 'com.happier.cli.daemon.preview.default',
          releaseChannel: 'preview',
          ringId: 'preview',
          mode: 'user',
          targetMode: 'default-following',
          relayUrl: 'https://relay.happier.dev?token=abc',
          running: true,
          configuredCliVersion: '0.2.1-preview.1',
          runningCliVersion: '0.2.1-preview.1',
          path: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.default.plist',
          happierHomeDir: '/Users/tester/.happier',
          isForeignHome: false,
          installedDefinitionMatchesExpected: true,
          isLegacyChannelScoped: false,
          managedServerIds: ['stack_main__id_default'],
        },
      ],
      currentlyRunning: [],
      localRelays: [
        {
          releaseChannel: 'preview',
          ringId: 'preview',
          mode: 'user',
          version: '0.2.1-preview.1',
          serviceActive: false,
          serviceEnabled: true,
          healthy: false,
          relayUrl: 'http://127.0.0.1:3025?token=abc',
          port: 3025,
          installRoot: '/Users/tester/.happier/relay/preview',
        },
      ],
      authProfiles: [],
      hasAnyServerProfile: true,
      findings: [
        {
          kind: 'background_service_not_running',
          severity: 'warning',
          autoApplyWithoutPrompt: false,
        },
      ],
      manualWarnings: ['Manual review needed.'],
    },
    plan: {
      action: 'none',
      reason: null,
      command: null,
      commands: [],
      existingServices: [],
      manualWarnings: ['Manual review needed.'],
    },
    snapshot: null,
    runtime: {
      platform: 'darwin',
      happierHomeDir: '/Users/tester/.happier',
      channel: 'preview',
      entryPath: '/Users/tester/.happier/cli-preview/current/package-dist/index.mjs',
      instanceId: 'stack_main__id_default',
      uid: 501,
    },
    serviceInventory: [],
  })),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerId: 'stack_main__id_default',
    serverUrl: 'http://127.0.0.1:3005',
    publicServerUrl: 'http://127.0.0.1:3005',
    webappUrl: 'http://127.0.0.1:3005',
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: () => readCredentialsMock(),
  readSettings: () => readSettingsMock(),
}));

vi.mock('@/daemon/statusSnapshot', () => ({
  readDaemonStatusSnapshot: () => readDaemonStatusSnapshotMock(),
}));

vi.mock('@/doctor/inv/installs', () => ({
  readDoctorInstallations: () => readDoctorInstallationsMock(),
}));

vi.mock('@/doctor/inv/services', () => ({
  readDoctorServices: () => readDoctorServicesMock(),
}));

vi.mock('@/doctor/inv/warnings', () => ({
  readDoctorWarnings: (args: unknown) => readDoctorWarningsMock(args),
}));

vi.mock('@/doctor/inv/relays', () => ({
  readDoctorRelays: () => readDoctorRelaysMock(),
}));

vi.mock('@/cli/commands/service/repair/resolveServiceRepairReport', () => ({
  resolveServiceRepairReport: (args: unknown) => resolveServiceRepairReportMock(args),
}));

vi.mock('@/diagnostics/doctorRepair/resolveDoctorRepairReport', () => ({
  resolveDoctorRepairReport: (args: unknown) => resolveDoctorRepairReportMock(args),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', () => ({
  discoverHappierInstallations: (args: unknown) => discoverHappierInstallationsMock(args),
  discoverHappierServices: (args: unknown) => discoverHappierServicesMock(args),
  buildHappierRuntimeWarnings: (args: unknown) => buildHappierRuntimeWarningsMock(args),
}));

import { buildDoctorSnapshot } from './doctorSnapshot';

describe('buildDoctorSnapshot', () => {
  it('includes active server, settings server profiles, and decoded account id', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'acct_123' })).toString('base64url');
    readCredentialsMock.mockResolvedValueOnce({ token: `header.${payload}.sig` });

    const snapshot = await buildDoctorSnapshot();

    expect(snapshot.server.activeServerId).toBe('stack_main__id_default');
    expect(snapshot.server.serverUrl).toBe('http://127.0.0.1:3005');
    expect(snapshot.settings.activeServerId).toBe('cloud');
    expect(snapshot.settings.servers.map((entry) => entry.id)).toContain('cloud');
    expect(snapshot.accountId).toBe('acct_123');
    expect(snapshot.daemonStatus?.auth.needsAuth).toBe(true);
    expect(snapshot.daemonStatus?.server.publicServerUrl).toBe('https://relay.happier.dev');
    expect(snapshot.daemonStatus?.daemon.startedWithCliVersion).toBe('1.2.3');
    expect(snapshot.daemonStatus?.daemon.startedWithPublicReleaseChannel).toBe('preview');
    expect(snapshot.daemonStatus?.daemon.startupSource).toBe('background-service');
    expect(snapshot.daemonStatus?.daemon.serviceManaged).toBe(true);
    expect(snapshot.daemonStatus?.daemon.serviceLabel).toBe('com.happier.cli.daemon.default');
    expect(snapshot.installations?.happier).toEqual(inventoryInstallationsFixture);
    expect(snapshot.services?.happier?.services).toEqual([
      expect.objectContaining({
        id: 'mock-service',
        label: 'com.happier.cli.daemon.preview.default',
        ring: 'preview',
        running: true,
      }),
    ]);
    expect(snapshot.warnings).toEqual(inventoryWarningsFixture);
    expect(readDoctorInstallationsMock).toHaveBeenCalledTimes(1);
    expect(readDoctorServicesMock).toHaveBeenCalledTimes(1);
    expect(readDoctorRelaysMock).toHaveBeenCalledTimes(1);
    expect(readDoctorWarningsMock).toHaveBeenCalledWith({
      daemonStatus: expect.objectContaining({
        daemon: expect.objectContaining({
          running: true,
        }),
      }),
    });
    expect(discoverHappierInstallationsMock).not.toHaveBeenCalled();
    expect(discoverHappierServicesMock).not.toHaveBeenCalled();
    expect(buildHappierRuntimeWarningsMock).not.toHaveBeenCalled();
    expect(resolveDoctorRepairReportMock).toHaveBeenCalledWith(expect.objectContaining({
      preferredMode: 'user',
      systemUser: '',
      inventory: expect.objectContaining({
        installations: inventoryInstallationsFixture,
        services: inventoryServicesFixture,
        warnings: inventoryWarningsFixture,
      }),
    }));
    expect(resolveServiceRepairReportMock).not.toHaveBeenCalled();
    expect(snapshot.repairSummary).toEqual(expect.objectContaining({
      status: 'needs_attention',
      findingCounts: expect.objectContaining({
        total: 1,
        warning: 1,
        actionable: 0,
      }),
      findingKinds: ['background_service_not_running'],
    }));
    expect(snapshot.localRelays?.relays).toEqual([
      expect.objectContaining({
        releaseChannel: 'preview',
        relayUrl: 'http://127.0.0.1:3025',
        installed: true,
        running: false,
        healthy: false,
        version: '0.2.1-preview.1',
        serviceEnabled: true,
      }),
    ]);
    expect(snapshot.automaticStartup?.entries).toEqual([
      expect.objectContaining({
        id: 'com.happier.cli.daemon.preview.default',
        targetMode: 'default-following',
      }),
    ]);
    expect(snapshot.activeStack).toEqual(expect.objectContaining({
      activeServerId: 'stack_main__id_default',
      relayUrl: 'http://127.0.0.1:3005',
      publicRelayUrl: 'https://relay.happier.dev',
    }));
    expect(snapshot.serviceHealth?.backgroundService).toEqual(expect.objectContaining({
      installed: true,
      running: true,
      healthy: true,
      serviceLabel: 'com.happier.cli.daemon.preview.default',
      releaseChannel: 'preview',
    }));
    expect(Array.isArray(snapshot.warnings)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('?token=');
  });
});
