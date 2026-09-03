import { resolveEffectiveDbProvider } from '../server/effective_db_provider.mjs';

function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodePowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

function prependRemotePath(target, script) {
  const entries = Array.isArray(target.remotePath) ? target.remotePath.map(String) : [];
  if (entries.length === 0) return script;
  if (target.platform === 'windows') {
    return `$env:PATH = ${powershellQuote(entries.join(';'))} + [IO.Path]::PathSeparator + $env:PATH; ${script}`;
  }
  return `export PATH=${posixQuote(entries.join(':'))}:"$PATH"; ${script}`;
}

function wrapRemoteScript(target, script) {
  const preparedScript = prependRemotePath(target, script);
  if (target.platform === 'windows') {
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(preparedScript)}`;
  }
  return `bash -lc ${posixQuote(preparedScript)}`;
}

function buildWindowsOrphanedMutagenCleanupScript() {
  return [
    'try {',
    `  $mutagenAgents = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'mutagen-agent.exe'" -ErrorAction SilentlyContinue);`,
    '  foreach ($agent in $mutagenAgents) {',
    '    $launcher = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $agent.ParentProcessId) -ErrorAction SilentlyContinue;',
    "    if ($null -eq $launcher -or $launcher.Name -ne 'cmd.exe') { continue };",
    '    $sshParentPid = [int]$launcher.ParentProcessId;',
    '    if (-not (Get-Process -Id $sshParentPid -ErrorAction SilentlyContinue)) {',
    '      & taskkill.exe /PID ([string]$launcher.ProcessId) /T /F | Out-Null',
    '    }',
    '  }',
    '} catch { }',
  ].join(' ');
}

export function buildRemoteEnsureDirectoriesCommand(target) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        "$ProgressPreference = 'SilentlyContinue'",
        buildWindowsOrphanedMutagenCleanupScript(),
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(target.repoDir)} | Out-Null`,
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(target.cliHomeDir)} | Out-Null`,
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    `set -euo pipefail; mkdir -p -- ${posixQuote(target.repoDir)} ${posixQuote(target.cliHomeDir)}`,
  );
}

export function buildRemoteBootstrapCommand(target) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `Set-Location -LiteralPath ${powershellQuote(target.repoDir)}`,
        'if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required on the remote target" }',
        'if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { throw "Corepack is required on the remote target" }',
        `$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = Join-Path $env:USERPROFILE '.cache'`,
        'corepack yarn node ./apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs',
        'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `cd -- ${posixQuote(target.repoDir)}`,
      'command -v node >/dev/null || { echo "Node.js is required on the remote target" >&2; exit 127; }',
      'command -v corepack >/dev/null || { echo "Corepack is required on the remote target" >&2; exit 127; }',
      'export HAPPIER_STACK_PM_CACHE_BASE_DIR="$HOME/.cache"',
      'corepack yarn node ./apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs',
    ].join('; '),
  );
}

export function buildRemoteDoctorCommand(target) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        'if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required on the remote target" }',
        'if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { throw "Corepack is required on the remote target" }',
        'node --version',
        'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        'corepack --version',
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      'command -v node >/dev/null || { echo "Node.js is required on the remote target" >&2; exit 127; }',
      'command -v corepack >/dev/null || { echo "Corepack is required on the remote target" >&2; exit 127; }',
      'node --version',
      'corepack --version',
    ].join('; '),
  );
}

export function buildRemoteInstallCredentialCommand(target, { stagedPath, finalPath }) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `$destination = ${powershellQuote(finalPath)}`,
        'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null',
        `Move-Item -Force -LiteralPath ${powershellQuote(stagedPath)} -Destination $destination`,
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `install -d -m 700 -- ${posixQuote(finalPath.slice(0, finalPath.lastIndexOf('/')))}`,
      `install -m 600 -- ${posixQuote(stagedPath)} ${posixQuote(finalPath)}`,
      `rm -f -- ${posixQuote(stagedPath)}`,
    ].join('; '),
  );
}

function requireServicePort(value, label, { optional = false } = {}) {
  if (optional && value == null) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`[dev-targets] ${label} must be an integer from 1024 to 65535`);
  }
  return port;
}

const REMOTE_SERVER_LIGHT_SEMANTIC_ENV_KEYS = new Set([
  'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY',
  'HAPPIER_SQLITE_BUSY_TIMEOUT_MS',
  'HAPPIER_SQLITE_CONNECTION_LIMIT',
]);
const REMOTE_SERVER_LIGHT_SEMANTIC_ENV_PREFIXES = ['HAPPIER_SERVER_RETENTION__'];

