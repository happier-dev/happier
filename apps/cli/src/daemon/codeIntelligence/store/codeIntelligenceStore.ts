import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  CodeIntelligenceActivityEventV1Schema,
  CodeIntelligenceCommitAnalysisV1Schema,
  CodeIntelligenceCommitV1Schema,
  ObservedAgentSessionV1Schema,
  type CodeIntelligenceActivityEventV1,
  type CodeIntelligenceCommitAnalysisV1,
  type CodeIntelligenceCommitV1,
  type CodeIntelligenceRepositoryV1,
  type CodeIntelligenceWorktreeV1,
  type ObservedAgentSessionV1,
} from '@happier-dev/protocol';

import { openSqliteDatabaseSync, type SqliteDatabaseSync } from '@/utils/sqlite/sqliteSync';

/**
 * Single writer for the daemon's code-intelligence observations. The daemon owns this file; clients
 * only ever read projections of it through daemon RPC, so there is exactly one event store.
 */
/** `Omit` would erase the keys of the passthrough schema's index signature, so pick them explicitly. */
export type CodeIntelligenceActivityEventInput = Pick<
  CodeIntelligenceActivityEventV1,
  'kind' | 'atMs' | 'repositoryId' | 'worktreePath' | 'sessionId' | 'commitSha' | 'data'
>;

export type CodeIntelligenceStore = Readonly<{
  upsertRepository: (input: Readonly<{
    repositoryId: string;
    displayName: string;
    commonDirPath: string;
    registrationSource: CodeIntelligenceRepositoryV1['registrationSource'];
    nowMs: number;
  }>) => Readonly<{ created: boolean }>;
  upsertWorktree: (input: Readonly<{
    repositoryId: string;
    worktreePath: string;
    gitDirPath: string;
    isLinkedWorktree: boolean;
    branch: string | null;
    headCommit: string | null;
    nowMs: number;
  }>) => Readonly<{ previous: CodeIntelligenceWorktreeV1 | null }>;
  getWorktree: (key: Readonly<{ worktreePath: string }>) => CodeIntelligenceWorktreeV1 | null;
  listRepositories: () => CodeIntelligenceRepositoryV1[];
  upsertSession: (session: ObservedAgentSessionV1) => Readonly<{ previous: ObservedAgentSessionV1 | null }>;
  listSessions: () => ObservedAgentSessionV1[];
  insertCommitIfAbsent: (commit: CodeIntelligenceCommitV1) => boolean;
  getCommit: (key: Readonly<{ repositoryId: string; sha: string }>) => CodeIntelligenceCommitV1 | null;
  updateCommitAnalysis: (input: Readonly<{ repositoryId: string; sha: string; analysis: CodeIntelligenceCommitAnalysisV1 }>) => void;
  listRecentCommits: (input: Readonly<{ limit: number }>) => CodeIntelligenceCommitV1[];
  listCommitsWithAnalysisStatus: (input: Readonly<{ status: CodeIntelligenceCommitAnalysisV1['status']; limit: number }>) => CodeIntelligenceCommitV1[];
  appendEvent: (event: CodeIntelligenceActivityEventInput) => CodeIntelligenceActivityEventV1;
  /** The newest `limit` events, oldest first: the starting point for a client without a cursor. */
  listLatestEvents: (input: Readonly<{ limit: number }>) => Readonly<{ events: CodeIntelligenceActivityEventV1[]; latestSeq: number }>;
  listEventsAfter: (input: Readonly<{ afterSeq: number; limit: number }>) => Readonly<{
    events: CodeIntelligenceActivityEventV1[];
    latestSeq: number;
    truncated: boolean;
  }>;
  recordUsage: (input: Readonly<{ monthKey: string; providerId: string; inputTokens: number; outputTokens: number; costUsd: number }>) => void;
  getMonthlySpendUsd: (input: Readonly<{ monthKey: string }>) => number;
  prune: (input: Readonly<{ olderThanMs: number }>) => void;
  close: () => void;
}>;

const SCHEMA_VERSION = 1;

