import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { writeDaemonState, clearDaemonStateForTests } from '@/persistence';
import * as controlClient from '@/daemon/controlClient';
import {
  DaemonConnectedServiceRefreshError,
  notifyDaemonConnectedServiceTurnLifecycle,
  requestDaemonSessionConnectedServiceAuthSwitch,
  resolveDaemonSpawnSessionByNonce,
  spawnDaemonSession,
} from '@/daemon/controlClient';
import { deriveConnectedServiceBrokerRefreshToken } from '@/daemon/connectedServices/broker/brokerRefreshCapabilityToken';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

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
    await clearDaemonStateForTests();
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    reloadConfiguration();
    if (tmpHomeDir) {
      await removeTempDir(tmpHomeDir);
      tmpHomeDir = null;
    }
  });

  it('settles an in-flight control request when the caller aborts', async () => {
    let requestObserved: (() => void) | null = null;
    const observed = new Promise<void>((resolve) => {
      requestObserved = resolve;
    });
    const server = http.createServer((_req, _res) => {
      requestObserved?.();
      // Keep the response open so only the caller signal can settle this request.
    });

    try {
      const { port } = await listen(server);
      tmpHomeDir = await createTempDir('happier-daemon-client-abort-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      const controller = new AbortController();
      const request = notifyDaemonConnectedServiceTurnLifecycle({
        sessionId: 'sess_1',
        event: 'assistant_message_end',
        terminalStatus: 'completed',
      }, {
        signal: controller.signal,
        timeoutMs: 60_000,
      });

      await observed;
      controller.abort();

      await expect(request).resolves.toEqual({
        error: expect.stringMatching(/aborted|aborterror/i),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('posts manual connected-service auth switch requests to the daemon control route', async () => {
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
        res.end(JSON.stringify({ ok: true, result: { ok: true, action: 'restart_requested' } }));
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

      await expect(requestDaemonSessionConnectedServiceAuthSwitch({
        sessionId: 'sess_1',
        agentId: 'claude',
        accountSettingsVersionHint: 42,
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
          },
        },
      })).resolves.toEqual({ ok: true, action: 'restart_requested' });

      expect(observedUrl).toBe('/connected-service-auth/session/switch');
      expect(observedBody).toEqual({
        sessionId: 'sess_1',
        agentId: 'claude',
        accountSettingsVersionHint: 42,
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
          },
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('posts exact prompt authorization fields while preserving old-body terminal notifications', async () => {
    let observedUrl: string | undefined;
    const observedBodies: Array<Record<string, unknown>> = [];

    const server = http.createServer((req, res) => {
      observedUrl = req.url;
      let rawBody = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        rawBody += chunk;
      });
      req.on('end', () => {
        observedBodies.push(JSON.parse(rawBody) as Record<string, unknown>);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          ok: true,
          result: {
            status: 'continue',
            turnCustody: {
              status: 'ignored_missing_exact_turn',
              activeTurnId: null,
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

      await expect(notifyDaemonConnectedServiceTurnLifecycle({
        sessionId: 'sess_1',
        event: 'prompt_or_steer',
        requestedAction: { v: 1, kind: 'steer_if_active' },
        activeTurnId: 'session-turn:exact-1',
      })).resolves.toEqual({
        status: 'continue',
        turnCustody: {
          status: 'ignored_missing_exact_turn',
          activeTurnId: null,
        },
      });

      expect(observedUrl).toBe('/connected-service-turn-lifecycle');
      expect(observedBodies[0]).toEqual({
        sessionId: 'sess_1',
        event: 'prompt_or_steer',
        requestedAction: { v: 1, kind: 'steer_if_active' },
        activeTurnId: 'session-turn:exact-1',
      });

      await expect(notifyDaemonConnectedServiceTurnLifecycle({
        sessionId: 'sess_1',
        event: 'assistant_message_end',
        terminalStatus: 'completed',
        turnId: 'session-turn:exact-1',
      })).resolves.toMatchObject({ status: 'continue' });
      expect(observedBodies[1]).toEqual({
        sessionId: 'sess_1',
        event: 'assistant_message_end',
        terminalStatus: 'completed',
        turnId: 'session-turn:exact-1',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns parsed 409 payload from /spawn-session (directory approval flow)', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/spawn-session') {
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

      await expect(spawnDaemonSession('/tmp')).resolves.toEqual({
        success: false,
        requiresUserApproval: true,
        actionRequired: 'CREATE_DIRECTORY',
        directory: '/tmp',
      });
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

      await expect(spawnDaemonSession('/tmp')).resolves.toEqual({
        success: false,
        error: 'Failed to spawn session: boom',
        errorCode: 'SPAWN_FAILED',
      });
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

  it('remains compatible with old-daemon allowlist parsers that ignore unknown spawn fields', async () => {
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
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        pendingFirstInput: {
          text: 'commit through Pending after session creation',
          localId: 'spawn-first:legacy-compat',
        },
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
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        pendingFirstInput: {
          text: 'commit through Pending after session creation',
          localId: 'spawn-first:legacy-compat',
        },
        transcriptStorage: 'direct',
      }));
      expect(parsedLegacyBody).toEqual({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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

  it('posts Codex ChatGPT refresh bridge requests to daemon control server', async () => {
    let observedBody: Record<string, unknown> | null = null;
    let observedAuthToken: string | undefined;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh') {
        const rawAuthToken = req.headers['x-happier-daemon-token'];
        observedAuthToken = Array.isArray(rawAuthToken) ? rawAuthToken.join(',') : rawAuthToken;
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
              accessToken: 'fresh-access',
              chatgptAccountId: 'acct_123',
              chatgptPlanType: 'plus',
            },
          }));
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

      const refresh = (controlClient as {
        refreshDaemonOpenAiCodexChatGptAuthTokensForBridge?: (input: Readonly<{
          sessionId: string;
          selection: Readonly<{ kind: 'profile'; serviceId: 'openai-codex'; profileId: string }>;
          chatgptPlanType: string | null;
        }>) => Promise<unknown>;
      }).refreshDaemonOpenAiCodexChatGptAuthTokensForBridge;
      expect(typeof refresh).toBe('function');
      await expect(refresh!({
        sessionId: 'sess_1',
        selection: {
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'work',
        },
        chatgptPlanType: 'plus',
      })).resolves.toEqual({
        accessToken: 'fresh-access',
        chatgptAccountId: 'acct_123',
        chatgptPlanType: 'plus',
      });
      expect(observedBody).toEqual({
        sessionId: 'sess_1',
        selection: {
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'work',
        },
        chatgptPlanType: 'plus',
      });
      expect(observedAuthToken).toBe('test-token');
      expect(observedAuthToken).not.toBe(deriveConnectedServiceBrokerRefreshToken('test-token'));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('preserves reconnect-required credential health from the daemon refresh bridge', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/connected-service-auth/openai-codex/chatgpt-auth-tokens/refresh') {
        req.resume();
        res.statusCode = 409;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          ok: false,
          errorCode: 'connected_service_credential_reconnect_required',
          credentialHealthStatus: 'needs_reauth',
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);
      tmpHomeDir = await createTempDir('happier-daemon-client-refresh-health-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(controlClient.refreshDaemonOpenAiCodexChatGptAuthTokensForBridge({
        sessionId: 'sess_1',
        selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
        chatgptPlanType: 'plus',
      })).rejects.toMatchObject({
        name: DaemonConnectedServiceRefreshError.name,
        errorCode: 'connected_service_credential_reconnect_required',
        credentialHealthStatus: 'needs_reauth',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('posts forced Claude subscription refresh bridge requests to daemon control server', async () => {
    let observedBody: Record<string, unknown> | null = null;
    let observedAuthToken: string | undefined;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh') {
        const rawAuthToken = req.headers['x-happier-daemon-token'];
        observedAuthToken = Array.isArray(rawAuthToken) ? rawAuthToken.join(',') : rawAuthToken;
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
              accessToken: 'fresh-claude-access',
              anthropicAccountId: 'acct_123',
              expiresAt: 123_456,
            },
          }));
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

      const refresh = (controlClient as {
        refreshDaemonClaudeSubscriptionAnthropicAuthTokensForBridge?: (input: Readonly<{
          sessionId: string;
          selection: Readonly<{ kind: 'profile'; serviceId: 'claude-subscription'; profileId: string }>;
          forceRefresh?: boolean;
        }>) => Promise<unknown>;
      }).refreshDaemonClaudeSubscriptionAnthropicAuthTokensForBridge;
      expect(typeof refresh).toBe('function');
      await expect(refresh!({
        sessionId: 'sess_1',
        selection: {
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'work',
        },
        forceRefresh: true,
      })).resolves.toEqual({
        accessToken: 'fresh-claude-access',
        anthropicAccountId: 'acct_123',
        expiresAt: 123_456,
      });
      expect(observedBody).toEqual({
        sessionId: 'sess_1',
        selection: {
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'work',
        },
        forceRefresh: true,
      });
      expect(observedAuthToken).toBe('test-token');
      expect(observedAuthToken).not.toBe(deriveConnectedServiceBrokerRefreshToken('test-token'));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('preserves reconnect-required credential health from the Claude daemon refresh bridge', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/connected-service-auth/claude-subscription/anthropic-auth-tokens/refresh') {
        req.resume();
        res.statusCode = 409;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          ok: false,
          errorCode: 'connected_service_credential_reconnect_required',
          credentialHealthStatus: 'needs_reauth',
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);
      tmpHomeDir = await createTempDir('happier-daemon-client-claude-refresh-health-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(controlClient.refreshDaemonClaudeSubscriptionAnthropicAuthTokensForBridge({
        sessionId: 'sess_1',
        selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' },
        forceRefresh: true,
      })).rejects.toMatchObject({
        name: DaemonConnectedServiceRefreshError.name,
        errorCode: 'connected_service_credential_reconnect_required',
        credentialHealthStatus: 'needs_reauth',
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
