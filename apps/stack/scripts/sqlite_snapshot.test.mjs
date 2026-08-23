import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  createSqliteSnapshot,
  restoreSqliteSnapshot,
} from './utils/sqlite/sqlite_snapshot.mjs';

const scriptPath = fileURLToPath(new URL('./sqlite_snapshot.mjs', import.meta.url));

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-snapshot-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function queryDatabase(path, sql) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function createDatabase(path, { withLedger = false, large = false } = {}) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE retained (id INTEGER PRIMARY KEY, value TEXT NOT NULL, payload BLOB);');
  db.prepare('INSERT INTO retained (value, payload) VALUES (?, ?)').run(
    'preserved',
    large ? new Uint8Array(16 * 1024 * 1024) : new Uint8Array([0, 1, 2, 127, 128, 254, 255]),
  );
  if (withLedger) {
    db.exec(`
      CREATE TABLE "_prisma_migrations" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "checksum" TEXT NOT NULL,
        "finished_at" DATETIME,
        "migration_name" TEXT NOT NULL,
        "logs" TEXT,
        "rolled_back_at" DATETIME,
        "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
        "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
      );
    `);
    db.prepare(`
      INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, applied_steps_count)
      VALUES (?, ?, ?, ?, ?)
    `).run('migration-1', 'checksum-a', '2026-07-17T00:00:00.000Z', '20260717000000_initial', 1);
  }
  db.close();
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

async function waitForPartial(...directories) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const directory of directories) {
      const name = (await readdir(directory)).find((entry) => entry.includes('.partial-'));
      if (name) return join(directory, name);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for a partial file in ${directories.join(', ')}`);
}

async function waitForManifestPartial(...directories) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const directory of directories) {
      const name = (await readdir(directory)).find((entry) => entry.includes('.manifest.partial-'));
      if (name) return join(directory, name);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for a manifest partial file in ${directories.join(', ')}`);
}

