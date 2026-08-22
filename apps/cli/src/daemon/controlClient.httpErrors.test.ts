import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { writeDaemonState, clearDaemonStateForTestTeardown } from '@/persistence';
import { resolveDaemonSpawnSessionByNonce, spawnDaemonSession } from '@/daemon/controlClient';
import * as controlClient from '@/daemon/controlClient';
import {
  buildProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { ProviderAccountUsageAdoptionV1 } from './connectedServices/accountUsage/adoption';

const LEGACY_SPAWN_ALLOWLIST_FIELDS = [
  'directory',
  'sessionId',
  'existingSessionId',
  'backendTarget',
  'experimentalCodexAcp',
  'environmentVariables',
] as const;

type LegacySpawnAllowlistField = (typeof LEGACY_SPAWN_ALLOWLIST_FIELDS)[number];

function parseLegacySpawnRequestAllowlist(
  body: unknown,
): { ok: true; parsed: Partial<Record<LegacySpawnAllowlistField, unknown>> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid body shape' };
  }

  const parsed = Object.fromEntries(
    LEGACY_SPAWN_ALLOWLIST_FIELDS.flatMap((field) => {
      if (!(field in body)) {
        return [];
      }
      return [[field, (body as Record<string, unknown>)[field]]];
    }),
  ) as Partial<Record<LegacySpawnAllowlistField, unknown>>;

  if (typeof parsed.directory !== 'string') {
    return { ok: false, error: 'directory is required' };
  }

  return { ok: true, parsed };
}

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve({ port: addr.port });
    });
  });
}

