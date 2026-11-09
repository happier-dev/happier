import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { reconcileCodexResumeRolloutPath, resolveExistingCodexIndexedRolloutPath } from './reconcileResumeRolloutPath.js';

const temporaryRoots: string[] = [];

async function createFixture(): Promise<Readonly<{
  codexHome: string;
  databasePath: string;
  rolloutPath: string;
  sqliteHome: string;
  vendorResumeId: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-resume-index-'));
  temporaryRoots.push(root);
  const codexHome = join(root, 'materialized-codex-home');
  const sqliteHome = join(root, 'shared-codex-state');
  const vendorResumeId = '019fea40-8040-7d00-9b7e-9b8f3b5cfca8';
  const rolloutDirectory = join(codexHome, 'sessions', '2026', '09', '07');
  const rolloutPath = join(
    rolloutDirectory,
    `rollout-2026-09-07T12-00-00-${vendorResumeId}.jsonl`,
  );
  await mkdir(rolloutDirectory, { recursive: true });
  await mkdir(sqliteHome, { recursive: true });
  await writeFile(rolloutPath, '{}\n', 'utf8');
  const databasePath = join(sqliteHome, 'state_5.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
  database.close();
  return { codexHome, databasePath, rolloutPath, sqliteHome, vendorResumeId };
}

function readIndexedPath(databasePath: string, vendorResumeId: string): string | null {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database
      .prepare('SELECT rollout_path FROM threads WHERE id = ?')
      .get(vendorResumeId) as { rollout_path?: unknown } | undefined;
    return typeof row?.rollout_path === 'string' ? row.rollout_path : null;
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('reconcileCodexResumeRolloutPath', () => {
  it('reads the host-selected shared index without launch environment affinity or index mutation', async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(fixture.vendorResumeId, fixture.rolloutPath);
    database.close();
    await writeFile(join(fixture.codexHome, '.happier-state-sharing.json'), JSON.stringify({
      v: 1, effectiveStateMode: 'shared', stateRootEnvironment: { CODEX_SQLITE_HOME: fixture.sqliteHome },
    }));
    expect(await resolveExistingCodexIndexedRolloutPath({
      processEnv: { CODEX_HOME: fixture.codexHome }, cwd: fixture.codexHome,
      vendorResumeId: fixture.vendorResumeId, signal: new AbortController().signal,
    })).toBe(fixture.rolloutPath);
    expect(readIndexedPath(fixture.databasePath, fixture.vendorResumeId)).toBe(fixture.rolloutPath);
  });

  it('repoints an exact stale shared SQLite row to the surviving rollout', async () => {
    const fixture = await createFixture();
    const stalePath = join(fixture.codexHome, '..', 'removed-generation', 'sessions', 'rollout.jsonl');
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)')
      .run(fixture.vendorResumeId, stalePath);
    database.close();

    await expect(reconcileCodexResumeRolloutPath({
      processEnv: {
        CODEX_HOME: fixture.codexHome,
        CODEX_SQLITE_HOME: fixture.sqliteHome,
      },
      cwd: fixture.codexHome,
      vendorResumeId: fixture.vendorResumeId,
    })).resolves.toBe(true);

    expect(readIndexedPath(fixture.databasePath, fixture.vendorResumeId))
      .toBe(fixture.rolloutPath);
  });

  it('does not replace a live path selected by Codex', async () => {
    const fixture = await createFixture();
    const indexedPath = join(fixture.sqliteHome, 'provider-owned-rollout.jsonl');
    await writeFile(indexedPath, '{}\n', 'utf8');
    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)')
      .run(fixture.vendorResumeId, indexedPath);
    database.close();

    await expect(reconcileCodexResumeRolloutPath({
      processEnv: {
        CODEX_HOME: fixture.codexHome,
        CODEX_SQLITE_HOME: fixture.sqliteHome,
      },
      cwd: fixture.codexHome,
      vendorResumeId: fixture.vendorResumeId,
    })).resolves.toBe(true);

    expect(readIndexedPath(fixture.databasePath, fixture.vendorResumeId)).toBe(indexedPath);
  });

  it('addresses the thread row and rollout by the exact vendor resume id bytes', async () => {
    const fixture = await createFixture();
    const exactVendorResumeId = '  provider ses AB+cd==  ';
    const strippedVendorResumeId = exactVendorResumeId.trim();
    const rolloutDirectory = join(fixture.codexHome, 'sessions', '2026', '09', '13');
    const exactRolloutPath = join(rolloutDirectory, `rollout-2026-09-13T12-00-00-${exactVendorResumeId}.jsonl`);
    const strippedRolloutPath = join(rolloutDirectory, `rollout-2026-09-13T12-00-00-${strippedVendorResumeId}.jsonl`);
    await mkdir(rolloutDirectory, { recursive: true });
    await writeFile(exactRolloutPath, '{}\n', 'utf8');
    await writeFile(strippedRolloutPath, '{}\n', 'utf8');
    const stalePath = join(fixture.codexHome, '..', 'removed-generation', 'sessions', 'rollout.jsonl');
    const database = new DatabaseSync(fixture.databasePath);
    const insert = database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)');
    insert.run(exactVendorResumeId, stalePath);
    insert.run(strippedVendorResumeId, stalePath);
    database.close();

    await expect(reconcileCodexResumeRolloutPath({
      processEnv: {
        CODEX_HOME: fixture.codexHome,
        CODEX_SQLITE_HOME: fixture.sqliteHome,
      },
      cwd: fixture.codexHome,
      vendorResumeId: exactVendorResumeId,
    })).resolves.toBe(true);

    expect(readIndexedPath(fixture.databasePath, exactVendorResumeId)).toBe(exactRolloutPath);
    expect(readIndexedPath(fixture.databasePath, strippedVendorResumeId)).toBe(stalePath);
  });

  it('does not create a missing provider database', async () => {
    const fixture = await createFixture();
    await rm(fixture.databasePath);

    await expect(reconcileCodexResumeRolloutPath({
      processEnv: {
        CODEX_HOME: fixture.codexHome,
        CODEX_SQLITE_HOME: fixture.sqliteHome,
      },
      cwd: fixture.codexHome,
      vendorResumeId: fixture.vendorResumeId,
    })).resolves.toBe(true);

    await expect(access(fixture.databasePath)).rejects.toThrow();
  });
});

 it.each([false, true])('preserves the logical index path for a compressed rollout (stale=%s)', async stale => {
  const fixture = await createFixture();
  await writeFile(`${fixture.rolloutPath}.zst`, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  await rm(fixture.rolloutPath);
  const indexedPath = stale ? join(fixture.codexHome, '..', 'removed-generation', 'rollout.jsonl') : fixture.rolloutPath;
  const database = new DatabaseSync(fixture.databasePath);
  try {
    database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(fixture.vendorResumeId, indexedPath);
  } finally {
    database.close();
  }
  const processEnv = { CODEX_HOME: fixture.codexHome, CODEX_SQLITE_HOME: fixture.sqliteHome };
  expect(await reconcileCodexResumeRolloutPath({ processEnv, cwd: fixture.codexHome, vendorResumeId: fixture.vendorResumeId })).toBe(true);
  expect(readIndexedPath(fixture.databasePath, fixture.vendorResumeId)).toBe(fixture.rolloutPath);
  expect(await resolveExistingCodexIndexedRolloutPath({ processEnv, cwd: fixture.codexHome,
    vendorResumeId: fixture.vendorResumeId, signal: new AbortController().signal,
  })).toBe(`${fixture.rolloutPath}.zst`);
});