async function waitForWrittenPartial(directory) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const name = (await readdir(directory)).find((entry) => entry.includes('.partial-'));
    if (name) {
      const path = join(directory, name);
      if ((await lstat(path)).size > 0) return path;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for a written partial file in ${directory}`);
}

async function waitForExisting(path) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test('online snapshot includes committed WAL rows and publishes private output plus a fingerprint manifest', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputParent = join(disposableRoot, 'copies');
    const snapshotPath = join(outputParent, 'snapshot.sqlite');
    const previousUmask = process.umask(0);
    try {
      await mkdir(outputParent, { recursive: true, mode: 0o777 });

      const source = new DatabaseSync(sourcePath);
      source.exec('PRAGMA journal_mode = WAL;');
      source.exec('PRAGMA wal_autocheckpoint = 0;');
      source.exec('CREATE TABLE retained (id INTEGER PRIMARY KEY, secret BLOB NOT NULL, note TEXT NOT NULL);');
      source.prepare('INSERT INTO retained (secret, note) VALUES (?, ?)').run(
        new Uint8Array([0, 1, 2, 127, 128, 254, 255]),
        'ciphertext-like-value',
      );
      await chmod(sourcePath, 0o666);

      try {
        const result = await createSqliteSnapshot({
          sourcePath,
          outputPath: snapshotPath,
          disposableRoot,
        });

        assert.equal(result.integrityCheck, 'ok');
        assert.equal(result.outputPath, snapshotPath);
        assert.equal(result.manifestPath, `${snapshotPath}.manifest.json`);
        assert.equal((await lstat(disposableRoot)).mode & 0o777, 0o700);
        assert.equal((await lstat(outputParent)).mode & 0o777, 0o700);
        assert.equal((await lstat(snapshotPath)).mode & 0o777, 0o600);
        assert.equal((await lstat(result.manifestPath)).mode & 0o777, 0o600);
        await assertMissing(`${snapshotPath}-wal`);
        await assertMissing(`${snapshotPath}-shm`);
        assert.match(result.fingerprints.contentSha256, /^[a-f0-9]{64}$/);
        assert.match(result.fingerprints.structureSha256, /^[a-f0-9]{64}$/);
        assert.deepEqual(result.fingerprints.prismaMigrations, {
          state: 'absent',
          rowCount: 0,
          sha256: null,
        });
        assert.equal(result.fingerprints.contentSha256, await sha256File(snapshotPath));
        assert.deepEqual(JSON.parse(await readFile(result.manifestPath, 'utf8')), {
          format: 'happier-sqlite-snapshot-v1',
          fingerprints: result.fingerprints,
        });
        assert.deepEqual(queryDatabase(snapshotPath, 'SELECT id, hex(secret) AS secret, note FROM retained'), [{
          id: 1,
          secret: '0001027F80FEFF',
          note: 'ciphertext-like-value',
        }]);
      } finally {
        source.close();
      }
    } finally {
      process.umask(previousUmask);
    }
  });
});

test('restore verifies the snapshot manifest and publishes a new private database with identical fingerprints', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    const restoredPath = join(disposableRoot, 'restored.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { withLedger: true });

    const snapshot = await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });
    const restored = await restoreSqliteSnapshot({
      snapshotPath,
      outputPath: restoredPath,
      disposableRoot,
    });

    assert.equal(restored.integrityCheck, 'ok');
    assert.equal(restored.sourceManifestPath, snapshot.manifestPath);
    assert.equal(restored.manifestPath, `${restoredPath}.manifest.json`);
    assert.deepEqual(restored.fingerprints, snapshot.fingerprints);
    assert.equal((await lstat(restoredPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(restored.manifestPath)).mode & 0o777, 0o600);
    assert.deepEqual(queryDatabase(restoredPath, 'SELECT id, value FROM retained'), [{
      id: 1,
      value: 'preserved',
    }]);
    await assert.rejects(
      restoreSqliteSnapshot({ snapshotPath, outputPath: restoredPath, disposableRoot }),
      /already exists/,
    );
  });
});

test('restore preserves the exact content fingerprint of a snapshot created from a WAL source', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    const restoredPath = join(disposableRoot, 'restored.sqlite');
    await mkdir(disposableRoot);

    const source = new DatabaseSync(sourcePath);
    source.exec('PRAGMA journal_mode = WAL;');
    source.exec('CREATE TABLE retained (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
    source.prepare('INSERT INTO retained (value) VALUES (?)').run('preserved-from-wal');
    source.close();

    const snapshot = await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });
    const restored = await restoreSqliteSnapshot({
      snapshotPath,
      outputPath: restoredPath,
      disposableRoot,
    });

    assert.deepEqual(restored.fingerprints, snapshot.fingerprints);
    assert.equal(await sha256File(restoredPath), snapshot.fingerprints.contentSha256);
    assert.deepEqual(queryDatabase(restoredPath, 'SELECT id, value FROM retained'), [{
      id: 1,
      value: 'preserved-from-wal',
    }]);
  });
});

test('fingerprints distinguish content and Prisma ledger changes while structural identity remains deterministic', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { withLedger: true });

    const first = await createSqliteSnapshot({
      sourcePath,
      outputPath: join(disposableRoot, 'first.sqlite'),
      disposableRoot,
    });
    const db = new DatabaseSync(sourcePath);
    db.exec("UPDATE retained SET value = 'changed';");
    db.exec("UPDATE \"_prisma_migrations\" SET checksum = 'checksum-b';");
    db.close();
    const second = await createSqliteSnapshot({
      sourcePath,
      outputPath: join(disposableRoot, 'second.sqlite'),
      disposableRoot,
    });

    assert.equal(first.fingerprints.prismaMigrations.state, 'present');
    assert.equal(first.fingerprints.prismaMigrations.rowCount, 1);
    assert.match(first.fingerprints.prismaMigrations.sha256, /^[a-f0-9]{64}$/);
    assert.equal(first.fingerprints.structureSha256, second.fingerprints.structureSha256);
    assert.notEqual(first.fingerprints.contentSha256, second.fingerprints.contentSha256);
    assert.notEqual(first.fingerprints.prismaMigrations.sha256, second.fingerprints.prismaMigrations.sha256);
  });
});

test('Prisma ledger fingerprint preserves valid 64-bit integer values without precision loss', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { withLedger: true });
    const source = new DatabaseSync(sourcePath);
    source.exec('UPDATE "_prisma_migrations" SET applied_steps_count = 9223372036854775807;');
    source.close();

    const snapshot = await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });

    assert.equal(snapshot.fingerprints.prismaMigrations.state, 'present');
    assert.equal(snapshot.fingerprints.prismaMigrations.rowCount, 1);
    assert.match(snapshot.fingerprints.prismaMigrations.sha256, /^[a-f0-9]{64}$/);
  });
});

test('structure and Prisma ledger fingerprints are deterministic across creation and row order', async () => {
  await withTempDir(async (dir) => {
    const firstSourcePath = join(dir, 'first-source.sqlite');
    const secondSourcePath = join(dir, 'second-source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    await mkdir(disposableRoot);
    const retainedSql = 'CREATE TABLE "retained items" (id INTEGER PRIMARY KEY, value TEXT NOT NULL);';
    const ledgerSql = `
      CREATE TABLE "_prisma_migrations" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "checksum" TEXT NOT NULL,
        "logs" TEXT,
        "applied_steps_count" INTEGER NOT NULL
      );
    `;
    const sharedSchemaSql = `
      CREATE INDEX "retained value index" ON "retained items" (value);
      CREATE VIEW "retained view" AS SELECT id, value FROM "retained items";
      CREATE TRIGGER "retained trim trigger"
      AFTER INSERT ON "retained items"
      BEGIN
        UPDATE "retained items" SET value = trim(NEW.value) WHERE id = NEW.id;
      END;
    `;
    const ledgerRows = [
      ['migration-b', 'checksum-b', 'quoted "text"', 9223372036854775807n],
      ['migration-a', 'checksum-a', null, 1n],
    ];
    for (const [path, reverseSchema, reverseRows] of [
      [firstSourcePath, false, false],
      [secondSourcePath, true, true],
    ]) {
      const database = new DatabaseSync(path);
      database.exec(reverseSchema ? `${ledgerSql}${retainedSql}` : `${retainedSql}${ledgerSql}`);
      database.exec(sharedSchemaSql);
      const insert = database.prepare(`
        INSERT INTO "_prisma_migrations" (id, checksum, logs, applied_steps_count)
        VALUES (?, ?, ?, ?)
      `);
      for (const row of reverseRows ? [...ledgerRows].reverse() : ledgerRows) insert.run(...row);
      database.close();
    }

    const first = await createSqliteSnapshot({
      sourcePath: firstSourcePath,
      outputPath: join(disposableRoot, 'first.sqlite'),
      disposableRoot,
    });
    const second = await createSqliteSnapshot({
      sourcePath: secondSourcePath,
      outputPath: join(disposableRoot, 'second.sqlite'),
      disposableRoot,
    });

    assert.equal(first.fingerprints.structureSha256, second.fingerprints.structureSha256);
    assert.deepEqual(first.fingerprints.prismaMigrations, second.fingerprints.prismaMigrations);
  });
});

test('snapshot reads a read-only source and excludes an active WAL writer uncommitted row', async () => {
  await withTempDir(async (dir) => {
    const readOnlySourcePath = join(dir, 'read-only.sqlite');
    const activeSourcePath = join(dir, 'active.sqlite');
    const disposableRoot = join(dir, 'disposable');
    await mkdir(disposableRoot);
    createDatabase(readOnlySourcePath);
    await chmod(readOnlySourcePath, 0o400);
    const readOnly = await createSqliteSnapshot({
      sourcePath: readOnlySourcePath,
      outputPath: join(disposableRoot, 'read-only-snapshot.sqlite'),
      disposableRoot,
    });
    assert.equal(readOnly.integrityCheck, 'ok');

    createDatabase(activeSourcePath);
    const writer = new DatabaseSync(activeSourcePath);
    writer.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;');
    writer.prepare('INSERT INTO retained (value, payload) VALUES (?, ?)').run('uncommitted', null);
    try {
      const active = await createSqliteSnapshot({
        sourcePath: activeSourcePath,
        outputPath: join(disposableRoot, 'active-snapshot.sqlite'),
        disposableRoot,
      });
      assert.deepEqual(queryDatabase(active.outputPath, 'SELECT value FROM retained ORDER BY id'), [{
        value: 'preserved',
      }]);
    } finally {
      writer.exec('ROLLBACK;');
      writer.close();
    }
  });
});

test('online backup waits for a short exclusive busy period and copies the committed database', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath);
    const locker = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(process.argv[1]);
        database.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;');
        process.stdout.write('locked\\n');
        setTimeout(() => {
          database.exec('ROLLBACK;');
          database.close();
        }, 300);
      `,
      sourcePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(locker, 'exit');
    const [ready] = await once(locker.stdout, 'data');
    assert.match(String(ready), /locked/);

    const snapshot = await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });
    const [status] = await exited;

    assert.equal(status, 0);
    assert.equal(snapshot.integrityCheck, 'ok');
    assert.deepEqual(queryDatabase(snapshotPath, 'SELECT value FROM retained'), [{ value: 'preserved' }]);
  });
});

