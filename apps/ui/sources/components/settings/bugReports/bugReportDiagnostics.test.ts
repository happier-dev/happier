import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedSyncReliabilityEvent } from '@/sync/domains/state/persistence';
import type { SyncPerformanceTelemetrySummary } from '@/sync/runtime/syncPerformanceTelemetry';
import type { PreRestartBugReportSnapshotV1 } from '@/utils/system/preRestartBugReportSnapshot';
import { installBugReportComponentCommonModuleMocks } from './bugReportComponentTestHelpers';

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: { version: '1.2.3' },
    deviceName: 'Simulator',
  },
}));

installBugReportComponentCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Platform: {
        OS: 'ios',
        Version: '17.0',
      },
    });
  },
  storage: async () => {
    return {
      getStorage: () => ({
        getState: () => ({
          sessions: {},
          sessionMessages: {},
          sessionPending: {},
        }),
      }),
    };
  },
});

const bugReportDiagnosticsModulePromise = import('./bugReportDiagnostics');
type CollectBugReportDiagnosticsArtifacts = typeof import('./bugReportDiagnostics')['collectBugReportDiagnosticsArtifacts'];
const collectBugReportDiagnosticsArtifacts: CollectBugReportDiagnosticsArtifacts = async (
  ...args: Parameters<CollectBugReportDiagnosticsArtifacts>
) => (await bugReportDiagnosticsModulePromise).collectBugReportDiagnosticsArtifacts(...args);

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({
    serverId: 'cloud',
    serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc',
    generation: 1,
  }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
  listServerProfiles: () => ([
    {
      id: 'cloud',
      name: 'Happier Cloud',
      serverUrl: 'https://api.happier.dev?token=abc',
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: 0,
      source: 'preconfigured',
    },
    {
      id: 'local',
      name: 'Local',
      serverUrl: 'https://admin:secret@localhost:3005/path?token=abc',
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: 0,
      source: 'manual',
    },
  ]),
}));

const { loadSyncReliabilityEventsMock } = vi.hoisted(() => ({
  loadSyncReliabilityEventsMock: vi.fn<() => PersistedSyncReliabilityEvent[]>(() => []),
}));

const {
  syncPerformanceTelemetryIsEnabledMock,
  syncPerformanceTelemetrySnapshotMock,
  syncPerformanceTelemetryFlushSummaryMock,
  syncPerformanceTelemetryResetMock,
} = vi.hoisted(() => ({
  syncPerformanceTelemetryIsEnabledMock: vi.fn<() => boolean>(() => false),
  syncPerformanceTelemetrySnapshotMock: vi.fn<() => SyncPerformanceTelemetrySummary>(() => ({ events: [] })),
  syncPerformanceTelemetryFlushSummaryMock: vi.fn<() => SyncPerformanceTelemetrySummary | null>(() => null),
  syncPerformanceTelemetryResetMock: vi.fn<() => void>(() => {}),
}));
vi.mock('@/sync/runtime/syncPerformanceTelemetry', () => ({
  syncPerformanceTelemetry: {
    isEnabled: syncPerformanceTelemetryIsEnabledMock,
    snapshot: syncPerformanceTelemetrySnapshotMock,
    flushSummary: syncPerformanceTelemetryFlushSummaryMock,
    reset: syncPerformanceTelemetryResetMock,
  },
}));

vi.mock('@/sync/domains/state/persistence', () => ({
  loadProfile: () => ({
    id: 'acct_ui_1',
    timestamp: 1,
    firstName: null,
    lastName: null,
    username: 'leeroy',
    avatar: null,
    linkedProviders: [{ id: 'github', displayName: null, login: null, avatarUrl: null }],
    connectedServices: [],
    connectedServicesV2: [],
  }),
  loadSyncReliabilityEvents: loadSyncReliabilityEventsMock,
}));

type ServerFetchResponseLike = Readonly<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json?: () => Promise<unknown>;
}>;

