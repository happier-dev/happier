function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodePowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

function wrapRemoteScript(target, script) {
  if (target.platform === 'windows') {
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
  }
  return `bash -lc ${posixQuote(script)}`;
}

export function buildRemoteEnsureDirectoriesCommand(target) {
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
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

export function buildRemoteDaemonCommand(target, { serverUrl, activeServerId, stackName }) {
  const stackStorageDir = `${String(target.cliHomeDir).replace(/[\\/]+$/, '')}/stack-state`;
  const stackBaseDir = `${stackStorageDir}/${stackName}`;
  const stackEnvPath = `${stackBaseDir}/env`;
  const stackEnvLines = [
    `HAPPIER_STACK_REPO_DIR=${target.repoDir}`,
    `HAPPIER_STACK_CLI_HOME_DIR=${target.cliHomeDir}`,
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
    'HAPPIER_CLI_PKGROLL_TIMEOUT_MS=1800000',
  ];
  if (target.platform === 'windows') {
    return wrapRemoteScript(
      target,
      [
        '$ErrorActionPreference = "Stop"',
        `$env:HAPPIER_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
        `$env:HAPPIER_STACK_CLI_HOME_DIR = ${powershellQuote(target.cliHomeDir)}`,
        `$env:HAPPIER_STACK_STORAGE_DIR = ${powershellQuote(stackStorageDir)}`,
        `$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = Join-Path $env:USERPROFILE '.cache'`,
        `$env:HAPPIER_STACK_STACK = ${powershellQuote(stackName)}`,
        `$env:HAPPIER_ACTIVE_SERVER_ID = ${powershellQuote(activeServerId)}`,
        `$env:HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID = ${powershellQuote(activeServerId)}`,
        `New-Item -ItemType Directory -Force -Path ${powershellQuote(stackBaseDir)} | Out-Null`,
        `$stackEnvPath = ${powershellQuote(stackEnvPath)}`,
        `@(${stackEnvLines.map(powershellQuote).join(', ')}) | Set-Content -LiteralPath $stackEnvPath -Encoding Ascii`,
        `Set-Location -LiteralPath ${powershellQuote(target.repoDir)}`,
        `corepack yarn workspace @happier-dev/stack stack dev ${powershellQuote(stackName)} --no-server --no-ui --no-browser --no-dev-targets --watch --server-url=${powershellQuote(serverUrl)}`,
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
      `export HAPPIER_STACK_STORAGE_DIR=${posixQuote(stackStorageDir)}`,
      'export HAPPIER_STACK_PM_CACHE_BASE_DIR="$HOME/.cache"',
      `export HAPPIER_STACK_STACK=${posixQuote(stackName)}`,
      `export HAPPIER_ACTIVE_SERVER_ID=${posixQuote(activeServerId)}`,
      `export HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID=${posixQuote(activeServerId)}`,
      `install -d -m 700 -- ${posixQuote(stackBaseDir)}`,
      `printf '%s\\n' ${stackEnvLines.map(posixQuote).join(' ')} > ${posixQuote(stackEnvPath)}`,
      `cd -- ${posixQuote(target.repoDir)}`,
      `exec corepack yarn workspace @happier-dev/stack stack dev ${posixQuote(stackName)} --no-server --no-ui --no-browser --no-dev-targets --watch --server-url=${posixQuote(serverUrl)}`,
    ].join('; '),
  );
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
