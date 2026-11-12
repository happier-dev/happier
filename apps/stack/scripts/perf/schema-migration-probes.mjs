import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { probeRuntimeImport } from '../utils/proc/runtimeImportProbe.mjs';

export const SCHEMA_SYNC_GRAPH = Object.freeze({ id: 'schema-sync', entry: 'apps/server/scripts/schemaSync.ts' });
export const TRACKED_MIGRATIONS_GRAPH = Object.freeze({ id: 'tracked-migrations', entry: 'apps/server/prisma/migrations' });
const execute = promisify(execFile);

export async function loadSchemaSync({ repoDir, signal, env = process.env }) {
  // Execute the schema:sync:check script through its existing source launcher.
  const result = await probeRuntimeImport({ entrypoint: join(repoDir, 'apps/server/scripts/runTsx.mjs'),
    args: ['--tsconfig', './tsconfig.json', './scripts/schemaSync.ts', '--check', '--quiet'],
    cwd: join(repoDir, 'apps/server'), signal, env });
  return { ...result, graph: SCHEMA_SYNC_GRAPH.id, entry: SCHEMA_SYNC_GRAPH.entry, basis: 'current-source',
    ...(result.status === 'failed' ? { firstFailingModule: SCHEMA_SYNC_GRAPH.entry,
      loadError: { name: 'SchemaSyncError', code: 'schema_sync_failed', message: '' } } : {}) };
}

export async function loadTrackedMigrations({ repoDir, signal, env = process.env }) {
  const started = performance.now();
  const base = { graph: TRACKED_MIGRATIONS_GRAPH.id, entry: TRACKED_MIGRATIONS_GRAPH.entry, basis: 'current-source' };
  try {
    const { stdout } = await execute('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--',
      'apps/server/prisma/migrations', 'apps/server/prisma/mysql/migrations', 'apps/server/prisma/sqlite/migrations'],
      { cwd: repoDir, signal, env, encoding: 'utf8' });
    const directories = new Set(stdout.split('\0').filter(Boolean).map(path =>
      path.match(/^(apps\/server\/prisma\/(?:mysql\/|sqlite\/)?migrations\/[^/]+)\//)?.[1]).filter(Boolean));
    for (const directory of directories) {
      const path = `${directory}/migration.sql`;
      try {
        if (!(await stat(join(repoDir, path))).isFile()) throw Object.assign(new Error(), { code: 'ENOENT' });
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        return { ...base, status: 'failed', elapsedMs: performance.now() - started, firstFailingModule: path,
          loadError: { name: 'MigrationPresenceError', code: 'tracked_migration_missing', message: '' } };
      }
    }
    return { ...base, status: 'passed', elapsedMs: performance.now() - started, loadError: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...base, status: 'failed', elapsedMs: performance.now() - started,
      firstFailingModule: TRACKED_MIGRATIONS_GRAPH.entry,
      loadError: { name: 'MigrationPresenceError', code: 'migration_presence_check_failed', message: '' } };
  }
}
