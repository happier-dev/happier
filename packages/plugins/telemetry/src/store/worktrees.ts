import type { DaemonDatabase, DaemonDatabaseMigration, DaemonDatabaseRow, DaemonDatabaseValue } from '@happier-dev/plugin-sdk/storage';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 as limits } from '@happier-dev/plugin-sdk/storage';

/** Retained observations outlive their launch and its in-memory path association. */
export const worktreeMigration: DaemonDatabaseMigration = { version: 6, id: 'worktree-roots', async up(tx) {
 await tx.execute('CREATE TABLE captureWorktrees (worktree TEXT PRIMARY KEY, physicalRoot TEXT NOT NULL)');
 await tx.execute('CREATE INDEX captureWorktreeRoot ON captureWorktrees(physicalRoot,worktree)');
} };

export function createCaptureWorktrees(db: DaemonDatabase,
 queryPage: <T extends DaemonDatabaseRow>(statement: string, params: readonly DaemonDatabaseValue[], requested: number) => Promise<{ rows: readonly T[]; pageSize: number }>) {
 return {
  async rememberWorktree(worktree: string, physicalRoot: string) {
   await db.execute('INSERT INTO captureWorktrees (worktree,physicalRoot) VALUES (?,?) ON CONFLICT(worktree) DO UPDATE SET physicalRoot=excluded.physicalRoot WHERE physicalRoot != excluded.physicalRoot', [worktree, physicalRoot]);
  },
  async worktreePartitions(physicalRoot: string): Promise<string[]> {
   const result: string[] = [];
   let after = '';
   while (true) {
    const { rows, pageSize } = await queryPage('SELECT worktree FROM captureWorktrees WHERE physicalRoot = ? AND worktree > ? ORDER BY worktree LIMIT ?', [physicalRoot, after], limits.maximumResultRows);
    for (const row of rows) result.push(String(row.worktree));
    if (rows.length < pageSize) return result;
    after = result.at(-1)!;
   }
  },
  async forgetWorktree(worktree: string) { await db.execute('DELETE FROM captureWorktrees WHERE worktree = ?', [worktree]); },
 };
}
