import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getHappyStacksHomeDir } from '../paths/paths.mjs';
import { runCaptureResult } from '../proc/proc.mjs';
import { loadDevTargetsConfig, resolveDevTargetExecutionPolicy } from '../dev_targets/config.mjs';
import { resolveRemoteStackStatePaths } from '../dev_targets/remote_commands.mjs';
import {
  loadExecutionHostGuestDevTargetsConfig,
  resolveExecutionHostWorkspaceMount,
} from './workspace_mount.mjs';

const DEFAULT_RETENTION = 3;
const MAX_RETENTION = 30;
const ARCHIVE_PREFIX = 'dev-vm-backup-';
const ARCHIVE_RE = /^dev-vm-backup-[0-9]+-[0-9a-f-]{36}\.tar\.gz$/;
const GUEST_ARCHIVE_RE = /^\/tmp\/happier-dev-vm-backup-[A-Za-z0-9._-]+\.tar\.gz$/;
const BACKUP_TMPDIR = '/tmp';
const STACK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const BACKUP_STATE_FILE = 'latest.json';
const ARCHIVE_SHA256_RE = /^[0-9a-f]{64}$/;
const SERVER_STATE_ARCHIVE_FORMAT = 2;
const SERVER_LIGHT_DIR_NAME = 'server-light';

function requireAbsolutePath(value, label) {
  const path = String(value ?? '').trim();
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) {
    throw new Error(`[dev-vm] ${label} must be an absolute path`);
  }
  return resolve(path);
}

function requireSafeStackName(value, label = 'backup Stack name') {
  const stackName = String(value ?? '').trim() || 'main';
  if (!STACK_NAME_RE.test(stackName)) {
    throw new Error(`[dev-vm] ${label} must be one safe path segment`);
  }
  return stackName;
}

function redactBackupSource(source) {
  return source.placement === 'target'
    ? { authority: source.authority, placement: 'target', target: source.target }
    : { authority: source.authority, placement: 'guest' };
}

function readStoredBackupSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const authority = raw.authority === 'guest-config' || raw.authority === 'host-config'
    ? raw.authority
    : '';
  if (!authority) return null;
  if (raw.placement === 'guest') return { authority, placement: 'guest' };
  const target = String(raw.target ?? '').trim();
  if (raw.placement === 'target' && STACK_NAME_RE.test(target)) {
    return { authority, placement: 'target', target };
  }
  return null;
}

function sameBackupSource(left, right) {
  return left.authority === right.authority
    && left.placement === right.placement
    && (left.placement !== 'target' || left.target === right.target);
}

export async function resolveExecutionHostBackupSource({
  profile,
  stackName = 'main',
  env = process.env,
  boundary,
} = {}) {
  const normalizedStackName = requireSafeStackName(stackName);
  // Candidate setup has not transferred Stack runtime authority. Once the
  // profile is active, its mounted guest home is the only config view backup
  // may use; falling back to the Mac copy could snapshot a retired server.
  const guestConfigAuthoritative = profile?.mode === 'managed-lima' && profile.activation === 'active';
  const loaded = guestConfigAuthoritative
    ? await loadExecutionHostGuestDevTargetsConfig({
      profile,
      stackName: normalizedStackName,
      env,
      boundary,
    })
    : await loadDevTargetsConfig({ stackName: normalizedStackName, env });
  const authority = guestConfigAuthoritative ? 'guest-config' : 'host-config';
  const policy = resolveDevTargetExecutionPolicy(loaded.config);
  if (policy.server.mode === 'local') return { authority, placement: 'guest' };
  if (policy.server.mode !== 'prefer-target') {
    throw new Error('[dev-vm] backup could not resolve the authoritative server placement');
  }
  const target = loaded.config.targets.find((candidate) => candidate.name === policy.server.target);
  if (!target) {
    throw new Error('[dev-vm] persisted target server placement has no configured target');
  }
  const { stackStorageDir, stackBaseDir } = resolveRemoteStackStatePaths(target, {
    stackName: normalizedStackName,
  });
  if (target.platform !== 'posix' || !isAbsolute(stackStorageDir) || !isAbsolute(stackBaseDir)) {
    throw new Error('[dev-vm] target-placed backup only supports locally reachable POSIX target state');
  }
  return {
    authority,
    placement: 'target',
    target: target.name,
    stackStorageDir,
    stackStateDir: stackBaseDir,
  };
}

