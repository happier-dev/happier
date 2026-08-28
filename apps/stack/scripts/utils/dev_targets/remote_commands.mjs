import { createHash } from 'node:crypto';

import { buildStackStableScopeId } from '../auth/stable_scope_id.mjs';
import { REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN } from '../managed_lima/provisioner.mjs';
import { resolveEffectiveDbProvider } from '../server/effective_db_provider.mjs';

export const REMOTE_DEPENDENCY_ADMISSION = Object.freeze({
  directCommands: Object.freeze([
    'node',
    'npm',
    'npx',
    'pnpm',
    'tsc',
    'vitest',
    'yarn',
  ]),
  corepackSubcommands: Object.freeze(['npm', 'pnpm', 'yarn']),
});

export const REMOTE_COMMAND_CLASSIFICATION = Object.freeze({
  primaryOnlyDirectCommands: Object.freeze(['git']),
  sourceSearchDirectCommands: Object.freeze(['find', 'grep', 'rg']),
  validationDirectCommands: Object.freeze(['tsc', 'vitest']),
  validationScriptFamilies: Object.freeze(['build', 'check', 'lint', 'test', 'typecheck', 'vitest']),
});

function commandBasename(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').split('/').at(-1);
}

export function classifyRemoteCommand(commandArgs, { cwd = '.' } = {}) {
  if (!Array.isArray(commandArgs) || commandArgs.length === 0) {
    return { placement: 'worker-eligible', commandClass: 'unclassified' };
  }
  if (REMOTE_COMMAND_CLASSIFICATION.primaryOnlyDirectCommands.includes(commandBasename(commandArgs[0]))) {
    return { placement: 'primary-only', commandClass: 'vcs-authority' };
  }
  if (REMOTE_COMMAND_CLASSIFICATION.sourceSearchDirectCommands.includes(commandBasename(commandArgs[0]))) {
    return { placement: 'worker-eligible', commandClass: 'source-search' };
  }
  if (
    REMOTE_COMMAND_CLASSIFICATION.validationDirectCommands.includes(commandBasename(commandArgs[0]))
    || REMOTE_COMMAND_CLASSIFICATION.validationScriptFamilies.includes(resolvePackageManagerScriptFamily(commandArgs))
  ) {
    return {
      placement: 'worker-eligible',
      commandClass: isRepositoryRootCwd(cwd) ? 'full-validation' : 'targeted-validation',
    };
  }
  return { placement: 'worker-eligible', commandClass: 'unclassified' };
}

function resolvePackageManagerScriptFamily(commandArgs) {
  const args = Array.isArray(commandArgs) ? commandArgs.map((value) => String(value ?? '').trim()) : [];
  let commandIndex = 0;
  if (commandBasename(args[0]) === 'corepack') commandIndex = 1;
  const command = commandBasename(args[commandIndex]);
  if (!REMOTE_DEPENDENCY_ADMISSION.corepackSubcommands.includes(command)) return '';

  const scriptArgs = args.slice(commandIndex + 1);
  for (let index = 0; index < scriptArgs.length; index += 1) {
    const argument = scriptArgs[index];
    if (argument === 'run') continue;
    if (argument === '--cwd' || argument === '-C') {
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) continue;
    return argument.split(':', 1)[0];
  }
  return '';
}

function isRepositoryRootCwd(cwd) {
  const normalized = String(cwd ?? '.').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized === '' || normalized === '.';
}

export function requiresRemoteWorkspacePreparation(commandArgs, { cwd = '.' } = {}) {
  return classifyRemoteCommand(commandArgs, { cwd }).commandClass === 'targeted-validation';
}

export function requiresRemoteDependencyBootstrap(commandArgs) {
  if (!Array.isArray(commandArgs) || commandArgs.length === 0) return false;
  const command = commandBasename(commandArgs[0]);
  if (command === 'corepack') {
    return REMOTE_DEPENDENCY_ADMISSION.corepackSubcommands.includes(
      String(commandArgs[1] ?? '').trim(),
    );
  }
  return REMOTE_DEPENDENCY_ADMISSION.directCommands.includes(command);
}

