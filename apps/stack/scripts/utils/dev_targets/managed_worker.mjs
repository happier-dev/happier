import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createManagedLimaHostExecutor } from '../managed_lima/host_executor.mjs';
import { getManagedLimaStatus } from '../managed_lima/lifecycle.mjs';
import { setupManagedLimaRuntime } from '../managed_lima/manager.mjs';
import { normalizeManagedLimaArchitecture } from '../managed_lima/profiles.mjs';
import { runCaptureResult } from '../proc/proc.mjs';
import { inspectProvisionedPosixDevTarget, provisionPosixDevTarget } from './provision.mjs';

function sshConfigQuote(value) {
  return `"${String(value).replace(/([\\"])/g, '\\$1')}"`;
}

function requireAbsolutePath(value, label) {
  const normalized = String(value ?? '').trim().replace(/\/+$/, '');
  if (!normalized.startsWith('/') || /[\0\r\n]/.test(normalized)) {
    throw new Error(`[dev-targets] ${label} must be an absolute POSIX path`);
  }
  return normalized || '/';
}

function guestSshPort(instance) {
  const value = Number(instance?.sshLocalPort ?? instance?.SSHLocalPort);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('[dev-targets] managed Lima guest SSH port is unavailable');
  }
  return value;
}

function renderGuestSshConfig({
  alias,
  user,
  port,
  privateKeyPath,
  knownHostsPath,
  controlPath,
  outerSsh,
  outerSshConfigFile,
  strictHostKeyChecking,
}) {
  return [
    `Host ${alias}`,
    '  HostName 127.0.0.1',
    `  HostKeyAlias ${alias}`,
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${sshConfigQuote(privateKeyPath)}`,
    '  IdentitiesOnly yes',
    '  ForwardAgent no',
    `  UserKnownHostsFile ${sshConfigQuote(knownHostsPath)}`,
    `  StrictHostKeyChecking ${strictHostKeyChecking}`,
    '  BatchMode yes',
    '  ConnectTimeout 180',
    '  ServerAliveInterval 30',
    '  ServerAliveCountMax 6',
    '  ControlMaster auto',
    '  ControlPersist 600',
    `  ControlPath ${sshConfigQuote(controlPath)}`,
    `  ProxyCommand ssh -T -F ${sshConfigQuote(outerSshConfigFile)} ${outerSsh} -W %h:%p`,
    '',
  ].join('\n');
}

function replaceSshConfigDirective(contents, directive, value) {
  const expression = new RegExp(`^(\\s*)${directive}\\s+.*$`, 'm');
  if (!expression.test(contents)) {
    throw new Error(`[dev-targets] managed guest SSH config is missing ${directive}`);
  }
  return contents.replace(expression, `$1${directive} ${value}`);
}

async function writePrivateFile(path, contents) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function defaultRunSshProbe({ configPath, alias, env }) {
  return await runCaptureResult('ssh', ['-T', '-F', configPath, alias, 'true'], { env });
}

function requireProbe(result, description) {
  if (result?.ok === true || result?.exitCode === 0) return;
  throw new Error(`[dev-targets] ${description}: ${String(result?.err ?? '').trim() || 'SSH probe failed'}`);
}

const INSTALL_CONTROLLER_KEY_SCRIPT = [
  'set -eu',
  'key=$1',
  'directory=$HOME/.ssh',
  'authorized=$directory/authorized_keys',
  'mkdir -p "$directory"',
  'chmod 700 "$directory"',
  'touch "$authorized"',
  'chmod 600 "$authorized"',
  'grep -qxF "$key" "$authorized" || printf "%s\\n" "$key" >>"$authorized"',
].join('\n');

export async function reconcileManagedLimaDevTargetSshPublication(
  { target, sshLocalPort, env = process.env },
  { runSshProbe = defaultRunSshProbe } = {},
) {
  if (target?.managedRuntime?.kind !== 'lima') {
    throw new Error(`[dev-targets] target ${String(target?.name ?? 'unknown')} has no managed Lima runtime`);
  }
  const port = guestSshPort({ sshLocalPort });
  const configPath = String(target.sshConfigFile ?? '').trim();
  const alias = String(target.ssh ?? '').trim();
  if (!configPath || !alias) throw new Error('[dev-targets] managed guest SSH publication is incomplete');

  const original = await readFile(configPath, 'utf8');
  let next = replaceSshConfigDirective(original, 'Port', String(port));
  const hostKeyAliasAdded = !/^\s*HostKeyAlias\s+/m.test(next);
  if (hostKeyAliasAdded) {
    next = next.replace(/^(\s*HostName\s+.*)$/m, `$1\n  HostKeyAlias ${alias}`);
  }
  const changed = next !== original;
  if (!changed) return { changed: false, port, hostKeyAliasAdded: false };

  if (hostKeyAliasAdded) {
    await writePrivateFile(configPath, replaceSshConfigDirective(next, 'StrictHostKeyChecking', 'accept-new'));
    requireProbe(
      await runSshProbe({ configPath, alias, env }),
      'managed guest host-key alias enrollment failed',
    );
  }
  await writePrivateFile(configPath, replaceSshConfigDirective(next, 'StrictHostKeyChecking', 'yes'));
  requireProbe(
    await runSshProbe({ configPath, alias, env }),
    'managed guest refreshed SSH verification failed',
  );
  return { changed: true, port, hostKeyAliasAdded };
}

export async function provisionManagedLimaDevTarget(
  {
    name,
    host,
    user,
    outerTarget = null,
    stackBaseDir,
    instance,
    profile = 'worker-balanced',
    limaHome = null,
    repoDir = null,
    cliHomeDir = null,
    allowInstall = true,
    env = process.env,
  },
  {
    provisionOuterHost = provisionPosixDevTarget,
    inspectOuterHost = inspectProvisionedPosixDevTarget,
    createHostExecutor = createManagedLimaHostExecutor,
    setupRuntime = setupManagedLimaRuntime,
    getRuntimeStatus = getManagedLimaStatus,
    runSshProbe = defaultRunSshProbe,
    guestProvisionScriptSource,
  } = {},
) {
  const targetName = String(name ?? '').trim().toLowerCase();
  const outer = outerTarget
    ? await inspectOuterHost({ target: outerTarget, requireToolchain: false, env })
    : await provisionOuterHost({
        name: `${targetName.slice(0, 27)}-host`,
        host,
        user,
        stackBaseDir,
        requireToolchain: false,
        env,
      });
  const resolvedLimaHome = limaHome == null
    ? join(outer.remoteHome, '.happier', 'lima')
    : requireAbsolutePath(limaHome, 'managed Lima home');
  const managedHost = {
    kind: 'ssh',
    ssh: outer.ssh,
    sshConfigFile: outer.sshConfigFile,
    ...(outer.remotePath?.length ? { remotePath: outer.remotePath } : {}),
  };
  const hostEnvironment = {
    LIMA_HOME: resolvedLimaHome,
    ...(outer.remotePath?.length ? { PATH: outer.remotePath.join(':') } : {}),
  };
  const executor = createHostExecutor(
    managedHost,
    undefined,
    env,
    { hostEnvironment },
  );
  const hostArchitecture = await executor.capture('uname', ['-m']);
  if (hostArchitecture.exitCode !== 0) {
    throw new Error(`[dev-targets] failed to inspect managed Lima host architecture: ${String(hostArchitecture.err ?? '').trim()}`);
  }
  const architecture = normalizeManagedLimaArchitecture(hostArchitecture.out);
  const runtime = await setupRuntime({
    executor,
    instance,
    profileName: profile,
    architecture,
    allowInstall,
    guestProvisionScriptSource,
    guestProvisionProfile: 'happier',
  });
  const publicKey = String(await readFile(outer.controllerKey.publicKeyPath, 'utf8')).trim();
  if (!publicKey || /[\0\r\n]/.test(publicKey)) {
    throw new Error('[dev-targets] managed worker controller public key is invalid');
  }
  const keyInstall = await executor.capture('limactl', [
    'shell', instance, '--', 'sh', '-ceu', INSTALL_CONTROLLER_KEY_SCRIPT,
    'happier-managed-worker-key', publicKey,
  ]);
  if (keyInstall.exitCode !== 0) {
    throw new Error(`[dev-targets] failed to install the controller key in managed guest: ${String(keyInstall.err ?? '').trim()}`);
  }
  const status = await getRuntimeStatus({ executor, instance });
  if (!status.exists || String(status.status).toLowerCase() !== 'running') {
    throw new Error(`[dev-targets] managed Lima guest is not running: ${String(status.status)}`);
  }
  const guestHome = requireAbsolutePath(runtime.guest?.homeDir, 'managed guest home');
  const guestUser = String(runtime.guest?.user ?? '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(guestUser)) {
    throw new Error('[dev-targets] managed Lima guest user is unavailable');
  }
  const sshDir = join(stackBaseDir, 'dev-target-ssh', targetName);
  const knownHostsPath = join(sshDir, 'guest-known-hosts');
  const controlPath = '~/.ssh/happier-managed-%C';
  const configPath = join(sshDir, 'guest.ssh.config');
  const alias = `happier-dev-target-${targetName}`;
  await mkdir(sshDir, { recursive: true, mode: 0o700 });
  const render = (strictHostKeyChecking) => renderGuestSshConfig({
    alias,
    user: guestUser,
    port: guestSshPort(status.instance),
    privateKeyPath: outer.controllerKey.privateKeyPath,
    knownHostsPath,
    controlPath,
    outerSsh: outer.ssh,
    outerSshConfigFile: outer.sshConfigFile,
    strictHostKeyChecking,
  });
  await writePrivateFile(configPath, render('accept-new'));
  try {
    requireProbe(await runSshProbe({ configPath, alias, env }), 'managed guest host-key enrollment failed');
  } finally {
    await writePrivateFile(configPath, render('yes'));
  }
  requireProbe(await runSshProbe({ configPath, alias, env }), 'managed guest strict SSH verification failed');
  return {
    name: targetName,
    platform: 'posix',
    ssh: alias,
    sshConfigFile: configPath,
    repoDir: repoDir == null
      ? join(guestHome, 'happier-dev')
      : requireAbsolutePath(repoDir, 'managed guest repository directory'),
    cliHomeDir: cliHomeDir == null
      ? join(guestHome, '.happier', 'dev-targets', targetName)
      : requireAbsolutePath(cliHomeDir, 'managed guest CLI home directory'),
    remotePath: ['/usr/local/bin', '/usr/bin', '/bin'],
    remoteServerPort: null,
    managedRuntime: {
      kind: 'lima',
      host: managedHost,
      instance,
      limaHome: resolvedLimaHome,
      profile,
      architecture,
    },
  };
}