test('restore rejects database tampering and leaves no accepted output or partial artifact', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    const restoredPath = join(disposableRoot, 'restored.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath);
    await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });

    const snapshot = new DatabaseSync(snapshotPath);
    snapshot.exec("UPDATE retained SET value = 'tampered';");
    snapshot.close();

    await assert.rejects(
      restoreSqliteSnapshot({ snapshotPath, outputPath: restoredPath, disposableRoot }),
      /content fingerprint/i,
    );
    await assertMissing(restoredPath);
    await assertMissing(`${restoredPath}.manifest.json`);
    assert.equal((await readdir(disposableRoot)).some((entry) => entry.includes('.partial-')), false);
  });
});

test('restore rejects a tampered Prisma ledger fingerprint before publishing output', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    const restoredPath = join(disposableRoot, 'restored.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { withLedger: true });
    const created = await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });
    const manifest = JSON.parse(await readFile(created.manifestPath, 'utf8'));
    manifest.fingerprints.prismaMigrations.sha256 = '1'.repeat(64);
    await writeFile(created.manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');

    await assert.rejects(
      restoreSqliteSnapshot({ snapshotPath, outputPath: restoredPath, disposableRoot }),
      /migration ledger fingerprint/i,
    );
    await assertMissing(restoredPath);
    await assertMissing(`${restoredPath}.manifest.json`);
  });
});