function projectRemoteServerLightSemanticEnvironment(env) {
  const projected = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    const included = REMOTE_SERVER_LIGHT_SEMANTIC_ENV_KEYS.has(key)
      || REMOTE_SERVER_LIGHT_SEMANTIC_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (!included || value == null) continue;
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new Error('[dev-targets] invalid remote server semantic environment key');
    }
    const normalized = String(value).trim();
    if (!normalized) continue;
    if (/[\0\r\n]/.test(normalized)) {
      throw new Error('[dev-targets] invalid remote server semantic environment value');
    }
    projected[key] = normalized;
  }
  return projected;
}

export function resolveRemoteServerRuntimeConfig({ serverComponentName, env = {} } = {}) {
  if (serverComponentName !== 'happier-server-light') {
    throw new Error('[dev-targets] remote server placement only supports happier-server-light');
  }
  const effectiveProvider = resolveEffectiveDbProvider({ serverComponentName, env });
  if (!effectiveProvider.ok || effectiveProvider.provider !== 'sqlite') {
    throw new Error('[dev-targets] remote server placement only supports SQLite');
  }
  const environment = projectRemoteServerLightSemanticEnvironment(env);
  if (environment.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY !== 'optional') {
    throw new Error('[dev-targets] remote server encryption storage policy must be optional');
  }
  if (environment.HAPPIER_SQLITE_CONNECTION_LIMIT !== '1') {
    throw new Error('[dev-targets] remote server SQLite connection limit must be 1');
  }
  return {
    serverComponentName: 'happier-server-light',
    dbProvider: 'sqlite',
    environment,
  };
}

function normalizeRemoteServerRuntimeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[dev-targets] remote server placement requires a supported server runtime configuration');
  }
  return resolveRemoteServerRuntimeConfig({
    serverComponentName: config.serverComponentName,
    env: {
      ...(config.environment ?? {}),
      HAPPIER_DB_PROVIDER: config.dbProvider,
    },
  });
}

function requireStableOuterServerUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || /[\0\r\n]/.test(text)) {
    throw new Error('[dev-targets] remote server placement requires a stable outer --server-public-url');
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('[dev-targets] remote server placement requires an HTTP(S) --server-public-url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('[dev-targets] remote server placement requires an HTTP(S) --server-public-url');
  }
  return text;
}

function buildRemoteDevArgs({ services, serverUrl, publicServerUrl, startMobile = false }) {
  const args = [];
  if (!services.server) args.push('--no-server');
  if (!services.expo) args.push('--no-ui');
  if (!services.daemon) args.push('--no-daemon');
  args.push('--no-browser', '--no-dev-targets', '--watch');
  if (services.expo && startMobile) args.push('--mobile');
  if (services.server) {
    if (publicServerUrl) args.push(`--server-public-url=${publicServerUrl}`);
  } else {
    args.push(`--server-url=${serverUrl}`);
    if (publicServerUrl) args.push(`--server-public-url=${publicServerUrl}`);
  }
  return args;
}

