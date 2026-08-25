import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { URL } from 'node:url';
import { join } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import {
  renderServerLightSqliteDatabaseUrl,
  resolveTestDbProvider,
  startServerLight,
  type StartedServer,
} from '../../src/testkit/process/serverLight';
import {
  acquireServerLightPostgresVoiceMintLock,
  countServerLightPostgresVoiceMintLockWaiters,
  readServerLightVoiceLeaseRows,
  resolveServerLightAccountId,
  type ServerLightQueryableDbProvider,
} from '../../src/testkit/process/serverLightDatabase';
import { createTestAuth } from '../../src/testkit/auth';
import { sleep, waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const configuredDbProvider = resolveTestDbProvider(process.env, {
  fallbackProvider: 'sqlite',
});
const suiteDbProvider = configuredDbProvider;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function getBoolean(record: UnknownRecord, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean ${key}`);
  }
  return value;
}

function getString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected string ${key}`);
  }
  return value;
}

function serverDatabaseTarget(server: StartedServer): Readonly<{
  provider: ServerLightQueryableDbProvider;
  databaseUrl: string;
}> {
  if (suiteDbProvider === 'pglite') {
    throw new Error('Voice lease database inspection requires sqlite, postgres, or mysql; PGlite is intentionally skipped.');
  }
  if (suiteDbProvider === 'sqlite') {
    return {
      provider: 'sqlite',
      databaseUrl: renderServerLightSqliteDatabaseUrl({
        dbPath: join(server.dataDir, 'happier-server-light.sqlite'),
      }),
    };
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(`Missing DATABASE_URL for ${suiteDbProvider} Voice lease inspection.`);
  }
  return { provider: suiteDbProvider, databaseUrl };
}

async function expectPromiseStillPending(promise: Promise<unknown>): Promise<void> {
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    sleep(250).then(() => false),
  ]);
  expect(settled).toBe(false);
}

