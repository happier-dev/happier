import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';


const checkpointFixture = vi.hoisted(() => ({ homeDir: '' }));

const {
  readCredentialsMock,
  readStoredCredentialsMock,
  readSettingsMock,
  readDaemonStateMock,
} = vi.hoisted(() => ({
  readCredentialsMock: vi.fn<() => Promise<{ token: string } | null>>(async () => null),
  readStoredCredentialsMock: vi.fn<() => Promise<{ token: string; encryption: null } | null>>(async () => null),
  readSettingsMock: vi.fn(async () => ({
    schemaVersion: 5,
    onboardingCompleted: false,
    activeServerId: 'cloud',
    servers: {
      cloud: {
        id: 'cloud',
        name: 'Happier Cloud',
        serverUrl: 'https://api.happier.dev?token=abc',
        webappUrl: 'https://app.happier.dev',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
      },
      local: {
        id: 'local',
        name: 'Local',
        serverUrl: 'https://admin:secret@localhost:3005/path?token=abc',
        publicServerUrl: 'https://localhost:3005/path?token=abc',
        webappUrl: 'https://localhost:3005/app?token=abc',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
      },
    },
  })),
  readDaemonStateMock: vi.fn(async () => null),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    get happyHomeDir() { return checkpointFixture.homeDir; },
    activeServerId: 'cloud',
    serverUrl: 'https://api.happier.dev',
    publicServerUrl: 'https://api.happier.dev',
    webappUrl: 'https://app.happier.dev',
    logsDir: '/path/that/does/not/exist',
  },
}));

vi.mock('@/persistence', async importOriginal => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readCredentials: readCredentialsMock,
  readStoredCredentials: readStoredCredentialsMock,
  readSettings: readSettingsMock,
  readDaemonState: readDaemonStateMock,
}));

import { collectBugReportDiagnosticsArtifacts } from './bugReportArtifacts';