test('restore rejects duplicate manifest keys instead of accepting JSON last-key-wins ambiguity', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    const restoredPath = join(disposableRoot, 'restored.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { withLedger: true });
    const created = await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });
    const manifest = JSON.parse(await readFile(created.manifestPath, 'utf8'));
    await writeFile(created.manifestPath, [
      '{',
      '"format":"attacker-controlled-format",',
      `"format":"${manifest.format}",`,
      `"fingerprints":${JSON.stringify(manifest.fingerprints)}`,
      '}\n',
    ].join(''), 'utf8');

    await assert.rejects(
      restoreSqliteSnapshot({ snapshotPath, outputPath: restoredPath, disposableRoot }),
      /duplicate.*format|format.*duplicate/i,
    );
    await assertMissing(restoredPath);
    await assertMissing(`${restoredPath}.manifest.json`);
  });
});

test('restore rejects an oversized manifest before parsing or publishing output', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    const restoredPath = join(disposableRoot, 'restored.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath);
    const created = await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });
    const manifest = await readFile(created.manifestPath, 'utf8');
    await writeFile(created.manifestPath, `${' '.repeat(128 * 1024)}${manifest}`, 'utf8');

    await assert.rejects(
      restoreSqliteSnapshot({ snapshotPath, outputPath: restoredPath, disposableRoot }),
      /manifest.*too large|too large.*manifest/i,
    );
    await assertMissing(restoredPath);
    await assertMissing(`${restoredPath}.manifest.json`);
  });
});

test('restore rejects a manifest that is not valid UTF-8 before publishing output', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    const restoredPath = join(disposableRoot, 'restored.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath);
    const created = await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });
    await writeFile(created.manifestPath, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));

    await assert.rejects(
      restoreSqliteSnapshot({ snapshotPath, outputPath: restoredPath, disposableRoot }),
      /manifest.*UTF-8|UTF-8.*manifest/i,
    );
    await assertMissing(restoredPath);
    await assertMissing(`${restoredPath}.manifest.json`);
  });
});

