import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

function resolveServerLightSqliteDbPath(server: StartedServer): string {
  return resolve(join(server.dataDir, 'happier-server-light.sqlite'));
}

function markSessionAsInactiveInSqlite(params: { server: StartedServer; sessionId: string }): void {
  const dbPath = resolveServerLightSqliteDbPath(params.server);
  const staleEpochMs = String(new Date('2024-01-01T00:00:00.000Z').getTime());
  execFileSync(
    'sqlite3',
    [
      dbPath,
      [
        'UPDATE "Session"',
        `SET "updatedAt" = ${staleEpochMs},`,
        `"lastActiveAt" = ${staleEpochMs},`,
        '"active" = 0',
        `WHERE "id" = '${params.sessionId}';`,
      ].join(' '),
    ],
    { stdio: 'pipe' },
  );
}

async function waitForSessionDeletion(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetchJson<any>(`${params.baseUrl}/v2/sessions/${params.sessionId}`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
      },
      timeoutMs: 5_000,
    });
    if (response.status === 404) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for session ${params.sessionId} to be pruned by retention`);
}

describe('core e2e: server retention session pruning', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('advertises configured retention and prunes sessions after they become inactive past the cutoff', async () => {
    const testDir = run.testDir('server-retention-session-pruning');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_SERVER_RETENTION__ENABLED: '1',
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

    markSessionAsInactiveInSqlite({ server, sessionId });
    await waitForSessionDeletion({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
    });

    const sessions = await fetchJson<any>(`${server.baseUrl}/v2/sessions`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
      },
      timeoutMs: 10_000,
    });
    expect(sessions.status).toBe(200);
    expect(Array.isArray(sessions.data?.sessions)).toBe(true);
    expect((sessions.data?.sessions as Array<{ id?: string }>).some((session) => session.id === sessionId)).toBe(false);
  }, 180_000);
});
