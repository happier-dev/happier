import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const SUPPORTED_CHANNELS = new Set(['stable', 'preview']);
const DEFAULTS = Object.freeze({
  githubRepo: 'happier-dev/happier',
  minisignPubKeyUrl: 'https://happier.dev/happier-release.pub',
  installRoot: '/opt/happier',
  binDir: '/usr/local/bin',
  configDir: '/etc/happier',
  dataDir: '/var/lib/happier',
  logDir: '/var/log/happier',
  serviceName: 'happier-server',
  serverHost: '127.0.0.1',
  serverPort: 3005,
  healthCheckTimeoutMs: 90_000,
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

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function pickReleaseAsset({ assets, product, os, arch }) {
  const list = Array.isArray(assets) ? assets : [];
  const normalizedOs = String(os ?? '').trim();
  const zipExt = '\\.zip';
  const tgzExt = '\\.tar\\.gz';
  const windows = normalizedOs.toLowerCase() === 'windows';
  const archiveZipRe = new RegExp(`^${escapeRegex(product)}-v.+-${escapeRegex(normalizedOs)}-${escapeRegex(arch)}${zipExt}$`);
  const archiveTgzRe = new RegExp(`^${escapeRegex(product)}-v.+-${escapeRegex(normalizedOs)}-${escapeRegex(arch)}${tgzExt}$`);
  const checksumsRe = new RegExp(`^checksums-${escapeRegex(product)}-v.+\\.txt$`);
  const signatureRe = new RegExp(`^checksums-${escapeRegex(product)}-v.+\\.txt\\.minisig$`);

  const archive = windows
    ? (list.find((asset) => archiveZipRe.test(String(asset?.name ?? ''))) ?? list.find((asset) => archiveTgzRe.test(String(asset?.name ?? ''))))
    : list.find((asset) => archiveTgzRe.test(String(asset?.name ?? '')));
  const checksums = list.find((asset) => checksumsRe.test(String(asset?.name ?? '')));
  const signature = list.find((asset) => signatureRe.test(String(asset?.name ?? '')));
  if (!archive || !checksums || !signature) {
    throw new Error(
      `[self-host] release assets not found for ${product} ${os}-${arch} (archive/checksums/signature missing)`
    );
  }
  const archiveName = String(archive.name);
  const versionMatch = archiveName.match(/-v([^-/]+)-/);
  return {
    archiveUrl: String(archive.browser_download_url ?? ''),
    archiveName,
    checksumsUrl: String(checksums.browser_download_url ?? ''),
    signatureUrl: String(signature.browser_download_url ?? ''),
    version: versionMatch ? versionMatch[1] : '',
  };
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

function parseChecksums(raw) {
  const map = new Map();
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-fA-F0-9]{64})\s{2}(.+)$/.exec(trimmed);
    if (!match) continue;
    map.set(match[2], match[1].toLowerCase());
  }
  return map;
}

async function downloadToFile(url, targetPath) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'happier-self-host-installer',
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`[self-host] download failed: ${url} (${response.status} ${response.statusText})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(targetPath, bytes);
}

async function readRelease(tag, githubRepo) {
  const url = `https://api.github.com/repos/${githubRepo}/releases/tags/${tag}`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'happier-self-host-installer',
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`[self-host] failed to resolve GitHub release tag ${tag} (${response.status})`);
  }
  return await response.json();
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
  const autoUpdate = parseBoolean(process.env.HAPPIER_SELF_HOST_AUTO_UPDATE, true);
  const serverBinaryName = platform === 'win32' ? 'happier-server.exe' : 'happier-server';

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
  };
}

