import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import {
  startTestDaemon,
  stopDaemonFromHomeDir,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
  startFakeTokenServer,
  startConnectedServicesCodexDaemon,
  spawnConnectedCodexSession,
  type StartedConnectedServicesCodexDaemonFixture,
} from '../../src/testkit/connectedServicesCodexDaemon';
import { fetchJson } from '../../src/testkit/http';
import { startHttpRequestRecordingProxy, type HttpRequestRecordingProxy, type RecordedHttpProxyRequest } from '../../src/testkit/httpRequestRecordingProxy';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSessionDetailRead(request: RecordedHttpProxyRequest): boolean {
  return request.method === 'GET' && /^\/v2\/sessions\/[^/?]+(?:\?.*)?$/u.test(request.path);
}

function isChangesRead(request: RecordedHttpProxyRequest): boolean {
  return request.method === 'GET' && request.path.startsWith('/v2/changes');
}

function requestPurpose(request: RecordedHttpProxyRequest): string {
  const value = request.headers['x-happier-request-purpose'];
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function summarizeRequests(params: Readonly<{
  requests: readonly RecordedHttpProxyRequest[];
  startedAtMs: number;
}>): unknown[] {
  return params.requests.map((entry) => ({
    method: entry.method,
    path: entry.path,
    purpose: requestPurpose(entry),
    startedOffsetMs: entry.startedAtMs - params.startedAtMs,
    durationMs: entry.endedAtMs === null ? null : entry.endedAtMs - entry.startedAtMs,
    statusCode: entry.statusCode,
    error: entry.error,
  }));
}

function withTemporaryEnv<T>(values: Readonly<Record<string, string>>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

async function waitForRequestQuiescence(params: Readonly<{
  proxy: HttpRequestRecordingProxy;
  predicate: (request: RecordedHttpProxyRequest) => boolean;
  quietMs: number;
  timeoutMs: number;
  context: string;
}>): Promise<void> {
  const startedAt = Date.now();
  let lastCount = params.proxy.count(params.predicate);
  let quietSince = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    await sleep(100);
    const nextCount = params.proxy.count(params.predicate);
    if (nextCount !== lastCount) {
      lastCount = nextCount;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= params.quietMs) return;
  }
  const recent = params.proxy.entries()
    .filter(params.predicate)
    .slice(-10);
  const summarized = summarizeRequests({ requests: recent, startedAtMs: startedAt });
  throw new Error(`Timed out waiting for ${params.context} request quiescence; recent=${JSON.stringify(summarized)}`);
}

describe('core e2e: socket-first runtime route counts', () => {
  let connectedFixture: StartedConnectedServicesCodexDaemonFixture | null = null;
  let tokenServer: Awaited<ReturnType<typeof startFakeTokenServer>> | null = null;
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let daemonHomeDir: string | null = null;
  let proxy: HttpRequestRecordingProxy | null = null;

  afterEach(async () => {
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
      daemonHomeDir = null;
    }
    await daemon?.stop().catch(() => {});
    daemon = null;
    await connectedFixture?.daemon.stop().catch(() => {});
    await connectedFixture?.server.stop().catch(() => {});
    connectedFixture = null;
    await tokenServer?.stop().catch(() => {});
    tokenServer = null;
    await proxy?.stop().catch(() => {});
    proxy = null;
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('keeps healthy idle ACP/provider waits at zero repeated session-detail reads after startup', async () => {
    await withTemporaryEnv({
      HAPPIER_SOCKET_TRANSPORTS: 'polling',
    }, async () => {
      const testDir = run.testDir(`socket-first-idle-route-counts-${randomUUID()}`);
      tokenServer = await startFakeTokenServer({
        respond: () => ({
          status: 200,
          body: {
            access_token: 'access-refreshed',
            refresh_token: 'refresh-refreshed',
            id_token: 'id-refreshed',
            expires_in: 3600,
            token_type: 'Bearer',
          },
        }),
      });
      connectedFixture = await startConnectedServicesCodexDaemon({
        testDir,
        testName: 'socket-first-idle-route-counts',
        tokenUrl: tokenServer.tokenUrl,
        accessToken: 'access-initial',
        refreshToken: 'refresh-initial',
        idToken: 'id-initial',
        expiresAt: Date.now() + 60 * 60_000,
        resolveDaemonServerBaseUrl: async (serverBaseUrl) => {
          proxy = await startHttpRequestRecordingProxy({ targetBaseUrl: serverBaseUrl });
          return proxy.baseUrl;
        },
      });

      const runnerEnv = {
        HAPPIER_SOCKET_TRANSPORTS: 'polling',
      };
      const spawn = await spawnConnectedCodexSession(connectedFixture, randomUUID(), {
        environmentVariables: runnerEnv,
      });
      expect(spawn.status).toBe(200);
      expect(spawn.data.success).toBe(true);

      if (!proxy) throw new Error('Expected recording proxy');
      await waitForRequestQuiescence({
        proxy,
        predicate: (entry) => isSessionDetailRead(entry) || isChangesRead(entry),
        quietMs: 5_000,
        timeoutMs: 60_000,
        context: 'startup realtime catch-up',
      });
      proxy.clear();
      const measurementStartedAt = Date.now();
      await sleep(8_000);

      const postStartupDetailReads = proxy.entries().filter((entry) =>
        isSessionDetailRead(entry) || isChangesRead(entry));
      expect(summarizeRequests({
        requests: postStartupDetailReads,
        startedAtMs: measurementStartedAt,
      })).toEqual([]);
    });
  }, 240_000);

  it('limits concurrent existing-session attach detail reads during daemon spawn bursts', async () => {
    const testDir = run.testDir(`socket-first-attach-burst-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);
    proxy = await startHttpRequestRecordingProxy({
      targetBaseUrl: server.baseUrl,
      delayRequestMs: (request) => isSessionDetailRead(request) ? 300 : 0,
    });

    daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: proxy.baseUrl, token: auth.token, secret });

    const sessionIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const metadata = encryptLegacyBase64({
        flavor: 'claude',
        path: workspaceDir,
        claudeSessionId: `fake-claude-resume-${index}`,
      }, secret);
      const created = await createSessionWithCiphertexts({
        baseUrl: server.baseUrl,
        token: auth.token,
        tag: `socket-first-attach-burst-${index}-${randomUUID()}`,
        metadataCiphertextBase64: metadata,
        agentStateCiphertextBase64: null,
      });
      sessionIds.push(created.sessionId);
    }

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const daemonEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: proxy.baseUrl,
      HAPPIER_WEBAPP_URL: proxy.baseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_DAEMON_REATTACH_CATCHUP_CONCURRENCY: '4',
    };

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      cleanupDescendantsOnExit: true,
    });

    proxy.clear();
    const spawnResults = await Promise.all(sessionIds.map((sessionId) =>
      daemonControlPostJson({
        port: daemon!.state.httpPort,
        path: '/spawn-session',
        controlToken: daemon!.state.controlToken,
        body: {
          directory: workspaceDir,
          existingSessionId: sessionId,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          terminal: { mode: 'plain' },
          environmentVariables: daemonEnv,
        },
        timeoutMs: 180_000,
      })));

    for (const result of spawnResults) {
      expect(result.status).toBe(200);
      expect(result.data.success).toBe(true);
    }

    const detailReads = proxy.entries().filter(isSessionDetailRead);
    expect(detailReads).toHaveLength(sessionIds.length);
    expect(proxy.maxConcurrent(isSessionDetailRead)).toBeLessThanOrEqual(4);
    expect(new Set(detailReads.map((entry) => entry.headers['x-happier-request-purpose']))).toEqual(
      new Set(['session-detail:manual-recovery']),
    );

    const list = await daemonControlPostJson<{ children?: unknown[] }>({
      port: daemon.state.httpPort,
      path: '/list',
      controlToken: daemon.state.controlToken,
    });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.data.children)).toBe(true);
    expect(list.data.children?.length).toBeGreaterThanOrEqual(sessionIds.length);

    const ready = await fetchJson(`${server.baseUrl}/ready`, { timeoutMs: 10_000 });
    expect(ready.status).toBe(200);
  }, 360_000);
});
