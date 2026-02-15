import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, win32 as win32Path } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { banner, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import { installService as installManagedService, restartService as restartManagedService, uninstallService as uninstallManagedService } from './utils/service/service_manager.mjs';
import {
  applyServicePlan,
  buildLaunchdPath,
  buildLaunchdPlistXml,
  buildServiceDefinition,
  planServiceAction,
  renderSystemdServiceUnit,
  renderWindowsScheduledTaskWrapperPs1,
  resolveServiceBackend,
} from '@happier-dev/cli-common/service';
import { DEFAULT_MINISIGN_PUBLIC_KEY } from '@happier-dev/release-runtime/minisign';
import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';
import { downloadVerifiedReleaseAssetBundle } from '@happier-dev/release-runtime/verifiedDownload';
import { planArchiveExtraction } from '@happier-dev/release-runtime/extractPlan';
import { fetchFirstGitHubReleaseByTags, fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';

const SUPPORTED_CHANNELS = new Set(['stable', 'preview']);
const DEFAULTS = Object.freeze({
  githubRepo: 'happier-dev/happier',
  installRoot: '/opt/happier',
  binDir: '/usr/local/bin',
  configDir: '/etc/happier',
  dataDir: '/var/lib/happier',
  logDir: '/var/log/happier',
  serviceName: 'happier-server',
  serverHost: '127.0.0.1',
  serverPort: 3005,
  healthCheckTimeoutMs: 90_000,
  autoUpdateIntervalMinutes: 1440,
  uiWebProduct: 'happier-ui-web',
  uiWebOs: 'web',
  uiWebArch: 'any',
});

export function resolveSelfHostDefaults({ platform = process.platform, mode = 'user', homeDir = homedir() } = {}) {
  const p = String(platform ?? '').trim() || process.platform;
  const m = String(mode ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
  const home = String(homeDir ?? '').trim() || homedir();

  if (m === 'system') {
    return {
      installRoot: DEFAULTS.installRoot,
      binDir: DEFAULTS.binDir,
      configDir: DEFAULTS.configDir,
      dataDir: DEFAULTS.dataDir,
      logDir: DEFAULTS.logDir,
    };
  }

  const happierHome = p === 'win32' ? `${home}\\.happier` : join(home, '.happier');
  const installRoot = p === 'win32' ? `${happierHome}\\self-host` : join(happierHome, 'self-host');
  return {
    installRoot,
    binDir: p === 'win32' ? `${happierHome}\\bin` : join(happierHome, 'bin'),
    configDir: p === 'win32' ? `${installRoot}\\config` : join(installRoot, 'config'),
    dataDir: p === 'win32' ? `${installRoot}\\data` : join(installRoot, 'data'),
    logDir: p === 'win32' ? `${installRoot}\\logs` : join(installRoot, 'logs'),
  };
}

function parseBoolean(raw, fallback = false) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'y' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'n' || value === 'off') return false;
  return fallback;
}

function parsePort(raw, fallback = DEFAULTS.serverPort) {
  const value = Number(String(raw ?? '').trim());
  if (!Number.isFinite(value)) return fallback;
  const port = Math.floor(value);
  return port > 0 && port <= 65535 ? port : fallback;
}

export function resolveSelfHostHealthTimeoutMs(env = process.env) {
  const raw = String(env?.HAPPIER_SELF_HOST_HEALTH_TIMEOUT_MS ?? '').trim();
  if (!raw) return DEFAULTS.healthCheckTimeoutMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 10_000
    ? Math.floor(parsed)
    : DEFAULTS.healthCheckTimeoutMs;
}

export function resolveSelfHostAutoUpdateDefault(env = process.env) {
  return parseBoolean(env?.HAPPIER_SELF_HOST_AUTO_UPDATE, false);
}

export function resolveSelfHostAutoUpdateIntervalMinutes(env = process.env) {
  const raw = String(env?.HAPPIER_SELF_HOST_AUTO_UPDATE_INTERVAL_MINUTES ?? '').trim();
  if (!raw) return DEFAULTS.autoUpdateIntervalMinutes;
  const parsed = Number(raw);
  const minutes = Number.isFinite(parsed) ? Math.floor(parsed) : NaN;
  return Number.isFinite(minutes) && minutes >= 15
    ? minutes
    : DEFAULTS.autoUpdateIntervalMinutes;
}

export function normalizeSelfHostAutoUpdateState(state, { fallbackIntervalMinutes = DEFAULTS.autoUpdateIntervalMinutes } = {}) {
  const fallbackRaw = Number(fallbackIntervalMinutes);
  const fallback =
    Number.isFinite(fallbackRaw) && Math.floor(fallbackRaw) >= 15
      ? Math.floor(fallbackRaw)
      : DEFAULTS.autoUpdateIntervalMinutes;

  const raw = state?.autoUpdate;
  if (raw != null && typeof raw === 'object') {
    const enabled = Boolean(raw.enabled);
    const parsed = Number(raw.intervalMinutes);
    const intervalMinutes = Number.isFinite(parsed) && Math.floor(parsed) >= 15 ? Math.floor(parsed) : fallback;
    return { enabled, intervalMinutes };
  }
  if (raw === true || raw === false) {
    return { enabled: raw, intervalMinutes: fallback };
  }
  return { enabled: false, intervalMinutes: fallback };
}

export function decideSelfHostAutoUpdateReconcile(state, { fallbackIntervalMinutes = DEFAULTS.autoUpdateIntervalMinutes } = {}) {
  const normalized = normalizeSelfHostAutoUpdateState(state, { fallbackIntervalMinutes });
  return {
    action: normalized.enabled ? 'install' : 'uninstall',
    enabled: normalized.enabled,
    intervalMinutes: normalized.intervalMinutes,
  };
}

function assertLinux() {
  if (process.platform !== 'linux') {
    throw new Error('[self-host] Happier Self-Host currently supports Linux only.');
  }
}

function assertRoot() {
  if (typeof process.getuid !== 'function') return;
  if (process.getuid() !== 0) {
    throw new Error('[self-host] root privileges are required for this command.');
  }
}

function runCommand(cmd, args, { cwd, env, allowFail = false, stdio = 'pipe' } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf-8',
    stdio,
  });
  if (result.error) {
    if (!allowFail) throw result.error;
    return result;
  }
  if (!allowFail && (result.status ?? 1) !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(`[self-host] command failed: ${cmd} ${args.join(' ')}${stderr ? `\n${stderr}` : ''}`);
  }
  return result;
}

function commandExists(cmd) {
  const name = String(cmd ?? '').trim();
  if (!name) return false;
  if (process.platform === 'win32') {
    const result = runCommand('where', [name], { allowFail: true, stdio: 'ignore' });
    return (result.status ?? 1) === 0;
  }
  const result = runCommand('sh', ['-lc', `command -v ${name} >/dev/null 2>&1`], { allowFail: true, stdio: 'ignore' });
  return (result.status ?? 1) === 0;
}

function normalizeArch() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!arch) {
    throw new Error(`[self-host] unsupported architecture: ${process.arch}`);
  }
  return arch;
}

function normalizeOs(platform = process.platform) {
  const p = String(platform ?? '').trim() || process.platform;
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'darwin';
  if (p === 'win32') return 'windows';
  throw new Error(`[self-host] unsupported platform: ${p}`);
}

function normalizeChannel(raw) {
  const channel = String(raw ?? '').trim() || 'stable';
  if (!SUPPORTED_CHANNELS.has(channel)) {
    throw new Error(`[self-host] invalid channel: ${channel} (expected stable|preview)`);
  }
  return channel;
}

function normalizeMode(raw) {
  const mode = String(raw ?? '').trim().toLowerCase();
  if (!mode) return 'user';
  if (mode === 'user' || mode === 'system') return mode;
  throw new Error(`[self-host] invalid mode: ${mode} (expected user|system)`);
}

export function parseSelfHostInvocation(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  if (args[0] === 'self-host' || args[0] === 'selfhost') {
    args.shift();
  }
  const subcommand = args.find((arg) => arg && !arg.startsWith('-')) ?? 'help';
  const subcommandIndex = args.indexOf(subcommand);
  return {
    subcommand,
    rest: subcommandIndex >= 0 ? args.slice(subcommandIndex + 1) : [],
    argv: args,
  };
}

export function pickReleaseAsset({ assets, product, os, arch }) {
  const { version, archive, checksums, checksumsSig } = resolveReleaseAssetBundle({
    assets,
    product,
    os,
    arch,
  });
  return {
    archiveUrl: archive.url,
    archiveName: archive.name,
    checksumsUrl: checksums.url,
    signatureUrl: checksumsSig.url,
    version,
  };
}

function resolveSqliteDatabaseFilePath(databaseUrl) {
  const raw = String(databaseUrl ?? '').trim();
  if (!raw) return '';
  if (!raw.startsWith('file:')) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'file:') return '';
    const pathname = url.pathname || '';
    // On Windows, URL.pathname can start with /C:/...
    return pathname.startsWith('/') && /^[A-Za-z]:\//.test(pathname.slice(1))
      ? pathname.slice(1)
      : pathname;
  } catch {
    const value = raw.slice('file:'.length);
    return value.startsWith('//') ? value.replace(/^\/+/, '/') : value;
  }
}

