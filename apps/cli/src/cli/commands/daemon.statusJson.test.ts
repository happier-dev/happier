import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

type MockDaemonStatusEntry = {
  serverId: string;
  name: string;
  serverUrl: string;
  daemonStatePath: string;
  comparableKey: string | null;
  auth?: {
    authenticated: boolean;
    needsAuth: boolean;
    machineRegistered: boolean;
    machineId: string | null;
    accountId: string | null;
  };
  drift?: {
    activeComparableKey: string | null;
    matchesActiveRelay: boolean | null;
  };
  service: {
    installed: boolean;
    running?: boolean;
    platform?: string;
    installedPath?: string;
  };
  daemon: {
    pid: number | null;
    httpPort: number | null;
    running: boolean;
    staleStateFile: boolean;
    installed?: boolean;
  };
};

const {
  runDoctorCommandMock,
  listDaemonStatusesForAllKnownServersMock,
  readDaemonStatusSnapshotMock,
} = vi.hoisted(() => ({
  runDoctorCommandMock: vi.fn<(scope: string) => Promise<void>>(async () => {}),
  listDaemonStatusesForAllKnownServersMock: vi.fn<() => Promise<MockDaemonStatusEntry[]>>(async () => []),
  readDaemonStatusSnapshotMock: vi.fn(async () => ({
    server: {
      activeServerId: 'cloud',
      serverUrl: 'https://relay.example.test',
      localServerUrl: 'http://127.0.0.1:3005',
      publicServerUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
      comparableKey: 'https://relay.example.test',
    },
    daemon: {
      running: true,
      pid: 4321,
      httpPort: 7777,
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

vi.mock('@/ui/doctor', () => ({
  runDoctorCommand: (scope: string) => runDoctorCommandMock(scope),
}));

vi.mock('@/daemon/multiDaemon', () => ({
  listDaemonStatusesForAllKnownServers: () => listDaemonStatusesForAllKnownServersMock(),
  stopAllDaemonsBestEffort: vi.fn(async () => {}),
}));

vi.mock('@/daemon/statusSnapshot', () => ({
  readDaemonStatusSnapshot: () => readDaemonStatusSnapshotMock(),
}));

vi.mock('@/daemon/controlClient', () => ({
  checkIfDaemonRunningAndCleanupStaleState: vi.fn(async () => false),
  listDaemonSessions: vi.fn(async () => []),
  stopDaemon: vi.fn(async () => {}),
  stopDaemonSession: vi.fn(async () => false),
}));

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
  spawnDetachedDaemonStartSync: vi.fn(async () => ({ unref() {} })),
}));

vi.mock('@/daemon/service/cli', () => ({
  runDaemonServiceCliCommand: vi.fn(async () => {}),
}));

vi.mock('@/ui/logger', () => ({
  getLatestDaemonLog: vi.fn(async () => null),
}));

vi.mock('@/daemon/waitForDaemonRunningWithinBudget', () => ({
  waitForDaemonRunningWithinBudget: vi.fn(async () => true),
}));

describe('happier daemon status --json', () => {
  afterEach(() => {
    runDoctorCommandMock.mockReset();
    listDaemonStatusesForAllKnownServersMock.mockReset();
    readDaemonStatusSnapshotMock.mockReset();
    vi.restoreAllMocks();
  });

  it('prints the stable single-status JSON contract instead of human doctor output', async () => {
    const output = captureStdoutJsonOutput<{
      server?: { serverUrl?: string; comparableKey?: string; localServerUrl?: string | null };
      auth?: { needsAuth?: boolean; accountId?: string | null };
      service?: { installed?: boolean; running?: boolean };
    }>();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');

      await expect(handleDaemonCliCommand({
        args: ['daemon', 'status', '--json'],
        rawArgv: [],
        terminalRuntime: null,
      })).rejects.toThrow('exit:0');

      expect(runDoctorCommandMock).not.toHaveBeenCalled();
      const parsed = output.json();
      expect(parsed.server?.serverUrl).toBe('https://relay.example.test');
      expect(parsed.server?.localServerUrl).toBe('http://127.0.0.1:3005');
      expect(parsed.server?.comparableKey).toBe('https://relay.example.test');
      expect(parsed.service).toEqual({
        installed: true,
        running: true,
      });
      expect(parsed.auth?.needsAuth).toBe(true);
      expect(parsed.auth?.accountId).toBe('acct_123');
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }
  });

  it('prints stable JSON for daemon status across all configured servers', async () => {
    listDaemonStatusesForAllKnownServersMock.mockResolvedValueOnce([
      {
        serverId: 'cloud',
        name: 'Happier Cloud',
        serverUrl: 'https://relay.example.test',
        daemonStatePath: '/tmp/daemon.state.json',
        comparableKey: 'https://relay.example.test',
        auth: {
          authenticated: true,
          needsAuth: false,
          machineRegistered: true,
          machineId: 'machine_123',
          accountId: 'acct_123',
        },
        drift: {
          activeComparableKey: 'https://relay.example.test',
          matchesActiveRelay: true,
        },
        service: {
          installed: true,
          running: true,
          platform: 'darwin',
          installedPath: '/tmp/daemon.plist',
        },
        daemon: {
          pid: 4321,
          httpPort: 7777,
          running: true,
          staleStateFile: false,
        },
      },
    ]);

    const output = captureStdoutJsonOutput<{
      active?: { serverId?: string; relayUrl?: string; comparableKey?: string | null };
      entries?: Array<{
        serverId?: string;
        name?: string;
        serverUrl?: string;
        daemonStatePath?: string;
        comparableKey?: string | null;
        service?: { installed?: boolean; running?: boolean };
        daemon?: { running?: boolean; pid?: number | null; httpPort?: number | null; staleStateFile?: boolean };
        auth?: { authenticated?: boolean; needsAuth?: boolean; machineRegistered?: boolean; machineId?: string | null; accountId?: string | null };
        drift?: { activeRelayUrl?: string | null; activeComparableKey?: string | null; matchesActiveRelay?: boolean | null };
      }>;
    }>();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    try {
      const { handleDaemonCliCommand } = await import('./daemon');

      await expect(handleDaemonCliCommand({
        args: ['daemon', 'status', '--all', '--json'],
        rawArgv: [],
        terminalRuntime: null,
      })).rejects.toThrow('exit:0');

      const parsed = output.json();
      expect(parsed.active).toEqual(expect.objectContaining({
        serverId: expect.any(String),
        relayUrl: expect.any(String),
      }));
      expect(parsed.active).toHaveProperty('comparableKey');

      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries?.[0]).toMatchObject({
        serverId: 'cloud',
        name: 'Happier Cloud',
        serverUrl: 'https://relay.example.test',
        daemonStatePath: '/tmp/daemon.state.json',
        comparableKey: 'https://relay.example.test',
        service: {
          installed: true,
          running: true,
          platform: 'darwin',
          installedPath: '/tmp/daemon.plist',
        },
        daemon: {
          installed: true,
          running: true,
          pid: 4321,
          httpPort: 7777,
          staleStateFile: false,
        },
        auth: {
          authenticated: true,
          needsAuth: false,
          machineRegistered: true,
          machineId: 'machine_123',
          accountId: 'acct_123',
        },
        drift: {
          activeComparableKey: 'https://relay.example.test',
          matchesActiveRelay: true,
        },
      });
      expect(parsed.entries?.[0]?.drift?.activeRelayUrl).toBe(parsed.active?.relayUrl);
    } finally {
      output.restore();
      exitSpy.mockRestore();
    }
  });
});
