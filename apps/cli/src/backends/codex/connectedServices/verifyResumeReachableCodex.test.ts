import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openSqliteDatabaseSync } from '@/utils/sqlite/sqliteSync';
import { resolveExistingCodexIndexedRolloutPath } from './reconcileCodexResumeRolloutPath';
import { verifyResumeReachableCodex } from './verifyResumeReachableCodex';

describe('verifyResumeReachableCodex', () => {
  it('accepts compressed state behind a plain SQLite path without rewriting the native index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-compressed-index-'));
    const vendorResumeId = '019f2339-9299-7e51-b192-9751a0a03586';
    const codexHome = join(root, 'codex-home');
    const sqliteHome = join(root, 'sqlite');
    const plain = join(codexHome, 'sessions', `rollout-2026-11-06T00-00-00-${vendorResumeId}.jsonl`);
    const env = { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome };
    try {
      await mkdir(join(codexHome, 'sessions'), { recursive: true });
      await mkdir(sqliteHome);
      await writeFile(`${plain}.zst`, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
      const database = openSqliteDatabaseSync(join(sqliteHome, 'state_5.sqlite'));
      try {
        database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
        database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(vendorResumeId, plain);
        await expect(verifyResumeReachableCodex({ targetMaterializedRoot: root,
          targetMaterializedEnv: env, vendorResumeId, cwd: root, candidatePersistedSessionFile: plain,
        })).resolves.toEqual({ ok: true, resolvedPath: `${plain}.zst` });
        expect(database.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(vendorResumeId))
          .toEqual({ rollout_path: plain });
        await expect(resolveExistingCodexIndexedRolloutPath({ env, vendorResumeId, cwd: root }))
          .resolves.toBe(`${plain}.zst`);
      } finally {
        database.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['.jsonl', '.jsonl.zst'])('repairs a stale home path for a promoted %s rollout using the logical plain path', async (extension) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-reachable-sqlite-'));
    const vendorResumeId = '019f2339-9299-7e51-b192-9751a0a03586';
    const otherVendorResumeId = '019f2339-9299-7e51-b192-9751a0a03587';
    const codexHome = join(root, 'codex-home');
    const sqliteHome = join(root, 'shared-sqlite');
    const stalePath = join(root, 'removed-materialized-home', 'sessions', `rollout-${vendorResumeId}.jsonl`);
    const otherStalePath = join(root, 'removed-materialized-home', 'sessions', `rollout-${otherVendorResumeId}.jsonl`);
    const foundPath = join(
      codexHome,
      'sessions',
      '2026',
      '09',
      '07',
      `rollout-2026-09-07T10-00-00-${vendorResumeId}${extension}`,
    );

    try {
      await mkdir(join(codexHome, 'sessions', '2026', '09', '07'), { recursive: true });
      await mkdir(sqliteHome, { recursive: true });
      await writeFile(foundPath, '{}\n');

      const databasePath = join(sqliteHome, 'state_5.sqlite');
      const database = openSqliteDatabaseSync(databasePath);
      try {
        database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
        database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(vendorResumeId, stalePath);
        database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(otherVendorResumeId, otherStalePath);
      } finally {
        database.close();
      }

      await expect(verifyResumeReachableCodex({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          CODEX_HOME: codexHome,
          CODEX_SQLITE_HOME: sqliteHome,
        },
        vendorResumeId,
        cwd: root,
      })).resolves.toEqual({ ok: true, resolvedPath: foundPath });

      const verifiedDatabase = openSqliteDatabaseSync(databasePath);
      try {
        expect(verifiedDatabase.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(vendorResumeId))
          .toEqual({ rollout_path: foundPath.replace(/\.zst$/, '') });
        expect(verifiedDatabase.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(otherVendorResumeId))
          .toEqual({ rollout_path: otherStalePath });
      } finally {
        verifiedDatabase.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns ok=true when candidatePersistedSessionFile exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-reachable-candidate-'));
    try {
      const candidatePath = join(root, 'codex-home', 'sessions', 'rollout-2026-01-01T00-00-00-vendor-session-1.jsonl');
      await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
      await writeFile(candidatePath, '{}\n');

      await expect(verifyResumeReachableCodex({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        vendorResumeId: 'vendor-session-1',
        cwd: root,
        candidatePersistedSessionFile: candidatePath,
      })).resolves.toEqual({
        ok: true,
        resolvedPath: candidatePath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['persisted candidate', 'manifest mapping'])('does not prove an empty target reachable from an old-home %s', async (hint) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-reachable-old-home-'));
    const vendorResumeId = '019f2339-9299-7e51-b192-9751a0a03586';
    const targetRoot = join(root, 'target');
    const targetHome = join(targetRoot, 'codex-home');
    const oldSessions = join(root, 'old-home', 'sessions');
    const candidatePath = join(oldSessions, `rollout-2026-10-11T10-00-00-${vendorResumeId}.jsonl`);
    try {
      await mkdir(oldSessions, { recursive: true });
      await mkdir(join(targetHome, 'sessions'), { recursive: true });
      await writeFile(candidatePath, '{}\n');
      if (hint === 'manifest mapping') {
        await writeFile(join(targetRoot, '.happier-state-sharing.json'), JSON.stringify({
          v: 1, requestedStateMode: 'isolated', effectiveStateMode: 'isolated', lastSyncAtMs: 0,
          configEntries: [], stateEntries: [], diagnostics: [],
          sessionFileMappings: [{ vendorResumeId, sourcePath: null, destinationPath: candidatePath, importedAtMs: 0, verifiedAtMs: null }],
        }));
      }
      await expect(verifyResumeReachableCodex({
        targetMaterializedRoot: targetRoot,
        targetMaterializedEnv: { CODEX_HOME: targetHome, CODEX_SQLITE_HOME: targetHome },
        vendorResumeId, cwd: root,
        ...(hint === 'persisted candidate' ? { candidatePersistedSessionFile: candidatePath } : {}),
      })).resolves.toEqual({ ok: false, reason: 'codex_session_file_not_found' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a native candidate that is visible through the target sessions symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-reachable-linked-candidate-'));
    const nativeSessions = join(root, 'native', 'sessions');
    const targetHome = join(root, 'target', 'codex-home');
    const vendorResumeId = '019f2339-9299-7e51-b192-9751a0a03586';
    const candidatePath = join(nativeSessions, `rollout-2026-10-11T10-00-00-${vendorResumeId}.jsonl`);
    try {
      await mkdir(nativeSessions, { recursive: true });
      await mkdir(targetHome, { recursive: true });
      await writeFile(candidatePath, '{}\n');
      await symlink(nativeSessions, join(targetHome, 'sessions'), 'junction');
      await expect(verifyResumeReachableCodex({
        targetMaterializedRoot: join(root, 'target'),
        targetMaterializedEnv: { CODEX_HOME: targetHome },
        vendorResumeId, cwd: root, candidatePersistedSessionFile: candidatePath,
      })).resolves.toEqual({ ok: true, resolvedPath: candidatePath });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds a continuation rollout whose filename appends a turn id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-reachable-continuation-'));
    const vendorResumeId = '019d94f3-0a6f-7c41-bb18-d26425384658';
    const continuationId = '019d94f4-0a6f-7c41-bb18-d26425384659';
    const foundPath = join(
      root,
      'codex-home',
      'sessions',
      '2026',
      '09',
      '25',
      `rollout-2026-09-25T11-50-33-${vendorResumeId}_${continuationId}.jsonl`,
    );
    try {
      await mkdir(join(root, 'codex-home', 'sessions', '2026', '09', '25'), { recursive: true });
      await writeFile(foundPath, '{}\n');

      await expect(verifyResumeReachableCodex({
        targetMaterializedRoot: root,
        targetMaterializedEnv: { CODEX_HOME: join(root, 'codex-home') },
        vendorResumeId,
        cwd: root,
      })).resolves.toEqual({ ok: true, resolvedPath: foundPath });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not accept a persisted candidate file whose rollout id does not match the vendor resume id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-reachable-stale-candidate-'));
    try {
      const candidatePath = join(
        root,
        'codex-home',
        'sessions',
        'rollout-2026-01-01T00-00-00-vendor-session-B.jsonl',
      );
      await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
      await writeFile(candidatePath, '{}\n');

      await expect(verifyResumeReachableCodex({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        vendorResumeId: 'vendor-session-A',
        cwd: root,
        candidatePersistedSessionFile: candidatePath,
      })).resolves.toEqual({
        ok: false,
        reason: 'codex_session_file_not_found',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns ok=true from manifest sessionFileMappings when mapped file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-reachable-manifest-'));
    try {
      const mappedPath = join(root, 'codex-home', 'sessions', 'rollout-2026-01-01T00-00-00-vendor-session-1.jsonl');
      await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
      await writeFile(mappedPath, '{}\n');
      await writeFile(join(root, '.happier-state-sharing.json'), JSON.stringify({
        v: 1,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        lastSyncAtMs: 0,
        configEntries: [],
        stateEntries: [],
        sessionFileMappings: [
          {
            vendorResumeId: 'vendor-session-1',
            sourcePath: null,
            destinationPath: 'codex-home/sessions/rollout-2026-01-01T00-00-00-vendor-session-1.jsonl',
            importedAtMs: 0,
            verifiedAtMs: null,
          },
        ],
        diagnostics: [],
      }));

      await expect(verifyResumeReachableCodex({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        vendorResumeId: 'vendor-session-1',
        cwd: root,
      })).resolves.toEqual({
        ok: true,
        resolvedPath: mappedPath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns ok=true when rollout search finds a matching vendor resume id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-reachable-search-'));
    try {
      const foundPath = join(
        root,
        'codex-home',
        'sessions',
        '2026',
        '01',
        '01',
        'rollout-2026-01-01T00-00-00-vendor-session-1.jsonl',
      );
      await mkdir(join(root, 'codex-home', 'sessions', '2026', '01', '01'), { recursive: true });
      await writeFile(foundPath, '{}\n');

      await expect(verifyResumeReachableCodex({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        vendorResumeId: 'vendor-session-1',
        cwd: root,
      })).resolves.toEqual({
        ok: true,
        resolvedPath: foundPath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds the rollout in a LATE date-partition even when more than 5000 decoy rollouts precede it', async () => {
    // THE bug: `codex-home/sessions` is a symlink to the native ~/.codex/sessions store (descriptor
    // `state.entries: { path: 'sessions', mode: 'linked' }`), which holds tens of thousands of
    // rollouts. The legacy capped tree walk (DEFAULT_MAX_SEARCH_FILES=5000), traversing oldest-date
    // partitions first, exhausted its file budget before reaching a target in a newer partition and
    // false-negatived `codex_session_file_not_found`. The id-targeted search descends newest-first
    // by name with no file-count cap, so it reaches the target regardless of store size.
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-reachable-large-store-'));
    try {
      const sessionsRoot = join(root, 'codex-home', 'sessions');
      // >5000 decoy rollouts in an OLDER partition (the capped walk visits these first and gives up).
      const olderDir = join(sessionsRoot, '2024', '01', '01');
      await mkdir(olderDir, { recursive: true });
      await Promise.all(
        Array.from({ length: 5200 }, (_unused, index) => {
          const padded = String(index).padStart(5, '0');
          return writeFile(
            join(olderDir, `rollout-2024-01-01T00-00-00-decoy${padded}-7c41-bb18-d26425384658.jsonl`),
            '{}\n',
          );
        }),
      );
      // The real target lives in a NEWER partition the capped walk never reaches.
      const vendorResumeId = '019d94f3-0a6f-7c41-bb18-d26425384658';
      const newerDir = join(sessionsRoot, '2026', '04', '16');
      const foundPath = join(newerDir, `rollout-2026-04-16T08-20-49-${vendorResumeId}.jsonl`);
      await mkdir(newerDir, { recursive: true });
      await writeFile(foundPath, '{}\n');

      await expect(verifyResumeReachableCodex({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        vendorResumeId,
        cwd: root,
      })).resolves.toEqual({ ok: true, resolvedPath: foundPath });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns codex_session_file_not_found when no resume file can be proven reachable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-reachable-miss-'));
    try {
      // codex-home/sessions exists but holds only a DIFFERENT id; the manifest carries no mapping
      // and no candidate hint is supplied -> a genuine miss.
      const sessionsRoot = join(root, 'codex-home', 'sessions', '2026', '01', '01');
      await mkdir(sessionsRoot, { recursive: true });
      await writeFile(
        join(sessionsRoot, 'rollout-2026-01-01T00-00-00-other-0a6f-7c41-bb18-d26425384658.jsonl'),
        '{}\n',
      );

      await expect(verifyResumeReachableCodex({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {},
        vendorResumeId: 'vendor-session-1',
        cwd: root,
      })).resolves.toEqual({
        ok: false,
        reason: 'codex_session_file_not_found',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