function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function powershellNativeArgument(value) {
  const escaped = String(value).replace(/(\\*)"/g, (_match, backslashes) => (
    `${backslashes}${backslashes}\\"`
  ));
  return powershellQuote(escaped);
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

function requireRemoteRelativeWorkingDirectory(target, cwd) {
  const raw = String(cwd ?? '.').trim() || '.';
  if (/\0|\r|\n/.test(raw)) {
    throw new Error('[dev-targets] invalid remote working directory');
  }
  const slashNormalized = raw.replace(/\\/g, '/');
  if (
    slashNormalized.startsWith('/')
    || /^[A-Za-z]:\//.test(slashNormalized)
    || slashNormalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('[dev-targets] remote working directory must stay inside the synchronized repository');
  }
  const segments = slashNormalized.split('/').filter((segment) => segment && segment !== '.');
  const root = String(target.repoDir).replace(/[\\/]+$/, '');
  return segments.length ? `${root}/${segments.join('/')}` : root;
}

function normalizeRemoteEnvironment(environment) {
  const result = [];
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`[dev-targets] invalid remote environment key: ${key}`);
    }
    const normalized = String(value ?? '');
    if (normalized.includes('\0')) {
      throw new Error(`[dev-targets] invalid remote environment value for ${key}`);
    }
    result.push([key, normalized]);
  }
  return result;
}

function requireRemoteExecutionId(executionId) {
  const normalized = String(executionId ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(normalized)) {
    throw new Error('[dev-targets] remote execution id must be a path-safe opaque identifier');
  }
  return normalized;
}

function resolveRemoteExecutionPidFile(target, executionId) {
  const normalizedHome = String(target.cliHomeDir).replace(/[\\/]+$/, '');
  return `${normalizedHome}/remote-exec/${requireRemoteExecutionId(executionId)}.pid`;
}

export function buildRemoteExecCommand(
  target,
  { executionId, cwd = '.', commandArgs, environment = {} } = {},
) {
  const args = Array.isArray(commandArgs) ? commandArgs.map(String) : [];
  if (args.length === 0 || !args[0]) {
    throw new Error('[dev-targets] remote command is required');
  }
  if (args.some((value) => value.includes('\0'))) {
    throw new Error('[dev-targets] remote command arguments cannot contain NUL bytes');
  }
  const workingDirectory = requireRemoteRelativeWorkingDirectory(target, cwd);
  const environmentEntries = normalizeRemoteEnvironment(environment);
  const normalizedExecutionId = requireRemoteExecutionId(executionId);
  const pidFile = resolveRemoteExecutionPidFile(target, normalizedExecutionId);
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        "$ProgressPreference = 'SilentlyContinue'",
        `$pidFile = ${powershellQuote(pidFile)}`,
        'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile) | Out-Null',
        '$selfProcess = Get-Process -Id $PID',
        '"$PID|$($selfProcess.StartTime.ToUniversalTime().Ticks)" | Set-Content -LiteralPath $pidFile -Encoding Ascii -NoNewline',
        'try { '
          + `Set-Location -LiteralPath ${powershellQuote(workingDirectory)}; `
          + environmentEntries.map(([key, value]) => `$env:${key} = ${powershellQuote(value)}; `).join('')
          + `& ${args.map(powershellNativeArgument).join(' ')}; `
          + '$commandStatus = $LASTEXITCODE; '
          + 'if ($null -eq $commandStatus) { $commandStatus = 0 }; '
          + 'exit $commandStatus '
          + '} finally { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $pidFile }',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `execution_id=${posixQuote(normalizedExecutionId)}`,
      `pid_file=${posixQuote(pidFile)}`,
      'mkdir -p -- "$(dirname -- "$pid_file")"',
      'printf \'%s\\n\' "$$" > "$pid_file"',
      'cleanup_remote_exec_pid_file() { rm -f -- "$pid_file"; }',
      'trap cleanup_remote_exec_pid_file EXIT',
      `cd -- ${posixQuote(workingDirectory)}`,
      ...environmentEntries.map(([key, value]) => `export ${key}=${posixQuote(value)}`),
      'set +e',
      `${args.map(posixQuote).join(' ')}`,
      'command_status=$?',
      'exit "$command_status"',
    ].join('; '),
  );
}