test('restore detects manifest replacement during backup and removes the unpublished restore', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    const restoredPath = join(disposableRoot, 'restored.sqlite');
    const originalManifestPath = join(disposableRoot, 'snapshot.manifest-original.json');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { withLedger: true, large: true });
    const created = await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });
    const manifestBytes = await readFile(created.manifestPath);

    const pending = restoreSqliteSnapshot({ snapshotPath, outputPath: restoredPath, disposableRoot });
    await waitForPartial(disposableRoot);
    await rename(created.manifestPath, originalManifestPath);
    await writeFile(created.manifestPath, manifestBytes, { mode: 0o600 });

    await assert.rejects(pending, /manifest.*replaced|manifest.*identity changed/i);
    await assertMissing(restoredPath);
    await assertMissing(`${restoredPath}.manifest.json`);
    assert.equal((await readdir(disposableRoot)).some((entry) => entry.includes('.partial-')), false);
  });
});

test('fails closed for relative paths, outside destinations, nonregular files, and symlinks', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    createDatabase(sourcePath);
    const disposableRoot = join(dir, 'disposable');
    const outsideParent = join(dir, 'outside');
    const outsidePath = join(outsideParent, 'outside.sqlite');
    const sourceLink = join(dir, 'source-link.sqlite');
    const rootLink = join(dir, 'root-link');
    const linkedParent = join(dir, 'linked-parent');
    await mkdir(disposableRoot);
    await mkdir(outsideParent, { mode: 0o755 });
    await chmod(outsideParent, 0o755);
    await symlink(sourcePath, sourceLink);
    await symlink(disposableRoot, rootLink);
    await symlink(disposableRoot, linkedParent);

    await assert.rejects(
      createSqliteSnapshot({ sourcePath: 'source.sqlite', outputPath: join(disposableRoot, 'snapshot.sqlite'), disposableRoot }),
      /absolute/,
    );
    await assert.rejects(
      createSqliteSnapshot({ sourcePath, outputPath: outsidePath, disposableRoot }),
      /disposable root/,
    );
    assert.equal((await lstat(outsideParent)).mode & 0o777, 0o755);
    await assert.rejects(
      createSqliteSnapshot({ sourcePath: sourceLink, outputPath: join(disposableRoot, 'snapshot.sqlite'), disposableRoot }),
      /symbolic link/,
    );
    await assert.rejects(
      createSqliteSnapshot({ sourcePath, outputPath: join(linkedParent, 'snapshot.sqlite'), disposableRoot }),
      /symbolic link|disposable root/,
    );
    await assert.rejects(
      createSqliteSnapshot({ sourcePath, outputPath: join(disposableRoot, 'snapshot.sqlite'), disposableRoot: rootLink }),
      /symbolic link/,
    );
    await assert.rejects(
      createSqliteSnapshot({ sourcePath: disposableRoot, outputPath: join(disposableRoot, 'snapshot.sqlite'), disposableRoot }),
      /regular file/,
    );
    assert.equal(await readlink(sourceLink), sourcePath);
  });
});

test('restore rejects outside-root and symlinked snapshot or manifest inputs', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    const snapshotLink = join(disposableRoot, 'snapshot-link.sqlite');
    const restoredPath = join(disposableRoot, 'restored.sqlite');
    const outsideSnapshot = join(dir, 'outside-snapshot.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath);
    const created = await createSqliteSnapshot({ sourcePath, outputPath: snapshotPath, disposableRoot });
    await symlink(snapshotPath, snapshotLink);
    await symlink(created.manifestPath, `${snapshotLink}.manifest.json`);

    await assert.rejects(
      restoreSqliteSnapshot({ snapshotPath: snapshotLink, outputPath: restoredPath, disposableRoot }),
      /symbolic link/,
    );
    await rename(snapshotPath, outsideSnapshot);
    await symlink(outsideSnapshot, snapshotPath);
    await assert.rejects(
      restoreSqliteSnapshot({ snapshotPath, outputPath: restoredPath, disposableRoot }),
      /symbolic link/,
    );
    await rm(snapshotPath);
    await rename(outsideSnapshot, snapshotPath);
    await rename(created.manifestPath, join(dir, 'outside-manifest.json'));
    await symlink(join(dir, 'outside-manifest.json'), created.manifestPath);
    await assert.rejects(
      restoreSqliteSnapshot({ snapshotPath, outputPath: restoredPath, disposableRoot }),
      /symbolic link/,
    );
    await assertMissing(restoredPath);
  });
});