const serverFetchMock = vi.fn(async (_url?: unknown, _init?: unknown, _options?: unknown): Promise<ServerFetchResponseLike> => ({
  ok: false,
  status: 500,
  text: async () => '',
}));
vi.mock('@/sync/http/client', () => ({
  serverFetch: (url: unknown, init?: unknown, options?: unknown) => serverFetchMock(url, init, options),
}));

const machineCollectBugReportDiagnosticsMock = vi.fn(async (_machineId?: string, _options?: { timeoutMs?: number }) => ({
  daemonState: {
    pid: 1,
    httpPort: 9999,
    startedAt: 1,
    startedWithCliVersion: '1.0.0',
    hasControlToken: true,
    daemonLogPath: '/tmp/daemon.log',
  },
  daemonLogs: [{ file: 'daemon.log', path: '/tmp/daemon.log', modifiedAt: new Date().toISOString() }],
  doctorSnapshot: {
    capturedAt: '2026-02-23T00:00:00.000Z',
    server: {
      activeServerId: 'cloud',
      serverUrl: 'https://api.happier.dev',
      publicServerUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
    },
    accountId: 'acct_cli_1',
    settings: {
      activeServerId: 'cloud',
      servers: [
        {
          id: 'cloud',
          name: 'Happier Cloud',
          serverUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: 0,
        },
      ],
      knownAccountIds: ['acct_cli_1'],
    },
  },
  runtime: { cwd: '/tmp/private/project', platform: 'darwin', nodeVersion: 'v20.0.0' },
  stackContext: {
    stackName: 'exp1',
    stackEnvPath: '/tmp/stack/env',
    runtimeStatePath: '/tmp/stack.runtime.json',
    runtimeState: JSON.stringify({ stackName: 'exp1' }),
    logCandidates: ['/tmp/stack-runner.log'],
  },
}));
const machineGetBugReportLogTailMock = vi.fn(async (
  _machineId?: string,
  _params?: { path?: string; maxBytes?: number },
  _options?: { timeoutMs?: number },
) => ({
  ok: true as const,
  path: '/tmp/stack-runner.log',
  tail: 'stack runner tail',
}));
vi.mock('@/sync/ops/machines', () => ({
  machineCollectBugReportDiagnostics: (machineId: string, options?: { timeoutMs?: number }) =>
    machineCollectBugReportDiagnosticsMock(machineId, options),
  machineGetBugReportLogTail: (
    machineId: string,
    params?: { path?: string; maxBytes?: number },
    options?: { timeoutMs?: number },
  ) => machineGetBugReportLogTailMock(machineId, params, options),
}));

const { isMachineOnlineMock } = vi.hoisted(() => ({
  isMachineOnlineMock: vi.fn((..._args: unknown[]) => true),
}));
vi.mock('@/utils/sessions/machineUtils', () => ({
  isMachineOnline: isMachineOnlineMock,
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
  getBugReportUserActionTrail: () => [],
}));

vi.mock('@/utils/system/bugReportLogBuffer', () => ({
  getBugReportLogText: () => '',
}));

const { peekPreRestartBugReportSnapshotMock } = vi.hoisted(() => ({
  peekPreRestartBugReportSnapshotMock: vi.fn(
    async (..._args: unknown[]): Promise<PreRestartBugReportSnapshotV1 | null> => null,
  ),
}));
vi.mock('@/utils/system/preRestartBugReportSnapshot', () => ({
  peekPreRestartBugReportSnapshot: peekPreRestartBugReportSnapshotMock,
}));

