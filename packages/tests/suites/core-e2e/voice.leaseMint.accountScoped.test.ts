import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { URL } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';

const run = createRunDirs({ runLabel: 'core' });

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

describe('core e2e: voice lease mint (account-scoped)', () => {
  let elevenStub: Server | null = null;
  let server: StartedServer | null = null;

  afterAll(async () => {
    await new Promise<void>((resolve) => elevenStub?.close(() => resolve()));
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
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_VOICE__ENABLED: 'true',
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: 'false',
        VOICE_TOKEN_MAX_PER_MINUTE: '0',
        VOICE_MAX_CONCURRENT_SESSIONS: '1',
        VOICE_MAX_SESSION_SECONDS: '60',
        ELEVENLABS_API_KEY: 'e2e-elevenlabs-key',
        ELEVENLABS_AGENT_ID: 'agent_dev',
        ELEVENLABS_API_BASE_URL: stub.baseUrl,
      },
    });

    const auth = await createTestAuth(server.baseUrl);
    const res = await fetch(`${server.baseUrl}/v1/voice/lease/mint`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.ok).toBe(true);

    const payload: unknown = await res.json().catch(() => null);
    const json = asRecord(payload);
    if (!json) throw new Error('Expected JSON object response');
    expect(getBoolean(json, 'allowed')).toBe(true);
    expect(getString(json, 'token')).toBe('e2e_elevenlabs_token');
    const leaseId = getString(json, 'leaseId');
    expect(leaseId.length).toBeGreaterThan(0);

    const dbPath = join(server.dataDir, 'happier-server-light.sqlite');
    const sqlite = new DatabaseSync(dbPath);
    const row: unknown = sqlite.prepare('select sessionId from VoiceSessionLease where id = ?').get(leaseId);
    expect(row).toEqual({ sessionId: null });
  }, 240_000);
});