function requireReturnedSafeStackName(value, label) {
  const stackName = String(value ?? '').trim();
  if (!STACK_NAME_RE.test(stackName)) {
    throw new Error(`[dev-vm] ${label} must be one safe path segment`);
  }
  return stackName;
}

function requireArchiveSha256(value, label = 'backup archive checksum') {
  const archiveSha256 = String(value ?? '').trim();
  if (!ARCHIVE_SHA256_RE.test(archiveSha256)) {
    throw new Error(`[dev-vm] ${label} must be a SHA-256 digest`);
  }
  return archiveSha256;
}

function pathContains(parent, candidate) {
  const suffix = relative(resolve(parent), resolve(candidate));
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

export function resolveExecutionHostBackupRetention(value = DEFAULT_RETENTION) {
  const retention = Number(value);
  if (!Number.isInteger(retention) || retention < 1 || retention > MAX_RETENTION) {
    throw new Error(`[dev-vm] backup retention must be an integer from 1 to ${MAX_RETENTION}`);
  }
  return retention;
}

export function resolveExecutionHostBackupPaths({ profile, env = process.env, stackName = 'main', destination = '' } = {}) {
  const normalizedStackName = requireSafeStackName(stackName);
  const stackHome = getHappyStacksHomeDir(env);
  const mount = resolveExecutionHostWorkspaceMount(profile, env);
  const backupDestination = requireAbsolutePath(
    destination || join(stackHome, 'vm-backups', String(profile?.instance ?? '').trim(), normalizedStackName),
    'backup destination',
  );
  const mountedGuestHome = requireAbsolutePath(profile?.hostMountDir || mount.mountDir, 'mounted guest home');
  if (pathContains(mountedGuestHome, backupDestination)) {
    throw new Error('[dev-vm] backup destination must be outside the mounted guest home');
  }
  return {
    stackName: normalizedStackName,
    destination: backupDestination,
    statePath: join(backupDestination, BACKUP_STATE_FILE),
    sshConfigFile: mount.sshConfigFile,
    sshHost: mount.sshHost,
  };
}

function defaultBoundary(env) {
  return {
    capture: (command, args, options = {}) => runCaptureResult(command, args, { env, ...options }),
    availableBytes: async (path) => {
      const filesystem = await statfs(path);
      return Number(filesystem.bavail) * Number(filesystem.bsize);
    },
  };
}

function backupArchiveName() {
  return `${ARCHIVE_PREFIX}${Date.now()}-${randomUUID()}.tar.gz`;
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function listArchives(destination) {
  let entries;
  try {
    entries = await readdir(destination, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile() || !ARCHIVE_RE.test(entry.name)) continue;
    const path = join(destination, entry.name);
    const details = await stat(path);
    archives.push({ path, name: entry.name, modifiedAt: details.mtime.toISOString(), modifiedMs: details.mtimeMs, size: details.size });
  }
  return archives.sort((left, right) => right.modifiedMs - left.modifiedMs || right.name.localeCompare(left.name));
}

async function pruneArchives(destination, retention) {
  const archives = await listArchives(destination);
  for (const archive of archives.slice(retention)) {
    await rm(archive.path, { force: false });
  }
  return archives.slice(0, retention);
}

function parseExecutionHostBackupResult(result, sourceLabel) {
  if (result.exitCode !== 0) {
    const detail = String(result.err ?? '').trim();
    throw new Error(`[dev-vm] ${sourceLabel} backup failed${detail ? `: ${detail}` : ''}`);
  }
  let payload;
  try {
    payload = JSON.parse(String(result.out ?? '').trim());
  } catch {
    throw new Error(`[dev-vm] ${sourceLabel} backup returned an invalid result`);
  }
  const archivePath = String(payload?.archivePath ?? '').trim();
  if (!GUEST_ARCHIVE_RE.test(archivePath)) {
    throw new Error(`[dev-vm] ${sourceLabel} backup returned an unsafe archive path`);
  }
  if (
    payload?.database?.provider !== 'sqlite'
    || payload?.database?.integrity !== 'ok'
    || payload?.database?.foreignKeys !== 'ok'
  ) {
    throw new Error(`[dev-vm] ${sourceLabel} backup did not produce an integrity-checked SQLite snapshot with valid foreign keys`);
  }
  const archiveBytes = Number(payload?.archiveBytes);
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0) {
    throw new Error(`[dev-vm] ${sourceLabel} backup returned an invalid archive size`);
  }
  const archiveSha256 = requireArchiveSha256(payload?.archiveSha256, `${sourceLabel} backup archive checksum`);
  return {
    archivePath,
    stackName: String(payload.stackName ?? '').trim(),
    database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
    archiveBytes,
    archiveSha256,
    included: Array.isArray(payload.included) ? payload.included.map((item) => String(item)) : [],
  };
}

function parseExecutionHostBackupPlan(result, sourceLabel) {
  if (result.exitCode !== 0) {
    const detail = String(result.err ?? '').trim();
    throw new Error(`[dev-vm] ${sourceLabel} backup preflight failed${detail ? `: ${detail}` : ''}`);
  }
  let payload;
  try {
    payload = JSON.parse(String(result.out ?? '').trim());
  } catch {
    throw new Error(`[dev-vm] ${sourceLabel} backup preflight returned an invalid result`);
  }
  if (payload?.database?.provider !== 'sqlite') {
    throw new Error(`[dev-vm] ${sourceLabel} backup preflight did not confirm SQLite storage`);
  }
  const databaseBytes = Number(payload?.databaseBytes);
  const treeBytes = Number(payload?.treeBytes);
  const archiveMaxBytes = Number(payload?.archiveMaxBytes);
  const requiredFreeBytes = Number(payload?.requiredFreeBytes);
  if (![databaseBytes, treeBytes, archiveMaxBytes, requiredFreeBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error(`[dev-vm] ${sourceLabel} backup preflight returned invalid capacity requirements`);
  }
  return {
    stackName: String(payload.stackName ?? '').trim(),
    databaseBytes,
    treeBytes,
    archiveMaxBytes,
    requiredFreeBytes,
  };
}

async function requireAvailableBytes({ availableBytes, path, requiredBytes, label }) {
  const available = Number(await availableBytes(path));
  if (!Number.isSafeInteger(available) || available < 0) {
    throw new Error(`[dev-vm] could not determine free space for ${label}`);
  }
  if (available < requiredBytes) {
    throw new Error(`[dev-vm] ${label} has insufficient free space: need ${requiredBytes} bytes, found ${available} bytes`);
  }
}

async function cleanupGuestArchive({ profile, executor, archivePath }) {
  await executor.capture(
    'limactl',
    ['shell', profile.instance, '--', 'python3', '-c', 'import os, sys; os.unlink(sys.argv[1]) if os.path.exists(sys.argv[1]) else None', archivePath],
  ).catch(() => {});
}

async function readGuestBackupScript() {
  return await readFile(new URL('./guest_backup.py', import.meta.url), 'utf8');
}

function executionHostBackupToolPath() {
  return fileURLToPath(new URL('./guest_backup.py', import.meta.url));
}

function backupSourceLabel(source) {
  return source.placement === 'target' ? 'target' : 'guest';
}

async function captureExecutionHostBackupAction({
  source,
  profile,
  executor,
  boundary,
  env,
  action,
  stackName,
}) {
  if (source.placement === 'guest') {
    return await executor.capture(
      'limactl',
      ['shell', profile.instance, '--', 'python3', '-', action, stackName],
      { input: await readGuestBackupScript() },
    );
  }
  return await boundary.capture(
    'python3',
    [executionHostBackupToolPath(), action, stackName],
    {
      // Keep the direct target tool's temporary archive in the same narrow,
      // validated location used by the guest transport. macOS otherwise
      // inherits a per-user TMPDIR under /var/folders and fails closed before
      // its locally produced archive can be copied.
      env: { ...env, HAPPIER_STACK_STORAGE_DIR: source.stackStorageDir, TMPDIR: BACKUP_TMPDIR },
    },
  );
}

async function transferExecutionHostBackupArchive({ source, paths, archivePath, temporaryPath, boundary }) {
  if (source.placement === 'guest') {
    const transfer = await boundary.capture('scp', [
      '-F', paths.sshConfigFile,
      `${paths.sshHost}:${archivePath}`,
      temporaryPath,
    ]);
    if (transfer.exitCode !== 0) {
      const detail = String(transfer.err ?? '').trim();
      throw new Error(`[dev-vm] backup transfer to the Mac host failed${detail ? `: ${detail}` : ''}`);
    }
    return;
  }
  try {
    await copyFile(archivePath, temporaryPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[dev-vm] target backup copy to the destination failed${detail ? `: ${detail}` : ''}`);
  }
}

async function cleanupExecutionHostBackupArchive({ source, profile, executor, archivePath }) {
  if (source.placement === 'guest') {
    await cleanupGuestArchive({ profile, executor, archivePath });
    return;
  }
  await rm(archivePath, { force: true }).catch(() => {});
}

function parseServerStateToolResult(result, action) {
  if (result.exitCode !== 0) {
    const detail = String(result.err ?? '').trim();
    throw new Error(`[dev-vm] server-state ${action} failed${detail ? `: ${detail}` : ''}`);
  }
  let payload;
  try {
    payload = JSON.parse(String(result.out ?? '').trim());
  } catch {
    throw new Error(`[dev-vm] server-state ${action} returned an invalid result`);
  }
  if (payload?.format !== SERVER_STATE_ARCHIVE_FORMAT) {
    throw new Error('[dev-vm] server-state archive has an unsupported format');
  }
  const stackName = requireReturnedSafeStackName(payload?.stackName, 'server-state archive Stack name');
  const archiveBytes = Number(payload?.archiveBytes);
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0) {
    throw new Error('[dev-vm] server-state archive returned an invalid size');
  }
  const archiveSha256 = requireArchiveSha256(payload?.archiveSha256, 'server-state archive checksum');
  if (
    payload?.database?.provider !== 'sqlite'
    || payload?.database?.integrity !== 'ok'
    || payload?.database?.foreignKeys !== 'ok'
  ) {
    throw new Error('[dev-vm] server-state archive did not pass SQLite integrity and foreign-key checks');
  }
  const secretPath = String(payload?.secret?.path ?? '').trim();
  const secretMode = Number(payload?.secret?.mode);
  if (secretPath !== 'stack/server-light/handy-master-secret.txt' || !Number.isInteger(secretMode) || secretMode < 0 || secretMode > 0o777) {
    throw new Error('[dev-vm] server-state archive is missing a valid handy master secret');
  }
  const secretSha256 = requireArchiveSha256(payload?.secret?.sha256, 'server-state secret checksum');
  const entryCount = Number(payload?.entryCount);
  if (!Number.isSafeInteger(entryCount) || entryCount < 2) {
    throw new Error('[dev-vm] server-state archive returned an invalid entry count');
  }
  const destination = typeof payload?.destination === 'string' ? payload.destination : '';
  return {
    stackName,
    archiveBytes,
    archiveSha256,
    database: { provider: 'sqlite', integrity: 'ok', foreignKeys: 'ok' },
    secret: { path: secretPath, mode: secretMode, sha256: secretSha256 },
    entryCount,
    ...(destination ? { destination } : {}),
  };
}

async function runServerStateTool({ action, args, boundary, env }) {
  if (!boundary?.capture) throw new Error('[dev-vm] server-state archive inspection requires a host process boundary');
  const result = await boundary.capture('python3', [executionHostBackupToolPath(), action, ...args]);
  return parseServerStateToolResult(result, action);
}

async function requirePathAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`[dev-vm] ${label} must be absent`);
}

export function resolveExecutionHostServerStateRestorePaths({ targetStackStateDir } = {}) {
  const normalizedTargetStackStateDir = requireAbsolutePath(targetStackStateDir, 'target Stack state directory');
  return {
    targetStackStateDir: normalizedTargetStackStateDir,
    targetServerLightDir: join(normalizedTargetStackStateDir, SERVER_LIGHT_DIR_NAME),
  };
}

export async function inspectExecutionHostServerStateArchive({
  archivePath,
  archiveSha256 = '',
  boundary,
  env = process.env,
} = {}) {
  const normalizedArchivePath = requireAbsolutePath(archivePath, 'server-state archive');
  const expectedArchiveSha256 = archiveSha256
    ? requireArchiveSha256(archiveSha256, 'expected server-state archive checksum')
    : '';
  const processBoundary = boundary ?? defaultBoundary(env);
  const inspection = await runServerStateTool({
    action: 'inspect',
    args: [normalizedArchivePath],
    boundary: processBoundary,
    env,
  });
  if (expectedArchiveSha256 && inspection.archiveSha256 !== expectedArchiveSha256) {
    throw new Error('[dev-vm] server-state archive checksum did not match the expected backup');
  }
  return { archivePath: normalizedArchivePath, ...inspection };
}

export async function planExecutionHostServerStateRestore({
  archivePath,
  archiveSha256 = '',
  stackName = 'main',
  targetStackStateDir,
  boundary,
  env = process.env,
} = {}) {
  const normalizedStackName = requireSafeStackName(stackName, 'restore Stack name');
  const paths = resolveExecutionHostServerStateRestorePaths({ targetStackStateDir });
  await requirePathAbsent(paths.targetServerLightDir, 'target server-light directory');
  const archive = await inspectExecutionHostServerStateArchive({
    archivePath,
    archiveSha256,
    boundary,
    env,
  });
  if (archive.stackName !== normalizedStackName) {
    throw new Error(`[dev-vm] server-state archive targets Stack ${archive.stackName}, not ${normalizedStackName}`);
  }
  return { ...paths, ...archive };
}

export async function restoreExecutionHostServerState({
  archivePath,
  archiveSha256,
  stackName = 'main',
  targetStackStateDir,
  boundary,
  env = process.env,
} = {}) {
  const expectedArchiveSha256 = requireArchiveSha256(archiveSha256, 'restore archive checksum');
  const plan = await planExecutionHostServerStateRestore({
    archivePath,
    archiveSha256: expectedArchiveSha256,
    stackName,
    targetStackStateDir,
    boundary,
    env,
  });
  const stagingServerLightDir = join(
    dirname(plan.targetServerLightDir),
    `.${basename(plan.targetServerLightDir)}.restore-${randomUUID()}`,
  );
  const processBoundary = boundary ?? defaultBoundary(env);
  await mkdir(dirname(stagingServerLightDir), { recursive: true, mode: 0o700 });
  await requirePathAbsent(stagingServerLightDir, 'server-state restore staging directory');
  let staged = false;
  try {
    const restored = await runServerStateTool({
      action: 'restore',
      args: [plan.archivePath, stagingServerLightDir],
      boundary: processBoundary,
      env,
    });
    if (
      restored.stackName !== plan.stackName
      || restored.archiveSha256 !== expectedArchiveSha256
      || restored.destination !== stagingServerLightDir
    ) {
      throw new Error('[dev-vm] restored server state did not match the inspected backup');
    }
    staged = true;
    await requirePathAbsent(plan.targetServerLightDir, 'target server-light directory');
    await rename(stagingServerLightDir, plan.targetServerLightDir);
    staged = false;
    return {
      targetServerLightDir: plan.targetServerLightDir,
      archivePath: plan.archivePath,
      archiveSha256: expectedArchiveSha256,
      stackName: plan.stackName,
      database: restored.database,
      secret: restored.secret,
    };
  } finally {
    if (staged) await rm(stagingServerLightDir, { recursive: true, force: true });
  }
}

export async function createExecutionHostBackup({
  profile,
  executor,
  boundary,
  env = process.env,
  stackName = 'main',
  destination = '',
  retention = DEFAULT_RETENTION,
} = {}) {
  if (!profile || profile.mode !== 'managed-lima') throw new Error('[dev-vm] a managed Lima execution host is required for backup');
  const paths = resolveExecutionHostBackupPaths({ profile, env, stackName, destination });
  const processBoundary = boundary ?? defaultBoundary(env);
  const source = await resolveExecutionHostBackupSource({
    profile,
    stackName: paths.stackName,
    env,
    boundary: processBoundary,
  });
  if (source.placement === 'guest' && !executor?.capture) {
    throw new Error('[dev-vm] managed Lima executor is required for backup');
  }
  const retainedCount = resolveExecutionHostBackupRetention(retention);
  if (source.placement === 'guest' && !existsSync(paths.sshConfigFile)) {
    throw new Error(`[dev-vm] managed Lima SSH configuration is missing: ${paths.sshConfigFile}; start the VM first`);
  }
  const availableBytes = processBoundary.availableBytes ?? defaultBoundary(env).availableBytes;
  await mkdir(paths.destination, { recursive: true, mode: 0o700 });
  await chmod(paths.destination, 0o700);
  const sourceLabel = backupSourceLabel(source);
  const archiveName = backupArchiveName();
  const archivePath = join(paths.destination, archiveName);
  const temporaryPath = join(paths.destination, `.${archiveName}.partial`);
  let backupResult = null;
  try {
    const plan = parseExecutionHostBackupPlan(await captureExecutionHostBackupAction({
      source,
      profile,
      executor,
      boundary: processBoundary,
      env,
      action: 'preflight',
      stackName: paths.stackName,
    }), sourceLabel);
    if (plan.stackName !== paths.stackName) {
      throw new Error(`[dev-vm] ${sourceLabel} backup preflight returned the wrong Stack name`);
    }
    await requireAvailableBytes({
      availableBytes,
      path: paths.destination,
      requiredBytes: plan.archiveMaxBytes,
      label: 'host backup destination',
    });
    backupResult = parseExecutionHostBackupResult(await captureExecutionHostBackupAction({
      source,
      profile,
      executor,
      boundary: processBoundary,
      env,
      action: 'backup',
      stackName: paths.stackName,
    }), sourceLabel);
    if (backupResult.stackName !== paths.stackName) {
      throw new Error(`[dev-vm] ${sourceLabel} backup returned the wrong Stack name`);
    }
    await requireAvailableBytes({
      availableBytes,
      path: paths.destination,
      requiredBytes: backupResult.archiveBytes,
      label: 'host backup destination',
    });
    try {
      await transferExecutionHostBackupArchive({
        source,
        paths,
        archivePath: backupResult.archivePath,
        temporaryPath,
        boundary: processBoundary,
      });
      const copied = await stat(temporaryPath);
      if (copied.size <= 0) throw new Error('[dev-vm] backup transfer produced an empty archive');
      if (copied.size !== backupResult.archiveBytes) throw new Error(`[dev-vm] backup transfer size did not match the ${sourceLabel} archive`);
      await chmod(temporaryPath, 0o600);
      const inspected = await inspectExecutionHostServerStateArchive({
        archivePath: temporaryPath,
        archiveSha256: backupResult.archiveSha256,
        boundary: processBoundary,
        env,
      });
      if (inspected.stackName !== paths.stackName) {
        throw new Error('[dev-vm] transferred backup archive returned the wrong Stack name');
      }
      await rename(temporaryPath, archivePath);
      await chmod(archivePath, 0o600);
      backupResult.database = inspected.database;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  } finally {
    if (backupResult) {
      await cleanupExecutionHostBackupArchive({
        source,
        profile,
        executor,
        archivePath: backupResult.archivePath,
      });
    }
  }
  const createdAt = new Date().toISOString();
  const archives = await pruneArchives(paths.destination, retainedCount);
  const latest = {
    archivePath,
    archiveName,
    createdAt,
    stackName: paths.stackName,
    database: backupResult.database,
    archiveSha256: backupResult.archiveSha256,
    included: backupResult.included,
    source: redactBackupSource(source),
  };
  await writeJsonAtomically(paths.statePath, latest);
  return {
    destination: paths.destination,
    archivePath,
    createdAt,
    stackName: paths.stackName,
    database: backupResult.database,
    archiveSha256: backupResult.archiveSha256,
    source: redactBackupSource(source),
    retained: archives.length,
  };
}

export async function inspectExecutionHostBackup({
  profile,
  env = process.env,
  stackName = 'main',
  destination = '',
  boundary,
} = {}) {
  const paths = resolveExecutionHostBackupPaths({ profile, env, stackName, destination });
  const archives = await listArchives(paths.destination);
  const state = await readJsonFile(paths.statePath);
  const stateArchivePath = typeof state?.archivePath === 'string' ? state.archivePath : '';
  const latest = stateArchivePath && archives.some((archive) => archive.path === stateArchivePath)
    ? state
    : archives[0]
      ? {
        archivePath: archives[0].path,
        archiveName: archives[0].name,
        createdAt: archives[0].modifiedAt,
        stackName: paths.stackName,
        database: { provider: 'sqlite', integrity: 'unknown' },
      }
      : null;
  let source;
  try {
    source = await resolveExecutionHostBackupSource({
      profile,
      stackName: paths.stackName,
      env,
      boundary,
    });
  } catch {
    return {
      destination: paths.destination,
      stackName: paths.stackName,
      archiveCount: archives.length,
      latest,
      source: null,
      health: { ok: false, code: 'source_unavailable' },
    };
  }
  const storedSource = readStoredBackupSource(latest?.source);
  const health = !latest
    ? { ok: false, code: 'missing' }
    : !storedSource
      ? { ok: false, code: 'source_unverified' }
      : !sameBackupSource(source, storedSource)
        ? { ok: false, code: 'source_stale' }
        : { ok: true, code: 'ready' };
  return {
    destination: paths.destination,
    stackName: paths.stackName,
    archiveCount: archives.length,
    latest,
    source: redactBackupSource(source),
    health,
  };
}
