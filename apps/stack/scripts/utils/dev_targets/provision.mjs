import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { run, runCaptureResult } from '../proc/proc.mjs';

const TARGET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:%_-]*$/;
const USER_RE = /^[A-Za-z0-9._-]+$/;

function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function sshConfigQuote(value) {
  return `"${String(value).replace(/([\\"])/g, '\\$1')}"`;
}

function requireMatching(value, pattern, label) {
  const normalized = String(value ?? '').trim();
  if (!pattern.test(normalized)) throw new Error(`[dev-targets] invalid ${label}: ${JSON.stringify(normalized)}`);
  return normalized;
}

function requireAbsolutePosixPath(value, label) {
  const normalized = String(value ?? '').trim().replace(/\/+$/, '');
  if (!normalized.startsWith('/') || /[\0\r\n]/.test(normalized)) {
    throw new Error(`[dev-targets] ${label} must be an absolute POSIX path`);
  }
  return normalized || '/';
}

function readMarker(output, name) {
  const match = String(output ?? '').match(new RegExp(`__HAPPIER_${name}__=([^\\r\\n]*)`));
  return String(match?.[1] ?? '').trim();
}

async function defaultRunInteractive({ command, args, env }) {
  await run(command, args, { env, stdio: [0, 2, 2] });
}

async function defaultRunCaptureResult({ command, args, env }) {
  return await runCaptureResult(command, args, { env });
}

function configuredSshArgs({ configPath, sshAlias, remoteCommand }) {
  return ['-T', '-F', configPath, sshAlias, remoteCommand];
}

function discoveryCommand() {
  const inner = [
    'printf "__HAPPIER_UNAME__=%s\\n" "$(uname -s)"',
    'printf "__HAPPIER_HOME__=%s\\n" "$HOME"',
    'printf "__HAPPIER_PATH__=%s\\n" "$PATH"',
    'node_command="$(command -v node 2>/dev/null || true)"',
    'node_exec="$(node -p "process.execPath" 2>/dev/null || true)"',
    'node_version="$(node --version 2>/dev/null || true)"',
    'corepack_command="$(command -v corepack 2>/dev/null || true)"',
    'if [ -z "$corepack_command" ] && [ -n "$node_exec" ]; then node_bin_dir="$(dirname "$node_exec")"; [ -x "$node_bin_dir/corepack" ] && corepack_command="$node_bin_dir/corepack"; fi',
    'printf "__HAPPIER_NODE__=%s\\n" "$node_command"',
    'printf "__HAPPIER_NODE_VERSION__=%s\\n" "$node_version"',
    'printf "__HAPPIER_COREPACK__=%s\\n" "$corepack_command"',
  ].join('; ');
  return `remote_shell="${'${SHELL:-/bin/sh}'}"; "$remote_shell" -lic ${posixQuote(inner)}`;
}

function normalizeDiscovery(discovery, { requireToolchain }) {
  if (!discovery?.ok) {
    const detail = String(discovery?.err ?? '').trim() || 'remote discovery failed';
    throw new Error(`[dev-targets] SSH provisioned, but remote discovery failed: ${detail}`);
  }
  const uname = readMarker(discovery.out, 'UNAME');
  if (uname !== 'Darwin' && uname !== 'Linux') {
    throw new Error(`[dev-targets] one-command SSH provisioning currently supports macOS and Linux targets; found ${uname || 'unknown'}`);
  }
  const remoteHome = requireAbsolutePosixPath(readMarker(discovery.out, 'HOME'), 'discovered remote home');
  const nodePath = readMarker(discovery.out, 'NODE');
  const nodeVersion = readMarker(discovery.out, 'NODE_VERSION');
  const corepackPath = readMarker(discovery.out, 'COREPACK');
  if (requireToolchain && (!nodePath.startsWith('/') || !corepackPath.startsWith('/'))) {
    throw new Error(
      '[dev-targets] SSH is ready, but Node.js and Corepack were not discoverable in the remote login shell; install them and rerun add',
    );
  }
  const nodeMajor = Number(nodeVersion.match(/^v?(\d+)/)?.[1]);
  if (requireToolchain && Number.isInteger(nodeMajor) && nodeMajor < 22) {
    throw new Error(
      `[dev-targets] SSH is ready, but Node.js 22 or newer is required; found ${nodeVersion}`,
    );
  }
  const discoveredPath = readMarker(discovery.out, 'PATH')
    .split(':')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => entry.startsWith('/'));
  const remotePath = [...new Set([
    ...(nodePath.startsWith('/') ? [dirname(nodePath)] : []),
    ...(corepackPath.startsWith('/') ? [dirname(corepackPath)] : []),
    ...discoveredPath,
  ])];
  return { remoteHome, remotePath };
}