export function buildRemoteCancelCommand(target, { executionId } = {}) {
  const normalizedExecutionId = requireRemoteExecutionId(executionId);
  const pidFile = resolveRemoteExecutionPidFile(target, normalizedExecutionId);
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        "$ProgressPreference = 'SilentlyContinue'",
        `$pidFile = ${powershellQuote(pidFile)}`,
        'if (-not (Test-Path -LiteralPath $pidFile)) { exit 0 }',
        'try { '
          + '$identity = (Get-Content -Raw -LiteralPath $pidFile).Trim().Split(\'|\'); '
          + 'if ($identity.Count -ne 2) { exit 0 }; '
          + '[int]$remoteProcessId = 0; [long]$remoteStartTicks = 0; '
          + 'if (-not [int]::TryParse($identity[0], [ref]$remoteProcessId)) { exit 0 }; '
          + 'if (-not [long]::TryParse($identity[1], [ref]$remoteStartTicks)) { exit 0 }; '
          + '$remoteProcess = Get-Process -Id $remoteProcessId -ErrorAction SilentlyContinue; '
          + 'if ($null -eq $remoteProcess) { exit 0 }; '
          + 'if ($remoteProcess.StartTime.ToUniversalTime().Ticks -ne $remoteStartTicks) { exit 0 }; '
          + 'taskkill.exe /PID $remoteProcessId /T /F | Out-Null; '
          + 'exit 0 '
          + '} finally { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $pidFile }',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -u',
      `execution_id=${posixQuote(normalizedExecutionId)}`,
      `pid_file=${posixQuote(pidFile)}`,
      '[ -f "$pid_file" ] || exit 0',
      'remote_pid=$(sed -n \'1p\' "$pid_file" 2>/dev/null || true)',
      'case "$remote_pid" in \'\'|*[!0-9]*) rm -f -- "$pid_file"; exit 0 ;; esac',
      'remote_command=$(ps -p "$remote_pid" -o command= 2>/dev/null || true)',
      'case "$remote_command" in *"$execution_id"*) ;; *) rm -f -- "$pid_file"; exit 0 ;; esac',
      'collect_descendants() { '
        + 'for child_pid in $(ps -eo pid=,ppid= | awk -v parent="$1" \'$2 == parent { print $1 }\'); do '
        + 'collect_descendants "$child_pid"; '
        + 'done; '
        + 'printf \'%s\\n\' "$1"; '
        + '}',
      'process_ids=$(collect_descendants "$remote_pid")',
      'for process_id in $process_ids; do kill -TERM "$process_id" 2>/dev/null || true; done',
      'attempt=0',
      'while [ "$attempt" -lt 20 ]; do '
        + 'remaining=0; '
        + 'for process_id in $process_ids; do kill -0 "$process_id" 2>/dev/null && remaining=1; done; '
        + '[ "$remaining" -eq 0 ] && break; '
        + 'sleep 0.1; '
        + 'attempt=$((attempt + 1)); '
        + 'done',
      'for process_id in $process_ids; do kill -KILL "$process_id" 2>/dev/null || true; done',
      'rm -f -- "$pid_file"',
      'exit 0',
    ].join('; '),
  );
}