async function applySelfHostSqliteMigrationsAtInstallTime({ env }) {
  if (typeof globalThis.Bun === 'undefined') {
    return { applied: [], skipped: true, reason: 'bun-unavailable' };
  }
  const databaseUrl = String(env?.DATABASE_URL ?? '').trim();
  const migrationsDir = String(env?.HAPPIER_SQLITE_MIGRATIONS_DIR ?? env?.HAPPY_SQLITE_MIGRATIONS_DIR ?? '').trim();
  if (!databaseUrl || !migrationsDir) {
    return { applied: [], skipped: true, reason: 'missing-config' };
  }
  const dbPath = resolveSqliteDatabaseFilePath(databaseUrl);
  if (!dbPath) {
    return { applied: [], skipped: true, reason: 'unsupported-database-url' };
  }
  const migrationsInfo = await stat(migrationsDir).catch(() => null);
  if (!migrationsInfo?.isDirectory()) {
    return { applied: [], skipped: true, reason: 'migrations-dir-missing' };
  }

  const mod = await import('bun:sqlite');
  const Database = mod?.Database;
  if (!Database) {
    return { applied: [], skipped: true, reason: 'bun-sqlite-unavailable' };
  }
  const db = new Database(dbPath);
  db.exec(
    [
      'CREATE TABLE IF NOT EXISTS _prisma_migrations (',
      '  id TEXT PRIMARY KEY,',
      '  checksum TEXT NOT NULL,',
      '  finished_at DATETIME,',
      '  migration_name TEXT NOT NULL,',
      '  logs TEXT,',
      '  rolled_back_at DATETIME,',
      '  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,',
      '  applied_steps_count INTEGER NOT NULL DEFAULT 0',
      ');',
    ].join('\n'),
  );

  const tableNamesQuery = db.query(`SELECT name FROM sqlite_master WHERE type='table'`);
  const appliedQuery = db.query(
    `SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL`,
  );
  const insertQuery = db.query(
    `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)`,
  );

  const applied = new Set(
    appliedQuery.all().map((row) => String(row?.migration_name ?? '').trim()).filter(Boolean),
  );

  const existingTables = new Set(
    tableNamesQuery.all().map((row) => String(row?.name ?? '').trim()).filter(Boolean),
  );
  const hasCoreTables =
    existingTables.has('Account')
    || existingTables.has('account')
    || existingTables.has('accounts');
  const legacyMode = applied.size === 0 && hasCoreTables;

  const isLikelyAlreadyAppliedError = (err) => {
    const msg = String(err?.message ?? err ?? '').toLowerCase();
    return msg.includes('already exists') || msg.includes('duplicate column') || msg.includes('duplicate');
  };

  const entries = await readdir(migrationsDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const sha256Hex = (input) => createHash('sha256').update(String(input)).digest('hex');
  const appliedNow = [];
  for (const name of dirs) {
    if (applied.has(name)) continue;
    const sqlPath = join(migrationsDir, name, 'migration.sql');
    const sql = await readFile(sqlPath, 'utf8').catch(() => '');
    if (!sql.trim()) continue;
    const checksum = sha256Hex(sql);
    db.exec('BEGIN');
    try {
      db.exec(sql);
      insertQuery.run(randomUUID(), checksum, name);
      db.exec('COMMIT');
      appliedNow.push(name);
      applied.add(name);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      if (legacyMode && isLikelyAlreadyAppliedError(e)) {
        db.exec('BEGIN');
        try {
          insertQuery.run(randomUUID(), checksum, name);
          db.exec('COMMIT');
        } catch (inner) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // ignore
          }
          throw inner;
        }
        appliedNow.push(name);
        applied.add(name);
        continue;
      }
      throw e;
    }
  }

  return { applied: appliedNow, skipped: false, reason: 'ok' };
}

async function findExecutableByName(rootDir, binaryName) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExecutableByName(fullPath, binaryName);
      if (nested) return nested;
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name !== binaryName) continue;
    const info = await stat(fullPath);
    if (process.platform === 'win32') return fullPath;
    if ((info.mode & 0o111) !== 0) return fullPath;
  }
  return '';
}

function resolveConfig({ channel, mode = 'user', platform = process.platform } = {}) {
  const defaults = resolveSelfHostDefaults({ platform, mode, homeDir: homedir() });
  const installRoot = String(process.env.HAPPIER_SELF_HOST_INSTALL_ROOT ?? defaults.installRoot).trim();
  const binDir = String(process.env.HAPPIER_SELF_HOST_BIN_DIR ?? defaults.binDir).trim();
  const configDir = String(process.env.HAPPIER_SELF_HOST_CONFIG_DIR ?? defaults.configDir).trim();
  const dataDir = String(process.env.HAPPIER_SELF_HOST_DATA_DIR ?? defaults.dataDir).trim();
  const logDir = String(process.env.HAPPIER_SELF_HOST_LOG_DIR ?? defaults.logDir).trim();
  const serviceName = String(process.env.HAPPIER_SELF_HOST_SERVICE_NAME ?? DEFAULTS.serviceName).trim();
  const serverHost = String(process.env.HAPPIER_SERVER_HOST ?? DEFAULTS.serverHost).trim();
  const serverPort = parsePort(process.env.HAPPIER_SERVER_PORT, DEFAULTS.serverPort);
  const githubRepo = String(process.env.HAPPIER_GITHUB_REPO ?? DEFAULTS.githubRepo).trim();
  const autoUpdate = resolveSelfHostAutoUpdateDefault(process.env);
  const autoUpdateIntervalMinutes = resolveSelfHostAutoUpdateIntervalMinutes(process.env);
  const serverBinaryName = platform === 'win32' ? 'happier-server.exe' : 'happier-server';
  const uiWebRootDir = join(installRoot, 'ui-web');

  return {
    channel,
    mode,
    platform,
    installRoot,
    versionsDir: join(installRoot, 'versions'),
    installBinDir: join(installRoot, 'bin'),
    serverBinaryName,
    serverBinaryPath: join(installRoot, 'bin', serverBinaryName),
    serverPreviousBinaryPath: join(installRoot, 'bin', `${serverBinaryName}.previous`),
    statePath: join(installRoot, 'self-host-state.json'),
    binDir,
    configDir,
    configEnvPath: join(configDir, 'server.env'),
    dataDir,
    filesDir: join(dataDir, 'files'),
    dbDir: join(dataDir, 'pglite'),
    logDir,
    serverStdoutLogPath: join(logDir, 'server.out.log'),
    serverStderrLogPath: join(logDir, 'server.err.log'),
    serviceName,
    serverHost,
    serverPort,
    githubRepo,
    autoUpdate,
    autoUpdateIntervalMinutes,
    uiWebProduct: DEFAULTS.uiWebProduct,
    uiWebOs: DEFAULTS.uiWebOs,
    uiWebArch: DEFAULTS.uiWebArch,
    uiWebRootDir,
    uiWebVersionsDir: join(uiWebRootDir, 'versions'),
    uiWebCurrentDir: join(uiWebRootDir, 'current'),
  };
}

export function renderServerEnvFile({
  port,
  host,
  dataDir,
  filesDir,
  dbDir,
  uiDir,
  serverBinDir = '',
  arch = process.arch,
  platform = process.platform,
}) {
  const normalizedDataDir = String(dataDir ?? '').replace(/\/+$/, '') || String(dataDir ?? '');
  const p = String(platform ?? '').trim() || process.platform;
  const a = String(arch ?? '').trim() || process.arch;
  const hasBunRuntime = typeof globalThis.Bun !== 'undefined';
  // NOTE: Bun's native sqlite module (`bun:sqlite`) can hang when used inside launchd-managed binaries on macOS.
  // We pre-apply migrations at install time in the self-host installer on that path instead.
  const autoMigrateSqlite = p === 'darwin' && hasBunRuntime ? '0' : '1';
  const migrationsDir =
    p === 'win32'
      ? win32Path.join(String(dataDir ?? ''), 'migrations', 'sqlite')
      : `${normalizedDataDir}/migrations/sqlite`;
  const dbPath =
    p === 'win32'
      ? win32Path.join(String(dataDir ?? ''), 'happier-server-light.sqlite')
      : `${normalizedDataDir}/happier-server-light.sqlite`;
  const databaseUrl =
    p === 'win32'
      ? (() => {
          const normalized = String(dbPath).replaceAll('\\', '/');
          if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`;
          if (normalized.startsWith('//')) return `file:${normalized}`;
          return `file:///${normalized}`;
        })()
      : `file:${dbPath}`;
  const uiDirRaw = typeof uiDir === 'string' && uiDir.trim() ? uiDir.trim() : '';
  const serverBinDirRaw = typeof serverBinDir === 'string' && serverBinDir.trim() ? serverBinDir.trim() : '';
  const prismaEngineCandidate = serverBinDirRaw && p === 'darwin' && a === 'arm64'
    ? join(serverBinDirRaw, 'generated', 'sqlite-client', 'libquery_engine-darwin-arm64.dylib.node')
    : serverBinDirRaw && p === 'linux' && a === 'arm64'
      ? join(serverBinDirRaw, 'generated', 'sqlite-client', 'libquery_engine-linux-arm64-openssl-1.1.x.so.node')
      : '';
  const prismaEnginePath = prismaEngineCandidate && existsSync(prismaEngineCandidate) ? prismaEngineCandidate : '';
  return [
    `PORT=${port}`,
    `HAPPIER_SERVER_HOST=${host}`,
    ...(uiDirRaw ? [`HAPPIER_SERVER_UI_DIR=${uiDirRaw}`] : []),
    'METRICS_ENABLED=false',
    // Bun-compiled server binaries currently exhibit unstable pglite path resolution in systemd environments.
    'HAPPIER_DB_PROVIDER=sqlite',
    `DATABASE_URL=${databaseUrl}`,
    'HAPPIER_FILES_BACKEND=local',
    ...(prismaEnginePath
      ? [
          'PRISMA_CLIENT_ENGINE_TYPE=library',
          `PRISMA_QUERY_ENGINE_LIBRARY=${prismaEnginePath}`,
        ]
      : []),
    `HAPPIER_SQLITE_AUTO_MIGRATE=${autoMigrateSqlite}`,
    `HAPPIER_SQLITE_MIGRATIONS_DIR=${migrationsDir}`,
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
    `HAPPIER_SERVER_LIGHT_FILES_DIR=${filesDir}`,
    `HAPPIER_SERVER_LIGHT_DB_DIR=${dbDir}`,
    '',
  ].join('\n');
}

