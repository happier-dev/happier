import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: { version: '1.2.3' },
    deviceName: 'Simulator',
  },
}));

vi.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    Version: '17.0',
  },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  getStorage: () => ({
    getState: () => ({
      sessions: {},
      sessionMessages: {},
      sessionPending: {},
    }),
  }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({
    serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc',
  }),
}));

const serverFetchMock = vi.fn(async (_url?: unknown, _init?: unknown, _options?: unknown) => ({
  ok: false,
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

const isMachineOnlineMock = vi.fn((..._args: unknown[]) => true);
vi.mock('@/utils/sessions/machineUtils', () => ({
  isMachineOnline: (...args: unknown[]) => isMachineOnlineMock(...args),
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
  getBugReportUserActionTrail: () => [],
}));

vi.mock('@/utils/system/bugReportLogBuffer', () => ({
  getBugReportLogText: () => '',
}));

import { collectBugReportDiagnosticsArtifacts } from './bugReportDiagnostics';

describe('collectBugReportDiagnosticsArtifacts', () => {
  beforeEach(() => {
    serverFetchMock.mockClear();
    machineCollectBugReportDiagnosticsMock.mockClear();
    machineGetBugReportLogTailMock.mockClear();
    isMachineOnlineMock.mockReset();
    isMachineOnlineMock.mockReturnValue(true);
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
    const appContextJson = JSON.parse(String(appContext?.content ?? '{}')) as {
      diagnosticsCollection?: Record<string, { status?: string }>;
    };
    expect(appContextJson.diagnosticsCollection).toBeDefined();
    expect(appContextJson.diagnosticsCollection?.machineDiagnostics?.status).toBe('collected');
    expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledWith('machine-1', { timeoutMs: 4000 });
    expect(machineGetBugReportLogTailMock).toHaveBeenCalledWith(
      'machine-1',
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 4000 }),
    );
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