function migrate(db: SqliteDatabaseSync): void {
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const userVersion = typeof versionRow?.user_version === 'number' ? versionRow.user_version : 0;
  if (userVersion >= SCHEMA_VERSION) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      repository_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      common_dir_path TEXT NOT NULL,
      registered_at_ms INTEGER NOT NULL,
      registration_source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worktrees (
      worktree_path TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
      git_dir_path TEXT NOT NULL,
      is_linked INTEGER NOT NULL,
      branch TEXT,
      head_commit TEXT,
      last_observed_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worktrees_repository ON worktrees(repository_id);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      last_activity_at_ms INTEGER NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commits (
      repository_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      analysis_status TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (repository_id, sha)
    );
    CREATE INDEX IF NOT EXISTS commits_observed ON commits(observed_at_ms);
    CREATE INDEX IF NOT EXISTS commits_analysis_status ON commits(analysis_status, observed_at_ms);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      repository_id TEXT,
      worktree_path TEXT,
      session_id TEXT,
      commit_sha TEXT,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_at ON events(at_ms);
    CREATE TABLE IF NOT EXISTS analysis_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS analysis_usage_month ON analysis_usage(month_key);
  `);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
}

type WorktreeRow = {
  worktree_path: string;
  repository_id: string;
  git_dir_path: string;
  is_linked: number;
  branch: string | null;
  head_commit: string | null;
  last_observed_at_ms: number;
};

function worktreeFromRow(row: WorktreeRow): CodeIntelligenceWorktreeV1 {
  return {
    worktreePath: row.worktree_path,
    gitDirPath: row.git_dir_path,
    isLinkedWorktree: row.is_linked === 1,
    branch: row.branch,
    headCommit: row.head_commit,
    lastObservedAtMs: Number(row.last_observed_at_ms),
  };
}

type EventRow = {
  seq: number;
  kind: string;
  at_ms: number;
  repository_id: string | null;
  worktree_path: string | null;
  session_id: string | null;
  commit_sha: string | null;
  data_json: string;
};

function eventFromRow(row: EventRow): CodeIntelligenceActivityEventV1 {
  return CodeIntelligenceActivityEventV1Schema.parse({
    seq: Number(row.seq),
    kind: row.kind,
    atMs: Number(row.at_ms),
    repositoryId: row.repository_id,
    worktreePath: row.worktree_path,
    sessionId: row.session_id,
    commitSha: row.commit_sha,
    data: JSON.parse(row.data_json),
  });
}

function readChanges(result: unknown): number {
  const changes = (result as { changes?: unknown } | null)?.changes;
  return typeof changes === 'number' ? changes : Number(changes ?? 0);
}

export function openCodeIntelligenceStore(params: Readonly<{ dbPath: string }>): CodeIntelligenceStore {
  mkdirSync(dirname(params.dbPath), { recursive: true });
  const db = openSqliteDatabaseSync(params.dbPath);
  migrate(db);

  const parseCommitJson = (json: string): CodeIntelligenceCommitV1 => CodeIntelligenceCommitV1Schema.parse(JSON.parse(json));

  const latestSeq = (): number => {
    const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as { seq?: unknown } | undefined;
    return row?.seq === undefined || row?.seq === null ? 0 : Number(row.seq);
  };

  return {
    upsertRepository: (input) => {
      const result = db.prepare(`
        INSERT INTO repositories (repository_id, display_name, common_dir_path, registered_at_ms, registration_source)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(repository_id) DO NOTHING
      `).run(input.repositoryId, input.displayName, input.commonDirPath, input.nowMs, input.registrationSource);
      return { created: readChanges(result) > 0 };
    },
    upsertWorktree: (input) => {
      const previousRow = db.prepare('SELECT * FROM worktrees WHERE worktree_path = ?').get(input.worktreePath) as WorktreeRow | undefined;
      db.prepare(`
        INSERT INTO worktrees (worktree_path, repository_id, git_dir_path, is_linked, branch, head_commit, last_observed_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worktree_path) DO UPDATE SET
          repository_id = excluded.repository_id,
          git_dir_path = excluded.git_dir_path,
          is_linked = excluded.is_linked,
          branch = excluded.branch,
          head_commit = excluded.head_commit,
          last_observed_at_ms = excluded.last_observed_at_ms
      `).run(
        input.worktreePath,
        input.repositoryId,
        input.gitDirPath,
        input.isLinkedWorktree ? 1 : 0,
        input.branch,
        input.headCommit,
        input.nowMs,
      );
      return { previous: previousRow ? worktreeFromRow(previousRow) : null };
    },
    getWorktree: ({ worktreePath }) => {
      const row = db.prepare('SELECT * FROM worktrees WHERE worktree_path = ?').get(worktreePath) as WorktreeRow | undefined;
      return row ? worktreeFromRow(row) : null;
    },
    listRepositories: () => {
      const repositories = db.prepare('SELECT * FROM repositories ORDER BY display_name, repository_id').all() as Array<{
        repository_id: string;
        display_name: string;
        common_dir_path: string;
        registered_at_ms: number;
        registration_source: CodeIntelligenceRepositoryV1['registrationSource'];
      }>;
      const worktrees = db.prepare('SELECT * FROM worktrees ORDER BY worktree_path').all() as WorktreeRow[];
      return repositories.map((row) => ({
        repositoryId: row.repository_id,
        displayName: row.display_name,
        commonDirPath: row.common_dir_path,
        registeredAtMs: Number(row.registered_at_ms),
        registrationSource: row.registration_source,
        worktrees: worktrees.filter((worktree) => worktree.repository_id === row.repository_id).map(worktreeFromRow),
      }));
    },
    upsertSession: (session) => {
      const previousRow = db.prepare('SELECT json FROM sessions WHERE id = ?').get(session.id) as { json: string } | undefined;
      db.prepare(`
        INSERT INTO sessions (id, last_activity_at_ms, json) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_activity_at_ms = excluded.last_activity_at_ms, json = excluded.json
      `).run(session.id, session.lastActivityAtMs, JSON.stringify(session));
      return { previous: previousRow ? ObservedAgentSessionV1Schema.parse(JSON.parse(previousRow.json)) : null };
    },
    listSessions: () => {
      const rows = db.prepare('SELECT json FROM sessions ORDER BY last_activity_at_ms DESC').all() as Array<{ json: string }>;
      return rows.map((row) => ObservedAgentSessionV1Schema.parse(JSON.parse(row.json)));
    },
    insertCommitIfAbsent: (commit) => {
      const result = db.prepare(`
        INSERT INTO commits (repository_id, sha, observed_at_ms, analysis_status, json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(repository_id, sha) DO NOTHING
      `).run(commit.repositoryId, commit.sha, commit.observedAtMs, commit.analysis.status, JSON.stringify(commit));
      return readChanges(result) > 0;
    },
    getCommit: ({ repositoryId, sha }) => {
      const row = db.prepare('SELECT json FROM commits WHERE repository_id = ? AND sha = ?').get(repositoryId, sha) as { json: string } | undefined;
      return row ? parseCommitJson(row.json) : null;
    },
    updateCommitAnalysis: ({ repositoryId, sha, analysis }) => {
      const row = db.prepare('SELECT json FROM commits WHERE repository_id = ? AND sha = ?').get(repositoryId, sha) as { json: string } | undefined;
      if (!row) return;
      const next = { ...parseCommitJson(row.json), analysis: CodeIntelligenceCommitAnalysisV1Schema.parse(analysis) };
      db.prepare('UPDATE commits SET analysis_status = ?, json = ? WHERE repository_id = ? AND sha = ?')
        .run(analysis.status, JSON.stringify(next), repositoryId, sha);
    },
    listRecentCommits: ({ limit }) => {
      const rows = db.prepare('SELECT json FROM commits ORDER BY observed_at_ms DESC LIMIT ?').all(limit) as Array<{ json: string }>;
      return rows.map((row) => parseCommitJson(row.json));
    },
    listCommitsWithAnalysisStatus: ({ status, limit }) => {
      const rows = db.prepare('SELECT json FROM commits WHERE analysis_status = ? ORDER BY observed_at_ms ASC LIMIT ?')
        .all(status, limit) as Array<{ json: string }>;
      return rows.map((row) => parseCommitJson(row.json));
    },
    appendEvent: (event) => {
      const parsedData = CodeIntelligenceActivityEventV1Schema.shape.data.parse(event.data);
      db.prepare(`
        INSERT INTO events (kind, at_ms, repository_id, worktree_path, session_id, commit_sha, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(event.kind, event.atMs, event.repositoryId, event.worktreePath, event.sessionId, event.commitSha, JSON.stringify(parsedData));
      return { ...event, data: parsedData, seq: latestSeq() };
    },
    listLatestEvents: ({ limit }) => {
      const rows = db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit) as EventRow[];
      return { events: rows.reverse().map(eventFromRow), latestSeq: latestSeq() };
    },
    listEventsAfter: ({ afterSeq, limit }) => {
      const rows = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(afterSeq, limit) as EventRow[];
      const oldestRow = db.prepare('SELECT MIN(seq) AS seq FROM events').get() as { seq?: unknown } | undefined;
      const oldestRetainedSeq = oldestRow?.seq === null || oldestRow?.seq === undefined ? null : Number(oldestRow.seq);
      const latest = latestSeq();
      const truncated = oldestRetainedSeq === null ? afterSeq < latest : afterSeq + 1 < oldestRetainedSeq;
      return { events: rows.map(eventFromRow), latestSeq: latest, truncated };
    },
    recordUsage: (input) => {
      db.prepare('INSERT INTO analysis_usage (month_key, provider_id, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)')
        .run(input.monthKey, input.providerId, input.inputTokens, input.outputTokens, input.costUsd);
    },
    getMonthlySpendUsd: ({ monthKey }) => {
      const row = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM analysis_usage WHERE month_key = ?').get(monthKey) as { total?: unknown } | undefined;
      return Number(row?.total ?? 0);
    },
    prune: ({ olderThanMs }) => {
      db.prepare('DELETE FROM events WHERE at_ms < ?').run(olderThanMs);
      db.prepare('DELETE FROM commits WHERE observed_at_ms < ?').run(olderThanMs);
      db.prepare('DELETE FROM sessions WHERE last_activity_at_ms < ?').run(olderThanMs);
    },
    close: () => db.close(),
  };
}