async function writeSshConfig(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

function renderSshConfig({
  sshAlias,
  remoteHost,
  remoteUser,
  keyPath,
  knownHostsPath,
  strictHostKeyChecking,
}) {
  return [
    `Host ${sshAlias}`,
    `  HostName ${remoteHost}`,
    `  User ${remoteUser}`,
    `  IdentityFile ${sshConfigQuote(keyPath)}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${sshConfigQuote(knownHostsPath)}`,
    `  StrictHostKeyChecking ${strictHostKeyChecking}`,
    '  BatchMode yes',
    '  ConnectTimeout 10',
    '  ServerAliveInterval 15',
    '  ServerAliveCountMax 3',
    '',
  ].join('\n');
}

export async function provisionPosixDevTarget(
  {
    name,
    host,
    user,
    stackBaseDir,
    repoDir = null,
    cliHomeDir = null,
    requireToolchain = true,
    env = process.env,
  },
  {
    pathExists = existsSync,
    runInteractive = defaultRunInteractive,
    runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult,
  } = {},
) {
  const targetName = requireMatching(name, TARGET_NAME_RE, 'target name').toLowerCase();
  const remoteHost = requireMatching(host, HOST_RE, 'remote host');
  const remoteUser = requireMatching(user, USER_RE, 'remote user');
  const baseDir = requireAbsolutePosixPath(stackBaseDir, 'stack base directory');
  const sshDir = join(baseDir, 'dev-target-ssh', targetName);
  const keyPath = join(sshDir, 'id_ed25519');
  const publicKeyPath = `${keyPath}.pub`;
  const knownHostsPath = join(sshDir, 'known_hosts');
  const configPath = join(sshDir, 'ssh.config');
  const sshAlias = `happier-dev-target-${targetName}`;
  await mkdir(sshDir, { recursive: true, mode: 0o700 });

  const hasPrivateKey = pathExists(keyPath);
  const hasPublicKey = pathExists(publicKeyPath);
  if (hasPrivateKey !== hasPublicKey) {
    throw new Error(`[dev-targets] incomplete SSH key pair at ${sshDir}; restore or remove it before retrying`);
  }
  if (!hasPrivateKey) {
    await runInteractive({
      command: 'ssh-keygen',
      args: [
        '-q', '-t', 'ed25519', '-N', '',
        '-C', `happier-dev-target:${targetName}`,
        '-f', keyPath,
      ],
      env,
    });
  }

  const bootstrapConfig = renderSshConfig({
    sshAlias,
    remoteHost,
    remoteUser,
    keyPath,
    knownHostsPath,
    strictHostKeyChecking: 'accept-new',
  });
  const strictConfig = renderSshConfig({
    sshAlias,
    remoteHost,
    remoteUser,
    keyPath,
    knownHostsPath,
    strictHostKeyChecking: 'yes',
  });
  const probeArgs = configuredSshArgs({ configPath, sshAlias, remoteCommand: 'true' });
  let discovery;

  await writeSshConfig(configPath, bootstrapConfig);
  try {
    let probe = await runCaptureResultImpl({ command: 'ssh', args: probeArgs, env });
    if (!probe?.ok) {
      await runInteractive({
        command: 'ssh-copy-id',
        args: [
          '-F', configPath,
          '-o', 'BatchMode=no',
          '-i', publicKeyPath,
          sshAlias,
        ],
        env,
      });
      probe = await runCaptureResultImpl({ command: 'ssh', args: probeArgs, env });
    }
    if (!probe?.ok) {
      const detail = String(probe?.err ?? '').trim() || 'dedicated key authentication failed';
      throw new Error(`[dev-targets] could not verify provisioned SSH key: ${detail}`);
    }

    discovery = await runCaptureResultImpl({
      command: 'ssh',
      args: configuredSshArgs({ configPath, sshAlias, remoteCommand: discoveryCommand() }),
      env,
    });
  } finally {
    await writeSshConfig(configPath, strictConfig);
  }

  const strictProbe = await runCaptureResultImpl({ command: 'ssh', args: probeArgs, env });
  if (!strictProbe?.ok) {
    const detail = String(strictProbe?.err ?? '').trim() || 'strict host-key verification failed';
    throw new Error(`[dev-targets] SSH provisioned, but strict host-key verification failed after enrollment: ${detail}`);
  }
  const { remoteHome, remotePath } = normalizeDiscovery(discovery, { requireToolchain });

  return {
    name: targetName,
    platform: 'posix',
    ssh: sshAlias,
    sshConfigFile: configPath,
    remoteHome,
    controllerKey: { privateKeyPath: keyPath, publicKeyPath },
    repoDir: repoDir == null
      ? join(remoteHome, 'happier-dev')
      : requireAbsolutePosixPath(repoDir, 'remote repo directory'),
    cliHomeDir: cliHomeDir == null
      ? join(remoteHome, '.happier', 'dev-targets', targetName)
      : requireAbsolutePosixPath(cliHomeDir, 'remote CLI home directory'),
    remotePath,
    remoteServerPort: null,
  };
}

export async function inspectProvisionedPosixDevTarget(
  { target, requireToolchain = false, env = process.env },
  {
    pathExists = existsSync,
    runCaptureResult: runCaptureResultImpl = defaultRunCaptureResult,
  } = {},
) {
  if (target?.platform !== 'posix' || !target.sshConfigFile) {
    throw new Error('[dev-targets] an existing POSIX target with a managed SSH config is required');
  }
  const privateKeyPath = join(dirname(target.sshConfigFile), 'id_ed25519');
  const publicKeyPath = `${privateKeyPath}.pub`;
  if (!pathExists(privateKeyPath) || !pathExists(publicKeyPath)) {
    throw new Error(`[dev-targets] existing target ${target.name} does not own a reusable controller key pair`);
  }
  const baseArgs = ['-T', '-F', target.sshConfigFile, target.ssh];
  const probe = await runCaptureResultImpl({ command: 'ssh', args: [...baseArgs, 'true'], env });
  if (!probe?.ok) {
    const detail = String(probe?.err ?? '').trim() || 'strict SSH probe failed';
    throw new Error(`[dev-targets] existing target ${target.name} is not reachable: ${detail}`);
  }
  const discovery = await runCaptureResultImpl({
    command: 'ssh',
    args: [...baseArgs, discoveryCommand()],
    env,
  });
  const { remoteHome, remotePath } = normalizeDiscovery(discovery, { requireToolchain });
  return {
    ...target,
    remoteHome,
    remotePath,
    controllerKey: { privateKeyPath, publicKeyPath },
  };
}