function resolveRemoteStackInvocation(target, {
  services,
  serverUrl,
  publicServerUrl = '',
  activeServerId,
  stackName,
  remoteServerPort = null,
  remoteExpoPort = null,
  expoPublicPort = null,
  expoPublicUrl = '',
  startMobile = false,
  resolveServerPublicUrlOnTarget = false,
  resolveExpoPublicUrlOnTarget = false,
  remoteServerRuntimeConfig = null,
  deferDaemonStartUntilCredentials = false,
}) {
  const normalizedServices = {
    server: services?.server === true,
    expo: services?.expo === true,
    daemon: services?.daemon === true,
  };
  if (!Object.values(normalizedServices).some(Boolean)) {
    throw new Error('[dev-targets] remote Stack command requires at least one service');
  }
  const serverPort = normalizedServices.server
    ? requireServicePort(remoteServerPort, 'remote server port')
    : null;
  const expoPort = normalizedServices.expo
    ? requireServicePort(remoteExpoPort, 'remote Expo port')
    : null;
  const stablePublicExpoPort = normalizedServices.expo && resolveExpoPublicUrlOnTarget
    ? requireServicePort(expoPublicPort, 'public Expo port')
    : null;
  const serverRuntimeConfig = normalizedServices.server
    ? normalizeRemoteServerRuntimeConfig(remoteServerRuntimeConfig)
    : null;
  const stablePublicServerUrl = normalizedServices.server
    ? (resolveServerPublicUrlOnTarget ? '' : requireStableOuterServerUrl(publicServerUrl))
    : publicServerUrl;
  const stackStorageDir = `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/stack-state`;
  const stackBaseDir = `${stackStorageDir}/${stackName}`;
  const stackEnvPath = `${stackBaseDir}/env`;
  const stackEnvLines = [
    `HAPPIER_STACK_REPO_DIR=${target.repoDir}`,
    `HAPPIER_STACK_CLI_HOME_DIR=${target.cliHomeDir}`,
    `HAPPIER_STACK_SERVER_COMPONENT=${serverRuntimeConfig?.serverComponentName ?? 'happier-server-light'}`,
    ...(serverPort == null ? [] : [`HAPPIER_STACK_SERVER_PORT=${serverPort}`]),
    ...(expoPort == null ? [] : [
      `HAPPIER_STACK_EXPO_DEV_PORT=${expoPort}`,
      'HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY=stable',
      'HAPPIER_STACK_EXPO_HOST=localhost',
    ]),
    ...(stablePublicExpoPort == null ? [] : [`HAPPIER_STACK_EXPO_PUBLIC_PORT=${stablePublicExpoPort}`]),
    ...(expoPublicUrl && !resolveExpoPublicUrlOnTarget ? [`EXPO_PACKAGER_PROXY_URL=${expoPublicUrl}`] : []),
    'HAPPIER_CLI_PKGROLL_TIMEOUT_MS=1800000',
    ...(normalizedServices.daemon && deferDaemonStartUntilCredentials
      ? ['HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1']
      : []),
    ...(serverRuntimeConfig ? [
      `HAPPIER_DB_PROVIDER=${serverRuntimeConfig.dbProvider}`,
      ...Object.entries(serverRuntimeConfig.environment).map(([key, value]) => `${key}=${value}`),
    ] : []),
  ];
  return {
    activeServerId,
    devArgs: buildRemoteDevArgs({
      services: normalizedServices,
      serverUrl,
      publicServerUrl: stablePublicServerUrl,
      startMobile,
    }),
    stackBaseDir,
    stackEnvLines,
    stackEnvPath,
    stackName,
    stackStorageDir,
  };
}

function formatPosixDevArg(arg) {
  const separator = arg.indexOf('=');
  if (separator < 0) return arg;
  return `${arg.slice(0, separator + 1)}${posixQuote(arg.slice(separator + 1))}`;
}

function formatPowerShellDevArg(arg) {
  const separator = arg.indexOf('=');
  if (separator < 0) return arg;
  return `${arg.slice(0, separator + 1)}${powershellQuote(arg.slice(separator + 1))}`;
}