describe('daemon control client (HTTP error responses)', () => {
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  let tmpHomeDir: string | null = null;

  afterEach(async () => {
    await clearDaemonStateForTestTeardown();
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    reloadConfiguration();
    if (tmpHomeDir) {
      await removeTempDir(tmpHomeDir);
      tmpHomeDir = null;
    }
  });

  it('returns parsed 409 payload from /spawn-session (directory approval flow)', async () => {
    let observedConnectionHeader: string | undefined;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/spawn-session') {
        observedConnectionHeader = req.headers.connection;
        res.statusCode = 409;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: '/tmp',
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(spawnDaemonSession({ directory: '/tmp' })).resolves.toEqual({
        success: false,
        requiresUserApproval: true,
        actionRequired: 'CREATE_DIRECTORY',
        directory: '/tmp',
      });
      expect(observedConnectionHeader).toBe('close');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns parsed 500 payload from /spawn-session (structured daemon error)', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/spawn-session') {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            success: false,
            error: 'Failed to spawn session: boom',
            errorCode: 'SPAWN_FAILED',
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(spawnDaemonSession({ directory: '/tmp' })).resolves.toEqual({
        success: false,
        error: 'Failed to spawn session: boom',
        errorCode: 'SPAWN_FAILED',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps connected-service switch HTTP diagnostics on its existing adapter path', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/connected-service-auth/session/switch') {
        res.statusCode = 501;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          ok: false,
          errorCode: 'connected_service_auth_switch_unavailable',
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(controlClient.requestDaemonSessionConnectedServiceAuthSwitch({
        sessionId: 'session-1',
        agentId: 'grok',
        bindings: {
          v: 1,
          bindingsByServiceId: {},
        },
      })).rejects.toThrow(
        /HTTP 501 \(connected_service_auth_switch_unavailable\)/u,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('posts canonical spawn request bodies to /spawn-session without rebuilding a stale field list', async () => {
    let observedBody: Record<string, unknown> | null = null;

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/spawn-session') {
        let rawBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          rawBody += chunk;
        });
        req.on('end', () => {
          observedBody = JSON.parse(rawBody) as Record<string, unknown>;
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ success: true, sessionId: 'sess-1' }));
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      const spawnRequest: SpawnDaemonSessionRequest = {
        directory: '/tmp',
        existingSessionId: 'sess-existing',
        spawnNonce: 'spawn-nonce-1',
        transcriptStorage: 'direct',
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['server-portable'],
          forceExcludeServerIds: ['server-disabled'],
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', profileId: 'work' },
          },
        },
      };

      await expect(spawnDaemonSession(spawnRequest)).resolves.toEqual({
        success: true,
        sessionId: 'sess-1',
      });
      expect(observedBody).toEqual(spawnRequest);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('posts connected-service turn lifecycle events to the daemon control route', async () => {
    let observedUrl: string | undefined;
    let observedBody: Record<string, unknown> | null = null;

    const server = http.createServer((req, res) => {
      observedUrl = req.url;
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        observedBody = JSON.parse(rawBody) as Record<string, unknown>;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          ok: true,
          result: {
            status: 'continue',
            turnCustody: {
              status: 'recorded',
              activeTurnId: 'session-turn:exact-1',
            },
          },
        }));
      });
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(controlClient.notifyDaemonConnectedServiceTurnLifecycle({
        sessionId: 'sess_1',
        event: 'prompt_or_steer',
        requestedAction: { v: 1, kind: 'steer_now' },
        activeTurnId: 'session-turn:exact-1',
      })).resolves.toEqual({
        status: 'continue',
        turnCustody: {
          status: 'recorded',
          activeTurnId: 'session-turn:exact-1',
        },
      });

      expect(observedUrl).toBe('/connected-service-turn-lifecycle');
      expect(observedBody).toEqual({
        sessionId: 'sess_1',
        event: 'prompt_or_steer',
        requestedAction: { v: 1, kind: 'steer_now' },
        activeTurnId: 'session-turn:exact-1',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('posts provider account usage snapshots to the canonical daemon control route', async () => {
    let observedUrl: string | undefined;
    let observedBody: Record<string, unknown> | null = null;

    const server = http.createServer((req, res) => {
      observedUrl = req.url;
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        observedBody = JSON.parse(rawBody) as Record<string, unknown>;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: { recorded: true } }));
      });
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      const recordKey = {
        providerId: 'claude',
        accountSubjectId: 'usr_123',
        subjectKind: 'account',
        quotaScope: 'account',
      } as const;
      const snapshot: ProviderAccountUsageSnapshotV1 = {
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'claude',
        accountSubject: { kind: 'providerSubject', id: 'usr_123' },
        observedAtMs: 1,
        fetchedAtMs: 1,
        staleAfterMs: 2,
        source: 'runtimeSignal',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: 'Pro',
        accountLabel: null,
        meters: [],
      };

      await expect(controlClient.notifyDaemonProviderAccountUsageSnapshot({
        sessionId: 'sess_1',
        snapshot,
        deriveCredentialFingerprintFromSource: true,
        credentialFingerprint: 'sha256:deadbeef',
      })).resolves.toEqual({
        ok: true,
        result: { recorded: true },
      });

      expect(observedUrl).toBe('/provider-account-usage-snapshot');
      expect(observedBody).toEqual({
        sessionId: 'sess_1',
        snapshot,
        deriveCredentialFingerprintFromSource: true,
        credentialFingerprint: 'sha256:deadbeef',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('posts provider account usage adoption to the canonical daemon control route', async () => {
    let observedUrl = '';
    let observedBody: unknown = null;
    const server = http.createServer((req, res) => {
      observedUrl = req.url || '';
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        observedBody = JSON.parse(body);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: { adopted: true } }));
      });
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      const fromKey = {
        providerId: 'claude',
        accountSubjectId: 'provisional:native',
        subjectKind: 'unknown',
        quotaScope: 'account',
      } as const;
      const stableRecordKey = {
        providerId: 'claude',
        accountSubjectId: 'usr_123',
        subjectKind: 'account',
        quotaScope: 'account',
      } as const;
      const adoption: ProviderAccountUsageAdoptionV1 = {
        providerId: 'claude',
        fromRecordId: buildProviderAccountUsageRecordId(fromKey),
        toRecordId: buildProviderAccountUsageRecordId(stableRecordKey),
        stableRecordKey,
        proof: { kind: 'provider_account_id_match' },
        observedAtMs: 1,
      };

      await expect(controlClient.notifyDaemonProviderAccountUsageAdoption({
        sessionId: 'sess_1',
        adoption,
      })).resolves.toEqual({
        ok: true,
        result: { adopted: true },
      });

      expect(observedUrl).toBe('/provider-account-usage-adoption');
      expect(observedBody).toEqual({
        sessionId: 'sess_1',
        adoption,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('down-converts built-in V2 backend targets for old-daemon spawn parsers', async () => {
    let observedBody: Record<string, unknown> | null = null;
    let parsedLegacyBody: Partial<Record<LegacySpawnAllowlistField, unknown>> | null = null;

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/spawn-session') {
        let rawBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          rawBody += chunk;
        });
        req.on('end', () => {
          observedBody = JSON.parse(rawBody) as Record<string, unknown>;
          const parsed = parseLegacySpawnRequestAllowlist(observedBody);
          if (parsed.ok) {
            parsedLegacyBody = parsed.parsed;
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ success: true, sessionId: 'sess-legacy-daemon' }));
            return;
          }
          res.statusCode = 400;
          res.end(parsed.error);
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(spawnDaemonSession({
        directory: '/tmp',
        spawnNonce: 'spawn-nonce-legacy-compat',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        transcriptStorage: 'direct',
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['server-portable'],
          forceExcludeServerIds: ['server-disabled'],
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', profileId: 'work' },
          },
        },
      })).resolves.toEqual({
        success: true,
        sessionId: 'sess-legacy-daemon',
      });
      expect(observedBody).toEqual(expect.objectContaining({
        directory: '/tmp',
        spawnNonce: 'spawn-nonce-legacy-compat',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        transcriptStorage: 'direct',
      }));
      expect(parsedLegacyBody).toEqual({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('resolves spawn-session nonce status from daemon control server', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/spawn-session/resolve') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ success: true, status: 'success', sessionId: 'sess-resolved' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);
      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(resolveDaemonSpawnSessionByNonce('nonce-1')).resolves.toEqual({
        status: 'success',
        sessionId: 'sess-resolved',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns unsupported for nonce lookup when daemon does not expose /spawn-session/resolve', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/spawn-session/resolve') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = 200;
      res.end();
    });

    try {
      const { port } = await listen(server);
      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(resolveDaemonSpawnSessionByNonce('nonce-1')).resolves.toEqual({
        status: 'unsupported',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