export function renderServerEnvFile({ port, host, dataDir, filesDir, dbDir, platform = process.platform }) {
  const normalizedDataDir = String(dataDir ?? '').replace(/\/+$/, '') || String(dataDir ?? '');
  const p = String(platform ?? '').trim() || process.platform;
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
  return [
    `PORT=${port}`,
    `HAPPIER_SERVER_HOST=${host}`,
    'METRICS_ENABLED=false',
    // Bun-compiled server binaries currently exhibit unstable pglite path resolution in systemd environments.
    'HAPPIER_DB_PROVIDER=sqlite',
    `DATABASE_URL=${databaseUrl}`,
    'HAPPIER_FILES_BACKEND=local',
    'HAPPIER_SQLITE_AUTO_MIGRATE=1',
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

export function renderUpdaterLaunchdPlistXml({
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
  if (!hstack) throw new Error('[self-host] missing hstackPath for updater launchd plist');
  const ch = String(channel ?? '').trim() || 'stable';
  const m = String(mode ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
  const wd = String(workingDirectory ?? '').trim();
  const out = String(stdoutPath ?? '').trim();
  const err = String(stderrPath ?? '').trim();

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

async function installAutoUpdateJob({ config, enabled }) {
  if (!enabled) return { installed: false, reason: 'disabled' };
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
  const wantedBy =
    backend === 'systemd-system' ? 'multi-user.target' : backend === 'systemd-user' ? 'default.target' : '';

  const definitionContents =
    backend === 'systemd-system' || backend === 'systemd-user'
      ? renderUpdaterSystemdUnit({
          updaterLabel,
          hstackPath,
          channel: config.channel,
          mode: config.mode,
          workingDirectory: config.installRoot,
          stdoutPath,
          stderrPath,
          wantedBy,
        })
      : backend === 'launchd-system' || backend === 'launchd-user'
          ? renderUpdaterLaunchdPlistXml({
              updaterLabel,
              hstackPath,
              channel: config.channel,
              mode: config.mode,
              workingDirectory: config.installRoot,
              stdoutPath,
              stderrPath,
            })
          : renderUpdaterScheduledTaskWrapperPs1({
              updaterLabel,
              hstackPath,
              channel: config.channel,
              mode: config.mode,
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
  return { installed: true, backend, label: updaterLabel, definitionPath };
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
  const plan = planServiceAction({
    backend,
    action: 'uninstall',
    label: updaterLabel,
    definitionPath,
    persistent: true,
  });
  await applyServicePlan(plan);
  await rm(definitionPath, { force: true }).catch(() => {});
  return { uninstalled: true };
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

async function resolveMinisignPublicKey() {
  const inline = String(process.env.HAPPIER_MINISIGN_PUBKEY ?? '').trim();
  if (inline) return inline;
  const publicKeyUrl = String(
    process.env.HAPPIER_MINISIGN_PUBKEY_URL ?? DEFAULTS.minisignPubKeyUrl
  ).trim();
  if (!publicKeyUrl) {
    throw new Error('[self-host] HAPPIER_MINISIGN_PUBKEY_URL is empty');
  }
  const response = await fetch(publicKeyUrl, {
    headers: {
      'user-agent': 'happier-self-host-installer',
      accept: 'text/plain,application/octet-stream;q=0.9,*/*;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(
      `[self-host] failed to download minisign public key (${response.status} ${response.statusText})`
    );
  }
  const raw = String(await response.text()).trim();
  if (!raw) {
    throw new Error('[self-host] downloaded minisign public key was empty');
  }
  return raw;
}

const MINISIGN_BOOTSTRAP_VERSION = '0.12';
const MINISIGN_BOOTSTRAP_ASSETS = Object.freeze({
  linux: {
    assetName: 'minisign-0.12-linux.tar.gz',
    sha256: '9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73',
  },
  darwin: {
    assetName: 'minisign-0.12-macos.zip',
    sha256: '89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63',
  },
  win32: {
    assetName: 'minisign-0.12-win64.zip',
    sha256: '37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479',
  },
});

export function resolveMinisignBootstrapAsset({ platform = process.platform } = {}) {
  const key = String(platform ?? '').trim() || process.platform;
  const asset = MINISIGN_BOOTSTRAP_ASSETS[key];
  if (!asset) {
    throw new Error(`[self-host] minisign bootstrap is not supported on platform: ${key}`);
  }
  return { assetName: asset.assetName, sha256: asset.sha256 };
}

let bootstrappedMinisignPath = null;

async function ensureMinisign() {
  if (commandExists('minisign')) return 'minisign';
  if (bootstrappedMinisignPath) return bootstrappedMinisignPath;

  const { assetName, sha256: expectedSha } = resolveMinisignBootstrapAsset({ platform: process.platform });
  const tmp = await mkdtemp(join(tmpdir(), 'happier-minisign-bootstrap-'));
  const archivePath = join(tmp, assetName);
  const extractDir = join(tmp, 'extract');
  try {
    await downloadToFile(`https://github.com/jedisct1/minisign/releases/download/${MINISIGN_BOOTSTRAP_VERSION}/${assetName}`, archivePath);
    const actual = await sha256(archivePath);
    if (actual !== expectedSha) {
      throw new Error(`[self-host] minisign bootstrap checksum mismatch (expected ${expectedSha}, got ${actual})`);
    }
    await mkdir(extractDir, { recursive: true });
    if (assetName.endsWith('.tar.gz')) {
      if (!commandExists('tar')) throw new Error('[self-host] tar is required to bootstrap minisign');
      runCommand('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'ignore' });
    } else if (assetName.endsWith('.zip')) {
      if (process.platform === 'win32') {
        if (!commandExists('powershell')) throw new Error('[self-host] powershell is required to bootstrap minisign on Windows');
        runCommand('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${extractDir}" -Force`], { stdio: 'ignore' });
      } else {
        if (commandExists('unzip')) {
          runCommand('unzip', ['-q', archivePath, '-d', extractDir], { stdio: 'ignore' });
        } else if (commandExists('ditto')) {
          runCommand('ditto', ['-x', '-k', archivePath, extractDir], { stdio: 'ignore' });
        } else {
          throw new Error('[self-host] unzip (or ditto) is required to bootstrap minisign on macOS');
        }
      }
    } else {
      throw new Error(`[self-host] unsupported minisign bootstrap archive: ${assetName}`);
    }

    const binName = process.platform === 'win32' ? 'minisign.exe' : 'minisign';
    const resolved = await findExecutableByName(extractDir, binName);
    if (!resolved) throw new Error('[self-host] failed to locate bootstrapped minisign binary');
    await chmod(resolved, 0o755).catch(() => {});
    bootstrappedMinisignPath = resolved;
    return resolved;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function verifySignature({ checksumsPath, signatureUrl, publicKey }) {
  if (!signatureUrl) {
    throw new Error('[self-host] release signature URL is missing');
  }
  if (!publicKey) {
    throw new Error('[self-host] minisign public key is missing');
  }
  const minisignBin = await ensureMinisign();
  const tmp = await mkdtemp(join(tmpdir(), 'happier-self-host-signature-'));
  const pubKeyPath = join(tmp, 'minisign.pub');
  const signaturePath = join(tmp, 'checksums.txt.minisig');
  try {
    await writeFile(pubKeyPath, `${publicKey}\n`, 'utf-8');
    await downloadToFile(signatureUrl, signaturePath);
    runCommand(minisignBin, ['-Vm', checksumsPath, '-x', signaturePath, '-p', pubKeyPath], { stdio: 'ignore' });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
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
    return { version, source: 'local' };
  }

  const channelTag = config.channel === 'preview' ? 'server-preview' : 'server-stable';
  const release = await readRelease(channelTag, config.githubRepo);
  const os = normalizeOs(config.platform);
  const asset = pickReleaseAsset({
    assets: release?.assets,
    product,
    os,
    arch: normalizeArch(),
  });

  const tempDir = await mkdtemp(join(tmpdir(), 'happier-self-host-release-'));
  try {
    const isZip = asset.archiveName.toLowerCase().endsWith('.zip');
    const archivePath = join(tempDir, isZip ? 'artifact.zip' : 'artifact.tar.gz');
    const checksumsPath = join(tempDir, 'checksums.txt');
    await downloadToFile(asset.archiveUrl, archivePath);
    await downloadToFile(asset.checksumsUrl, checksumsPath);
    const checksumsMap = parseChecksums(await readFile(checksumsPath, 'utf-8'));
    const expected = checksumsMap.get(asset.archiveName);
    if (!expected) {
      throw new Error(`[self-host] checksum entry missing for ${asset.archiveName}`);
    }
    const actual = await sha256(archivePath);
    if (actual !== expected) {
      throw new Error('[self-host] checksum verification failed for downloaded server artifact');
    }

    const publicKey = await resolveMinisignPublicKey();
    await verifySignature({
      checksumsPath,
      signatureUrl: asset.signatureUrl,
      publicKey,
    });

    const extractDir = join(tempDir, 'extract');
    await mkdir(extractDir, { recursive: true });
    if (isZip) {
      if (!commandExists('powershell')) {
        throw new Error('[self-host] powershell is required to extract zip artifacts on Windows');
      }
      runCommand(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${extractDir}" -Force`],
        { stdio: 'ignore' }
      );
    } else {
      if (!commandExists('tar')) {
        throw new Error('[self-host] tar is required to extract release artifacts');
      }
      runCommand('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'ignore' });
    }
    const extractedBinary = await findExecutableByName(extractDir, binaryName);
    if (!extractedBinary) {
      throw new Error('[self-host] failed to locate extracted server binary');
    }

    const version = asset.version || String(release?.tag_name ?? '').replace(/^server-v/, '') || `${Date.now()}`;
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
    return { version, source: asset.archiveUrl };
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
  const withoutCli = argv.includes('--without-cli') || parseBoolean(process.env.HAPPIER_WITH_CLI, true) === false;
  const nonInteractive = argv.includes('--non-interactive') || parseBoolean(process.env.HAPPIER_NONINTERACTIVE, false);
  const serverBinaryOverride = String(process.env.HAPPIER_SELF_HOST_SERVER_BINARY ?? '').trim();

  if (normalizeOs(config.platform) !== 'windows' && !commandExists('tar')) {
    throw new Error('[self-host] tar is required to extract release artifacts');
  }
  if (normalizeOs(config.platform) === 'windows' && !commandExists('powershell')) {
    throw new Error('[self-host] powershell is required on Windows');
  }
  if (normalizeOs(config.platform) === 'linux' && !commandExists('systemctl')) {
    throw new Error('[self-host] systemctl is required on Linux');
  }

  await mkdir(config.installRoot, { recursive: true });
  await mkdir(config.installBinDir, { recursive: true });
  await mkdir(config.versionsDir, { recursive: true });
  await mkdir(config.configDir, { recursive: true });
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.filesDir, { recursive: true });
  await mkdir(config.dbDir, { recursive: true });
  await mkdir(config.logDir, { recursive: true });

  const installResult = await installFromRelease({
    product: 'happier-server',
    binaryName: config.serverBinaryName,
    config,
    explicitBinaryPath: serverBinaryOverride,
  });

  const envText = renderServerEnvFile({
    port: config.serverPort,
    host: config.serverHost,
    dataDir: config.dataDir,
    filesDir: config.filesDir,
    dbDir: config.dbDir,
    platform: config.platform,
  });
  await writeFile(config.configEnvPath, envText, 'utf-8');

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

  const autoUpdateResult = await installAutoUpdateJob({ config, enabled: autoUpdateEnabled }).catch((e) => ({
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
    autoUpdate: autoUpdateEnabled,
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
      `- auto-update: ${autoUpdateEnabled ? (autoUpdateResult.installed ? green('installed') : yellow('failed')) : dim('disabled')}`,
      `- cli: ${cliResult.installed ? green('installed') : dim(cliResult.reason)}`,
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

      const updaterIsActive = runCommand('systemctl', [...prefix, 'is-active', '--quiet', `${updaterLabel}.service`], {
        allowFail: true,
        stdio: 'ignore',
      });
      updaterActive = (updaterIsActive.status ?? 1) === 0;
      const updaterIsEnabled = runCommand('systemctl', [...prefix, 'is-enabled', '--quiet', `${updaterLabel}.service`], {
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

  printResult({
    json,
    data: {
      ok: true,
      channel,
      mode,
      service: {
        name: config.serviceName,
        active,
        enabled,
      },
      autoUpdate: {
        label: updaterLabel,
        active: updaterActive,
        enabled: updaterEnabled,
      },
      healthy,
      state,
    },
    text: [
      `${cyan('mode')}: ${mode}`,
      `${cyan('service')}: ${config.serviceName}`,
      `${cyan('active')}: ${active == null ? dim('unknown') : active ? green('yes') : yellow('no')}`,
      `${cyan('enabled')}: ${enabled == null ? dim('unknown') : enabled ? green('yes') : yellow('no')}`,
      `${cyan('auto-update')}: ${updaterEnabled == null ? dim('unknown') : updaterEnabled ? green('enabled') : yellow('disabled')}`,
      `${cyan('health')}: ${healthy ? green('ok') : yellow('failed')}`,
      state?.version ? `${cyan('version')}: ${state.version}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

async function cmdUpdate({ channel, mode, json }) {
  const config = resolveConfig({ channel, mode, platform: process.platform });
  if (config.mode === 'system' && config.platform !== 'win32') {
    assertRoot();
  }
  const installResult = await installFromRelease({
    product: 'happier-server',
    binaryName: config.serverBinaryName,
    config,
  });

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
    if (existsSync(config.serverPreviousBinaryPath)) {
      await copyFile(config.serverPreviousBinaryPath, config.serverBinaryPath);
      await chmod(config.serverBinaryPath, 0o755).catch(() => {});
      await restartAndCheckHealth({ config: configWithPort, serviceSpec });
    }
    throw new Error('[self-host] update failed health checks and was rolled back to previous binary');
  }

  await writeSelfHostState(config, {
    channel,
    mode,
    version: installResult.version,
    source: installResult.source,
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
  const os = normalizeOs(config.platform);
  const minisignBootstrapOk =
    commandExists('minisign') ||
    (os === 'linux' && commandExists('tar')) ||
    (os === 'darwin' && (commandExists('unzip') || commandExists('ditto'))) ||
    (os === 'windows' && commandExists('powershell'));
  const checks = [
    { name: 'platform', ok: ['linux', 'darwin', 'windows'].includes(os) },
    { name: 'mode', ok: config.mode === 'user' || (config.mode === 'system' && config.platform !== 'win32') },
    { name: 'minisign', ok: minisignBootstrapOk },
    { name: 'tar', ok: os === 'windows' ? true : commandExists('tar') },
    { name: 'powershell', ok: os === 'windows' ? commandExists('powershell') : true },
    { name: 'systemctl', ok: os === 'linux' ? commandExists('systemctl') : true },
    { name: 'launchctl', ok: os === 'darwin' ? commandExists('launchctl') : true },
    { name: 'schtasks', ok: os === 'windows' ? commandExists('schtasks') : true },
    { name: 'server-binary', ok: existsSync(config.serverBinaryPath) },
    { name: 'server-env', ok: existsSync(config.configEnvPath) },
  ];
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
    `  ${cyan('hstack self-host')} install [--mode=user|system] [--without-cli] [--channel=stable|preview] [--auto-update|--no-auto-update] [--non-interactive] [--json]`,
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