function wrapRemoteScript(target, script) {
  const wrappedScript = prependRemotePath(target, script);
  if (target.platform === 'windows') {
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(wrappedScript)}`;
  }
  return `bash -lc ${posixQuote(wrappedScript)}`;
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

export function buildRemoteDoctorCommand(target) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.map(({ command, label }) => (
          `if (-not (Get-Command ${command} -ErrorAction SilentlyContinue)) { throw "${label} is required on the remote target" }`
        )),
        ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.flatMap(({ command }) => [
          `${command} --version`,
          'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        ]),
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.map(({ command, label }) => (
        `command -v ${command} >/dev/null || { echo "${label} is required on the remote target" >&2; exit 127; }`
      )),
      ...REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN.map(({ command }) => `${command} --version`),
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

function isRemoteServerLightSemanticEnvKey(key) {
  return REMOTE_SERVER_LIGHT_SEMANTIC_ENV_KEYS.has(key)
    || REMOTE_SERVER_LIGHT_SEMANTIC_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function projectRemoteServerLightSemanticEnvironment(env) {
  const projected = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!isRemoteServerLightSemanticEnvKey(key) || value == null) continue;
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
  if (!effectiveProvider.ok) {
    throw new Error('[dev-targets] remote server placement has an unsupported SQLite provider configuration');
  }
  if (effectiveProvider.provider !== 'sqlite') {
    throw new Error('[dev-targets] remote server placement only supports SQLite');
  }
  return {
    serverComponentName: 'happier-server-light',
    dbProvider: 'sqlite',
    environment: projectRemoteServerLightSemanticEnvironment(env),
  };
}

function normalizeRemoteServerRuntimeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[dev-targets] remote server placement requires a supported server runtime configuration');
  }
  const environment = config.environment ?? {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('[dev-targets] remote server semantic environment must be an object');
  }
  const envProvider = environment.HAPPIER_DB_PROVIDER;
  if (
    config.dbProvider != null
    && envProvider != null
    && String(config.dbProvider).trim().toLowerCase() !== String(envProvider).trim().toLowerCase()
  ) {
    throw new Error('[dev-targets] remote server runtime DB provider configuration conflicts');
  }
  return resolveRemoteServerRuntimeConfig({
    serverComponentName: config.serverComponentName,
    env: {
      ...environment,
      ...(config.dbProvider != null ? { HAPPIER_DB_PROVIDER: config.dbProvider } : {}),
    },
  });
}

function requireStableOuterServerUrl(value) {
  const urlText = String(value ?? '').trim();
  if (!urlText || /[\0\r\n]/.test(urlText)) {
    throw new Error('[dev-targets] remote server placement requires a stable outer --server-public-url');
  }
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error('[dev-targets] remote server placement requires an HTTP(S) --server-public-url');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('[dev-targets] remote server placement requires an HTTP(S) --server-public-url');
  }
  return urlText;
}

function buildRemoteDevArgs({ services, serverUrl, publicServerUrl, startMobile }) {
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

function resolveRemoteTargetStackName(target, { stackName } = {}) {
  const controllerStackName = String(stackName ?? '').trim();
  const targetName = String(target?.name ?? '').trim().toLowerCase();
  if (!controllerStackName || !targetName) {
    throw new Error('[dev-targets] remote Stack identity requires controller Stack and target names');
  }
  const targetToken = targetName
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'target';
  const fingerprint = createHash('sha256')
    .update(`${controllerStackName}\0${targetName}\0${String(target.repoDir ?? '')}\0${String(target.cliHomeDir ?? '')}`)
    .digest('hex')
    .slice(0, 16);
  return `dev-target-${targetToken}-${fingerprint}`;
}

export function resolveRemoteStackStatePaths(target, { stackName } = {}) {
  const remoteStackName = resolveRemoteTargetStackName(target, { stackName });
  const stackStorageDir = `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/stack-state`;
  const stackBaseDir = `${stackStorageDir}/${remoteStackName}`;
  return {
    activeServerId: buildStackStableScopeId({
      stackName: remoteStackName,
      cliIdentity: 'default',
    }),
    stackName: remoteStackName,
    stackStorageDir,
    stackBaseDir,
    stackEnvPath: `${stackBaseDir}/env`,
  };
}

export function buildRemoteStackRetirementProbeCommand(target, { stackName } = {}) {
  const { stackBaseDir } = resolveRemoteStackStatePaths(target, { stackName });
  const runtimeStatePath = `${stackBaseDir}/stack.runtime.json`;
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `if (Test-Path -LiteralPath ${powershellQuote(runtimeStatePath)}) { exit 1 }`,
        'exit 0',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `test ! -e ${posixQuote(runtimeStatePath)}`,
    ].join('; '),
  );
}

function resolveRemoteStackInvocation(target, {
  services,
  serverUrl,
  publicServerUrl = '',
  stackName,
  remoteServerPort = null,
  remoteExpoPort = null,
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
  const serverRuntimeConfig = normalizedServices.server
    ? normalizeRemoteServerRuntimeConfig(remoteServerRuntimeConfig)
    : null;
  const stablePublicServerUrl = normalizedServices.server
    ? (resolveServerPublicUrlOnTarget ? '' : requireStableOuterServerUrl(publicServerUrl))
    : publicServerUrl;
  const expoPort = normalizedServices.expo
    ? requireServicePort(remoteExpoPort, 'remote Expo port')
    : null;
  const {
    activeServerId,
    stackName: remoteStackName,
    stackStorageDir,
    stackBaseDir,
    stackEnvPath,
  } = resolveRemoteStackStatePaths(target, { stackName });
  const stackServerComponent = serverRuntimeConfig?.serverComponentName ?? 'happier-server-light';
  const stackDbProvider = serverRuntimeConfig?.dbProvider ?? 'sqlite';
  const stackEnvLines = [
    `HAPPIER_STACK_REPO_DIR=${target.repoDir}`,
    `HAPPIER_STACK_CLI_HOME_DIR=${target.cliHomeDir}`,
    `HAPPIER_STACK_SERVER_COMPONENT=${stackServerComponent}`,
    `HAPPIER_DB_PROVIDER=${stackDbProvider}`,
    ...Object.entries(serverRuntimeConfig?.environment ?? {}).map(([key, value]) => `${key}=${value}`),
    'HAPPIER_CLI_PKGROLL_TIMEOUT_MS=1800000',
    'HAPPIER_DEV_TARGET_EXECUTION=1',
    ...(normalizedServices.daemon && deferDaemonStartUntilCredentials
      ? ['HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1']
      : []),
    ...(serverPort ? [`HAPPIER_STACK_SERVER_PORT=${serverPort}`] : []),
    ...(expoPort ? [
      `HAPPIER_STACK_EXPO_DEV_PORT=${expoPort}`,
      'HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY=stable',
      'HAPPIER_STACK_EXPO_HOST=localhost',
    ] : []),
    ...(expoPublicUrl && !resolveExpoPublicUrlOnTarget ? [`EXPO_PACKAGER_PROXY_URL=${expoPublicUrl}`] : []),
  ];
  const devArgs = buildRemoteDevArgs({
    services: normalizedServices,
    serverUrl,
    publicServerUrl: stablePublicServerUrl,
    startMobile,
  });
  return {
    activeServerId,
    devArgs,
    stackBaseDir,
    stackEnvLines,
    stackEnvPath,
    stackServerComponent,
    stackDbProvider,
    stackName: remoteStackName,
    stackStorageDir,
  };
}

function buildWindowsRemoteStackPrelude(target, invocation) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$env:HAPPIER_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
    `$env:HAPPIER_STACK_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
    `$env:HAPPIER_STACK_CLI_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
    `$env:HAPPIER_STACK_STORAGE_DIR = ${powershellQuote(invocation.stackStorageDir)}`,
    `$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = ${powershellQuote(`${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`)}`,
    `$env:HAPPIER_STACK_STACK = ${powershellQuote(invocation.stackName)}`,
    `$env:HAPPIER_ACTIVE_SERVER_ID = ${powershellQuote(invocation.activeServerId)}`,
    `$env:HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID = ${powershellQuote(invocation.activeServerId)}`,
    `Set-Location -LiteralPath ${powershellQuote(target.repoDir)}`,
  ];
}

function buildPosixRemoteStackPrelude(target, invocation) {
  return [
    'set -euo pipefail',
    `export HAPPIER_HOME_DIR=${posixQuote(target.cliHomeDir)}`,
    `export HAPPIER_STACK_HOME_DIR=${posixQuote(target.cliHomeDir)}`,
    `export HAPPIER_STACK_CLI_HOME_DIR=${posixQuote(target.cliHomeDir)}`,
    `export HAPPIER_STACK_STORAGE_DIR=${posixQuote(invocation.stackStorageDir)}`,
    `export HAPPIER_STACK_PM_CACHE_BASE_DIR=${posixQuote(`${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/cache`)}`,
    `export HAPPIER_STACK_STACK=${posixQuote(invocation.stackName)}`,
    `export HAPPIER_ACTIVE_SERVER_ID=${posixQuote(invocation.activeServerId)}`,
    `export HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID=${posixQuote(invocation.activeServerId)}`,
    `cd -- ${posixQuote(target.repoDir)}`,
  ];
}

function buildWindowsRemoteStackInitializationCommands(target, invocation) {
  return [
    `corepack yarn workspace @happier-dev/stack stack new ${powershellQuote(invocation.stackName)} --server=${powershellQuote(invocation.stackServerComponent)} --db-provider=${powershellQuote(invocation.stackDbProvider)} --repo=${powershellQuote(target.repoDir)} --no-copy-auth --non-interactive --if-missing`,
    `corepack yarn workspace @happier-dev/stack stack env ${powershellQuote(invocation.stackName)} set ${invocation.stackEnvLines.map(powershellQuote).join(' ')}`,
  ];
}

function buildPosixRemoteStackInitializationCommands(target, invocation) {
  return [
    `corepack yarn workspace @happier-dev/stack stack new ${posixQuote(invocation.stackName)} --server=${posixQuote(invocation.stackServerComponent)} --db-provider=${posixQuote(invocation.stackDbProvider)} --repo=${posixQuote(target.repoDir)} --no-copy-auth --non-interactive --if-missing`,
    `corepack yarn workspace @happier-dev/stack stack env ${posixQuote(invocation.stackName)} set ${invocation.stackEnvLines.map(posixQuote).join(' ')}`,
  ];
}

export function buildRemoteStackStopCommand(target, options) {
  const invocation = resolveRemoteStackInvocation(target, options);
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        ...buildWindowsRemoteStackPrelude(target, invocation),
        "$env:HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = '0'",
        "$env:HAPPIER_STACK_UPDATE_CHECK = '0'",
        `corepack yarn workspace @happier-dev/stack stack stop ${powershellQuote(invocation.stackName)} --yes --no-docker`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      ...buildPosixRemoteStackPrelude(target, invocation),
      'export HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=0',
      'export HAPPIER_STACK_UPDATE_CHECK=0',
      `exec corepack yarn workspace @happier-dev/stack stack stop ${posixQuote(invocation.stackName)} --yes --no-docker`,
    ].join('; '),
  );
}

export function buildRemoteStackCommand(target, options) {
  const invocation = resolveRemoteStackInvocation(target, options);
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        ...buildWindowsRemoteStackPrelude(target, invocation),
        ...buildWindowsRemoteStackInitializationCommands(target, invocation).flatMap((command) => [
          command,
          'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        ]),
        `corepack yarn workspace @happier-dev/stack stack dev ${powershellQuote(invocation.stackName)} ${invocation.devArgs.map(formatPowerShellDevArg).join(' ')}`,
        'exit $LASTEXITCODE',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      ...buildPosixRemoteStackPrelude(target, invocation),
      ...buildPosixRemoteStackInitializationCommands(target, invocation),
      `exec corepack yarn workspace @happier-dev/stack stack dev ${posixQuote(invocation.stackName)} ${invocation.devArgs.map(formatPosixDevArg).join(' ')}`,
    ].join('; '),
  );
}

export function buildRemoteDaemonCommand(target, { serverUrl, activeServerId, stackName }) {
  return buildRemoteStackCommand(target, {
    services: { server: false, expo: false, daemon: true },
    serverUrl,
    activeServerId,
    stackName,
  });
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

export function buildRemoteDaemonReadinessProbeCommand(target, { stackName }) {
  const { activeServerId } = resolveRemoteStackStatePaths(target, { stackName });
  const cliHomeDir = String(target.cliHomeDir).replace(/[\\/]+$/, '');
  const statePath = `${cliHomeDir}/servers/${String(activeServerId)}/daemon.state.json`;
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `$statePath = ${powershellQuote(statePath)}`,
        'if (-not (Test-Path -LiteralPath $statePath)) { exit 1 }',
        '$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json',
        'if ($null -eq $state.pid) { exit 1 }',
        '$daemonProcess = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue',
        'if ($null -eq $daemonProcess) { exit 1 }',
        'exit 0',
      ].join('; '),
    );
  }
  return wrapRemoteScript(
    target,
    [
      'set -euo pipefail',
      `state_path=${posixQuote(statePath)}`,
      '[ -f "$state_path" ] || exit 1',
      'daemon_pid=$(sed -n \'s/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p\' "$state_path" | head -n 1)',
      'case "$daemon_pid" in \'\'|*[!0-9]*) exit 1 ;; esac',
      'kill -0 "$daemon_pid" 2>/dev/null',
    ].join('; '),
  );
}

export function buildSshTunnelArgs(
  target,
  { localServerPort, remoteServerPort, sshArgs = [] },
) {
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
    '-N',
    '-R',
    `127.0.0.1:${remoteServerPort}:127.0.0.1:${localServerPort}`,
    target.ssh,
  ];
}

function formatSshForward(forward) {
  const direction = forward?.direction;
  if (direction !== 'local' && direction !== 'reverse') {
    throw new Error('[dev-targets] SSH forward direction must be local or reverse');
  }
  const listenHost = String(forward.listenHost ?? '127.0.0.1').trim();
  const targetHost = String(forward.targetHost ?? '127.0.0.1').trim();
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(listenHost) || !/^[A-Za-z0-9.:[\]-]+$/.test(targetHost)) {
    throw new Error('[dev-targets] invalid SSH forward host');
  }
  // OpenSSH treats `0.0.0.0` as IPv4-only, while `*` is its native dual-stack
  // wildcard. LAN-exposed local forwards (notably remote Metro) must remain
  // reachable when a device resolves this Mac through IPv6/Tailscale.
  const effectiveListenHost = direction === 'local' && listenHost === '0.0.0.0'
    ? '*'
    : listenHost;
  const listenPort = requireServicePort(forward.listenPort, 'SSH forward listen port');
  const targetPort = requireServicePort(forward.targetPort, 'SSH forward target port');
  return {
    flag: direction === 'local' ? '-L' : '-R',
    specification: `${effectiveListenHost}:${listenPort}:${targetHost}:${targetPort}`,
  };
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
      const formatted = formatSshForward(forward);
      return [formatted.flag, formatted.specification];
    }),
    '-N',
    target.ssh,
  ];
}

export function buildSshWorkerArgs(
  target,
  { remoteCommand, sshArgs = [], tty = target.platform !== 'windows' },
) {
  return [
    tty ? '-tt' : '-T',
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