test('rejects an existing database or manifest destination without overwriting either', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputPath = join(disposableRoot, 'snapshot.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath);
    await writeFile(outputPath, 'existing database');
    await assert.rejects(
      createSqliteSnapshot({ sourcePath, outputPath, disposableRoot }),
      /already exists/,
    );
    assert.equal(await readFile(outputPath, 'utf8'), 'existing database');

    await rm(outputPath);
    await writeFile(`${outputPath}.manifest.json`, 'existing manifest');
    await assert.rejects(
      createSqliteSnapshot({ sourcePath, outputPath, disposableRoot }),
      /manifest.*already exists|already exists.*manifest/i,
    );
    assert.equal(await readFile(`${outputPath}.manifest.json`, 'utf8'), 'existing manifest');
    await assertMissing(outputPath);
  });
});

test('manifest publication conflict removes the owned database publication and preserves the conflict', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputPath = join(disposableRoot, 'snapshot.sqlite');
    const manifestPath = `${outputPath}.manifest.json`;
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { large: true });

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot });
    await waitForManifestPartial(disposableRoot);
    await writeFile(manifestPath, 'preexisting manifest', { flag: 'wx', mode: 0o600 });

    await assert.rejects(pending, /manifest.*already exists|already exists.*manifest/i);
    await assertMissing(outputPath);
    assert.equal(await readFile(manifestPath, 'utf8'), 'preexisting manifest');
    assert.equal((await readdir(disposableRoot)).some((entry) => entry.includes('.partial-')), false);
  });
});

test('detects source replacement during backup and cleans unpublished artifacts', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const replacedSourcePath = join(dir, 'source-original.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputPath = join(disposableRoot, 'snapshot.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { large: true });

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot });
    await waitForPartial(disposableRoot);
    await rename(sourcePath, replacedSourcePath);
    createDatabase(sourcePath);

    await assert.rejects(pending, /source.*replaced|source.*identity|source.*changed/i);
    await assertMissing(outputPath);
    await assertMissing(`${outputPath}.manifest.json`);
    assert.equal((await readdir(disposableRoot)).some((entry) => entry.includes('.partial-')), false);
  });
});

test('detects private partial replacement during backup and never publishes the substitute', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputPath = join(disposableRoot, 'snapshot.sqlite');
    const displacedPartialPath = join(dir, 'displaced-partial.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { large: true });

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const partialPath = await waitForPartial(disposableRoot);
    while ((await lstat(partialPath)).size === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await rename(partialPath, displacedPartialPath);
    createDatabase(partialPath);
    const substituteSha256 = await sha256File(partialPath);

    const outcome = await pending;
    assert.match(String(outcome.error), /partial.*replaced|partial.*identity|partial.*changed/i);
    await assertMissing(outputPath);
    await assertMissing(`${outputPath}.manifest.json`);
    assert.equal(await sha256File(partialPath), substituteSha256);
  });
});

test('detects manifest partial replacement and never accepts or removes the substitute', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputPath = join(disposableRoot, 'snapshot.sqlite');
    const displacedManifestPath = join(dir, 'displaced-manifest.json');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { large: true });

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const manifestPartialPath = await waitForManifestPartial(disposableRoot);
    while ((await lstat(manifestPartialPath)).size === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const manifestText = await readFile(manifestPartialPath, 'utf8');
    await rename(manifestPartialPath, displacedManifestPath);
    await writeFile(manifestPartialPath, manifestText);
    const substituteSha256 = await sha256File(manifestPartialPath);

    const outcome = await pending;
    assert.ok(outcome.error instanceof Error);
    await assertMissing(outputPath);
    await assertMissing(`${outputPath}.manifest.json`);
    assert.equal(await sha256File(manifestPartialPath), substituteSha256);
  });
});

