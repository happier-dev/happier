import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { banner, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green, yellow } from './utils/ui/ansi.mjs';

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
});

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
  const result = runCommand('bash', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], { allowFail: true, stdio: 'ignore' });
  return (result.status ?? 1) === 0;
}

function normalizeArch() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!arch) {
    throw new Error(`[self-host] unsupported architecture: ${process.arch}`);
  }
  return arch;
}

function normalizeChannel(raw) {
  const channel = String(raw ?? '').trim() || 'stable';
  if (!SUPPORTED_CHANNELS.has(channel)) {
    throw new Error(`[self-host] invalid channel: ${channel} (expected stable|preview)`);
  }
  return channel;
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
  const archiveRe = new RegExp(`^${escapeRegex(product)}-v.+-${escapeRegex(os)}-${escapeRegex(arch)}\\.tar\\.gz$`);
  const checksumsRe = new RegExp(`^checksums-${escapeRegex(product)}-v.+\\.txt$`);
  const signatureRe = new RegExp(`^checksums-${escapeRegex(product)}-v.+\\.txt\\.minisig$`);

  const archive = list.find((asset) => archiveRe.test(String(asset?.name ?? '')));
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
    if ((info.mode & 0o111) !== 0) return fullPath;
  }
  return '';
}

function resolveConfig({ channel }) {
  const installRoot = String(process.env.HAPPIER_SELF_HOST_INSTALL_ROOT ?? DEFAULTS.installRoot).trim();
  const binDir = String(process.env.HAPPIER_SELF_HOST_BIN_DIR ?? DEFAULTS.binDir).trim();
  const configDir = String(process.env.HAPPIER_SELF_HOST_CONFIG_DIR ?? DEFAULTS.configDir).trim();
  const dataDir = String(process.env.HAPPIER_SELF_HOST_DATA_DIR ?? DEFAULTS.dataDir).trim();
  const logDir = String(process.env.HAPPIER_SELF_HOST_LOG_DIR ?? DEFAULTS.logDir).trim();
  const serviceName = String(process.env.HAPPIER_SELF_HOST_SERVICE_NAME ?? DEFAULTS.serviceName).trim();
  const serverHost = String(process.env.HAPPIER_SERVER_HOST ?? DEFAULTS.serverHost).trim();
  const serverPort = parsePort(process.env.HAPPIER_SERVER_PORT, DEFAULTS.serverPort);
  const githubRepo = String(process.env.HAPPIER_GITHUB_REPO ?? DEFAULTS.githubRepo).trim();
  const autoUpdate = parseBoolean(process.env.HAPPIER_SELF_HOST_AUTO_UPDATE, true);

  return {
    channel,
    installRoot,
    versionsDir: join(installRoot, 'versions'),
    installBinDir: join(installRoot, 'bin'),
    serverBinaryPath: join(installRoot, 'bin', 'happier-server'),
    serverPreviousBinaryPath: join(installRoot, 'bin', 'happier-server.previous'),
    statePath: join(installRoot, 'self-host-state.json'),
    binDir,
    configDir,
    configEnvPath: join(configDir, 'server.env'),
    dataDir,
    filesDir: join(dataDir, 'files'),
    dbDir: join(dataDir, 'pglite'),
    logDir,
    serverLogPath: join(logDir, 'server.log'),
    serviceName,
    serviceUnitName: `${serviceName}.service`,
    serviceUnitPath: join('/etc/systemd/system', `${serviceName}.service`),
    updaterServiceName: `${serviceName}-updater`,
    updaterServiceUnitPath: join('/etc/systemd/system', `${serviceName}-updater.service`),
    updaterTimerUnitName: `${serviceName}-updater.timer`,
    updaterTimerUnitPath: join('/etc/systemd/system', `${serviceName}-updater.timer`),
    serverHost,
    serverPort,
    githubRepo,
    autoUpdate,
  };
}

