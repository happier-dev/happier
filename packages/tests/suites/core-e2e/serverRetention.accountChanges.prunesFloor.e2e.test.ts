import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { fetchChanges, fetchCursor } from '../../src/testkit/changes';
import { createSession } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

function resolveServerLightSqliteDbPath(server: StartedServer): string {
  return resolve(join(server.dataDir, 'happier-server-light.sqlite'));
}

function markAccountChangesAsStaleInSqlite(params: { server: StartedServer }): void {
  const dbPath = resolveServerLightSqliteDbPath(params.server);
  const staleEpochMs = String(new Date('2024-01-01T00:00:00.000Z').getTime());
  execFileSync(
    'sqlite3',
    [
      dbPath,
      `UPDATE "AccountChange" SET "changedAt" = ${staleEpochMs};`,
    ],
    { stdio: 'pipe' },
  );
}

async function waitForChangesFloorAdvance(params: {
  baseUrl: string;
  token: string;
  minimumFloor: number;
  timeoutMs?: number;
}): Promise<{ cursor: number; changesFloor: number }> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const cursor = await fetchCursor(params.baseUrl, params.token);
    if (cursor.changesFloor >= params.minimumFloor) {
      return cursor;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for changesFloor >= ${params.minimumFloor}`);
}

describe('core e2e: server retention account-change pruning', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('advances changesFloor after pruning aged account changes and returns 410 for stale cursors', async () => {
    const testDir = run.testDir('server-retention-account-changes-floor');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_SERVER_RETENTION__ENABLED: '1',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: '200',
        HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: 'delete_older_than',
        HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: '1',
      },
    });

    const auth = await createTestAuth(server.baseUrl);
    const cursor0 = await fetchCursor(server.baseUrl, auth.token);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const changesBeforePrune = await fetchChanges(server.baseUrl, auth.token, { after: cursor0.cursor });
    expect(changesBeforePrune.changes.some((change) => change.kind === 'session' && change.entityId === sessionId)).toBe(true);
    const staleAfterCursor = changesBeforePrune.nextCursor;

    markAccountChangesAsStaleInSqlite({ server });

    const advancedCursor = await waitForChangesFloorAdvance({
      baseUrl: server.baseUrl,
      token: auth.token,
      minimumFloor: staleAfterCursor,
    });

    expect(advancedCursor.changesFloor).toBeGreaterThanOrEqual(staleAfterCursor);

    const staleChanges = await fetchJson<{ error?: string; currentCursor?: number }>(
      `${server.baseUrl}/v2/changes?after=${cursor0.cursor}&limit=50`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
        },
        timeoutMs: 10_000,
      },
    );

    expect(staleChanges.status).toBe(410);
    expect(staleChanges.data).toMatchObject({
      error: 'cursor-gone',
      currentCursor: advancedCursor.cursor,
    });

    const currentChanges = await fetchChanges(server.baseUrl, auth.token, { after: advancedCursor.cursor });
    expect(currentChanges.changes).toHaveLength(0);
    expect(currentChanges.nextCursor).toBe(advancedCursor.cursor);
  }, 180_000);
});
