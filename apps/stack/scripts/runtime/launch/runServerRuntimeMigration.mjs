import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { spawnProc } from '../../utils/proc/proc.mjs';

export class RuntimeServerMigrationError extends Error {
  constructor(message, { code, reason, command = null, cwd = null, exitCode = null, signal = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RuntimeServerMigrationError';
    this.code = code;
    this.reason = reason;
    this.command = command;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.signal = signal;
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
  const expectedName = `happier-server-migrate${String(serverLaunchSpec?.entrypoint ?? '').toLowerCase().endsWith('.exe') ? '.exe' : ''}`;
  if (cwd !== serverDir || dirname(command) !== serverDir || basename(command) !== expectedName) {
    throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'artifact_migration_command_escape', migration);
  }

  let commandStat;
  try {
    commandStat = await lstat(command);
    const [realServerDir, realCommand] = await Promise.all([realpath(serverDir), realpath(command)]);
    if (dirname(realCommand) !== realServerDir) {
      throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'artifact_migration_command_escape', migration);
    }
  } catch (error) {
    if (error instanceof RuntimeServerMigrationError) throw error;
    throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'unusable_artifact_migration_command', migration, { cause: error });
  }
  const executable = process.platform === 'win32' || (commandStat.mode & 0o111) !== 0;
  if (!commandStat.isFile() || !executable) {
    throw migrationError('ERUNTIMESERVERMIGRATIONUNAVAILABLE', 'unusable_artifact_migration_command', migration);
  }
  return { command, cwd, args: Array.isArray(migration.args) ? migration.args : [] };
}

export async function runServerRuntimeMigration({
  serverLaunchSpec,
  env,
  children,
  isCancellationRequested,
  spawnProcImpl = spawnProc,
}) {
  throwIfStartupCancelled(isCancellationRequested, serverLaunchSpec?.migration);
  const migration = await validateRuntimeServerMigration(serverLaunchSpec);
  throwIfStartupCancelled(isCancellationRequested, migration);
  let child;
  try {
    child = spawnProcImpl('server-migrate', migration.command, migration.args, env, { cwd: migration.cwd });
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
  } finally {
    const index = children?.indexOf(child) ?? -1;
    if (index >= 0) children.splice(index, 1);
  }
}

export async function spawnRuntimeServerAfterMigration({
  serverLaunchSpec,
  env,
  children,
  isCancellationRequested,
  spawnProcImpl = spawnProc,
}) {
  await runServerRuntimeMigration({ serverLaunchSpec, env, children, isCancellationRequested, spawnProcImpl });
  throwIfStartupCancelled(isCancellationRequested, serverLaunchSpec.migration);
  const server = spawnProcImpl('server', serverLaunchSpec.command, serverLaunchSpec.args, env, { cwd: serverLaunchSpec.serverDir });
  children?.push(server);
  return server;
}