test('detects output-parent replacement, keeps private partials, and leaves no misleading artifact', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputParent = join(disposableRoot, 'copies');
    const movedParent = join(disposableRoot, 'copies-original');
    const outputPath = join(outputParent, 'snapshot.sqlite');
    await mkdir(outputParent, { recursive: true, mode: 0o777 });
    await chmod(disposableRoot, 0o777);
    await chmod(outputParent, 0o777);
    createDatabase(sourcePath, { large: true });
    await chmod(sourcePath, 0o666);

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot });
    const partialPath = await waitForPartial(disposableRoot, outputParent);
    const observedModes = {
      root: (await lstat(disposableRoot)).mode & 0o777,
      parent: (await lstat(outputParent)).mode & 0o777,
      partial: (await lstat(partialPath)).mode & 0o777,
    };
    await rename(outputParent, movedParent);
    await mkdir(outputParent, { mode: 0o700 });

    const failure = await pending.then(
      () => null,
      (error) => error,
    );
    assert.equal(observedModes.root, 0o700);
    assert.equal(observedModes.parent, 0o700);
    assert.equal(observedModes.partial, 0o600);
    assert.match(String(failure), /output parent.*replaced|output parent.*changed/i);
    await assertMissing(outputPath);
    await assertMissing(`${outputPath}.manifest.json`);
    assert.equal((await readdir(disposableRoot)).some((entry) => entry.includes('.partial-')), false);
    assert.deepEqual(await readdir(movedParent), []);
  });
});

test('nested output stages its manifest partial under the pinned output parent', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputParent = join(disposableRoot, 'copies');
    const outputPath = join(outputParent, 'snapshot.sqlite');
    await mkdir(outputParent, { recursive: true });
    createDatabase(sourcePath, { large: true });

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot });
    const manifestPartialPath = await waitForManifestPartial(disposableRoot, outputParent);
    const result = await pending;

    assert.equal(result.integrityCheck, 'ok');
    assert.equal(dirname(manifestPartialPath), outputParent);
  });
});

test('late output-parent replacement rejects success and leaves only private unaccepted artifacts', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputParent = join(disposableRoot, 'copies');
    const movedParent = join(disposableRoot, 'copies-moved');
    const outputPath = join(outputParent, 'snapshot.sqlite');
    await mkdir(outputParent, { recursive: true });
    createDatabase(sourcePath, { large: true });

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot }).then(
      () => null,
      (error) => error,
    );
    await waitForManifestPartial(outputParent);
    await rename(outputParent, movedParent);
    await mkdir(outputParent, { mode: 0o700 });

    const failure = await pending;
    assert.match(
      String(failure),
      /output parent.*replaced|output parent.*changed|manifest partial.*replaced|manifest partial.*removed|snapshot manifest.*replaced|snapshot manifest.*removed/i,
    );
    await assertMissing(outputPath);
    await assertMissing(`${outputPath}.manifest.json`);
    const movedOutputPath = join(movedParent, 'snapshot.sqlite');
    assert.equal((await lstat(movedOutputPath)).mode & 0o777, 0o600);
    await assertMissing(`${movedOutputPath}.manifest.json`);
    const movedResiduals = await readdir(movedParent);
    assert.equal(movedResiduals.some((entry) => entry.includes('.manifest.partial-')), true);
    for (const residual of movedResiduals) {
      assert.equal((await lstat(join(movedParent, residual))).mode & 0o777, 0o600);
    }
    assert.equal((await readdir(disposableRoot)).some((entry) => entry.includes('.partial-')), false);
  });
});

test('publishing the matching manifest is the final commit point', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputParent = join(disposableRoot, 'copies');
    const movedParent = join(disposableRoot, 'copies-moved');
    const outputPath = join(outputParent, 'snapshot.sqlite');
    const manifestPath = `${outputPath}.manifest.json`;
    await mkdir(outputParent, { recursive: true });
    createDatabase(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source.exec('UPDATE retained SET payload = zeroblob(134217728);');
    source.close();

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot });
    await waitForExisting(manifestPath);
    await rename(outputParent, movedParent);
    await mkdir(outputParent, { mode: 0o700 });

    const result = await pending;
    assert.equal(result.integrityCheck, 'ok');
    const movedOutputPath = join(movedParent, 'snapshot.sqlite');
    const movedManifestPath = `${movedOutputPath}.manifest.json`;
    assert.equal((await lstat(movedOutputPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(movedManifestPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(movedManifestPath, 'utf8')).fingerprints, result.fingerprints);
  });
});

