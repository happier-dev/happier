import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { spawnProc } from '../../utils/proc/proc.mjs';
import { assertSharedDatabaseMigrationsApplied } from '../../utils/server/shared_database_migration_gate.mjs';

export class RuntimeServerMigrationError extends Error {
  constructor(message, { code, reason, command = null, cwd = null, exitCode = null, signal = null, failedMigration = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RuntimeServerMigrationError';
    this.code = code;
    this.reason = reason;
    this.command = command;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.signal = signal;
    this.failedMigration = failedMigration;
  }
}

function migrationError(code, reason, migration, details = {}) {
  return new RuntimeServerMigrationError(
    `[local] runtime server migration ${reason.replaceAll('_', ' ')}`,
    { code, reason, command: migration?.command ?? null, cwd: migration?.cwd ?? null, ...details },
  );
}

function throwIfStartupCancelled(isCancellationRequested, migration) {
  if (isCancellationRequested?.() === true) {
    throw migrationError('ERUNTIMESERVERMIGRATIONCANCELLED', 'startup_shutdown_requested', migration);
  }
}

async function validateRuntimeServerMigration(serverLaunchSpec) {
  const migration = serverLaunchSpec?.migration;
  if (!migration || typeof migration.command !== 'string' || !migration.command.trim()) {
    throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'missing_artifact_migration_command', migration);
  }
  const serverDir = resolve(String(serverLaunchSpec?.serverDir ?? ''));
  const command = resolve(migration.command);
  const cwd = resolve(String(migration.cwd ?? ''));
  const sourceSidecar = migration.mode === 'external';
  const expectedDir = sourceSidecar ? resolve(serverDir, 'scripts') : serverDir;
  const expectedName = sourceSidecar ? 'migrate.mjs'
    : `happier-server-migrate${String(serverLaunchSpec?.entrypoint ?? '').toLowerCase().endsWith('.exe') ? '.exe' : ''}`;
  if (cwd !== serverDir || dirname(command) !== expectedDir || basename(command) !== expectedName) {
    throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'artifact_migration_command_escape', migration);
  }

  let commandStat;
  try {
    commandStat = await lstat(command);
    const [realServerDir, realCommand] = await Promise.all([realpath(serverDir), realpath(command)]);
    if (dirname(realCommand) !== (sourceSidecar ? resolve(realServerDir, 'scripts') : realServerDir)) {
      throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'artifact_migration_command_escape', migration);
    }
  } catch (error) {
    if (error instanceof RuntimeServerMigrationError) throw error;
    throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'unusable_artifact_migration_command', migration, { cause: error });
  }
  const executable = sourceSidecar || process.platform === 'win32' || (commandStat.mode & 0o111) !== 0;
  if (!commandStat.isFile() || !executable) {
    throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'unusable_artifact_migration_command', migration);
  }
  return { command, cwd, sourceSidecar, args: Array.isArray(migration.args) ? migration.args : [] };
}

export async function runServerRuntimeMigration({
  serverLaunchSpec,
  /** The server source checkout: it opens a shared Postgres source's ledger, which the payload cannot. */
  sourceServerDir,
  env,
  children,
  isCancellationRequested,
  spawnProcImpl = spawnProc,
}) {
  const shared = await assertSharedDatabaseMigrationsApplied({ serverDir: serverLaunchSpec?.serverDir,
    databaseOwnerDir: sourceServerDir, env });
  // Shared consumers can only inspect the ledger, regardless of a stale launch spec.
  if (shared) return;
  if (serverLaunchSpec?.migration?.mode === 'disabled' || serverLaunchSpec?.migration?.mode === 'in-process') {
    return;
  }
  throwIfStartupCancelled(isCancellationRequested, serverLaunchSpec?.migration);
  const migration = await validateRuntimeServerMigration(serverLaunchSpec);
  throwIfStartupCancelled(isCancellationRequested, migration);
  let failedMigration = null;
  let child;
  try {
    child = spawnProcImpl(
      'server-migrate',
      migration.sourceSidecar ? process.execPath : migration.command,
      migration.sourceSidecar ? [migration.command, ...migration.args] : migration.args,
      env,
      { cwd: migration.cwd, onLine(event) {
        // Retain only the canonical identifier, never driver output or connection values.
        // SQLite tags the executed SQL failure; Prisma's P3018 diagnostic
        // names the failed migration. Progress/success lines are not failures.
        const match = String(event?.line ?? '').match(/(?:migrationName=|^\s*Migration name:\s*)(\d{14}_[a-z0-9_]+)\b/);
        if (match) failedMigration = match[1];
      } },
    );
  } catch (error) {
    throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'spawn_error', migration, { cause: error });
  }
  children?.push(child);
  try {
    let completion;
    try {
      completion = await child?.completion;
    } catch (error) {
      throw migrationError('ERUNTIMESERVERMIGRATIONFAILED', 'abnormal_completion', migration, { cause: error });
    }
    if (completion?.error) {
      throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'spawn_error', migration, { cause: completion.error });
    }
    if (completion?.signal) {
      throw migrationError('ERUNTIMESERVERMIGRATIONFAILED', 'signaled', migration, { signal: completion.signal });
    }
    if (completion?.code !== 0) {
      const reason = Number.isInteger(completion?.code) ? 'nonzero_exit' : 'abnormal_completion';
      throw migrationError('ERUNTIMESERVERMIGRATIONFAILED', reason, migration, { exitCode: completion?.code ?? null });
    }
  } catch (error) {
    if (error instanceof RuntimeServerMigrationError && error.code === 'ERUNTIMESERVERMIGRATIONFAILED') {
      if (failedMigration) {
        error.failedMigration = failedMigration;
        error.message += ` (${failedMigration})`;
      }
    }
    throw error;
  } finally {
    const index = children?.indexOf(child) ?? -1;
    if (index >= 0) children.splice(index, 1);
  }
}

export async function spawnRuntimeServerAfterMigration({
  serverLaunchSpec,
  sourceServerDir,
  env,
  children,
  isCancellationRequested,
  onServerLine,
  spawnProcImpl = spawnProc,
}) {
  await runServerRuntimeMigration({ serverLaunchSpec, sourceServerDir, env, children, isCancellationRequested, spawnProcImpl });
  throwIfStartupCancelled(isCancellationRequested, serverLaunchSpec.migration);
  const server = spawnProcImpl('server', serverLaunchSpec.command, serverLaunchSpec.args, env, {
    cwd: serverLaunchSpec.serverDir,
    ...(onServerLine ? { onLine: onServerLine } : {}),
  });
  children?.push(server);
  return server;
}