describe('collectBugReportDiagnosticsArtifacts', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    checkpointFixture.homeDir = await createTempDir('happier-bug-report-cursors-');
    writeFileSync(join(checkpointFixture.homeDir, 'changes-cursors.json'), JSON.stringify({ cloud: { acct_old: 10 } }));
  });

  afterEach(async () => { await removeTempDir(checkpointFixture.homeDir); });

  it('redacts sensitive invocation input and strips absolute paths in JSON artifacts', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'acct_123' })).toString('base64url');
    readStoredCredentialsMock.mockResolvedValueOnce({
      token: `header.${payload}.sig`,
      encryption: null,
    });

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
    const doctorSnapshotArtifact = result.artifacts.find((entry) => entry.filename === 'doctor-snapshot.json');
    const daemonSummaryArtifact = result.artifacts.find((entry) => entry.filename === 'daemon-summary.json');
    const stackContextArtifact = result.artifacts.find((entry) => entry.filename === 'stack-context.json');

    expect(cliContextArtifact).toBeDefined();
    expect(doctorSnapshotArtifact).toBeUndefined();
    expect(daemonSummaryArtifact).toBeDefined();
    expect(stackContextArtifact).toBeUndefined();

    const cliContext = JSON.parse(String(cliContextArtifact?.content ?? '{}')) as Record<string, unknown>;
    expect(cliContext.invocationArgs).toBeUndefined();
    expect(cliContext.invocationSummary).toBeDefined();
    expect(JSON.stringify(cliContext)).not.toContain('super-secret-token');
    expect(JSON.stringify(cliContext)).not.toContain('/Users/alice/private/project');
    expect(JSON.stringify(cliContext)).not.toContain('admin:secret');
    expect(JSON.stringify(cliContext)).not.toContain('?token=');
    expect(cliContext.cwd).toBe(basename(process.cwd()));
    expect(cliContext.accountId).toBe('acct_123');
    expect(readStoredCredentialsMock).toHaveBeenCalledOnce();
    expect(readCredentialsMock).not.toHaveBeenCalled();
    expect(cliContext.settingsActiveServerId).toBe('cloud');
    expect(cliContext.settingsServers).toBeDefined();

    const daemonSummary = JSON.parse(String(daemonSummaryArtifact?.content ?? '{}')) as Record<string, unknown>;
    expect(daemonSummary.daemonState).toBeNull();
    expect(JSON.stringify(daemonSummary)).not.toContain('/Users/alice/');
  });

  it('skips daemon/stack/server collectors when accepted kinds only allow cli artifacts', async () => {
    readStoredCredentialsMock.mockResolvedValueOnce({
      token: 'token-value',
      encryption: null,
    });
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

  it('collects only allowlisted context when all automatic log kinds are disabled', async () => {
    const result = await collectBugReportDiagnosticsArtifacts({
      includeDiagnostics: true, acceptedKinds: ['cli', 'daemon', 'stack-service'], maxArtifactBytes: 256_000,
      serverUrl: 'https://api.happier.dev', activeServerId: 'main', rawArgs: [],
      logSelection: { daemon: false, session: false, provider: false },
    });
    expect(result.artifacts.map(entry => entry.filename).sort()).toEqual(['cli-context.json', 'daemon-summary.json']);
    const context = JSON.parse(result.artifacts.find(entry => entry.filename === 'cli-context.json')!.content);
    expect(context.sessionDiagnostics.logs.every((entry: { status: string }) => entry.status === 'disabled')).toBe(true);
  });

  it('keeps explicit provider-file consent separate from automatic provider collection', async () => {
    const path = join(checkpointFixture.homeDir, 'explicit.jsonl');
    writeFileSync(path, 'EXPLICIT_PROVIDER_BODY');
    const result = await collectBugReportDiagnosticsArtifacts({
      includeDiagnostics: true, acceptedKinds: ['cli', 'provider-transcript'], maxArtifactBytes: 256_000,
      serverUrl: 'https://api.happier.dev', activeServerId: 'main', rawArgs: [],
      logSelection: { daemon: false, session: false, provider: false }, extraAttachments: [{ path, sourceKind: 'provider-transcript' }],
    });
    expect(result.artifacts.find(entry => entry.sourceKind === 'provider-transcript')?.content).toBe('EXPLICIT_PROVIDER_BODY');
    const context = JSON.parse(result.artifacts.find(entry => entry.filename === 'cli-context.json')!.content);
    expect(context.sessionDiagnostics.logs.find((entry: { kind: string }) => entry.kind === 'provider')).toEqual({ kind: 'provider', status: 'disabled' });
    expect(JSON.stringify(context)).not.toContain('EXPLICIT_PROVIDER_BODY');
  });

  it('adds diagnostics collection status to cli context artifact', async () => {
    readDaemonStateMock.mockRejectedValueOnce(new Error('machine diagnostics failed'));

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
    readStoredCredentialsMock.mockResolvedValueOnce({
      token: 'token-value',
      encryption: null,
    });
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

  it('finishes diagnostics collection with an error when the server body stalls past its deadline', async () => {
    readStoredCredentialsMock.mockResolvedValueOnce({ token: 'token-value', encryption: null });
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      const result = await Promise.race([
        collectBugReportDiagnosticsArtifacts({
          includeDiagnostics: true,
          acceptedKinds: ['server', 'cli'],
          maxArtifactBytes: 256_000,
          serverUrl: `http://127.0.0.1:${address.port}`,
          activeServerId: 'main',
          rawArgs: [],
        }),
        new Promise<null>((resolve) => { guard = setTimeout(() => resolve(null), 7_000); }),
      ]);
      expect(result).not.toBeNull();
      const context = result?.artifacts.find((entry) => entry.filename === 'cli-context.json');
      expect(JSON.parse(String(context?.content ?? '{}'))).toMatchObject({
        diagnosticsCollection: { serverDiagnostics: { status: 'error' } },
      });
      expect(result?.artifacts.some((entry) => entry.filename === 'server-diagnostics.json')).toBe(false);
    } finally {
      clearTimeout(guard);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('treats server diagnostics 404 as skipped (disabled) instead of an error', async () => {
    readStoredCredentialsMock.mockResolvedValueOnce({
      token: 'token-value',
      encryption: null,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    });

    try {
      const result = await collectBugReportDiagnosticsArtifacts({
        includeDiagnostics: true,
        acceptedKinds: ['server', 'cli'],
        maxArtifactBytes: 256_000,
        contextWindowMs: 45_000,
        serverUrl: 'https://api.happier.dev',
        activeServerId: 'main',
        rawArgs: ['--title', 'bug'],
      });

      const cliContextArtifact = result.artifacts.find((entry) => entry.filename === 'cli-context.json');
      const cliContext = JSON.parse(String(cliContextArtifact?.content ?? '{}')) as {
        diagnosticsCollection?: Record<string, { status?: string; detail?: string }>;
      };

      expect(cliContext.diagnosticsCollection?.serverDiagnostics?.status).toBe('skipped');
      expect(String(cliContext.diagnosticsCollection?.serverDiagnostics?.detail ?? '')).toContain('404');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('collects redirected server diagnostics without forwarding the Home bearer', async () => {
    readStoredCredentialsMock.mockResolvedValueOnce({ token: 'fixture', encryption: null });
    let secondHopRequests = 0;
    let secondHopCredentialPresent = false;
    const server = createServer((request, response) => {
      if (request.url === '/diagnostics') {
        secondHopRequests++;
        secondHopCredentialPresent ||= Boolean(request.headers.authorization);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ captured: true }));
      } else {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing test listener');
        response.writeHead(307, { location: `http://127.0.0.2:${address.port}/diagnostics` }).end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test listener');
      const result = await collectBugReportDiagnosticsArtifacts({ includeDiagnostics: true, acceptedKinds: ['server'],
        maxArtifactBytes: 256_000, serverUrl: `http://127.0.0.1:${address.port}`, activeServerId: 'main', rawArgs: [] });
      const artifact = result.artifacts.find(entry => entry.filename === 'server-diagnostics.json');
      expect(JSON.parse(String(artifact?.content))).toEqual({ captured: true });
      expect(secondHopRequests).toBe(1);
      expect(secondHopCredentialPresent).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
