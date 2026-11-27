import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchAllMessages } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

function resolveServerLightSqliteDbPath(server: StartedServer): string {
  return resolve(join(server.dataDir, 'happier-server-light.sqlite'));
}

function markSessionAsInactiveInSqlite(params: { server: StartedServer; sessionId: string }): void {
  const dbPath = resolveServerLightSqliteDbPath(params.server);
  const staleEpochMs = Date.parse('2024-01-01T00:00:00.000Z');
  const database = new DatabaseSync(dbPath);
  try {
    database.exec('PRAGMA busy_timeout=5000');
    database.prepare('UPDATE "Session" SET "updatedAt" = ?, "lastActiveAt" = ?, "active" = 0 WHERE "id" = ?')
      .run(staleEpochMs, staleEpochMs, params.sessionId);
  } finally {
    database.close();
  }
}

async function waitForCloudCopyRemoval(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetchJson<{ session?: { cloudCopyLeftAt?: number } }>(`${params.baseUrl}/v2/sessions/${params.sessionId}`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
      },
      timeoutMs: 5_000,
    });
    if (response.status === 200 && typeof response.data?.session?.cloudCopyLeftAt === 'number') {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for session ${params.sessionId} to lose its cloud transcript`);
}

describe('core e2e: server retention session pruning', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('advertises configured retention and keeps sessions in the list after their cloud transcript expires', async () => {
    const testDir = run.testDir('server-retention-session-pruning');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_SERVER_RETENTION__ENABLED: '1',
        HAPPIER_SERVER_RETENTION__DRY_RUN: 'false',
        HAPPIER_SERVER_RETENTION__STARTS_AT: '2024-01-01T00:00:00.000Z',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: '200',
        HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
        HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: '1',
      },
    });

    const features = await fetchJson<any>(`${server.baseUrl}/v1/features`);
    expect(features.status).toBe(200);
    expect(features.data?.capabilities?.server?.retention).toMatchObject({
      enabled: true,
      sessions: {
        mode: 'delete_inactive',
        inactivityDays: 1,
      },
    });

    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const write = await fetchJson(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext: Buffer.from('retained-transcript-fixture').toString('base64') }),
    });
    expect(write.status).toBe(200);
    expect(await fetchAllMessages(server.baseUrl, auth.token, sessionId)).toHaveLength(1);

    markSessionAsInactiveInSqlite({ server, sessionId });
    await waitForCloudCopyRemoval({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
    });

    expect(await fetchAllMessages(server.baseUrl, auth.token, sessionId)).toHaveLength(0);

    const sessions = await fetchJson<any>(`${server.baseUrl}/v2/sessions`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
      },
      timeoutMs: 10_000,
    });
    expect(sessions.status).toBe(200);
    expect(Array.isArray(sessions.data?.sessions)).toBe(true);
    expect(sessions.data?.sessions).toContainEqual(expect.objectContaining({ id: sessionId, cloudCopyLeftAt: expect.any(Number) }));
  }, 180_000);
});