export function buildRemoteStackCommand(target, options) {
  const invocation = resolveRemoteStackInvocation(target, options);
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `$env:HAPPIER_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
        `$env:HAPPIER_STACK_CLI_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
        "$env:HAPPIER_STACK_CLI_ROOT_DISABLE = '1'",
        ...(options?.attended === true ? ["$env:HAPPIER_STACK_TUI = '1'"] : []),
        `$env:HAPPIER_STACK_STORAGE_DIR = ${powershellQuote(invocation.stackStorageDir)}`,
        `$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = Join-Path $env:USERPROFILE '.cache'`,
        `$env:HAPPIER_STACK_STACK = ${powershellQuote(invocation.stackName)}`,
        `$env:HAPPIER_ACTIVE_SERVER_ID = ${powershellQuote(invocation.activeServerId)}`,
        `$env:HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID = ${powershellQuote(invocation.activeServerId)}`,
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(invocation.stackBaseDir)} | Out-Null`,
        `$stackEnvPath = ${powershellQuote(invocation.stackEnvPath)}`,
        `@(${invocation.stackEnvLines.map(powershellQuote).join(', ')}) | Set-Content -LiteralPath $stackEnvPath -Encoding Ascii`,
        `Set-Location -LiteralPath ${powershellQuote(target.repoDir)}`,
        `corepack yarn workspace @happier-dev/stack stack dev ${powershellQuote(invocation.stackName)} ${invocation.devArgs.map(formatPowerShellDevArg).join(' ')}`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `export HAPPIER_HOME_DIR=${posixQuote(target.cliHomeDir)}`,
      `export HAPPIER_STACK_CLI_HOME_DIR=${posixQuote(target.cliHomeDir)}`,
      'export HAPPIER_STACK_CLI_ROOT_DISABLE=1',
      ...(options?.attended === true ? ['export HAPPIER_STACK_TUI=1'] : []),
      `export HAPPIER_STACK_STORAGE_DIR=${posixQuote(invocation.stackStorageDir)}`,
      'export HAPPIER_STACK_PM_CACHE_BASE_DIR="$HOME/.cache"',
      `export HAPPIER_STACK_STACK=${posixQuote(invocation.stackName)}`,
      `export HAPPIER_ACTIVE_SERVER_ID=${posixQuote(invocation.activeServerId)}`,
      `export HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID=${posixQuote(invocation.activeServerId)}`,
      `install -d -m 700 -- ${posixQuote(invocation.stackBaseDir)}`,
      `printf '%s\\n' ${invocation.stackEnvLines.map(posixQuote).join(' ')} > ${posixQuote(invocation.stackEnvPath)}`,
      `cd -- ${posixQuote(target.repoDir)}`,
      `exec corepack yarn workspace @happier-dev/stack stack dev ${posixQuote(invocation.stackName)} ${invocation.devArgs.map(formatPosixDevArg).join(' ')}`,
    ].join('; '),
  );
}

export function buildRemoteStackStopCommand(target, options) {
  const invocation = resolveRemoteStackInvocation(target, options);
  const command = `corepack yarn workspace @happier-dev/stack stack stop ${target.platform === 'windows'
    ? powershellQuote(invocation.stackName)
    : posixQuote(invocation.stackName)} --yes --no-docker --preserve-daemon`;
  if (target.platform === 'windows') {
    return wrapRemoteScript(target, [
      '$ErrorActionPreference = "Stop"',
      "$env:HAPPIER_STACK_CLI_ROOT_DISABLE = '1'",
      `$env:HAPPIER_STACK_STORAGE_DIR = ${powershellQuote(invocation.stackStorageDir)}`,
      `Set-Location -LiteralPath ${powershellQuote(target.repoDir)}`,
      command,
      'exit $LASTEXITCODE',
    ].join('; '));
  }
  return wrapRemoteScript(target, [
    'set -euo pipefail',
    'export HAPPIER_STACK_CLI_ROOT_DISABLE=1',
    `export HAPPIER_STACK_STORAGE_DIR=${posixQuote(invocation.stackStorageDir)}`,
    `cd -- ${posixQuote(target.repoDir)}`,
    command,
  ].join('; '));
}

export function buildRemoteForwardProbeCommand(target, { remoteServerPort }) {
  const port = Math.trunc(Number(remoteServerPort));
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        '$client = [System.Net.Sockets.TcpClient]::new()',
        `try { $client.Connect('127.0.0.1', ${port}) } finally { $client.Dispose() }`,
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `exec 3<>/dev/tcp/127.0.0.1/${port}`,
      'exec 3>&-',
    ].join('; '),
  );
}

function renderForwardEndpoint(host, port, { listen = false } = {}) {
  const normalizedHost = listen && host === '0.0.0.0' ? '*' : host;
  return `${normalizedHost}:${port}`;
}

export function buildSshForwardArgs(target, { forwards, sshArgs = [] } = {}) {
  if (!Array.isArray(forwards) || forwards.length === 0) {
    throw new Error('[dev-targets] at least one SSH forward is required');
  }
  return [
    '-T',
    ...sshArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...forwards.flatMap((forward) => {
      if (!['local', 'reverse'].includes(forward.direction)) {
        throw new Error(`[dev-targets] invalid SSH forward direction: ${String(forward.direction)}`);
      }
      return [
        forward.direction === 'local' ? '-L' : '-R',
        `${renderForwardEndpoint(forward.listenHost, forward.listenPort, { listen: true })}:${renderForwardEndpoint(forward.targetHost, forward.targetPort)}`,
      ];
    }),
    '-N',
    target.ssh,
  ];
}

export function buildSshWorkerArgs(
  target,
  { remoteCommand, sshArgs = [] },
) {
  return [
    target.platform === 'windows' ? '-T' : '-tt',
    ...sshArgs,
    '-o',
    'BatchMode=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    target.ssh,
    remoteCommand,
  ];
}
