import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePersonalHomeRuntimeLayout } from '@happier-dev/cli-common/firstPartyRuntime/server';

import { getServerLightDataDirFromEnvOrDefault } from '../stack/dirs.mjs';
import { hasTrustedStackRuntimeLifecycle, withStackRuntimeStartClaim } from '../stack/runtime_state.mjs';
import { spawnProc } from '../proc/proc.mjs';
import { runDevTargetCommand } from './executor.mjs';
import { loadDevTargetsConfig } from './config.mjs';
import { resolveRemoteStackStatePaths, resolveRemoteServerRuntimeConfig } from './remote_commands.mjs';
import { runRuntimeArchiveCommand, transferRuntimeFile } from './runtime_artifact_transfer.mjs';

const WORKER_SCRIPT = './apps/stack/scripts/utils/dev_targets/retained_server_data.mjs';
const DATABASE_FILE = 'happier-server-light.sqlite';

async function exists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function hasRetainedServerData(dataDir) {
  if (!await exists(dataDir)) return false;
  return (await readdir(dataDir)).length > 0;
}

// Hash the complete retained tree, including empty directories and file modes.
// The digest is a transfer check, never another persisted data authority.
export async function fingerprintRetainedServerData(dataDir) {
  const digest = createHash('sha256');
  const visit = async (relativePath) => {
    const path = join(dataDir, relativePath);
    const stat = await lstat(path);
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error('[dev-targets] retained server data must contain only regular files and directories');
    }
    digest.update(JSON.stringify([relativePath.replaceAll('\\', '/'), stat.isDirectory() ? 'directory' : 'file', stat.mode & 0o777, stat.isFile() ? stat.size : null]));
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(relativePath, entry));
    } else {
      for await (const bytes of createReadStream(path)) digest.update(bytes);
    }
  };
  await visit('');
  return digest.digest('hex');
}

async function assertRetainedDatabase(dataDir) {
  for (const filename of [DATABASE_FILE, 'handy-master-secret.txt']) {
    const path = join(dataDir, filename);
    if (!await exists(path)) throw new Error(`[dev-targets] retained server data is missing ${filename}`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size === 0) throw new Error(`[dev-targets] retained server data has invalid ${filename}`);
  }
}

async function verifySqliteIntegrity(dataDir) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(dataDir, DATABASE_FILE), { readOnly: true });
  try {
    const rows = database.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') {
      throw new Error('[dev-targets] retained SQLite integrity check failed');
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('[dev-targets] retained SQLite foreign-key check failed');
    }
  } finally { database.close(); }
}

async function withStoppedStack({ stackBaseDir, stackName }, fn) {
  const statePath = join(stackBaseDir, 'stack.runtime.json');
  if (await exists(statePath)) {
    // Read failures must not reinterpret a possibly running stack as stopped.
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (await hasTrustedStackRuntimeLifecycle(state, { stackName }, { throwOnInconclusive: true })) {
      throw new Error(`[dev-targets] stop stack ${stackName} before moving its retained server data`);
    }
  }
  return await withStackRuntimeStartClaim(statePath, { stackName }, async ({ existing }) => {
    if (await hasTrustedStackRuntimeLifecycle(existing, { stackName }, { throwOnInconclusive: true })) {
      throw new Error(`[dev-targets] stop stack ${stackName} before moving its retained server data`);
    }
    return await fn();
  });
}

