import { basename } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  readCredentialsMock,
  collectBugReportMachineDiagnosticsSnapshotMock,
  readBugReportLogTailMock,
} = vi.hoisted(() => ({
  readCredentialsMock: vi.fn<() => Promise<{ token: string } | null>>(async () => null),
  collectBugReportMachineDiagnosticsSnapshotMock: vi.fn(async () => ({
    daemonState: {
      pid: 100,
      httpPort: 3001,
      startedAt: 1,
      startedWithCliVersion: '1.0.0',
      hasControlToken: true,
      daemonLogPath: '/Users/alice/.happier/logs/daemon.log',
    },
    daemonLogs: [
      { file: 'daemon.log', path: '/Users/alice/.happier/logs/daemon.log', modifiedAt: '2026-02-11T00:00:00.000Z' },
    ],
    runtime: {
      cwd: '/Users/alice/private/project',
      platform: 'darwin',
      nodeVersion: 'v20.0.0',
    },
    stackContext: {
      stackName: 'qa-stack',
      stackEnvPath: '/Users/alice/private/project/.stack/env',
      runtimeStatePath: '/Users/alice/private/project/.stack/stack.runtime.json',
      runtimeState: '{"stackName":"qa-stack"}',
      logCandidates: ['/Users/alice/private/project/.stack/logs/runner.log'],
    },
  })),
  readBugReportLogTailMock: vi.fn(async (path: string) => `tail for ${path}`),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    logsDir: '/path/that/does/not/exist',
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: readCredentialsMock,
}));

vi.mock('@/diagnostics/bugReportMachineDiagnostics', () => ({
  collectBugReportMachineDiagnosticsSnapshot: collectBugReportMachineDiagnosticsSnapshotMock,
  readBugReportLogTail: readBugReportLogTailMock,
}));

import { collectBugReportDiagnosticsArtifacts } from './bugReportArtifacts';

describe('collectBugReportDiagnosticsArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redacts sensitive invocation input and strips absolute paths in JSON artifacts', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      includeDiagnostics: true,
      acceptedKinds: ['cli', 'daemon', 'stack-service'],
      maxArtifactBytes: 256_000,
      serverUrl: 'https://api.happier.dev',
      activeServerId: 'main',
      rawArgs: [
        '--title',
        'bug',
        '--token',
        'super-secret-token',
        '/Users/alice/private/project',
      ],
    });

    const cliContextArtifact = result.artifacts.find((entry) => entry.filename === 'cli-context.json');
    const daemonSummaryArtifact = result.artifacts.find((entry) => entry.filename === 'daemon-summary.json');
    const stackContextArtifact = result.artifacts.find((entry) => entry.filename === 'stack-context.json');

    expect(cliContextArtifact).toBeDefined();
    expect(daemonSummaryArtifact).toBeDefined();
    expect(stackContextArtifact).toBeDefined();

    const cliContext = JSON.parse(String(cliContextArtifact?.content ?? '{}')) as Record<string, unknown>;
    expect(cliContext.invocationArgs).toBeUndefined();
    expect(cliContext.invocationSummary).toBeDefined();
    expect(JSON.stringify(cliContext)).not.toContain('super-secret-token');
    expect(JSON.stringify(cliContext)).not.toContain('/Users/alice/private/project');
    expect(cliContext.cwd).toBe(basename(process.cwd()));

    const daemonSummary = JSON.parse(String(daemonSummaryArtifact?.content ?? '{}')) as Record<string, unknown>;
    expect(JSON.stringify(daemonSummary)).not.toContain('/Users/alice/');
    expect(JSON.stringify(daemonSummary)).toContain('"daemonLogPath":"daemon.log"');

    const stackContext = JSON.parse(String(stackContextArtifact?.content ?? '{}')) as Record<string, unknown>;
    expect(JSON.stringify(stackContext)).not.toContain('/Users/alice/');
    expect(JSON.stringify(stackContext)).toContain('"stackEnvPath":"env"');
    expect(JSON.stringify(stackContext)).toContain('"runtimeStatePath":"stack.runtime.json"');
    expect(JSON.stringify(stackContext)).toContain('"runner.log"');
  });

  it('skips daemon/stack/server collectors when accepted kinds only allow cli artifacts', async () => {
    readCredentialsMock.mockResolvedValueOnce({ token: 'token-value' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      const result = await collectBugReportDiagnosticsArtifacts({
        includeDiagnostics: true,
        acceptedKinds: ['cli'],
        maxArtifactBytes: 256_000,
        serverUrl: 'https://api.happier.dev',
        activeServerId: 'main',
        rawArgs: ['--title', 'bug'],
      });

      expect(result.artifacts.every((artifact) => artifact.sourceKind === 'cli')).toBe(true);
      expect(collectBugReportMachineDiagnosticsSnapshotMock).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not leak inline flag values in invocation summary', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      includeDiagnostics: true,
      acceptedKinds: ['cli'],
      maxArtifactBytes: 256_000,
      serverUrl: 'https://api.happier.dev',
      activeServerId: 'main',
      rawArgs: [
        '--title=bug',
        '--api-key=super-secret-inline-value',
        '--provider-url=https://reports.example.dev',
      ],
    });

    const cliContextArtifact = result.artifacts.find((entry) => entry.filename === 'cli-context.json');
    const cliContext = JSON.parse(String(cliContextArtifact?.content ?? '{}')) as {
      invocationSummary?: { flags?: string[] };
    };

    const serialized = JSON.stringify(cliContext);
    expect(serialized).not.toContain('super-secret-inline-value');
    expect(serialized).not.toContain('https://reports.example.dev');
    expect(cliContext.invocationSummary?.flags ?? []).toContain('--api-key');
  });

  it('uses basename-only stack log filenames for windows-style paths', async () => {
    collectBugReportMachineDiagnosticsSnapshotMock.mockResolvedValueOnce({
      daemonState: {
        pid: 100,
        httpPort: 3001,
        startedAt: 1,
        startedWithCliVersion: '1.0.0',
        hasControlToken: true,
        daemonLogPath: 'C:\\Users\\alice\\.happier\\logs\\daemon.log',
      },
      daemonLogs: [],
      runtime: {
        cwd: 'C:\\Users\\alice\\private\\project',
        platform: 'win32',
        nodeVersion: 'v20.0.0',
      },
      stackContext: {
        stackName: 'qa-stack',
        stackEnvPath: 'C:\\Users\\alice\\private\\project\\.stack\\env',
        runtimeStatePath: 'C:\\Users\\alice\\private\\project\\.stack\\stack.runtime.json',
        runtimeState: '{"stackName":"qa-stack"}',
        logCandidates: ['C:\\Users\\alice\\private\\project\\.stack\\logs\\runner.log'],
      },
    });

    const result = await collectBugReportDiagnosticsArtifacts({
      includeDiagnostics: true,
      acceptedKinds: ['stack-service'],
      maxArtifactBytes: 256_000,
      serverUrl: 'https://api.happier.dev',
      activeServerId: 'main',
      rawArgs: ['--title', 'bug'],
    });

    const stackLogArtifact = result.artifacts.find((entry) => entry.filename.endsWith('.log'));
    expect(stackLogArtifact).toBeDefined();
    expect(stackLogArtifact?.filename).toContain('runner.log');
    expect(stackLogArtifact?.filename.toLowerCase()).not.toContain('users');
    expect(stackLogArtifact?.filename).not.toContain('\\');
  });

  it('adds diagnostics collection status to cli context artifact', async () => {
    collectBugReportMachineDiagnosticsSnapshotMock.mockRejectedValueOnce(new Error('machine diagnostics failed'));

    const result = await collectBugReportDiagnosticsArtifacts({
      includeDiagnostics: true,
      acceptedKinds: ['cli', 'daemon'],
      maxArtifactBytes: 256_000,
      serverUrl: 'https://api.happier.dev',
      activeServerId: 'main',
      rawArgs: ['--title', 'bug'],
    });

    const cliContextArtifact = result.artifacts.find((entry) => entry.filename === 'cli-context.json');
    const cliContext = JSON.parse(String(cliContextArtifact?.content ?? '{}')) as {
      diagnosticsCollection?: Record<string, { status?: string }>;
    };

    expect(cliContext.diagnosticsCollection).toBeDefined();
    expect(cliContext.diagnosticsCollection?.machineDiagnostics?.status).toBe('error');
    expect(cliContext.diagnosticsCollection?.serverDiagnostics?.status).toBe('skipped');
  });

  it('uses context-window-derived line count for server diagnostics requests', async () => {
    const urls: string[] = [];
    readCredentialsMock.mockResolvedValueOnce({ token: 'token-value' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    try {
      await collectBugReportDiagnosticsArtifacts({
        includeDiagnostics: true,
        acceptedKinds: ['server'],
        maxArtifactBytes: 256_000,
        contextWindowMs: 45_000,
        serverUrl: 'https://api.happier.dev',
        activeServerId: 'main',
        rawArgs: ['--title', 'bug'],
      });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(urls.some((entry) => entry.includes('/v1/diagnostics/bug-report-snapshot?lines=50'))).toBe(true);
  });
});
