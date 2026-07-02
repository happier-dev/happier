import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';

import {
  ConnectedServiceQuotaSnapshotV1Schema,
  openAccountScopedBlobCiphertext,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import {
  spawnConnectedCodexSession,
  startConnectedServicesCodexDaemon,
  startFakeTokenServer,
  type FakeTokenServerRequest,
  type StartedConnectedServicesCodexDaemonFixture,
} from '../../src/testkit/connectedServicesCodexDaemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type CountingServerProxy = Readonly<{
  baseUrl: string;
  quotaWriteCount: () => number;
  stop: () => Promise<void>;
}>;

type QuotaGetResponse = Readonly<{
  sealed?: Readonly<{ format: 'account_scoped_v1'; ciphertext: string }>;
  metadata?: Readonly<{ fetchedAt: number; staleAfterMs: number; status: string }>;
}>;

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function writeProxyResponse(res: ServerResponse, response: Response, body: Buffer): void {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });
  res.end(body);
}

function copyBufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(out).set(buffer);
  return out;
}

async function startCountingServerProxy(targetBaseUrl: string): Promise<CountingServerProxy> {
  let quotaWriteCount = 0;
  const target = new URL(targetBaseUrl);
  const server = createServer(async (req, res) => {
    try {
      const targetUrl = new URL(req.url ?? '/', targetBaseUrl);
      const body = await readRequestBody(req);
      if (
        req.method === 'POST' &&
        /^\/v2\/connect\/[^/]+\/profiles\/[^/]+\/quotas$/u.test(targetUrl.pathname)
      ) {
        quotaWriteCount += 1;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() === 'host') continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else if (typeof value === 'string') {
          headers.set(key, value);
        }
      }
      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : copyBufferToArrayBuffer(body),
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      writeProxyResponse(res, response, responseBody);
    } catch (error) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const targetSocket = connect({
      host: target.hostname,
      port: Number(target.port),
    });
    targetSocket.once('connect', () => {
      targetSocket.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n`);
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const key = req.rawHeaders[index];
        const value = req.rawHeaders[index + 1];
        if (!key || value === undefined) continue;
        targetSocket.write(`${key}: ${value}\r\n`);
      }
      targetSocket.write('\r\n');
      if (head.length > 0) targetSocket.write(head);
      socket.pipe(targetSocket);
      targetSocket.pipe(socket);
    });
    targetSocket.once('error', () => socket.destroy());
    socket.once('error', () => targetSocket.destroy());
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('counting proxy missing address');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    quotaWriteCount: () => quotaWriteCount,
    stop: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

function createSnapshot(params: Readonly<{
  profileId: string;
  fetchedAt: number;
  used: number;
}>): ConnectedServiceQuotaSnapshotV1 {
  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: 'openai-codex',
    profileId: params.profileId,
    fetchedAt: params.fetchedAt,
    staleAfterMs: 60_000,
    planLabel: 'Pro',
    accountLabel: 'user@example.test',
    meters: [
      {
        meterId: 'weekly',
        label: 'Weekly',
        used: params.used,
        limit: 100,
        unit: 'count',
        utilizationPct: null,
        resetsAt: null,
        status: 'ok',
        details: {},
      },
    ],
  });
}

async function postQuotaSnapshotToDaemon(
  fixture: StartedConnectedServicesCodexDaemonFixture,
  sessionId: string,
  snapshot: ConnectedServiceQuotaSnapshotV1,
): Promise<void> {
  const response = await daemonControlPostJson<{
    ok?: boolean;
    result?: { status?: string; quotaStateRecorded?: boolean };
  }>({
    port: fixture.daemonPort,
    path: '/connected-service-quota-snapshot',
    controlToken: fixture.controlToken,
    body: {
      sessionId,
      serviceId: snapshot.serviceId,
      snapshot,
    },
    timeoutMs: 30_000,
  });
  expect(response.status).toBe(200);
  expect(response.data.ok).toBe(true);
  expect(response.data.result).toMatchObject({ status: 'recorded', quotaStateRecorded: true });
}

async function fetchPersistedQuotaSnapshot(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  profileId: string;
}>): Promise<ConnectedServiceQuotaSnapshotV1> {
  const response = await fetchJson<QuotaGetResponse>(
    `${params.fixture.serverBaseUrl}/v2/connect/openai-codex/profiles/${params.profileId}/quotas`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.fixture.auth.token}`,
        'Content-Type': 'application/json',
      },
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  const ciphertext = response.data?.sealed?.ciphertext;
  expect(typeof ciphertext).toBe('string');
  const opened = openAccountScopedBlobCiphertext({
    kind: 'connected_service_quota_snapshot',
    material: { type: 'legacy', secret: params.fixture.accountSecret },
    ciphertext: ciphertext ?? '',
  });
  expect(opened?.value).toBeTruthy();
  return ConnectedServiceQuotaSnapshotV1Schema.parse(opened?.value);
}

describe('core e2e: connected-service quota in-band coalescing', () => {
  let fixture: StartedConnectedServicesCodexDaemonFixture | null = null;
  let tokenServer: Awaited<ReturnType<typeof startFakeTokenServer>> | null = null;
  let proxy: CountingServerProxy | null = null;

  afterEach(async () => {
    await fixture?.daemon.stop().catch(() => {});
    await fixture?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
    await proxy?.stop().catch(() => {});
    fixture = null;
    tokenServer = null;
    proxy = null;
  }, 60_000);

  it('coalesces duplicate in-band quota snapshots and persists the latest material state', async () => {
    const testDir = run.testDir('connected-services-quotas-coalescing');
    tokenServer = await startFakeTokenServer({
      respond: (_request: FakeTokenServerRequest) => ({
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
    fixture = await startConnectedServicesCodexDaemon({
      testDir,
      testName: 'connected-services-quotas-coalescing',
      tokenUrl: tokenServer.tokenUrl,
      accessToken: 'access-initial',
      refreshToken: 'refresh-initial',
      idToken: 'id-initial',
      expiresAt: Date.now() + 60 * 60_000,
      resolveDaemonServerBaseUrl: async (serverBaseUrl) => {
        proxy = await startCountingServerProxy(serverBaseUrl);
        return proxy.baseUrl;
      },
    });

    const sessionId = randomUUID();
    const spawn = await spawnConnectedCodexSession(fixture, sessionId);
    expect(spawn.status).toBe(200);
    expect(spawn.data.success).toBe(true);
    expect(typeof spawn.data.sessionId).toBe('string');
    const happySessionId = spawn.data.sessionId ?? sessionId;

    const duplicate = createSnapshot({ profileId: 'work', fetchedAt: 1_000, used: 12 });
    for (let index = 0; index < 20; index += 1) {
      await postQuotaSnapshotToDaemon(fixture, happySessionId, duplicate);
    }

    const latest = createSnapshot({ profileId: 'work', fetchedAt: 2_000, used: 42 });
    await postQuotaSnapshotToDaemon(fixture, happySessionId, latest);

    await waitFor(async () => {
      const persisted = await fetchPersistedQuotaSnapshot({ fixture: fixture!, profileId: 'work' });
      return persisted.fetchedAt === latest.fetchedAt && persisted.meters[0]?.used === latest.meters[0]?.used;
    }, { timeoutMs: 20_000, intervalMs: 250 });

    const persisted = await fetchPersistedQuotaSnapshot({ fixture, profileId: 'work' });
    expect(persisted.fetchedAt).toBe(latest.fetchedAt);
    expect(persisted.meters[0]?.used).toBe(latest.meters[0]?.used);
    expect(proxy?.quotaWriteCount()).toBeLessThanOrEqual(3);
  }, 360_000);
});