function parseEnvText(raw) {
  const env = {};
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1);
    if (!k) continue;
    env[k] = v;
  }
  return env;
}

function listEnvKeysInOrder(raw) {
  const keys = [];
  const seen = new Set();
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  return keys;
}

export function mergeEnvTextWithDefaults(existingText, defaultsText) {
  const existingRaw = String(existingText ?? '');
  const defaultsRaw = String(defaultsText ?? '');
  if (!existingRaw.trim()) return defaultsRaw.endsWith('\n') ? defaultsRaw : `${defaultsRaw}\n`;

  const existingEnv = parseEnvText(existingRaw);
  const defaultsEnv = parseEnvText(defaultsRaw);
  const defaultKeys = listEnvKeysInOrder(defaultsRaw);
  const existingKeys = listEnvKeysInOrder(existingRaw);

  const lines = [];
  for (const key of defaultKeys) {
    const fromExisting = Object.prototype.hasOwnProperty.call(existingEnv, key) ? existingEnv[key] : null;
    const v = fromExisting != null ? fromExisting : defaultsEnv[key];
    if (v == null) continue;
    lines.push(`${key}=${v}`);
  }
  for (const key of existingKeys) {
    if (Object.prototype.hasOwnProperty.call(defaultsEnv, key)) continue;
    if (!Object.prototype.hasOwnProperty.call(existingEnv, key)) continue;
    lines.push(`${key}=${existingEnv[key]}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function identity(s) {
  return String(s ?? '');
}

function formatTriState(value, { yes, no, unknown }) {
  if (value == null) return unknown('unknown');
  return value ? yes('yes') : no('no');
}

function formatHealth(value, { ok, warn }) {
  return value ? ok('ok') : warn('failed');
}

function formatJobState(value, { yes, no, unknown }) {
  if (value == null) return unknown('unknown');
  return value ? yes('enabled') : no('disabled');
}

function formatJobActive(value, { yes, no, unknown }) {
  if (value == null) return unknown('unknown');
  return value ? yes('active') : no('inactive');
}

export function renderSelfHostStatusText(report, { colors = true } = {}) {
  const fmt = colors
    ? {
        label: cyan,
        yes: green,
        no: yellow,
        ok: green,
        warn: yellow,
        unknown: dim,
        dim,
      }
    : {
        label: identity,
        yes: identity,
        no: identity,
        ok: identity,
        warn: identity,
        unknown: identity,
        dim: identity,
      };

  const channel = String(report?.channel ?? '').trim();
  const mode = String(report?.mode ?? '').trim();
  const serviceName = String(report?.serviceName ?? '').trim();
  const serverUrl = String(report?.serverUrl ?? '').trim();
  const healthy = Boolean(report?.healthy);
  const updatedAt = report?.updatedAt ? String(report.updatedAt) : '';

  const serviceActive = report?.service?.active ?? null;
  const serviceEnabled = report?.service?.enabled ?? null;

  const serverVersion = report?.versions?.server ? String(report.versions.server) : '';
  const uiWebVersion = report?.versions?.uiWeb ? String(report.versions.uiWeb) : '';

  const autoConfiguredEnabled = Boolean(report?.autoUpdate?.configured?.enabled);
  const autoConfiguredInterval = report?.autoUpdate?.configured?.intervalMinutes ?? null;
  const updaterEnabled = report?.autoUpdate?.job?.enabled ?? null;
  const updaterActive = report?.autoUpdate?.job?.active ?? null;

  const configuredLine = autoConfiguredEnabled
    ? `configured enabled${autoConfiguredInterval ? ` (every ${autoConfiguredInterval}m)` : ''}`
    : 'configured disabled';

  const jobLine =
    updaterEnabled == null && updaterActive == null
      ? 'job unknown'
      : `job ${formatJobState(updaterEnabled, fmt)}, ${formatJobActive(updaterActive, fmt)}`;

  return [
    channel ? `${fmt.label('channel')}: ${channel}` : null,
    mode ? `${fmt.label('mode')}: ${mode}` : null,
    serviceName ? `${fmt.label('service')}: ${serviceName}` : null,
    serverUrl ? `${fmt.label('url')}: ${serverUrl}` : null,
    `${fmt.label('health')}: ${formatHealth(healthy, fmt)}`,
    `${fmt.label('active')}: ${formatTriState(serviceActive, fmt)}`,
    `${fmt.label('enabled')}: ${formatTriState(serviceEnabled, fmt)}`,
    `${fmt.label('auto-update')}: ${configuredLine}; ${jobLine}`,
    `${fmt.label('server')}: ${serverVersion || fmt.unknown('unknown')}`,
    `${fmt.label('ui-web')}: ${uiWebVersion || fmt.unknown('unknown')}`,
    updatedAt ? `${fmt.label('updated')}: ${updatedAt}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderServerServiceUnit({ serviceName, binaryPath, envFilePath, workingDirectory, logPath }) {
  return [
    '[Unit]',
    `Description=${serviceName}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `EnvironmentFile=${envFilePath}`,
    `WorkingDirectory=${workingDirectory}`,
    `ExecStart=${binaryPath}`,
    'Restart=on-failure',
    'RestartSec=5',
    'LimitNOFILE=65535',
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export function buildSelfHostDoctorChecks(config, { state, commandExists: commandExistsOverride, pathExists } = {}) {
  const cfg = config ?? {};
  const platform = String(cfg.platform ?? process.platform).trim() || process.platform;
  const mode = String(cfg.mode ?? 'user').trim() || 'user';
  const os = normalizeOs(platform);

  const commandExistsFn = typeof commandExistsOverride === 'function' ? commandExistsOverride : commandExists;
  const pathExistsFn = typeof pathExists === 'function'
    ? pathExists
    : (p) => existsSync(String(p ?? ''));
  const stateObj = state ?? {};

  const uiExpected = Boolean(stateObj?.uiWeb?.installed);
  const uiIndexPath = cfg.uiWebCurrentDir ? join(String(cfg.uiWebCurrentDir), 'index.html') : '';

  return [
    { name: 'platform', ok: ['linux', 'darwin', 'windows'].includes(os) },
    { name: 'mode', ok: mode === 'user' || (mode === 'system' && platform !== 'win32') },
    // We verify minisign signatures using the bundled public key + node:crypto, so no external `minisign` dependency.
    { name: 'tar', ok: commandExistsFn('tar') },
    { name: 'powershell', ok: os === 'windows' ? commandExistsFn('powershell') : true },
    { name: 'systemctl', ok: os === 'linux' ? commandExistsFn('systemctl') : true },
    { name: 'launchctl', ok: os === 'darwin' ? commandExistsFn('launchctl') : true },
    { name: 'schtasks', ok: os === 'windows' ? commandExistsFn('schtasks') : true },
    { name: 'server-binary', ok: cfg.serverBinaryPath ? pathExistsFn(cfg.serverBinaryPath) : false },
    { name: 'server-env', ok: cfg.configEnvPath ? pathExistsFn(cfg.configEnvPath) : false },
    ...(uiExpected
      ? [{ name: 'ui-web', ok: uiIndexPath ? pathExistsFn(uiIndexPath) : false }]
      : []),
  ];
}

export function renderUpdaterSystemdUnit({
  updaterLabel,
  hstackPath,
  channel,
  mode,
  workingDirectory,
  stdoutPath,
  stderrPath,
  wantedBy,
} = {}) {
  const label = String(updaterLabel ?? '').trim() || 'happier-self-host-updater';
  const hstack = String(hstackPath ?? '').trim();
  if (!hstack) throw new Error('[self-host] missing hstackPath for updater unit');
  const ch = String(channel ?? '').trim() || 'stable';
  const m = String(mode ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
  const wd = String(workingDirectory ?? '').trim();
  const out = String(stdoutPath ?? '').trim();
  const err = String(stderrPath ?? '').trim();
  const wb = String(wantedBy ?? '').trim() || 'default.target';

  return renderSystemdServiceUnit({
    description: `${label} (auto-update)`,
    execStart: [
      hstack,
      'self-host',
      'update',
      `--channel=${ch}`,
      `--mode=${m}`,
      '--non-interactive',
    ],
    workingDirectory: wd,
    env: {},
    restart: 'no',
    stdoutPath: out,
    stderrPath: err,
    wantedBy: wb,
  });
}

export function renderUpdaterSystemdTimerUnit({ updaterLabel, intervalMinutes = 1440 } = {}) {
  const label = String(updaterLabel ?? '').trim() || 'happier-self-host-updater';
  const minutesRaw = Number(intervalMinutes);
  const minutes = Number.isFinite(minutesRaw) ? Math.max(15, Math.floor(minutesRaw)) : 1440;
  return [
    '[Unit]',
    `Description=${label} (auto-update timer)`,
    '',
    '[Timer]',
    'OnBootSec=5m',
    `OnUnitActiveSec=${minutes}m`,
    `Unit=${label}.service`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

export function renderUpdaterLaunchdPlistXml({
  updaterLabel,
  hstackPath,
  channel,
  mode,
  intervalMinutes,
  workingDirectory,
  stdoutPath,
  stderrPath,
} = {}) {
  const label = String(updaterLabel ?? '').trim() || 'happier-self-host-updater';
  const hstack = String(hstackPath ?? '').trim();
  if (!hstack) throw new Error('[self-host] missing hstackPath for updater launchd plist');
  const ch = String(channel ?? '').trim() || 'stable';
  const m = String(mode ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
  const wd = String(workingDirectory ?? '').trim();
  const out = String(stdoutPath ?? '').trim();
  const err = String(stderrPath ?? '').trim();
  const intervalRaw = Number(intervalMinutes);
  const startIntervalSec = Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.max(15, Math.floor(intervalRaw)) * 60 : 0;

  return buildLaunchdPlistXml({
    label,
    programArgs: [
      hstack,
      'self-host',
      'update',
      `--channel=${ch}`,
      `--mode=${m}`,
      '--non-interactive',
    ],
    env: {
      PATH: buildLaunchdPath({ execPath: process.execPath, basePath: process.env.PATH }),
    },
    stdoutPath: out,
    stderrPath: err,
    workingDirectory: wd,
    keepAliveOnFailure: false,
    startIntervalSec: startIntervalSec || undefined,
  });
}

export function renderUpdaterScheduledTaskWrapperPs1({
  updaterLabel,
  hstackPath,
  channel,
  mode,
  workingDirectory,
  stdoutPath,
  stderrPath,
} = {}) {
  const label = String(updaterLabel ?? '').trim() || 'happier-self-host-updater';
  const hstack = String(hstackPath ?? '').trim();
  if (!hstack) throw new Error('[self-host] missing hstackPath for updater scheduled task wrapper');
  const ch = String(channel ?? '').trim() || 'stable';
  const m = String(mode ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
  const wd = String(workingDirectory ?? '').trim();
  const out = String(stdoutPath ?? '').trim();
  const err = String(stderrPath ?? '').trim();

  return renderWindowsScheduledTaskWrapperPs1({
    workingDirectory: wd,
    programArgs: [
      hstack,
      'self-host',
      'update',
      `--channel=${ch}`,
      `--mode=${m}`,
      '--non-interactive',
    ],
    env: {},
    stdoutPath: out,
    stderrPath: err,
  });
}

function resolveAutoUpdateEnabled(argv, fallback) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  if (args.includes('--no-auto-update')) return false;
  if (args.includes('--auto-update')) return true;
  return Boolean(fallback);
}

function resolveAutoUpdateIntervalMinutes(argv, fallback) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const findEq = args.find((a) => a.startsWith('--auto-update-interval='));
  const value = findEq
    ? findEq.slice('--auto-update-interval='.length)
    : (() => {
        const idx = args.indexOf('--auto-update-interval');
        if (idx >= 0 && args[idx + 1] && !String(args[idx + 1]).startsWith('-')) return String(args[idx + 1]);
        return '';
      })();
  const raw = String(value ?? '').trim();
  if (!raw) return Number(fallback) || DEFAULTS.autoUpdateIntervalMinutes;
  const parsed = Number(raw);
  const minutes = Number.isFinite(parsed) ? Math.floor(parsed) : NaN;
  if (!Number.isFinite(minutes) || minutes < 15) return Number(fallback) || DEFAULTS.autoUpdateIntervalMinutes;
  return Math.min(minutes, 60 * 24 * 7);
}

function resolveUpdaterLabel(config) {
  const override = String(process.env.HAPPIER_SELF_HOST_UPDATER_LABEL ?? '').trim();
  if (override) return override;
  const base = String(config?.serviceName ?? '').trim() || 'happier-server';
  return `${base}-updater`;
}

function resolveHstackPathForUpdater(config) {
  const override = String(process.env.HAPPIER_SELF_HOST_HSTACK_PATH ?? '').trim();
  if (override) return override;
  const platform = String(config?.platform ?? '').trim() || process.platform;
  const exe = platform === 'win32' ? 'hstack.exe' : 'hstack';
  return join(String(config?.binDir ?? '').trim() || '', exe);
}

async function installAutoUpdateJob({ config, enabled, intervalMinutes }) {
  if (!enabled) return { installed: false, reason: 'disabled' };
  const updaterLabel = resolveUpdaterLabel(config);
  const hstackPath = resolveHstackPathForUpdater(config);
  const stdoutPath = join(config.logDir, 'updater.out.log');
  const stderrPath = join(config.logDir, 'updater.err.log');
  const backend = resolveServiceBackend({ platform: config.platform, mode: config.mode });
  const interval = resolveAutoUpdateIntervalMinutes([], intervalMinutes ?? config.autoUpdateIntervalMinutes);

  const baseSpec = {
    label: updaterLabel,
    description: `Happier Self-Host (${updaterLabel})`,
    programArgs: [hstackPath],
    workingDirectory: config.installRoot,
    env: {},
    stdoutPath,
    stderrPath,
  };
  const definitionPath = buildServiceDefinition({ backend, homeDir: homedir(), spec: baseSpec }).path;
  const wantedBy =
    backend === 'systemd-system' ? 'multi-user.target' : backend === 'systemd-user' ? 'default.target' : '';

  if (backend === 'systemd-system' || backend === 'systemd-user') {
    const timerPath = definitionPath.replace(/\.service$/, '.timer');
    const serviceContents = renderUpdaterSystemdUnit({
      updaterLabel,
      hstackPath,
      channel: config.channel,
      mode: config.mode,
      workingDirectory: config.installRoot,
      stdoutPath,
      stderrPath,
      wantedBy,
    });
    const timerContents = renderUpdaterSystemdTimerUnit({ updaterLabel, intervalMinutes: interval });
    const prefix = backend === 'systemd-user' ? ['--user'] : [];
    const plan = {
      writes: [
        { path: definitionPath, contents: serviceContents, mode: 0o644 },
        { path: timerPath, contents: timerContents, mode: 0o644 },
      ],
      commands: [
        { cmd: 'systemctl', args: [...prefix, 'daemon-reload'] },
        { cmd: 'systemctl', args: [...prefix, 'enable', '--now', `${updaterLabel}.timer`] },
        { cmd: 'systemctl', args: [...prefix, 'start', `${updaterLabel}.service`], allowFail: true },
      ],
    };
    await applyServicePlan(plan);
    return { installed: true, backend, label: updaterLabel, definitionPath, timerPath, intervalMinutes: interval };
  }

  if (backend === 'launchd-system' || backend === 'launchd-user') {
    const definitionContents = renderUpdaterLaunchdPlistXml({
      updaterLabel,
      hstackPath,
      channel: config.channel,
      mode: config.mode,
      intervalMinutes: interval,
      workingDirectory: config.installRoot,
      stdoutPath,
      stderrPath,
    });
    const plan = planServiceAction({
      backend,
      action: 'install',
      label: updaterLabel,
      definitionPath,
      definitionContents,
      persistent: true,
    });
    await applyServicePlan(plan);
    return { installed: true, backend, label: updaterLabel, definitionPath, intervalMinutes: interval };
  }

  const definitionContents = renderUpdaterScheduledTaskWrapperPs1({
    updaterLabel,
    hstackPath,
    channel: config.channel,
    mode: config.mode,
    workingDirectory: config.installRoot,
    stdoutPath,
    stderrPath,
  });
  const name = `Happier\\${updaterLabel}`;
  const ps = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${definitionPath}"`;
  const args = [
    '/Create',
    '/F',
    '/SC',
    'MINUTE',
    '/MO',
    String(interval),
    '/ST',
    '00:00',
    '/TN',
    name,
    '/TR',
    ps,
    ...(backend === 'schtasks-system' ? ['/RU', 'SYSTEM', '/RL', 'HIGHEST'] : []),
  ];
  const plan = {
    writes: [{ path: definitionPath, contents: definitionContents, mode: 0o644 }],
    commands: [
      { cmd: 'schtasks', args },
      { cmd: 'schtasks', args: ['/Run', '/TN', name] },
    ],
  };
  await applyServicePlan(plan);
  return { installed: true, backend, label: updaterLabel, definitionPath, taskName: name, intervalMinutes: interval };
}

async function uninstallAutoUpdateJob({ config }) {
  const updaterLabel = resolveUpdaterLabel(config);
  const hstackPath = resolveHstackPathForUpdater(config);
  const stdoutPath = join(config.logDir, 'updater.out.log');
  const stderrPath = join(config.logDir, 'updater.err.log');
  const backend = resolveServiceBackend({ platform: config.platform, mode: config.mode });
  const baseSpec = {
    label: updaterLabel,
    description: `Happier Self-Host (${updaterLabel})`,
    programArgs: [hstackPath],
    workingDirectory: config.installRoot,
    env: {},
    stdoutPath,
    stderrPath,
  };
  const definitionPath = buildServiceDefinition({ backend, homeDir: homedir(), spec: baseSpec }).path;

  if (backend === 'systemd-system' || backend === 'systemd-user') {
    const prefix = backend === 'systemd-user' ? ['--user'] : [];
    const timerPath = definitionPath.replace(/\.service$/, '.timer');
    const plan = {
      writes: [],
      commands: [
        { cmd: 'systemctl', args: [...prefix, 'disable', '--now', `${updaterLabel}.timer`], allowFail: true },
        { cmd: 'systemctl', args: [...prefix, 'disable', '--now', `${updaterLabel}.service`], allowFail: true },
        { cmd: 'systemctl', args: [...prefix, 'daemon-reload'] },
      ],
    };
    await applyServicePlan(plan);
    await rm(timerPath, { force: true }).catch(() => {});
    await rm(definitionPath, { force: true }).catch(() => {});
    return { uninstalled: true, backend, label: updaterLabel };
  }

  if (backend === 'launchd-system' || backend === 'launchd-user') {
    const plan = planServiceAction({
      backend,
      action: 'uninstall',
      label: updaterLabel,
      definitionPath,
      persistent: true,
    });
    await applyServicePlan(plan);
    await rm(definitionPath, { force: true }).catch(() => {});
    return { uninstalled: true, backend, label: updaterLabel };
  }

  const name = `Happier\\${updaterLabel}`;
  const plan = {
    writes: [],
    commands: [
      { cmd: 'schtasks', args: ['/End', '/TN', name], allowFail: true },
      { cmd: 'schtasks', args: ['/Delete', '/F', '/TN', name], allowFail: true },
    ],
  };
  await applyServicePlan(plan);
  await rm(definitionPath, { force: true }).catch(() => {});
  return { uninstalled: true, backend, label: updaterLabel };
}

async function restartAndCheckHealth({ config, serviceSpec }) {
  await restartManagedService({ platform: config.platform, mode: config.mode, spec: serviceSpec }).catch(() => {});
  const timeoutMs = resolveSelfHostHealthTimeoutMs();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await checkHealth({ port: config.serverPort });
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

async function checkHealth({ port }) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/version`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => ({}));
    return payload?.ok === true;
  } catch {
    return false;
  }
}

export function resolveMinisignPublicKeyText(env = process.env) {
  const inline = String(env?.HAPPIER_MINISIGN_PUBKEY ?? '').trim();
  return inline || DEFAULT_MINISIGN_PUBLIC_KEY;
}

async function installBinaryAtomically({ sourceBinaryPath, targetBinaryPath, previousBinaryPath, versionedTargetPath }) {
  await mkdir(dirname(targetBinaryPath), { recursive: true });
  await mkdir(dirname(versionedTargetPath), { recursive: true });
  const stagedPath = `${targetBinaryPath}.new`;
  await copyFile(sourceBinaryPath, stagedPath);
  await chmod(stagedPath, 0o755).catch(() => {});
  if (existsSync(targetBinaryPath)) {
    await copyFile(targetBinaryPath, previousBinaryPath);
    await chmod(previousBinaryPath, 0o755).catch(() => {});
  }
  await copyFile(stagedPath, versionedTargetPath);
  await chmod(versionedTargetPath, 0o755).catch(() => {});
  await rm(stagedPath, { force: true });
  await copyFile(versionedTargetPath, targetBinaryPath);
  await chmod(targetBinaryPath, 0o755).catch(() => {});
}

async function syncSelfHostSqliteMigrations({ artifactRootDir, targetDir }) {
  const root = String(artifactRootDir ?? '').trim();
  const dest = String(targetDir ?? '').trim();
  if (!root || !dest) return { copied: false, reason: 'missing-paths' };

  const source = join(root, 'prisma', 'sqlite', 'migrations');
  if (!existsSync(source)) return { copied: false, reason: 'missing-source' };

  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true });
  return { copied: true, reason: 'ok' };
}

async function syncSelfHostGeneratedClients({ artifactRootDir, targetDir }) {
  const root = String(artifactRootDir ?? '').trim();
  const dest = String(targetDir ?? '').trim();
  if (!root || !dest) return { copied: false, reason: 'missing-paths' };

  const source = join(root, 'generated');
  if (!existsSync(source)) return { copied: false, reason: 'missing-source' };

  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true });
  return { copied: true, reason: 'ok' };
}

async function installFromRelease({ product, binaryName, config, explicitBinaryPath = '' }) {
  if (explicitBinaryPath) {
    const srcPath = explicitBinaryPath;
    if (!existsSync(srcPath)) {
      throw new Error(`[self-host] missing --server-binary path: ${srcPath}`);
    }
    const version = `local-${Date.now()}`;
    await installBinaryAtomically({
      sourceBinaryPath: srcPath,
      targetBinaryPath: config.serverBinaryPath,
      previousBinaryPath: config.serverPreviousBinaryPath,
      versionedTargetPath: join(config.versionsDir, `${binaryName}-${version}`),
    });
    await syncSelfHostSqliteMigrations({
      artifactRootDir: dirname(srcPath),
      targetDir: join(config.dataDir, 'migrations', 'sqlite'),
    }).catch(() => {});
    const generated = await syncSelfHostGeneratedClients({
      artifactRootDir: dirname(srcPath),
      targetDir: join(dirname(config.serverBinaryPath), 'generated'),
    });
    if (!generated.copied) {
      throw new Error('[self-host] server runtime is missing packaged generated clients');
    }
    return { version, source: 'local' };
  }

  const channelTag = config.channel === 'preview' ? 'server-preview' : 'server-stable';
  const release = await fetchGitHubReleaseByTag({
    githubRepo: config.githubRepo,
    tag: channelTag,
    userAgent: 'happier-self-host-installer',
    githubToken: String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''),
  });
  const os = normalizeOs(config.platform);
  const resolved = resolveReleaseAssetBundle({
    assets: release?.assets,
    product,
    os,
    arch: normalizeArch(),
  });

  const tempDir = await mkdtemp(join(tmpdir(), 'happier-self-host-release-'));
  try {
    const pubkeyFile = resolveMinisignPublicKeyText(process.env);
    const downloaded = await downloadVerifiedReleaseAssetBundle({
      bundle: resolved,
      destDir: tempDir,
      pubkeyFile,
      userAgent: 'happier-self-host-installer',
    });

    const extractDir = join(tempDir, 'extract');
    await mkdir(extractDir, { recursive: true });
    const plan = planArchiveExtraction({
      archiveName: downloaded.archiveName,
      archivePath: downloaded.archivePath,
      destDir: extractDir,
      os,
    });
    if (!commandExists(plan.requiredCommand)) {
      throw new Error(`[self-host] ${plan.requiredCommand} is required to extract release artifacts`);
    }
    runCommand(plan.command.cmd, plan.command.args, { stdio: 'ignore' });
    const extractedBinary = await findExecutableByName(extractDir, binaryName);
    if (!extractedBinary) {
      throw new Error('[self-host] failed to locate extracted server binary');
    }

    const version = resolved.version || String(release?.tag_name ?? '').replace(/^server-v/, '') || `${Date.now()}`;
    await installBinaryAtomically({
      sourceBinaryPath: extractedBinary,
      targetBinaryPath: config.serverBinaryPath,
      previousBinaryPath: config.serverPreviousBinaryPath,
      versionedTargetPath: join(config.versionsDir, `${binaryName}-${version}`),
    });
    const roots = await readdir(extractDir).catch(() => []);
    const artifactRootDir = roots.length > 0 ? join(extractDir, roots[0]) : extractDir;
    await syncSelfHostSqliteMigrations({
      artifactRootDir,
      targetDir: join(config.dataDir, 'migrations', 'sqlite'),
    }).catch(() => {});
    const generated = await syncSelfHostGeneratedClients({
      artifactRootDir,
      targetDir: join(dirname(config.serverBinaryPath), 'generated'),
    });
    if (!generated.copied) {
      throw new Error('[self-host] server runtime is missing packaged generated clients');
    }
    return { version, source: asset.archiveUrl };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function assertUiWebBundleIsValid(rootDir) {
  const indexPath = join(rootDir, 'index.html');
  const info = await stat(indexPath).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`[self-host] UI web bundle is missing index.html: ${indexPath}`);
  }
}

async function installUiWebFromRelease({ config }) {
  const tags = config.channel === 'preview'
    ? ['ui-web-preview', 'ui-web-stable']
    : ['ui-web-stable'];

  const resolvedRelease = await fetchFirstGitHubReleaseByTags({
    githubRepo: config.githubRepo,
    tags,
    userAgent: 'happier-self-host-installer',
    githubToken: String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''),
  }).catch((e) => {
    const status = Number(e?.status);
    if (status === 404) return null;
    throw e;
  });

  if (!resolvedRelease) {
    return {
      installed: false,
      version: null,
      source: null,
      reason: `ui web release tag not found (${tags.join(', ')})`,
    };
  }
  const { release, tag: channelTag } = resolvedRelease;

  const resolved = resolveReleaseAssetBundle({
    assets: release?.assets,
    product: config.uiWebProduct,
    os: config.uiWebOs,
    arch: config.uiWebArch,
  });

  const tempDir = await mkdtemp(join(tmpdir(), 'happier-self-host-ui-web-'));
  try {
    const pubkeyFile = resolveMinisignPublicKeyText(process.env);
    const downloaded = await downloadVerifiedReleaseAssetBundle({
      bundle: resolved,
      destDir: tempDir,
      pubkeyFile,
      userAgent: 'happier-self-host-installer',
    });

    const extractDir = join(tempDir, 'extract');
    await mkdir(extractDir, { recursive: true });
    const plan = planArchiveExtraction({
      archiveName: downloaded.archiveName,
      archivePath: downloaded.archivePath,
      destDir: extractDir,
      os: normalizeOs(config.platform),
    });
    if (!commandExists(plan.requiredCommand)) {
      throw new Error(`[self-host] ${plan.requiredCommand} is required to extract ui web bundle artifacts`);
    }
    runCommand(plan.command.cmd, plan.command.args, { stdio: 'ignore' });

    const roots = await readdir(extractDir).catch(() => []);
    if (roots.length === 0) {
      throw new Error('[self-host] extracted ui web bundle is empty');
    }
    const artifactRootDir = join(extractDir, roots[0]);
    await assertUiWebBundleIsValid(artifactRootDir);

    const version = resolved.version || String(release?.tag_name ?? '').replace(/^ui-web-v/, '') || `${Date.now()}`;
    const versionedTargetDir = join(config.uiWebVersionsDir, `${config.uiWebProduct}-${version}`);
    await rm(versionedTargetDir, { recursive: true, force: true });
    await mkdir(dirname(versionedTargetDir), { recursive: true });
    await cp(artifactRootDir, versionedTargetDir, { recursive: true });

    await rm(config.uiWebCurrentDir, { recursive: true, force: true }).catch(() => {});
    await symlink(versionedTargetDir, config.uiWebCurrentDir, config.platform === 'win32' ? 'junction' : 'dir').catch(async () => {
      await cp(versionedTargetDir, config.uiWebCurrentDir, { recursive: true });
    });

    return { installed: true, version, source: downloaded.source.archiveUrl, tag: channelTag };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeSelfHostState(config, statePatch) {
  const existing = existsSync(config.statePath)
    ? JSON.parse(await readFile(config.statePath, 'utf-8').catch(() => '{}'))
    : {};
  const next = {
    ...existing,
    ...statePatch,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(config.statePath), { recursive: true });
  await writeFile(config.statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}

async function maybeInstallCompanionCli({ channel, nonInteractive, withCli }) {
  if (!withCli) return { installed: false, reason: 'disabled' };
  if (commandExists('happier')) {
    return { installed: false, reason: 'already-installed' };
  }
  if (!commandExists('curl') || !commandExists('bash')) {
    return { installed: false, reason: 'missing-curl-or-bash' };
  }
  const result = runCommand(
    'bash',
    ['-lc', 'curl -fsSL https://happier.dev/install | bash'],
    {
      allowFail: true,
      env: {
        ...process.env,
        HAPPIER_CHANNEL: channel,
        HAPPIER_NONINTERACTIVE: nonInteractive ? '1' : '0',
      },
      stdio: 'inherit',
    }
  );
  return {
    installed: (result.status ?? 1) === 0,
    reason: (result.status ?? 1) === 0 ? 'installed' : 'installer-failed',
  };
}

function buildSelfHostServerServiceSpec({ config, envText }) {
  return {
    label: config.serviceName,
    description: `Happier Self-Host (${config.serviceName})`,
    programArgs: [config.serverBinaryPath],
    workingDirectory: config.installRoot,
    env: parseEnvText(envText),
    stdoutPath: config.serverStdoutLogPath,
    stderrPath: config.serverStderrLogPath,
  };
}

async function cmdInstall({ channel, mode, argv, json }) {
  if (mode === 'system' && process.platform !== 'win32') {
    assertRoot();
  }
  const config = resolveConfig({ channel, mode, platform: process.platform });
  const autoUpdateEnabled = resolveAutoUpdateEnabled(argv, config.autoUpdate);
  const autoUpdateIntervalMinutes = resolveAutoUpdateIntervalMinutes(argv, config.autoUpdateIntervalMinutes);
  const withoutCli = argv.includes('--without-cli') || parseBoolean(process.env.HAPPIER_WITH_CLI, true) === false;
  const withUi =
    !(argv.includes('--without-ui')
      || parseBoolean(process.env.HAPPIER_WITH_UI, true) === false
      || parseBoolean(process.env.HAPPIER_SELF_HOST_WITH_UI, true) === false);
  const nonInteractive = argv.includes('--non-interactive') || parseBoolean(process.env.HAPPIER_NONINTERACTIVE, false);
  const serverBinaryOverride = String(process.env.HAPPIER_SELF_HOST_SERVER_BINARY ?? '').trim();

  if (normalizeOs(config.platform) !== 'windows' && !commandExists('tar')) {
    throw new Error('[self-host] tar is required to extract release artifacts');
  }
  if (normalizeOs(config.platform) === 'windows' && !commandExists('powershell')) {
    throw new Error('[self-host] powershell is required on Windows');
  }
  if (withUi && !commandExists('tar')) {
    throw new Error('[self-host] tar is required to extract ui web bundle artifacts');
  }
  if (normalizeOs(config.platform) === 'linux' && !commandExists('systemctl')) {
    throw new Error('[self-host] systemctl is required on Linux');
  }
  if (autoUpdateEnabled && normalizeOs(config.platform) === 'darwin' && !commandExists('launchctl')) {
    throw new Error('[self-host] launchctl is required on macOS for auto-update scheduling');
  }
  if (autoUpdateEnabled && normalizeOs(config.platform) === 'windows' && !commandExists('schtasks')) {
    throw new Error('[self-host] schtasks is required on Windows for auto-update scheduling');
  }

  await mkdir(config.installRoot, { recursive: true });
  await mkdir(config.installBinDir, { recursive: true });
  await mkdir(config.versionsDir, { recursive: true });
  await mkdir(config.configDir, { recursive: true });
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.filesDir, { recursive: true });
  await mkdir(config.dbDir, { recursive: true });
  await mkdir(config.logDir, { recursive: true });
  await mkdir(config.uiWebRootDir, { recursive: true });
  await mkdir(config.uiWebVersionsDir, { recursive: true });

  const installResult = await installFromRelease({
    product: 'happier-server',
    binaryName: config.serverBinaryName,
    config,
    explicitBinaryPath: serverBinaryOverride,
  });

  const uiResult = withUi
    ? await installUiWebFromRelease({ config })
    : { installed: false, version: null, source: null, reason: 'disabled' };
  const uiInstalled = Boolean(uiResult?.installed);

  const envText = renderServerEnvFile({
    port: config.serverPort,
    host: config.serverHost,
    dataDir: config.dataDir,
    filesDir: config.filesDir,
    dbDir: config.dbDir,
    uiDir: uiInstalled ? config.uiWebCurrentDir : '',
    serverBinDir: dirname(config.serverBinaryPath),
    arch: process.arch,
    platform: config.platform,
  });
  await writeFile(config.configEnvPath, envText, 'utf-8');
  const installEnv = parseEnvText(envText);
  if (!parseBoolean(installEnv.HAPPIER_SQLITE_AUTO_MIGRATE ?? installEnv.HAPPY_SQLITE_AUTO_MIGRATE, true)) {
    await applySelfHostSqliteMigrationsAtInstallTime({ env: installEnv }).catch((e) => {
      throw new Error(`[self-host] failed to apply sqlite migrations at install time: ${String(e?.message ?? e)}`);
    });
  }

  const serverShimPath = join(config.binDir, config.serverBinaryName);
  await mkdir(config.binDir, { recursive: true });
  await rm(serverShimPath, { force: true });
  await symlink(config.serverBinaryPath, serverShimPath).catch(async () => {
    await copyFile(config.serverBinaryPath, serverShimPath);
    await chmod(serverShimPath, 0o755).catch(() => {});
  });

  const serviceSpec = buildSelfHostServerServiceSpec({ config, envText });
  await installManagedService({
    platform: config.platform,
    mode: config.mode,
    homeDir: homedir(),
    spec: serviceSpec,
    persistent: true,
  });

  const healthy = await restartAndCheckHealth({ config, serviceSpec });
  if (!healthy) {
    throw new Error('[self-host] service failed health checks after install');
  }

  const autoUpdateResult = await installAutoUpdateJob({ config, enabled: autoUpdateEnabled, intervalMinutes: autoUpdateIntervalMinutes }).catch((e) => ({
    installed: false,
    reason: String(e?.message ?? e),
  }));

  const cliResult = await maybeInstallCompanionCli({
    channel,
    nonInteractive,
    withCli: !withoutCli,
  });
  await writeSelfHostState(config, {
    channel,
    mode,
    version: installResult.version,
    source: installResult.source,
    withCli: !withoutCli,
    uiWeb: uiInstalled
      ? { installed: true, version: uiResult.version, source: uiResult.source, tag: uiResult.tag }
      : { installed: false, reason: String(uiResult?.reason ?? (withUi ? 'missing' : 'disabled')) },
    autoUpdate: { enabled: autoUpdateEnabled, intervalMinutes: autoUpdateIntervalMinutes },
  });

  printResult({
    json,
    data: {
      ok: true,
      channel,
      mode,
      version: installResult.version,
      service: config.serviceName,
      serverPort: config.serverPort,
      autoUpdate: {
        enabled: autoUpdateEnabled,
        intervalMinutes: autoUpdateIntervalMinutes,
        ...autoUpdateResult,
      },
      cli: cliResult,
    },
    text: [
      `${green('✓')} Happier Self-Host installed`,
      `- mode: ${cyan(mode)}`,
      `- service: ${cyan(config.serviceName)}`,
      `- version: ${cyan(installResult.version || 'unknown')}`,
      `- server: ${cyan(`http://127.0.0.1:${config.serverPort}`)}`,
      `- auto-update: ${autoUpdateEnabled ? (autoUpdateResult.installed ? green(`installed (every ${autoUpdateIntervalMinutes}m)`) : yellow('failed')) : dim('disabled')}`,
      `- cli: ${cliResult.installed ? green('installed') : dim(cliResult.reason)}`,
      `- ui: ${uiInstalled ? green('installed') : dim(String(uiResult?.reason ?? 'disabled'))}`,
    ].join('\n'),
  });
}

async function cmdStatus({ channel, mode, json }) {
  const config = resolveConfig({ channel, mode, platform: process.platform });
  const state = existsSync(config.statePath)
    ? JSON.parse(await readFile(config.statePath, 'utf-8').catch(() => '{}'))
    : {};

  let active = null;
  let enabled = null;
  let updaterActive = null;
  let updaterEnabled = null;
  const updaterLabel = resolveUpdaterLabel(config);
  try {
    if (config.platform === 'linux' && commandExists('systemctl')) {
      const prefix = config.mode === 'user' ? ['--user'] : [];
      const isActive = runCommand('systemctl', [...prefix, 'is-active', '--quiet', `${config.serviceName}.service`], {
        allowFail: true,
        stdio: 'ignore',
      });
      active = (isActive.status ?? 1) === 0;
      const isEnabled = runCommand('systemctl', [...prefix, 'is-enabled', '--quiet', `${config.serviceName}.service`], {
        allowFail: true,
        stdio: 'ignore',
      });
      enabled = (isEnabled.status ?? 1) === 0;

      const updaterTimerIsActive = runCommand('systemctl', [...prefix, 'is-active', '--quiet', `${updaterLabel}.timer`], {
        allowFail: true,
        stdio: 'ignore',
      });
      updaterActive = (updaterTimerIsActive.status ?? 1) === 0;
      const updaterIsEnabled = runCommand('systemctl', [...prefix, 'is-enabled', '--quiet', `${updaterLabel}.timer`], {
        allowFail: true,
        stdio: 'ignore',
      });
      updaterEnabled = (updaterIsEnabled.status ?? 1) === 0;
    } else if (config.platform === 'darwin' && commandExists('launchctl')) {
      const list = runCommand('launchctl', ['list'], { allowFail: true, stdio: 'pipe' });
      const out = String(list.stdout ?? '');
      active = out.includes(`\t${config.serviceName}`) || out.includes(` ${config.serviceName}`);
      updaterActive = out.includes(`\t${updaterLabel}`) || out.includes(` ${updaterLabel}`);
      enabled = null;
      updaterEnabled = null;
    } else if (config.platform === 'win32' && commandExists('schtasks')) {
      const query = runCommand('schtasks', ['/Query', '/TN', `Happier\\${config.serviceName}`, '/FO', 'LIST', '/V'], {
        allowFail: true,
        stdio: 'pipe',
      });
      const out = String(query.stdout ?? '');
      active = /Status:\s*Running/i.test(out) ? true : /Status:/i.test(out) ? false : null;
      enabled = /Scheduled Task State:\s*Enabled/i.test(out) ? true : /Scheduled Task State:/i.test(out) ? false : null;

      const updaterQuery = runCommand('schtasks', ['/Query', '/TN', `Happier\\${updaterLabel}`, '/FO', 'LIST', '/V'], {
        allowFail: true,
        stdio: 'pipe',
      });
      const updaterOut = String(updaterQuery.stdout ?? '');
      updaterActive = /Status:\s*Running/i.test(updaterOut) ? true : /Status:/i.test(updaterOut) ? false : null;
      updaterEnabled = /Scheduled Task State:\s*Enabled/i.test(updaterOut)
        ? true
        : /Scheduled Task State:/i.test(updaterOut)
          ? false
          : null;
    }
  } catch {
    active = null;
    enabled = null;
    updaterActive = null;
    updaterEnabled = null;
  }

  const healthy = await checkHealth({ port: config.serverPort });
  const serverVersion = state?.version ? String(state.version) : '';
  const uiWebVersion =
    state?.uiWeb?.installed === true && state?.uiWeb?.version
      ? String(state.uiWeb.version)
      : '';
  const autoUpdateState = normalizeSelfHostAutoUpdateState(state, {
    fallbackIntervalMinutes: config.autoUpdateIntervalMinutes,
  });

  const serverUrl = `http://${config.serverHost}:${config.serverPort}`;
  printResult({
    json,
    data: {
      ok: true,
      channel,
      mode,
      serverUrl,
      versions: {
        server: serverVersion || null,
        uiWeb: uiWebVersion || null,
      },
      service: {
        name: config.serviceName,
        active,
        enabled,
      },
      autoUpdate: {
        label: updaterLabel,
        active: updaterActive,
        enabled: updaterEnabled,
        configured: {
          enabled: Boolean(autoUpdateState?.enabled),
          intervalMinutes: autoUpdateState?.intervalMinutes ?? null,
        },
      },
      healthy,
      state,
    },
    text: renderSelfHostStatusText({
      channel,
      mode,
      serviceName: config.serviceName,
      serverUrl,
      healthy,
      service: { active, enabled },
      versions: { server: serverVersion || null, uiWeb: uiWebVersion || null },
      autoUpdate: {
        label: updaterLabel,
        job: { active: updaterActive, enabled: updaterEnabled },
        configured: {
          enabled: Boolean(autoUpdateState?.enabled),
          intervalMinutes: autoUpdateState?.intervalMinutes ?? null,
        },
      },
      updatedAt: state?.updatedAt ?? null,
    }),
  });
}

async function cmdUpdate({ channel, mode, json }) {
  const config = resolveConfig({ channel, mode, platform: process.platform });
  if (config.mode === 'system' && config.platform !== 'win32') {
    assertRoot();
  }
  const existingState = existsSync(config.statePath)
    ? JSON.parse(await readFile(config.statePath, 'utf-8').catch(() => '{}'))
    : {};
  const autoUpdateReconcile = decideSelfHostAutoUpdateReconcile(existingState, {
    fallbackIntervalMinutes: config.autoUpdateIntervalMinutes,
  });
  const withUi =
    parseBoolean(process.env.HAPPIER_WITH_UI, true) !== false
    && parseBoolean(process.env.HAPPIER_SELF_HOST_WITH_UI, true) !== false;
  const installResult = await installFromRelease({
    product: 'happier-server',
    binaryName: config.serverBinaryName,
    config,
  });
  const uiResult = withUi
    ? await installUiWebFromRelease({ config })
    : { installed: false, version: null, source: null, reason: 'disabled' };
  const uiInstalled = Boolean(uiResult?.installed);

  const envText = existsSync(config.configEnvPath)
    ? await readFile(config.configEnvPath, 'utf-8').catch(() => '')
    : '';
  const parsedEnv = parseEnvText(envText);
  const effectivePort = parsePort(parsedEnv.PORT, config.serverPort);
  const configWithPort = effectivePort === config.serverPort ? config : { ...config, serverPort: effectivePort };
  const defaultsEnvText = renderServerEnvFile({
    port: configWithPort.serverPort,
    host: configWithPort.serverHost,
    dataDir: configWithPort.dataDir,
    filesDir: configWithPort.filesDir,
    dbDir: configWithPort.dbDir,
    uiDir: uiInstalled ? configWithPort.uiWebCurrentDir : '',
    serverBinDir: dirname(configWithPort.serverBinaryPath),
    arch: process.arch,
    platform: configWithPort.platform,
  });
  const nextEnvText = envText ? mergeEnvTextWithDefaults(envText, defaultsEnvText) : defaultsEnvText;
  await mkdir(configWithPort.configDir, { recursive: true });
  await writeFile(configWithPort.configEnvPath, nextEnvText, 'utf-8');
  const nextEnv = parseEnvText(nextEnvText);
  if (!parseBoolean(nextEnv.HAPPIER_SQLITE_AUTO_MIGRATE ?? nextEnv.HAPPY_SQLITE_AUTO_MIGRATE, true)) {
    await applySelfHostSqliteMigrationsAtInstallTime({ env: nextEnv }).catch((e) => {
      throw new Error(`[self-host] failed to apply sqlite migrations at update time: ${String(e?.message ?? e)}`);
    });
  }

  const serviceSpec = buildSelfHostServerServiceSpec({ config: configWithPort, envText: nextEnvText });
  await installManagedService({
    platform: configWithPort.platform,
    mode: configWithPort.mode,
    homeDir: homedir(),
    spec: serviceSpec,
    persistent: true,
  }).catch(() => {});
  const healthy = await restartAndCheckHealth({ config: configWithPort, serviceSpec });
  if (!healthy) {
    if (existsSync(config.serverPreviousBinaryPath)) {
      await copyFile(config.serverPreviousBinaryPath, config.serverBinaryPath);
      await chmod(config.serverBinaryPath, 0o755).catch(() => {});
      await restartAndCheckHealth({ config: configWithPort, serviceSpec });
    }
    throw new Error('[self-host] update failed health checks and was rolled back to previous binary');
  }

  if (autoUpdateReconcile.action === 'install') {
    await installAutoUpdateJob({
      config: configWithPort,
      enabled: true,
      intervalMinutes: autoUpdateReconcile.intervalMinutes,
    }).catch(() => {});
  } else {
    await uninstallAutoUpdateJob({ config: configWithPort }).catch(() => {});
  }

  await writeSelfHostState(config, {
    channel,
    mode,
    version: installResult.version,
    source: installResult.source,
    autoUpdate: { enabled: autoUpdateReconcile.enabled, intervalMinutes: autoUpdateReconcile.intervalMinutes },
    uiWeb: uiInstalled
      ? { installed: true, version: uiResult.version, source: uiResult.source, tag: uiResult.tag }
      : { installed: false, reason: String(uiResult?.reason ?? (withUi ? 'missing' : 'disabled')) },
  });

  printResult({
    json,
    data: { ok: true, version: installResult.version, service: config.serviceName },
    text: `${green('✓')} updated self-host runtime to ${cyan(installResult.version || 'latest')}`,
  });
}

function parseRollbackVersion(argv) {
  const { kv } = parseArgs(argv);
  const fromEq = String(kv.get('--to') ?? '').trim();
  if (fromEq) return fromEq;
  const idx = argv.indexOf('--to');
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]).trim();
  return '';
}

async function cmdRollback({ channel, mode, argv, json }) {
  const config = resolveConfig({ channel, mode, platform: process.platform });
  if (config.mode === 'system' && config.platform !== 'win32') {
    assertRoot();
  }
  const to = parseRollbackVersion(argv);
  const target = to
    ? join(config.versionsDir, `${config.serverBinaryName}-${to}`)
    : config.serverPreviousBinaryPath;
  if (!existsSync(target)) {
    throw new Error(
      to
        ? `[self-host] rollback target version not found: ${to}`
        : '[self-host] no previous binary is available for rollback'
    );
  }
  await copyFile(target, config.serverBinaryPath);
  await chmod(config.serverBinaryPath, 0o755).catch(() => {});
  const envText = existsSync(config.configEnvPath)
    ? await readFile(config.configEnvPath, 'utf-8').catch(() => '')
    : '';
  const parsedEnv = parseEnvText(envText);
  const effectivePort = parsePort(parsedEnv.PORT, config.serverPort);
  const configWithPort = effectivePort === config.serverPort ? config : { ...config, serverPort: effectivePort };
  const defaultsEnvText = renderServerEnvFile({
    port: configWithPort.serverPort,
    host: configWithPort.serverHost,
    dataDir: configWithPort.dataDir,
    filesDir: configWithPort.filesDir,
    dbDir: configWithPort.dbDir,
    serverBinDir: dirname(configWithPort.serverBinaryPath),
    arch: process.arch,
    platform: configWithPort.platform,
  });
  const nextEnvText = envText ? mergeEnvTextWithDefaults(envText, defaultsEnvText) : defaultsEnvText;
  await mkdir(configWithPort.configDir, { recursive: true });
  await writeFile(configWithPort.configEnvPath, nextEnvText, 'utf-8');

  const serviceSpec = buildSelfHostServerServiceSpec({ config: configWithPort, envText: nextEnvText });
  await installManagedService({
    platform: configWithPort.platform,
    mode: configWithPort.mode,
    homeDir: homedir(),
    spec: serviceSpec,
    persistent: true,
  }).catch(() => {});
  const healthy = await restartAndCheckHealth({ config: configWithPort, serviceSpec });
  if (!healthy) {
    throw new Error('[self-host] rollback completed binary swap but health checks failed');
  }
  await writeSelfHostState(config, {
    channel,
    mode,
    version: to || 'previous',
    rolledBackAt: new Date().toISOString(),
  });
  printResult({
    json,
    data: { ok: true, version: to || 'previous' },
    text: `${green('✓')} rollback completed (${cyan(to || 'previous')})`,
  });
}

async function cmdUninstall({ channel, mode, argv, json }) {
  const config = resolveConfig({ channel, mode, platform: process.platform });
  if (config.mode === 'system' && config.platform !== 'win32') {
    assertRoot();
  }
  const purgeData = argv.includes('--purge-data');
  const yes = argv.includes('--yes') || parseBoolean(process.env.HAPPIER_NONINTERACTIVE, false);
  if (!yes) {
    throw new Error('[self-host] uninstall requires --yes (or HAPPIER_NONINTERACTIVE=1)');
  }

  const envText = existsSync(config.configEnvPath)
    ? await readFile(config.configEnvPath, 'utf-8').catch(() => '')
    : '';
  const fallbackEnvText = envText || renderServerEnvFile({
    port: config.serverPort,
    host: config.serverHost,
    dataDir: config.dataDir,
    filesDir: config.filesDir,
    dbDir: config.dbDir,
    serverBinDir: dirname(config.serverBinaryPath),
    arch: process.arch,
    platform: config.platform,
  });
  const serviceSpec = buildSelfHostServerServiceSpec({ config, envText: fallbackEnvText });
  await uninstallAutoUpdateJob({ config }).catch(() => {});
  await uninstallManagedService({
    platform: config.platform,
    mode: config.mode,
    homeDir: homedir(),
    spec: serviceSpec,
    persistent: true,
  }).catch(() => {});

  await rm(config.serverBinaryPath, { force: true });
  await rm(config.serverPreviousBinaryPath, { force: true });
  await rm(join(config.binDir, config.serverBinaryName), { force: true });
  await rm(config.statePath, { force: true });

  if (purgeData) {
    await rm(config.installRoot, { recursive: true, force: true });
    await rm(config.configDir, { recursive: true, force: true });
    await rm(config.dataDir, { recursive: true, force: true });
    await rm(config.logDir, { recursive: true, force: true });
  }

  printResult({
    json,
    data: { ok: true, purgeData },
    text: `${green('✓')} self-host uninstalled${purgeData ? ' (data purged)' : ''}`,
  });
}

async function cmdDoctor({ channel, mode, json }) {
  const config = resolveConfig({ channel, mode, platform: process.platform });
  const state = existsSync(config.statePath)
    ? JSON.parse(await readFile(config.statePath, 'utf-8').catch(() => '{}'))
    : {};
  const checks = buildSelfHostDoctorChecks(config, { state });
  const ok = checks.every((check) => check.ok);
  printResult({
    json,
    data: { ok, checks },
    text: [
      banner('self-host doctor', { subtitle: 'Self-host diagnostics.' }),
      '',
      ...checks.map((check) => `${check.ok ? green('✓') : yellow('!')} ${check.name}`),
    ].join('\n'),
  });
  if (!ok) {
    process.exitCode = 1;
  }
}

export function usageText() {
  return [
    banner('self-host', { subtitle: 'Happier Self-Host guided installation flow.' }),
    '',
    sectionTitle('usage:'),
    `  ${cyan('hstack self-host')} install [--mode=user|system] [--without-cli] [--without-ui] [--channel=stable|preview] [--auto-update|--no-auto-update] [--auto-update-interval=<minutes>] [--non-interactive] [--json]`,
    `  ${cyan('hstack self-host')} status [--mode=user|system] [--channel=stable|preview] [--json]`,
    `  ${cyan('hstack self-host')} update [--mode=user|system] [--channel=stable|preview] [--json]`,
    `  ${cyan('hstack self-host')} rollback [--mode=user|system] [--to=<version>] [--channel=stable|preview] [--json]`,
    `  ${cyan('hstack self-host')} uninstall [--mode=user|system] [--purge-data] [--yes] [--json]`,
    `  ${cyan('hstack self-host')} doctor [--json]`,
    '',
    sectionTitle('notes:'),
    '- works without a repository checkout (binary-safe flow).',
    `- runtime paths are configurable via env vars (${dim('HAPPIER_SELF_HOST_*')}).`,
  ].join('\n');
}

export async function runSelfHostCli(argv = process.argv.slice(2)) {
  const parsed = parseSelfHostInvocation(argv);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const channel = normalizeChannel(String(kv.get('--channel') ?? process.env.HAPPIER_CHANNEL ?? 'stable'));
  const mode = normalizeMode(
    String(
      kv.get('--mode') ??
        (argv.includes('--system') ? 'system' : argv.includes('--user') ? 'user' : process.env.HAPPIER_SELF_HOST_MODE ?? 'user')
    )
  );

  if (wantsHelp(argv, { flags }) || parsed.subcommand === 'help') {
    printResult({
      json,
      data: {
        ok: true,
        commands: ['install', 'status', 'update', 'rollback', 'uninstall', 'doctor'],
      },
      text: usageText(),
    });
    return;
  }

  if (parsed.subcommand === 'install') {
    await cmdInstall({ channel, mode, argv: parsed.rest, json });
    return;
  }
  if (parsed.subcommand === 'status') {
    await cmdStatus({ channel, mode, json });
    return;
  }
  if (parsed.subcommand === 'update') {
    await cmdUpdate({ channel, mode, json });
    return;
  }
  if (parsed.subcommand === 'rollback') {
    await cmdRollback({ channel, mode, argv: parsed.rest, json });
    return;
  }
  if (parsed.subcommand === 'uninstall') {
    await cmdUninstall({ channel, mode, argv: parsed.rest, json });
    return;
  }
  if (parsed.subcommand === 'doctor' || parsed.subcommand === 'migrate-from-npm') {
    await cmdDoctor({ channel, mode, json });
    return;
  }

  throw new Error(`[self-host] unknown command: ${parsed.subcommand}`);
}