export function renderServerEnvFile({ port, host, dataDir, filesDir, dbDir }) {
  return [
    `PORT=${port}`,
    `HAPPIER_SERVER_HOST=${host}`,
    'HAPPIER_DB_PROVIDER=sqlite',
    'HAPPIER_FILES_BACKEND=local',
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
    `HAPPIER_SERVER_LIGHT_FILES_DIR=${filesDir}`,
    `HAPPIER_SERVER_LIGHT_DB_DIR=${dbDir}`,
    '',
  ].join('\n');
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

function renderUpdaterServiceUnit({ updaterServiceName, hstackPath, channel }) {
  return [
    '[Unit]',
    `Description=${updaterServiceName}`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${hstackPath} self-host update --channel=${channel} --non-interactive`,
    '',
  ].join('\n');
}

function renderUpdaterTimerUnit({ updaterServiceName, updaterTimerName }) {
  return [
    '[Unit]',
    `Description=${updaterTimerName}`,
    '',
    '[Timer]',
    'OnCalendar=weekly',
    'RandomizedDelaySec=30m',
    'Persistent=true',
    `Unit=${updaterServiceName}.service`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

async function restartAndCheckHealth({ serviceUnitName, serverPort }) {
  runCommand('systemctl', ['restart', serviceUnitName], { stdio: 'inherit' });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
    const active = runCommand('systemctl', ['is-active', '--quiet', serviceUnitName], { allowFail: true, stdio: 'ignore' });
    if ((active.status ?? 1) === 0) {
      const ok = await checkHealth({ port: serverPort });
      if (ok) return true;
    }
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

async function verifySignature({ checksumsPath, signatureUrl, publicKey }) {
  if (!signatureUrl) {
    throw new Error('[self-host] release signature URL is missing');
  }
  if (!publicKey) {
    throw new Error('[self-host] minisign public key is missing');
  }
  if (!commandExists('minisign')) {
    throw new Error('[self-host] minisign is required for self-host signature verification');
  }
  const tmp = await mkdtemp(join(tmpdir(), 'happier-self-host-signature-'));
  const pubKeyPath = join(tmp, 'minisign.pub');
  const signaturePath = join(tmp, 'checksums.txt.minisig');
  try {
    await writeFile(pubKeyPath, `${publicKey}\n`, 'utf-8');
    await downloadToFile(signatureUrl, signaturePath);
    runCommand('minisign', ['-Vm', checksumsPath, '-x', signaturePath, '-p', pubKeyPath], { stdio: 'ignore' });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function installBinaryAtomically({ sourceBinaryPath, targetBinaryPath, previousBinaryPath, versionedTargetPath }) {
  await mkdir(dirname(targetBinaryPath), { recursive: true });
  await mkdir(dirname(versionedTargetPath), { recursive: true });
  const stagedPath = `${targetBinaryPath}.new`;
  await copyFile(sourceBinaryPath, stagedPath);
  await chmod(stagedPath, 0o755);
  if (existsSync(targetBinaryPath)) {
    await copyFile(targetBinaryPath, previousBinaryPath);
    await chmod(previousBinaryPath, 0o755);
  }
  await copyFile(stagedPath, versionedTargetPath);
  await chmod(versionedTargetPath, 0o755);
  await rm(stagedPath, { force: true });
  await copyFile(versionedTargetPath, targetBinaryPath);
  await chmod(targetBinaryPath, 0o755);
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
    return { version, source: 'local' };
  }

  const channelTag = config.channel === 'preview' ? 'server-preview' : 'server-stable';
  const release = await readRelease(channelTag, config.githubRepo);
  const asset = pickReleaseAsset({
    assets: release?.assets,
    product,
    os: 'linux',
    arch: normalizeArch(),
  });

  const tempDir = await mkdtemp(join(tmpdir(), 'happier-self-host-release-'));
  try {
    const archivePath = join(tempDir, 'artifact.tar.gz');
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
    runCommand('tar', ['-xzf', archivePath, '-C', extractDir], { stdio: 'ignore' });
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

async function cmdInstall({ channel, argv, json }) {
  assertLinux();
  assertRoot();
  if (!commandExists('systemctl')) {
    throw new Error('[self-host] systemctl is required');
  }
  if (!commandExists('tar')) {
    throw new Error('[self-host] tar is required');
  }
  const config = resolveConfig({ channel });
  const withoutCli = argv.includes('--without-cli') || parseBoolean(process.env.HAPPIER_WITH_CLI, true) === false;
  const nonInteractive = argv.includes('--non-interactive') || parseBoolean(process.env.HAPPIER_NONINTERACTIVE, false);
  const serverBinaryOverride = String(process.env.HAPPIER_SELF_HOST_SERVER_BINARY ?? '').trim();

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
    binaryName: 'happier-server',
    config,
    explicitBinaryPath: serverBinaryOverride,
  });

  await writeFile(
    config.configEnvPath,
    renderServerEnvFile({
      port: config.serverPort,
      host: config.serverHost,
      dataDir: config.dataDir,
      filesDir: config.filesDir,
      dbDir: config.dbDir,
    }),
    'utf-8'
  );
  await writeFile(
    config.serviceUnitPath,
    renderServerServiceUnit({
      serviceName: config.serviceName,
      binaryPath: config.serverBinaryPath,
      envFilePath: config.configEnvPath,
      workingDirectory: config.installRoot,
      logPath: config.serverLogPath,
    }),
    'utf-8'
  );

  const hstackPath = existsSync(join(config.binDir, 'hstack'))
    ? join(config.binDir, 'hstack')
    : join(config.installRoot, 'bin', 'hstack');
  await writeFile(
    config.updaterServiceUnitPath,
    renderUpdaterServiceUnit({
      updaterServiceName: config.updaterServiceName,
      hstackPath,
      channel,
    }),
    'utf-8'
  );
  await writeFile(
    config.updaterTimerUnitPath,
    renderUpdaterTimerUnit({
      updaterServiceName: config.updaterServiceName,
      updaterTimerName: config.updaterTimerUnitName,
    }),
    'utf-8'
  );

  const serverShimPath = join(config.binDir, 'happier-server');
  await mkdir(config.binDir, { recursive: true });
  await rm(serverShimPath, { force: true });
  await symlink(config.serverBinaryPath, serverShimPath).catch(async () => {
    await copyFile(config.serverBinaryPath, serverShimPath);
    await chmod(serverShimPath, 0o755);
  });

  runCommand('systemctl', ['daemon-reload'], { stdio: 'inherit' });
  runCommand('systemctl', ['enable', '--now', config.serviceUnitName], { stdio: 'inherit' });

  if (config.autoUpdate) {
    runCommand('systemctl', ['enable', '--now', config.updaterTimerUnitName], { allowFail: true, stdio: 'inherit' });
  } else {
    runCommand('systemctl', ['disable', '--now', config.updaterTimerUnitName], { allowFail: true, stdio: 'ignore' });
  }

  const healthy = await restartAndCheckHealth({ serviceUnitName: config.serviceUnitName, serverPort: config.serverPort });
  if (!healthy) {
    throw new Error('[self-host] service failed health checks after install');
  }

  const cliResult = await maybeInstallCompanionCli({
    channel,
    nonInteractive,
    withCli: !withoutCli,
  });
  await writeSelfHostState(config, {
    channel,
    version: installResult.version,
    source: installResult.source,
    autoUpdate: config.autoUpdate,
    withCli: !withoutCli,
  });

  printResult({
    json,
    data: {
      ok: true,
      channel,
      version: installResult.version,
      service: config.serviceUnitName,
      serverPort: config.serverPort,
      cli: cliResult,
    },
    text: [
      `${green('✓')} Happier Self-Host installed`,
      `- service: ${cyan(config.serviceUnitName)}`,
      `- version: ${cyan(installResult.version || 'unknown')}`,
      `- server: ${cyan(`http://127.0.0.1:${config.serverPort}`)}`,
      `- cli: ${cliResult.installed ? green('installed') : dim(cliResult.reason)}`,
    ].join('\n'),
  });
}

async function cmdStatus({ channel, json }) {
  assertLinux();
  const config = resolveConfig({ channel });
  const serviceState = runCommand('systemctl', ['is-active', config.serviceUnitName], { allowFail: true, stdio: 'pipe' });
  const active = (serviceState.status ?? 1) === 0;
  const enabledState = runCommand('systemctl', ['is-enabled', config.serviceUnitName], { allowFail: true, stdio: 'pipe' });
  const enabled = (enabledState.status ?? 1) === 0;
  const healthy = active ? await checkHealth({ port: config.serverPort }) : false;
  const state = existsSync(config.statePath)
    ? JSON.parse(await readFile(config.statePath, 'utf-8').catch(() => '{}'))
    : {};

  printResult({
    json,
    data: {
      ok: true,
      channel,
      service: {
        name: config.serviceUnitName,
        active,
        enabled,
      },
      healthy,
      state,
    },
    text: [
      `${cyan('service')}: ${config.serviceUnitName}`,
      `${cyan('active')}: ${active ? green('yes') : yellow('no')}`,
      `${cyan('enabled')}: ${enabled ? green('yes') : yellow('no')}`,
      `${cyan('health')}: ${healthy ? green('ok') : yellow('failed')}`,
      state?.version ? `${cyan('version')}: ${state.version}` : null,
    ].filter(Boolean).join('\n'),
  });
}

async function cmdUpdate({ channel, json }) {
  assertLinux();
  assertRoot();
  const config = resolveConfig({ channel });
  const installResult = await installFromRelease({
    product: 'happier-server',
    binaryName: 'happier-server',
    config,
  });
  const healthy = await restartAndCheckHealth({ serviceUnitName: config.serviceUnitName, serverPort: config.serverPort });
  if (!healthy) {
    if (existsSync(config.serverPreviousBinaryPath)) {
      await copyFile(config.serverPreviousBinaryPath, config.serverBinaryPath);
      await chmod(config.serverBinaryPath, 0o755);
      await restartAndCheckHealth({ serviceUnitName: config.serviceUnitName, serverPort: config.serverPort });
    }
    throw new Error('[self-host] update failed health checks and was rolled back to previous binary');
  }

  await writeSelfHostState(config, {
    channel,
    version: installResult.version,
    source: installResult.source,
  });

  printResult({
    json,
    data: { ok: true, version: installResult.version, service: config.serviceUnitName },
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

async function cmdRollback({ channel, argv, json }) {
  assertLinux();
  assertRoot();
  const config = resolveConfig({ channel });
  const to = parseRollbackVersion(argv);
  const target = to
    ? join(config.versionsDir, `happier-server-${to}`)
    : config.serverPreviousBinaryPath;
  if (!existsSync(target)) {
    throw new Error(
      to
        ? `[self-host] rollback target version not found: ${to}`
        : '[self-host] no previous binary is available for rollback'
    );
  }
  await copyFile(target, config.serverBinaryPath);
  await chmod(config.serverBinaryPath, 0o755);
  const healthy = await restartAndCheckHealth({ serviceUnitName: config.serviceUnitName, serverPort: config.serverPort });
  if (!healthy) {
    throw new Error('[self-host] rollback completed binary swap but health checks failed');
  }
  await writeSelfHostState(config, {
    channel,
    version: to || 'previous',
    rolledBackAt: new Date().toISOString(),
  });
  printResult({
    json,
    data: { ok: true, version: to || 'previous' },
    text: `${green('✓')} rollback completed (${cyan(to || 'previous')})`,
  });
}

async function cmdUninstall({ channel, argv, json }) {
  assertLinux();
  assertRoot();
  const config = resolveConfig({ channel });
  const purgeData = argv.includes('--purge-data');
  const yes = argv.includes('--yes') || parseBoolean(process.env.HAPPIER_NONINTERACTIVE, false);
  if (!yes) {
    throw new Error('[self-host] uninstall requires --yes (or HAPPIER_NONINTERACTIVE=1)');
  }

  runCommand('systemctl', ['disable', '--now', config.serviceUnitName], { allowFail: true, stdio: 'ignore' });
  runCommand('systemctl', ['disable', '--now', config.updaterTimerUnitName], { allowFail: true, stdio: 'ignore' });

  await rm(config.serviceUnitPath, { force: true });
  await rm(config.updaterServiceUnitPath, { force: true });
  await rm(config.updaterTimerUnitPath, { force: true });
  runCommand('systemctl', ['daemon-reload'], { allowFail: true, stdio: 'ignore' });

  await rm(config.serverBinaryPath, { force: true });
  await rm(config.serverPreviousBinaryPath, { force: true });
  await rm(join(config.binDir, 'happier-server'), { force: true });
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

async function cmdDoctor({ channel, json }) {
  const config = resolveConfig({ channel });
  const checks = [
    { name: 'linux', ok: process.platform === 'linux' },
    { name: 'systemctl', ok: commandExists('systemctl') },
    { name: 'curl', ok: commandExists('curl') },
    { name: 'tar', ok: commandExists('tar') },
    { name: 'server-binary', ok: existsSync(config.serverBinaryPath) },
    { name: 'service-unit', ok: existsSync(config.serviceUnitPath) },
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
    `  ${cyan('hstack self-host')} install [--without-cli] [--channel=stable|preview] [--non-interactive] [--json]`,
    `  ${cyan('hstack self-host')} status [--channel=stable|preview] [--json]`,
    `  ${cyan('hstack self-host')} update [--channel=stable|preview] [--json]`,
    `  ${cyan('hstack self-host')} rollback [--to=<version>] [--channel=stable|preview] [--json]`,
    `  ${cyan('hstack self-host')} uninstall [--purge-data] [--yes] [--json]`,
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
    await cmdInstall({ channel, argv: parsed.rest, json });
    return;
  }
  if (parsed.subcommand === 'status') {
    await cmdStatus({ channel, json });
    return;
  }
  if (parsed.subcommand === 'update') {
    await cmdUpdate({ channel, json });
    return;
  }
  if (parsed.subcommand === 'rollback') {
    await cmdRollback({ channel, argv: parsed.rest, json });
    return;
  }
  if (parsed.subcommand === 'uninstall') {
    await cmdUninstall({ channel, argv: parsed.rest, json });
    return;
  }
  if (parsed.subcommand === 'doctor' || parsed.subcommand === 'migrate-from-npm') {
    await cmdDoctor({ channel, json });
    return;
  }

  throw new Error(`[self-host] unknown command: ${parsed.subcommand}`);
}