export async function importRetainedServerData({ archivePath, dataDir, stackBaseDir, stackName, expectedFingerprint }) {
  return await withStoppedStack({ stackBaseDir, stackName }, async () => {
    await mkdir(stackBaseDir, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(stackBaseDir, '.server-light-handoff-'));
    const staged = join(temporary, 'server-light');
    try {
      await mkdir(staged, { mode: 0o700 });
      await runRuntimeArchiveCommand(['-xf', archivePath, '-C', staged]);
      if (await fingerprintRetainedServerData(staged) !== expectedFingerprint) {
        throw new Error('[dev-targets] retained server data transfer checksum mismatch');
      }
      await assertRetainedDatabase(staged);
      await verifySqliteIntegrity(staged);
      if (await exists(dataDir)) {
        if (await fingerprintRetainedServerData(dataDir) !== expectedFingerprint) {
          throw new Error('[dev-targets] target retained server data already exists and differs; no files were replaced');
        }
        return { reused: true };
      }
      await rename(staged, dataDir);
      return { reused: false };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

async function runRetainedServerDataCommand(options) {
  let out = '';
  const result = await runDevTargetCommand(options, {
    spawnProcess: ({ label, command, args, env }) => spawnProc(label, command, args, env, {
      persistOutput: false,
      lineFilter: ({ stream, line }) => {
        if (stream !== 'stdout') return true;
        out += `${line}\n`;
        return false;
      },
    }),
  });
  return { ...result, out };
}

async function remoteDataCommand({ target, stackBaseDir, commandArgs, env }, runCommand) {
  const result = await runCommand({ target, stackBaseDir, env, commandArgs: ['node', WORKER_SCRIPT, ...commandArgs], dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip' });
  if (result?.code !== 0) throw new Error(`[dev-targets] retained server data operation failed on ${target.name} (exit ${result?.code ?? 'unknown'})`);
  return result;
}

export async function ensureRemoteServerDataReady({ target, stackName, stackBaseDir, syncStackBaseDir = stackBaseDir, config, env = process.env }, { runCommand = runRetainedServerDataCommand } = {}) {
  if (env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK) {
    const placement = (config ?? (await loadDevTargetsConfig({ stackName, env })).config).runtimePlacement?.server;
    if (placement?.mode !== 'prefer-target' || placement.target !== target.name || !env.HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE) {
      throw new Error('[shared-db] source server host and env reference are required');
    }
    // The consumer has only derived server state, not its own database tree.
    // Its server resolves the existing source authority before opening SQLite.
    return { retainedRemoteData: true };
  }
  const sourceDir = getServerLightDataDirFromEnvOrDefault({ stackBaseDir, env });
  const retainedSource = await hasRetainedServerData(sourceDir);
  const placement = (config ?? (await loadDevTargetsConfig({ stackName, env, allowMissing: true })).config).runtimePlacement?.server;
  if (retainedSource && (placement?.mode !== 'prefer-target' || placement.target !== target.name)) {
    throw new Error(`[dev-targets] retained data is still local; run hstack dev-targets move-server ${target.name} --stack=${stackName} before remote startup`);
  }
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'controlled' });
  const result = await remoteDataCommand({ target, stackBaseDir: syncStackBaseDir, env, commandArgs: [
    '--check-placement', `--data-dir=${paths.serverLightDataDir}`,
    `--require-existing=${retainedSource || (placement?.mode === 'prefer-target' && placement.target === target.name)}`,
    `--controller-stack=${stackName}`, `--target=${target.name}`,
  ] }, runCommand);
  const observed = JSON.parse(result.out);
  if (typeof observed?.retainedRemoteData !== 'boolean') throw new Error('[dev-targets] invalid remote retained data readiness result');
  return { retainedRemoteData: observed.retainedRemoteData };
}

export async function moveRetainedServerData({ target, stackName, stackBaseDir, syncStackBaseDir = stackBaseDir, config, env = process.env, persistPlacement }, {
  runCommand = runRetainedServerDataCommand, transferFile = transferRuntimeFile,
} = {}) {
  const previous = config.runtimePlacement?.server;
  if (previous?.mode === 'prefer-target') {
    if (previous.target !== target.name) throw new Error(`[dev-targets] retained server data already belongs to ${previous.target}; remote-to-remote handoff is not supported`);
    return { moved: false, reason: 'already_remote', target: target.name };
  }
  resolveRemoteServerRuntimeConfig({ serverComponentName: env.HAPPIER_STACK_SERVER_COMPONENT || 'happier-server-light', env });
  const sourceDir = getServerLightDataDirFromEnvOrDefault({ stackBaseDir, env });
  const layout = resolvePersonalHomeRuntimeLayout({ env: { ...env, HAPPIER_SERVER_LIGHT_DATA_DIR: sourceDir } });
  if (layout.databasePath !== resolve(sourceDir, DATABASE_FILE)
    || layout.publicFilesDir !== resolve(sourceDir, 'files')
    || layout.privateFilesDir !== resolve(sourceDir, 'private-files')) {
    throw new Error('[dev-targets] server storage overrides require a layout-aware handoff; no data or placement was changed');
  }
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'controlled' });
  const dataDir = paths.serverLightDataDir;
  return await withStoppedStack({ stackBaseDir, stackName }, async () => {
    await assertRetainedDatabase(sourceDir);
    if (env.HANDY_MASTER_SECRET?.trim()
      && env.HANDY_MASTER_SECRET.trim() !== (await readFile(layout.masterSecretPath, 'utf8')).trim()) {
      throw new Error('[dev-targets] configured signing material differs from the retained directory; no data or placement was changed');
    }
    const fingerprint = await fingerprintRetainedServerData(sourceDir);
    const temporary = await mkdtemp(join(tmpdir(), 'hstack-server-handoff-'));
    const archivePath = join(temporary, 'server-light.tar');
    const remoteArchivePath = `${paths.stackBaseDir}/.server-light-handoff-${randomUUID()}.tar`;
    try {
      await runRuntimeArchiveCommand(['-cf', archivePath, '-C', sourceDir, '.']);
      await chmod(archivePath, 0o600);
      if (await fingerprintRetainedServerData(sourceDir) !== fingerprint) throw new Error('[dev-targets] source server data changed during capture; placement was not changed');
      await remoteDataCommand({ target, stackBaseDir: syncStackBaseDir, env, commandArgs: ['--prepare', `--stack-base-dir=${paths.stackBaseDir}`] }, runCommand);
      await transferFile({ target, direction: 'upload', localPath: archivePath, remotePath: remoteArchivePath });
      await remoteDataCommand({ target, stackBaseDir: syncStackBaseDir, env, commandArgs: [
        '--import', `--archive=${remoteArchivePath}`, `--data-dir=${dataDir}`, `--stack-base-dir=${paths.stackBaseDir}`,
        `--stack-name=${paths.stackName}`, `--fingerprint=${fingerprint}`,
      ] }, runCommand);
      if (await fingerprintRetainedServerData(sourceDir) !== fingerprint) throw new Error('[dev-targets] source server data changed during transfer; placement was not changed');
      await persistPlacement();
      return { moved: true, target: target.name, sourceDir, dataDir, sourceRetained: true };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

async function workerMain(args) {
  const value = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  if (args.includes('--prepare')) {
    await mkdir(value('--stack-base-dir'), { recursive: true, mode: 0o700 });
  } else if (args.includes('--import')) {
    await importRetainedServerData({ archivePath: value('--archive'), dataDir: value('--data-dir'), stackBaseDir: value('--stack-base-dir'), stackName: value('--stack-name'), expectedFingerprint: value('--fingerprint') });
    await rm(value('--archive'));
  } else if (args.includes('--check-placement')) {
    const dataDir = value('--data-dir');
    const retainedRemoteData = await hasRetainedServerData(dataDir);
    if (retainedRemoteData) await assertRetainedDatabase(dataDir);
    else if (value('--require-existing') === 'true') {
      throw new Error(`[dev-targets] authoritative remote retained server data is missing on ${value('--target')}; startup refused for ${value('--controller-stack')}`);
    }
    process.stdout.write(`${JSON.stringify({ retainedRemoteData })}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  workerMain(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