describe('collectBugReportDiagnosticsArtifacts', () => {
  beforeEach(() => {
    serverFetchMock.mockClear();
    machineCollectBugReportDiagnosticsMock.mockClear();
    machineGetBugReportLogTailMock.mockClear();
    loadSyncReliabilityEventsMock.mockReset();
    loadSyncReliabilityEventsMock.mockReturnValue([]);
    syncPerformanceTelemetryIsEnabledMock.mockReset();
    syncPerformanceTelemetryIsEnabledMock.mockReturnValue(false);
    syncPerformanceTelemetrySnapshotMock.mockReset();
    syncPerformanceTelemetrySnapshotMock.mockReturnValue({ events: [] });
    syncPerformanceTelemetryFlushSummaryMock.mockReset();
    syncPerformanceTelemetryFlushSummaryMock.mockReturnValue(null);
    syncPerformanceTelemetryResetMock.mockReset();
    isMachineOnlineMock.mockReset();
    isMachineOnlineMock.mockReturnValue(true);
  });

  it('includes persisted sync reliability events from the diagnostics context window', async () => {
    const nowMs = Date.parse('2026-05-04T12:00:00.000Z');
    loadSyncReliabilityEventsMock.mockReturnValue([
      {
        id: 'old-event',
        name: 'sync.cursor.contractAnomaly',
        atMs: nowMs - 31 * 60 * 1_000,
        fields: { reason: 'old' },
      },
      {
        id: 'event-1',
        name: 'sync.cursor.contractAnomaly',
        atMs: nowMs - 1_000,
        fields: { reason: 'returned-after-cursor', afterCursor: '42' },
      },
    ]);

    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [],
      includeDiagnostics: true,
      acceptedKinds: ['ui-mobile'],
      maxArtifactBytes: 128_000,
      nowMs,
      contextWindowMs: 30 * 60 * 1_000,
    });

    const reliabilityArtifact = result.artifacts.find((artifact) => artifact.filename === 'sync-reliability-events.json');
    expect(reliabilityArtifact).toMatchObject({
      sourceKind: 'ui-mobile',
      contentType: 'application/json',
    });
    const reliabilityPayload = JSON.parse(String(reliabilityArtifact?.content ?? '{}')) as {
      eventCount?: number;
      events?: Array<{ id?: string; name?: string; fields?: Record<string, unknown> }>;
    };
    expect(reliabilityPayload.eventCount).toBe(1);
    expect(reliabilityPayload.events).toEqual([
      {
        id: 'event-1',
        name: 'sync.cursor.contractAnomaly',
        atMs: nowMs - 1_000,
        fields: { reason: 'returned-after-cursor', afterCursor: '42' },
      },
    ]);

    const appContext = result.artifacts.find((artifact) => artifact.filename === 'app-context.json');
    const appContextJson = JSON.parse(String(appContext?.content ?? '{}')) as {
      diagnosticsCollection?: Record<string, { status?: string }>;
    };
    expect(appContextJson.diagnosticsCollection?.syncReliability?.status).toBe('collected');
  });

  it('includes enabled sync performance telemetry snapshot without flushing it', async () => {
    const nowMs = Date.parse('2026-05-04T12:00:00.000Z');
    syncPerformanceTelemetryIsEnabledMock.mockReturnValue(true);
    syncPerformanceTelemetrySnapshotMock.mockReturnValue({
      events: [
        {
          name: 'sync.sessions.snapshot.fetch.page',
          count: 2,
          totalMs: 120,
          minMs: 40,
          maxMs: 80,
          p50Ms: 64,
          p90Ms: 64,
          p99Ms: 64,
          slowCount: 1,
          durationBuckets: { '64': 1, '256': 1 },
          fields: { sessions: 3 },
          fieldStats: { sessions: { sum: 3, min: 1, max: 2, last: 2 } },
        },
      ],
    });

    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [],
      includeDiagnostics: true,
      acceptedKinds: ['ui-mobile'],
      maxArtifactBytes: 128_000,
      nowMs,
      contextWindowMs: 30 * 60 * 1_000,
    });

    const performanceArtifact = result.artifacts.find((artifact) => artifact.filename === 'sync-performance-telemetry.json');
    expect(performanceArtifact).toMatchObject({
      sourceKind: 'ui-mobile',
      contentType: 'application/json',
    });
    const performancePayload = JSON.parse(String(performanceArtifact?.content ?? '{}')) as {
      eventCount?: number;
      telemetry?: { events?: Array<{ name?: string; count?: number }> };
    };
    expect(performancePayload.eventCount).toBe(1);
    expect(performancePayload.telemetry?.events).toEqual([
      expect.objectContaining({
        name: 'sync.sessions.snapshot.fetch.page',
        count: 2,
      }),
    ]);
    expect(syncPerformanceTelemetryFlushSummaryMock).not.toHaveBeenCalled();
    expect(syncPerformanceTelemetryResetMock).not.toHaveBeenCalled();

    const appContext = result.artifacts.find((artifact) => artifact.filename === 'app-context.json');
    const appContextJson = JSON.parse(String(appContext?.content ?? '{}')) as {
      diagnosticsCollection?: Record<string, { status?: string }>;
    };
    expect(appContextJson.diagnosticsCollection?.syncPerformance?.status).toBe('collected');
  });

  it('includes stack diagnostics artifacts from machine diagnostics', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [{ id: 'machine-1' } as any],
      includeDiagnostics: true,
      acceptedKinds: ['stack-service', 'daemon', 'ui-mobile', 'server'],
      maxArtifactBytes: 128_000,
    });

    const filenames = result.artifacts.map((artifact) => artifact.filename);
    expect(filenames.some((filename) => filename.includes('stack-context'))).toBe(true);
    expect(filenames.some((filename) => filename.includes('stack-runtime'))).toBe(true);
    expect(filenames.some((filename) => filename.includes('stack-runner'))).toBe(true);

    const appContext = result.artifacts.find((artifact) => artifact.filename === 'app-context.json');
    const daemonSummary = result.artifacts.find((artifact) => artifact.filename.includes('daemon-summary'));
    const stackContext = result.artifacts.find((artifact) => artifact.filename.includes('stack-context'));
    const cliDoctorSnapshot = result.artifacts.find((artifact) => artifact.filename.includes('cli-doctor-snapshot'));
    expect(appContext?.content).toContain('https://api.happier.dev/path');
    expect(appContext?.content).not.toContain('admin:secret');
    expect(appContext?.content).not.toContain('?token=');
    expect(daemonSummary?.content).not.toContain('/tmp/');
    expect(stackContext?.content).not.toContain('/tmp/');
    expect(daemonSummary?.content).toContain('"daemonLogPath": "daemon.log"');
    expect(daemonSummary?.content).toContain('"cwd": "project"');
    expect(stackContext?.content).toContain('"stackEnvPath": "env"');
    expect(stackContext?.content).toContain('"runtimeStatePath": "stack.runtime.json"');
    expect(stackContext?.content).toContain('"stack-runner.log"');
    expect(cliDoctorSnapshot?.content).toContain('"acct_cli_1"');
    const appContextJson = JSON.parse(String(appContext?.content ?? '{}')) as {
      diagnosticsCollection?: Record<string, { status?: string }>;
      profile?: { id?: string; username?: string; linkedProviderIds?: string[] };
      serverProfiles?: Array<{ id?: string; serverUrl?: string }>;
    };
    expect(appContextJson.diagnosticsCollection).toBeDefined();
    expect(appContextJson.diagnosticsCollection?.machineDiagnostics?.status).toBe('collected');
    expect(appContextJson.profile?.id).toBe('acct_ui_1');
    expect(appContextJson.profile?.username).toBe('leeroy');
    expect(appContextJson.profile?.linkedProviderIds).toContain('github');
    expect((appContextJson.serverProfiles ?? []).map((entry) => entry.id)).toContain('cloud');
    expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledWith('machine-1', { timeoutMs: 4000 });
    expect(machineGetBugReportLogTailMock).toHaveBeenCalledWith(
      'machine-1',
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 4000 }),
    );
  });

  it('includes a pasted CLI doctor snapshot artifact when provided and daemon artifacts are accepted', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [{ id: 'machine-1' } as any],
      includeDiagnostics: true,
      acceptedKinds: ['daemon', 'ui-mobile'],
      maxArtifactBytes: 128_000,
      pastedCliDoctorSnapshotJson: JSON.stringify({
        capturedAt: '2026-02-23T00:00:00.000Z',
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://api.happier.dev',
          publicServerUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
        },
        accountId: 'acct_pasted_1',
        settings: {
          activeServerId: 'cloud',
          servers: [],
          knownAccountIds: ['acct_pasted_1'],
        },
      }),
    } as any);

    const pasted = result.artifacts.find((artifact) => artifact.filename === 'pasted-cli-doctor-snapshot.json');
    expect(pasted).toBeTruthy();
    expect(String(pasted?.content ?? '')).toContain('acct_pasted_1');
  });

  it('skips server and machine diagnostics when accepted kinds exclude those sources', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [{ id: 'machine-1' } as any],
      includeDiagnostics: true,
      acceptedKinds: ['ui-mobile'],
      maxArtifactBytes: 128_000,
    });

    expect(result.artifacts.every((artifact) => artifact.sourceKind === 'ui-mobile')).toBe(true);
    expect(serverFetchMock).not.toHaveBeenCalled();
    expect(machineCollectBugReportDiagnosticsMock).not.toHaveBeenCalled();
    expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
  });

  it('does not mark machine diagnostics as an error when there are no online machines', async () => {
    isMachineOnlineMock.mockReturnValue(false);

    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [{ id: 'machine-1' } as any],
      includeDiagnostics: true,
      acceptedKinds: ['ui-mobile', 'daemon'],
      maxArtifactBytes: 128_000,
    });

    const appContext = result.artifacts.find((artifact) => artifact.filename === 'app-context.json');
    const appContextJson = JSON.parse(String(appContext?.content ?? '{}')) as {
      diagnosticsCollection?: Record<string, { status?: string; detail?: string }>;
    };
    expect(appContextJson.diagnosticsCollection?.machineDiagnostics?.status).toBe('skipped');
  });

  it('includes pre-restart crash artifacts when a persisted snapshot is available', async () => {
    peekPreRestartBugReportSnapshotMock.mockResolvedValueOnce({
      v: 1,
      createdAtMs: Date.now(),
      reason: 'crash',
      platform: 'ios',
      origin: 'http://localhost',
      isSecureContext: true,
      errorDetails: 'boom\nstack: ...',
      appLogs: '[log] before restart',
      userActions: [{ timestamp: new Date().toISOString(), action: 'tap', route: '/foo' }],
    });

    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [],
      includeDiagnostics: true,
      acceptedKinds: ['ui-mobile'],
      maxArtifactBytes: 128_000,
    });

    const filenames = result.artifacts.map((artifact) => artifact.filename);
    expect(filenames).toContain('pre-restart-crash.txt');
    expect(filenames).toContain('pre-restart-app-console.log');
    expect(filenames).toContain('pre-restart-user-action-trail.json');

    const crashArtifact = result.artifacts.find((artifact) => artifact.filename === 'pre-restart-crash.txt');
    expect(String(crashArtifact?.content ?? '')).toContain('boom');
  });

  it('does not block forever when a machine diagnostics RPC hangs', async () => {
    machineCollectBugReportDiagnosticsMock.mockImplementation(async () => await new Promise(() => {}));

    const outcome = await Promise.race([
      collectBugReportDiagnosticsArtifacts({
        machines: [{ id: 'machine-1' } as any],
        includeDiagnostics: true,
        acceptedKinds: ['daemon'],
        maxArtifactBytes: 128_000,
        machineDiagnosticsTimeoutMs: 20,
      } as any),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 120)),
    ]);

    expect(outcome).not.toBe('timeout');
  });

  it('does not block forever when server diagnostics fetch hangs', async () => {
    let capturedSignal: { aborted: boolean } | null = null;
    serverFetchMock.mockImplementation(async (_url?: unknown, init?: unknown) => {
      const requestInit = init as { signal?: { aborted?: boolean } } | undefined;
      capturedSignal = requestInit?.signal ? (requestInit.signal as { aborted: boolean }) : null;
      return await new Promise(() => {});
    });

    const outcome = await Promise.race([
      collectBugReportDiagnosticsArtifacts({
        machines: [],
        includeDiagnostics: true,
        acceptedKinds: ['server'],
        maxArtifactBytes: 128_000,
        serverDiagnosticsTimeoutMs: 20,
      } as any),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 120)),
    ]);

    expect(outcome).not.toBe('timeout');
    const observedSignal = capturedSignal as { aborted: boolean } | null;
    if (!observedSignal) {
      throw new Error('expected abort signal to be provided to serverFetch');
    }
    expect(observedSignal.aborted).toBe(true);
  });

  it('uses context-window-derived line count for server diagnostics requests', async () => {
    serverFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{"ok":true}',
    });

    await collectBugReportDiagnosticsArtifacts({
      machines: [],
      includeDiagnostics: true,
      acceptedKinds: ['server'],
      maxArtifactBytes: 128_000,
      contextWindowMs: 45_000,
    } as any);

    const requestPath = String(serverFetchMock.mock.calls[0]?.[0] ?? '');
    expect(requestPath).toContain('/v1/diagnostics/bug-report-snapshot?lines=50');
  });

  it('treats server diagnostics 404 as skipped (disabled) instead of an error', async () => {
    serverFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'not found',
    });

    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [],
      includeDiagnostics: true,
      acceptedKinds: ['server', 'ui-mobile'],
      maxArtifactBytes: 128_000,
    } as any);

    const appContext = result.artifacts.find((artifact) => artifact.filename === 'app-context.json');
    const appContextJson = JSON.parse(String(appContext?.content ?? '{}')) as {
      diagnosticsCollection?: Record<string, { status?: string; detail?: string }>;
    };
    expect(appContextJson.diagnosticsCollection?.serverDiagnostics?.status).toBe('skipped');
    expect(String(appContextJson.diagnosticsCollection?.serverDiagnostics?.detail ?? '')).toContain('404');
  });

  it('uses basename-only log filenames for windows-style machine log paths', async () => {
    machineCollectBugReportDiagnosticsMock.mockResolvedValueOnce({
      daemonState: {
        pid: 1,
        httpPort: 9999,
        startedAt: 1,
        startedWithCliVersion: '1.0.0',
        hasControlToken: true,
        daemonLogPath: 'C:\\Users\\alice\\.happier\\logs\\daemon.log',
      },
      daemonLogs: [{ file: 'daemon.log', path: 'C:\\Users\\alice\\.happier\\logs\\daemon.log', modifiedAt: new Date().toISOString() }],
      doctorSnapshot: {
        capturedAt: '2026-02-23T00:00:00.000Z',
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://api.happier.dev',
          publicServerUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
        },
        accountId: 'acct_cli_1',
        settings: {
          activeServerId: 'cloud',
          servers: [
            {
              id: 'cloud',
              name: 'Happier Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
              createdAt: 0,
              updatedAt: 0,
              lastUsedAt: 0,
            },
          ],
          knownAccountIds: ['acct_cli_1'],
        },
      },
      runtime: { cwd: 'C:\\Users\\alice\\project', platform: 'win32', nodeVersion: 'v20.0.0' },
      stackContext: {
        stackName: 'exp1',
        stackEnvPath: 'C:\\Users\\alice\\stack\\env',
        runtimeStatePath: 'C:\\Users\\alice\\stack\\stack.runtime.json',
        runtimeState: JSON.stringify({ stackName: 'exp1' }),
        logCandidates: ['C:\\Users\\alice\\stack\\logs\\stack-runner.log'],
      },
    });

    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [{ id: 'machine-1' } as any],
      includeDiagnostics: true,
      acceptedKinds: ['stack-service', 'daemon'],
      maxArtifactBytes: 128_000,
    });

    const logFilenames = result.artifacts
      .filter((artifact) => artifact.contentType === 'text/plain')
      .map((artifact) => artifact.filename);
    expect(logFilenames.some((name) => name.includes('daemon.log'))).toBe(true);
    expect(logFilenames.some((name) => name.includes('stack-runner.log'))).toBe(true);
    expect(logFilenames.join('|').toLowerCase()).not.toContain('users');
    expect(logFilenames.join('|')).not.toContain('\\');
  });
});