async function mintVoiceLease(params: Readonly<{
  baseUrl: string;
  token: string;
  path: '/v1/voice/token' | '/v1/voice/lease/mint';
  sessionId?: string;
}>): Promise<Readonly<{ response: Response; body: UnknownRecord }>> {
  const response = await fetch(`${params.baseUrl}${params.path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
  });
  const payload: unknown = await response.json().catch(() => null);
  const body = asRecord(payload);
  if (!body) throw new Error('Expected JSON object response');
  return { response, body };
}

async function startElevenLabsStub(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/v1/convai/conversation/token') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'e2e_elevenlabs_token' }));
      return;
    }

    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Stub server did not bind to a TCP port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

describe.skipIf(suiteDbProvider === 'pglite')('core e2e: voice lease mint (account-scoped)', () => {
  let elevenStub: Server | null = null;
  let server: StartedServer | null = null;

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (!elevenStub) {
        resolve();
        return;
      }
      elevenStub.close(() => resolve());
    });
    elevenStub = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('mints via /v1/voice/lease/mint and persists a lease with sessionId null', async () => {
    const testDir = run.testDir('voice-lease-mint-account-scoped');

    const stub = await startElevenLabsStub();
    elevenStub = stub.server;

    server = await startServerLight({
      testDir,
      dbProvider: suiteDbProvider,
      extraEnv: {
        HAPPIER_FEATURE_VOICE__ENABLED: 'true',
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: 'false',
        HAPPIER_VOICE_TOKEN_RATE_LIMIT_MAX: '100',
        VOICE_MAX_CONCURRENT_SESSIONS: '1',
        VOICE_MAX_SESSION_SECONDS: '60',
        ELEVENLABS_API_KEY: 'e2e-elevenlabs-key',
        ELEVENLABS_AGENT_ID: 'agent_dev',
        ELEVENLABS_API_BASE_URL: stub.baseUrl,
      },
    });

    const auth = await createTestAuth(server.baseUrl);
    const expectedAccountId = await resolveServerLightAccountId({
      ...serverDatabaseTarget(server),
      publicKey: auth.publicKeyBase64,
    });
    const mint = await mintVoiceLease({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v1/voice/lease/mint',
    });
    expect(mint.response.ok).toBe(true);
    expect(getBoolean(mint.body, 'allowed')).toBe(true);
    expect(getString(mint.body, 'token')).toBe('e2e_elevenlabs_token');
    const leaseId = getString(mint.body, 'leaseId');
    expect(leaseId.length).toBeGreaterThan(0);

    const rows = await readServerLightVoiceLeaseRows({
      ...serverDatabaseTarget(server),
      leaseId,
      expectedAccountId,
    });
    expect(rows.lease).toEqual({ accountId: expectedAccountId, sessionId: null });
    expect(rows.accountLeaseCount).toBe(1);
  }, 240_000);

  it.skipIf(suiteDbProvider !== 'postgres')(
    'blocks both aliases on the exact account advisory lock, then serializes their durable admission',
    async () => {
      if (!server) throw new Error('Expected the PostgreSQL Voice server to be started.');

      const accountA = await createTestAuth(server.baseUrl);
      const database = serverDatabaseTarget(server);
      const accountAId = await resolveServerLightAccountId({
        ...database,
        publicKey: accountA.publicKeyBase64,
      });
      const accountALock = await acquireServerLightPostgresVoiceMintLock({
        databaseUrl: database.databaseUrl,
        accountId: accountAId,
      });
      const tokenMint = mintVoiceLease({
        baseUrl: server.baseUrl,
        token: accountA.token,
        path: '/v1/voice/token',
        sessionId: 'postgres-concurrent-token',
      });
      const aliasMint = mintVoiceLease({
        baseUrl: server.baseUrl,
        token: accountA.token,
        path: '/v1/voice/lease/mint',
        sessionId: 'postgres-concurrent-alias',
      });
      try {
        await waitFor(
          async () => await countServerLightPostgresVoiceMintLockWaiters({
            databaseUrl: database.databaseUrl,
            accountId: accountAId,
          }) === 2,
          { timeoutMs: 10_000, context: 'both Voice mint aliases waiting on Account A advisory lock' },
        );
        await expectPromiseStillPending(tokenMint);
        await expectPromiseStillPending(aliasMint);
      } finally {
        await accountALock.release();
      }
      const [tokenResult, aliasResult] = await Promise.all([
        tokenMint,
        aliasMint,
      ]);
      const sameAccountResults = [tokenResult, aliasResult];
      expect(sameAccountResults.map(({ response }) => response.status).sort()).toEqual([200, 429]);
      const admitted = sameAccountResults.find(({ response }) => response.status === 200);
      const rejected = sameAccountResults.find(({ response }) => response.status === 429);
      if (!admitted || !rejected) throw new Error('Expected one admitted and one rejected same-account mint.');
      expect(getBoolean(admitted.body, 'allowed')).toBe(true);
      expect(getBoolean(rejected.body, 'allowed')).toBe(false);
      expect(getString(rejected.body, 'reason')).toBe('too_many_sessions');

      const accountARows = await readServerLightVoiceLeaseRows({
        ...database,
        leaseId: getString(admitted.body, 'leaseId'),
        expectedAccountId: accountAId,
      });
      expect(accountARows.lease).toMatchObject({ accountId: accountAId });
      expect(accountARows.accountLeaseCount).toBe(1);

      const [accountB, accountC] = await Promise.all([
        createTestAuth(server.baseUrl),
        createTestAuth(server.baseUrl),
      ]);
      const accountBId = await resolveServerLightAccountId({
        ...database,
        publicKey: accountB.publicKeyBase64,
      });
      const accountCId = await resolveServerLightAccountId({
        ...database,
        publicKey: accountC.publicKeyBase64,
      });
      const accountBLock = await acquireServerLightPostgresVoiceMintLock({
        databaseUrl: database.databaseUrl,
        accountId: accountBId,
      });
      try {
        const accountCMint = await mintVoiceLease({
          baseUrl: server.baseUrl,
          token: accountC.token,
          path: '/v1/voice/token',
          sessionId: 'postgres-account-c',
        });
        expect(accountCMint.response.status).toBe(200);
        const accountCRows = await readServerLightVoiceLeaseRows({
          ...database,
          leaseId: getString(accountCMint.body, 'leaseId'),
          expectedAccountId: accountCId,
        });
        expect(accountCRows.lease).toMatchObject({ accountId: accountCId });
        expect(accountCRows.accountLeaseCount).toBe(1);
      } finally {
        await accountBLock.release();
      }
    },
    240_000,
  );
});
