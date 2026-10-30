import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedSyncReliabilityEvent } from '@/sync/domains/state/persistence';
import type { SyncPerformanceTelemetrySummary } from '@/sync/runtime/syncPerformanceTelemetry';
import { installBugReportComponentCommonModuleMocks } from './bugReportComponentTestHelpers';
import { act } from 'react-test-renderer';
import { createMachineFixture, renderHook } from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

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
        OS: 'web',
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
    connectedServiceCredentialRevisionsV1: [],
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

type MachineDiagnosticsResult = NonNullable<Awaited<ReturnType<typeof import('@/sync/ops/machines')['machineCollectBugReportDiagnostics']>>>;
const machineCollectBugReportDiagnosticsMock = vi.fn<(machineId?: string, options?: Parameters<typeof import('@/sync/ops/machines')['machineCollectBugReportDiagnostics']>[1]) => Promise<MachineDiagnosticsResult>>(async () => ({
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

vi.mock('@/utils/system/bugReportActionTrail', () => ({
  getBugReportUserActionTrail: () => [],
}));

vi.mock('@/utils/system/bugReportLogBuffer', () => ({
  getBugReportLogText: () => '',
}));

vi.mock('expo-file-system', async () => {
  const { createExpoFileSystemMock } = await import('@/dev/testkit/mocks/expoFileSystem');
  return createExpoFileSystemMock().module;
});
afterEach(() => vi.unstubAllGlobals());

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
  });

  it('collects only the selected session machine on its captured server', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [createMachineFixture({ id: 'unrelated' }), createMachineFixture({ id: 'selected-machine' })],
      includeDiagnostics: true,
      acceptedKinds: ['daemon', 'session-log', 'ui-mobile'],
      maxArtifactBytes: 128_000,
      sessionTarget: { sessionId: 'chosen-session', serverId: 'cloud', machineId: 'selected-machine' },
    });
    expect(machineCollectBugReportDiagnosticsMock.mock.calls.map(([machineId]) => machineId)).toEqual(['selected-machine']);
    expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledWith('selected-machine', expect.objectContaining({
      serverId: 'cloud', sessionId: 'chosen-session', logSelection: { daemon: true, session: true, provider: false },
    }));
    expect(result.collectionStatuses.session.status).toBe('unsupported');
    expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
  });

  it('does not fall back to another machine when the selected machine is missing', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [createMachineFixture({ id: 'unrelated' })],
      includeDiagnostics: true, acceptedKinds: ['daemon', 'session-log', 'ui-mobile'], maxArtifactBytes: 128_000,
      sessionTarget: { sessionId: 'chosen-session', serverId: 'other-server' },
    });
    expect(machineCollectBugReportDiagnosticsMock).not.toHaveBeenCalled();
    expect(result.collectionStatuses.session.status).toBe('unavailable');
  });

  it('does not guess a machine or a recent session for an app-only report', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [createMachineFixture({ id: 'unrelated-online-machine' })],
      includeDiagnostics: true, acceptedKinds: ['daemon', 'server', 'ui-mobile'], maxArtifactBytes: 128_000,
    });
    expect(machineCollectBugReportDiagnosticsMock).not.toHaveBeenCalled();
    expect(result.artifacts.map((artifact) => artifact.filename)).toEqual(['app-context.json']);
    expect(result.collectionStatuses.daemon.status).toBe('unavailable');
    expect(serverFetchMock).not.toHaveBeenCalled();
  });

  it('shares the settled diagnostic preview with submission and refreshes when log choices change', async () => {
    const { usePreparedBugReportDiagnostics } = await import('./hooks/usePreparedBugReportDiagnostics');
    const machines: Parameters<CollectBugReportDiagnosticsArtifacts>[0]['machines'] = [];
    const hook = await renderHook(({ title, daemon }: { title: string; daemon: boolean }) => {
      void title;
      return usePreparedBugReportDiagnostics({
        machines, includeDiagnostics: true, acceptedKinds: ['ui-mobile'], maxArtifactBytes: 128_000,
        logSelection: { daemon, session: false, provider: false },
      });
    }, { initialProps: { title: 'Original title', daemon: true } });
    let preview: Awaited<ReturnType<CollectBugReportDiagnosticsArtifacts>>;
    await act(async () => { preview = await hook.getCurrent().collectDiagnosticsArtifacts(); });
    await hook.rerender({ title: 'Edited report', daemon: true });
    let submission: Awaited<ReturnType<CollectBugReportDiagnosticsArtifacts>>;
    await act(async () => { submission = await hook.getCurrent().collectDiagnosticsArtifacts(); });
    expect(submission!).toBe(preview!);
    await hook.rerender({ title: 'Edited report', daemon: false });
    let changed: Awaited<ReturnType<CollectBugReportDiagnosticsArtifacts>>;
    await act(async () => { changed = await hook.getCurrent().collectDiagnosticsArtifacts(); });
    expect(changed!).not.toBe(preview!);
    expect(hook.getCurrent().collectionStatuses).toEqual(changed!.collectionStatuses);
  });

  it('refuses a pending snapshot after the user changes its log exclusions', async () => {
    const { usePreparedBugReportDiagnostics } = await import('./hooks/usePreparedBugReportDiagnostics');
    const rpcStarted = createDeferred<void>();
    const reply = createDeferred<MachineDiagnosticsResult>();
    machineCollectBugReportDiagnosticsMock.mockImplementationOnce(async () => { rpcStarted.resolve(); return await reply.promise; });
    const hook = await renderHook(({ provider }: { provider: boolean }) => usePreparedBugReportDiagnostics({
      machines: [], includeDiagnostics: true, acceptedKinds: ['ui-mobile', 'provider-transcript'], maxArtifactBytes: 128_000,
      sessionTarget: { sessionId: 'selected', serverId: 'cloud', machineId: 'selected-machine' },
      logSelection: { daemon: false, session: false, provider },
    }), { initialProps: { provider: true } });
    let pending: Promise<Awaited<ReturnType<CollectBugReportDiagnosticsArtifacts>>>;
    await act(async () => { pending = hook.getCurrent().collectDiagnosticsArtifacts(); await rpcStarted.promise; });
    await hook.rerender({ provider: false });
    reply.resolve({
      daemonState: null, daemonLogs: [], doctorSnapshot: null, stackContext: null, runtime: { cwd: '', platform: 'linux', nodeVersion: 'v22' },
      sessionDiagnostics: { context: { sessionId: 'selected', machineId: 'selected-machine', metadataStatus: 'available' }, logs: [
        { kind: 'provider', status: 'collected', artifact: { filename: 'provider.jsonl', sourceKind: 'provider-transcript', contentType: 'text/plain', content: 'superseded private provider transcript' } },
      ] },
    });
    await act(async () => { await expect(pending!).rejects.toThrow('bug_report_diagnostics_superseded'); });
    expect(hook.getCurrent().collectionStatuses).toEqual({});
    await act(async () => {
      const current = await hook.getCurrent().collectDiagnosticsArtifacts();
      expect(JSON.stringify(current.artifacts)).not.toContain('superseded private provider transcript');
      expect(current.collectionStatuses.provider.status).toBe('disabled');
    });
  });

  it('keeps technical-only diagnostics to structured facts even with an older daemon', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      sessionTarget: { sessionId: 'selected', serverId: 'cloud', machineId: 'machine-1' },
      machines: [createMachineFixture({ id: 'machine-1' })],
      includeDiagnostics: true, acceptedKinds: ['daemon', 'stack-service', 'ui-mobile', 'server'], maxArtifactBytes: 128_000,
      logSelection: { daemon: false, session: false, provider: false },
    });
    expect(result.artifacts.map((artifact) => artifact.filename)).toEqual(['selected-session-summary.json', 'machine-1-daemon-summary.json', 'app-context.json']);
    expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
    expect(serverFetchMock).not.toHaveBeenCalled();
    expect(result.collectionStatuses.daemon.status).toBe('disabled');
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

  it('keeps older daemon replies to known structured facts and reports unsupported log scope', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      sessionTarget: { sessionId: 'selected', serverId: 'cloud', machineId: 'machine-1' },
      machines: [createMachineFixture({ id: 'machine-1' })],
      includeDiagnostics: true, acceptedKinds: ['stack-service', 'daemon', 'ui-mobile', 'server'], maxArtifactBytes: 128_000,
    });
    const daemonSummary = result.artifacts.find((artifact) => artifact.filename.includes('daemon-summary'));
    expect(daemonSummary?.content).toContain('"platform": "darwin"');
    expect(daemonSummary?.content).not.toContain('/tmp/');
    expect(result.artifacts.map((artifact) => artifact.filename)).not.toEqual(expect.arrayContaining([
      'machine-1-cli-doctor-snapshot.json', 'machine-1-stack-runtime.json',
    ]));
    expect(result.collectionStatuses.daemon.status).toBe('unsupported');
    expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
  });

  it('uses inline categorized artifacts and filters categories the user excluded', async () => {
    machineCollectBugReportDiagnosticsMock.mockResolvedValueOnce({
      daemonState: null, daemonLogs: [], runtime: { cwd: '', platform: 'linux', nodeVersion: 'v22' },
      sessionDiagnostics: {
        context: { sessionId: 'chosen-session', machineId: 'selected-machine', metadataStatus: 'available' },
        logs: [
          { kind: 'session', status: 'collected', artifact: { filename: 'session.log', sourceKind: 'session-log', contentType: 'text/plain', content: 'session details' } },
          { kind: 'provider', status: 'collected', artifact: { filename: 'provider.jsonl', sourceKind: 'daemon', contentType: 'text/plain', content: 'private provider transcript' } },
        ],
      },
    });
    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [], includeDiagnostics: true, acceptedKinds: ['daemon', 'session-log', 'ui-mobile'], maxArtifactBytes: 128_000,
      sessionTarget: { sessionId: 'chosen-session', serverId: 'cloud', machineId: 'selected-machine' },
    });
    expect(result.artifacts.find((artifact) => artifact.filename === 'session.log')?.content).toBe('session details');
    expect(JSON.stringify(result.artifacts)).not.toContain('private provider transcript');
    expect(result.collectionStatuses.session.status).toBe('collected');
    expect(result.collectionStatuses.provider.status).toBe('disabled');
    expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'session' as const, sourceKind: 'session-log', logSelection: { daemon: false, session: true, provider: false } },
    { kind: 'provider' as const, sourceKind: 'provider-transcript', logSelection: { daemon: false, session: false, provider: true } },
  ])('collects an independently accepted $sourceKind without daemon artifacts', async ({ kind, sourceKind, logSelection }) => {
    machineCollectBugReportDiagnosticsMock.mockResolvedValueOnce({
      daemonState: null, daemonLogs: [], runtime: { cwd: '', platform: 'linux', nodeVersion: 'v22' },
      sessionDiagnostics: {
        context: { sessionId: 'selected', machineId: 'selected-machine', metadataStatus: 'available' },
        logs: [{ kind, status: 'collected', artifact: { filename: `${kind}.log`, sourceKind, contentType: 'text/plain', content: 'selected artifact' } }],
      },
    });
    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [], includeDiagnostics: true, acceptedKinds: ['ui-mobile', sourceKind], maxArtifactBytes: 128_000,
      sessionTarget: { sessionId: 'selected', serverId: 'cloud', machineId: 'selected-machine' }, logSelection,
    });
    expect(result.artifacts.find((artifact) => artifact.sourceKind === sourceKind)?.content).toBe('selected artifact');
    expect(result.collectionStatuses[kind].status).toBe('collected');
  });

  it('includes a pasted CLI doctor snapshot artifact when provided and daemon artifacts are accepted', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [createMachineFixture({ id: 'machine-1' })],
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
    });

    const pasted = result.artifacts.find((artifact) => artifact.filename === 'pasted-cli-doctor-snapshot.json');
    expect(pasted).toBeTruthy();
    expect(String(pasted?.content ?? '')).toContain('acct_pasted_1');
  });

  it('skips server and machine diagnostics when accepted kinds exclude those sources', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [createMachineFixture({ id: 'machine-1' })],
      includeDiagnostics: true,
      acceptedKinds: ['ui-mobile'],
      maxArtifactBytes: 128_000,
    });

    expect(result.artifacts.every((artifact) => artifact.sourceKind === 'ui-mobile')).toBe(true);
    expect(serverFetchMock).not.toHaveBeenCalled();
    expect(machineCollectBugReportDiagnosticsMock).not.toHaveBeenCalled();
    expect(machineGetBugReportLogTailMock).not.toHaveBeenCalled();
  });

  it('marks machine diagnostics as skipped for an app-only report', async () => {

    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [createMachineFixture({ id: 'machine-1' })],
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

  it('keeps optional crash context without reattaching an unedited copy of the stack', async () => {
    const snapshot = {
      v: 1,
      createdAtMs: Date.now(),
      reason: 'crash',
      platform: 'ios',
      origin: 'http://localhost',
      isSecureContext: true,
      errorDetails: 'private original stack',
      appLogs: '[log] before restart',
      userActions: [{ timestamp: new Date().toISOString(), action: 'tap', route: '/foo' }],
    };
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'happier_pre_restart_bug_report_snapshot_v1' ? JSON.stringify(snapshot) : null,
    });

    const result = await collectBugReportDiagnosticsArtifacts({
      machines: [],
      includeDiagnostics: true,
      acceptedKinds: ['ui-mobile'],
      maxArtifactBytes: 128_000,
    });

    const filenames = result.artifacts.map((artifact) => artifact.filename);
    expect(filenames).not.toContain('pre-restart-crash.txt');
    expect(filenames).toContain('pre-restart-app-console.log');
    expect(filenames).toContain('pre-restart-user-action-trail.json');

    expect(JSON.stringify(result.artifacts)).not.toContain('private original stack');
  });

  it('does not block forever when a machine diagnostics RPC hangs', async () => {
    machineCollectBugReportDiagnosticsMock.mockImplementation(async () => await new Promise(() => {}));

    const outcome = await Promise.race([
      collectBugReportDiagnosticsArtifacts({
        sessionTarget: { sessionId: 'selected', serverId: 'cloud', machineId: 'machine-1' },
      machines: [createMachineFixture({ id: 'machine-1' })],
        includeDiagnostics: true,
        acceptedKinds: ['daemon'],
        maxArtifactBytes: 128_000,
        machineDiagnosticsTimeoutMs: 20,
      }),
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
        sessionTarget: { sessionId: 'selected', serverId: 'cloud' },
      machines: [],
        includeDiagnostics: true,
        acceptedKinds: ['server'],
        maxArtifactBytes: 128_000,
        serverDiagnosticsTimeoutMs: 20,
      }),
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
      sessionTarget: { sessionId: 'selected', serverId: 'cloud' },
      machines: [],
      includeDiagnostics: true,
      acceptedKinds: ['server'],
      maxArtifactBytes: 128_000,
      contextWindowMs: 45_000,
    });

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
      sessionTarget: { sessionId: 'selected', serverId: 'cloud' },
      machines: [],
      includeDiagnostics: true,
      acceptedKinds: ['server', 'ui-mobile'],
      maxArtifactBytes: 128_000,
    });

    const appContext = result.artifacts.find((artifact) => artifact.filename === 'app-context.json');
    const appContextJson = JSON.parse(String(appContext?.content ?? '{}')) as {
      diagnosticsCollection?: Record<string, { status?: string; detail?: string }>;
    };
    expect(appContextJson.diagnosticsCollection?.serverDiagnostics?.status).toBe('skipped');
    expect(String(appContextJson.diagnosticsCollection?.serverDiagnostics?.detail ?? '')).toContain('404');
  });


});