test('rejects disposable-root replacement without deleting substitutes and reports the private residual', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const movedRoot = join(dir, 'disposable-moved');
    const outputPath = join(disposableRoot, 'snapshot.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { large: true });

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot });
    await waitForWrittenPartial(disposableRoot);
    await rename(disposableRoot, movedRoot);
    await mkdir(disposableRoot, { mode: 0o700 });

    await assert.rejects(pending, /partial.*replaced|root.*replaced|root.*changed/i);
    await assertMissing(outputPath);
    await assertMissing(`${outputPath}.manifest.json`);
    const residuals = await readdir(movedRoot);
    assert.equal(residuals.some((entry) => entry.includes('.partial-')), true);
    for (const residual of residuals) {
      assert.equal((await lstat(join(movedRoot, residual))).mode & 0o777, 0o600);
    }
  });
});

test('rejects mutation through the published hard link before accepting its manifest', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputPath = join(disposableRoot, 'snapshot.sqlite');
    const attackerLink = join(dir, 'attacker-link.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { large: true });

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot });
    await waitForManifestPartial(disposableRoot);
    await link(outputPath, attackerLink);
    const attacker = new DatabaseSync(attackerLink);
    attacker.prepare('UPDATE retained SET value = ?').run('mutated-after-fingerprint');
    attacker.close();

    await assert.rejects(pending, /fingerprint|sidecar|changed|replaced/i);
    await assertMissing(outputPath);
    await assertMissing(`${outputPath}.manifest.json`);
  });
});

test('a concurrent hard-link destination cannot overwrite or mutate the source', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputPath = join(disposableRoot, 'snapshot.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath, { large: true });
    const sourceBefore = await sha256File(sourcePath);

    const pending = createSqliteSnapshot({ sourcePath, outputPath, disposableRoot });
    await waitForPartial(disposableRoot);
    await link(sourcePath, outputPath);

    await assert.rejects(pending, /already exists|identity/i);
    assert.equal(await sha256File(sourcePath), sourceBefore);
    assert.equal(await sha256File(outputPath), sourceBefore);
    await assertMissing(`${outputPath}.manifest.json`);
    assert.equal((await readdir(disposableRoot)).some((entry) => entry.includes('.partial-')), false);
  });
});

test('invalid SQLite input fails without publishing output or leaving partial files', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'not-a-database.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const outputPath = join(disposableRoot, 'snapshot.sqlite');
    await mkdir(disposableRoot);
    await writeFile(sourcePath, 'not sqlite');

    await assert.rejects(createSqliteSnapshot({ sourcePath, outputPath, disposableRoot }));
    await assertMissing(outputPath);
    await assertMissing(`${outputPath}.manifest.json`);
    assert.equal((await readdir(disposableRoot)).some((entry) => entry.includes('.partial-')), false);
  });
});

test('CLI requires explicit absolute source, output, and disposable-root paths', () => {
  const result = spawnSync(process.execPath, [
    scriptPath,
    'snapshot',
    '--source=relative.sqlite',
    '--output=relative-snapshot.sqlite',
    '--disposable-root=relative-root',
  ], { encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute/);
});

test('CLI emits the verified machine-readable manifest and fingerprints', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = join(dir, 'source.sqlite');
    const disposableRoot = join(dir, 'disposable');
    const snapshotPath = join(disposableRoot, 'snapshot.sqlite');
    await mkdir(disposableRoot);
    createDatabase(sourcePath);

    const result = spawnSync(process.execPath, [
      scriptPath,
      'snapshot',
      '--source', sourcePath,
      '--output', snapshotPath,
      '--disposable-root', disposableRoot,
      '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.operation, 'snapshot');
    assert.equal(payload.sourcePath, sourcePath);
    assert.equal(payload.outputPath, snapshotPath);
    assert.equal(payload.manifestPath, `${snapshotPath}.manifest.json`);
    assert.equal(payload.disposableRoot, await realpath(disposableRoot));
    assert.equal(payload.integrityCheck, 'ok');
    assert.match(payload.fingerprints.contentSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(await readFile(payload.manifestPath, 'utf8')).fingerprints, payload.fingerprints);
  });
});
