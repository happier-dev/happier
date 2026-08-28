import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';

import { buildLaunchdPath, buildLaunchdPlistXml } from '@happier-dev/cli-common/service';

import { startManagedLimaInstance } from '../managed_lima/lifecycle.mjs';
import { getHappyStacksHomeDir } from '../paths/paths.mjs';
import { runCaptureResult } from '../proc/proc.mjs';
import { ensureExecutionHostServiceTunnel } from './service_tunnel.mjs';
import { mountExecutionHostWorkspace } from './workspace_mount.mjs';

const RECOVERY_LABEL = 'dev.happier.stack.dev-vm-recovery';
const RECOVERY_ROOT = 'execution-host-recovery';
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireActiveManagedProfile(profile) {
  if (!profile || profile.mode !== 'managed-lima' || profile.activation !== 'active') {
    throw new Error('[dev-vm] recovery requires the active managed execution-host profile');
  }
  return profile;
}

function requireInstance(profile) {
  const instance = String(profile?.instance ?? '').trim();
  if (!SAFE_COMPONENT.test(instance)) {
    throw new Error('[dev-vm] recovery requires a safe managed Lima instance name');
  }
  return instance;
}

function requireAbsolutePath(value, label) {
  const path = String(value ?? '').trim();
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) {
    throw new Error(`[dev-vm] ${label} must be an absolute path`);
  }
  return resolve(path);
}

function normalizeProgramArgs(programArgs) {
  if (!Array.isArray(programArgs) || programArgs.length === 0) {
    throw new Error('[dev-vm] recovery requires the repo-local hstack controller');
  }
  const normalized = programArgs.map((argument) => String(argument ?? '').trim());
  if (!normalized.every(Boolean) || !isAbsolute(normalized[0]) || normalized.some((argument) => /[\0\r\n]/.test(argument))) {
    throw new Error('[dev-vm] recovery received unsafe hstack controller arguments');
  }
  return normalized;
}

function launchctlTarget(uid) {
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error('[dev-vm] recovery could not determine the macOS user id');
  }
  return `gui/${uid}/${RECOVERY_LABEL}`;
}

function defaultBoundary(env) {
  return {
    capture: (command, args) => runCaptureResult(command, args, { env }),
  };
}

async function writeAtomically(path, contents, mode) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode, flag: 'wx' });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function buildRecoveryPlist({ paths, programArgs, env }) {
  return buildLaunchdPlistXml({
    label: RECOVERY_LABEL,
    programArgs,
    env: {
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      HAPPIER_STACK_HOME_DIR: getHappyStacksHomeDir(env),
      // The recovery command needs only its pinned Node binary plus standard
      // macOS/Homebrew locations for limactl and SSHFS. Do not copy an
      // interactive shell PATH (which can contain ephemeral tool shims).
      PATH: buildLaunchdPath({ execPath: programArgs[0], basePath: '' }),
    },
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    workingDirectory: paths.recoveryRoot,
    keepAliveOnFailure: false,
  });
}

function configuredWorkspaces(profile) {
  if (profile?.version === 2) return profile.workspaces ?? [];
  return [{ id: '', guestDir: profile?.guestWorkspaceDir ?? '', stackName: '' }];
}

function devTargetSyncWorkspace(profile) {
  if (profile?.version !== 2) return configuredWorkspaces(profile)[0] ?? null;
  return (profile.workspaces ?? []).find((workspace) => workspace.id === '0.3') ?? null;
}

async function safeOutcome(action, success) {
  try {
    return { ok: true, result: await action() };
  } catch {
    // Recovery output is captured by launchd. Do not let a child process
    // diagnostic (which can contain a Stack environment value) reach its logs.
    return { ok: false, result: success };
  }
}

async function resumeIndependentDevTargetSync({ profile, workspace, executor }) {
  if (!workspace) {
    return { workspaceId: '0.3', status: 'missing_configuration' };
  }
  const guestDir = String(workspace.guestDir ?? '').trim();
  if (!guestDir.startsWith('/') || /[\0\r\n]/.test(guestDir)) {
    return { workspaceId: String(workspace.id ?? ''), status: 'missing_configuration' };
  }
  const stackName = String(workspace.stackName ?? '').trim();
  if (/[\0\r\n]/.test(stackName)) {
    return { workspaceId: String(workspace.id ?? ''), status: 'missing_configuration' };
  }
  const result = await executor.capture('limactl', [
    'shell', '--workdir', guestDir, profile.instance, '--',
    'env',
    'HAPPIER_STACK_EXECUTION_HOST_REENTRY=1',
    `HAPPIER_STACK_INVOKED_CWD=${guestDir}`,
    ...(stackName ? [`HAPPIER_STACK_STACK=${stackName}`] : []),
    'node', posix.join(guestDir, 'apps', 'stack', 'bin', 'hstack.mjs'),
    'dev-targets', 'sync-service', 'start', '--detached', '--json',
  ]);
  return {
    workspaceId: String(workspace.id ?? ''),
    status: result?.exitCode === 0 ? 'started' : 'failed',
  };
}

export function resolveExecutionHostRecoveryPaths({ profile, env = process.env, homeDir = homedir() } = {}) {
  const instance = requireInstance(profile);
  const recoveryRoot = join(getHappyStacksHomeDir(env), RECOVERY_ROOT, instance);
  return {
    label: RECOVERY_LABEL,
    recoveryRoot,
    logsDir: join(recoveryRoot, 'logs'),
    stdoutPath: join(recoveryRoot, 'logs', 'recovery.out.log'),
    stderrPath: join(recoveryRoot, 'logs', 'recovery.err.log'),
    plistPath: join(requireAbsolutePath(homeDir, 'macOS home directory'), 'Library', 'LaunchAgents', `${RECOVERY_LABEL}.plist`),
  };
}

export async function installExecutionHostRecovery({
  profile,
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  programArgs,
} = {}) {
  requireActiveManagedProfile(profile);
  if (platform !== 'darwin') {
    throw new Error('[dev-vm] recovery is supported only by macOS user LaunchAgents');
  }
  const paths = resolveExecutionHostRecoveryPaths({ profile, env, homeDir });
  const launchArgs = normalizeProgramArgs(programArgs);
  await Promise.all([
    mkdir(paths.recoveryRoot, { recursive: true, mode: 0o700 }),
    mkdir(paths.logsDir, { recursive: true, mode: 0o700 }),
    mkdir(dirname(paths.plistPath), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(paths.recoveryRoot, 0o700),
    chmod(paths.logsDir, 0o700),
  ]);
  await writeAtomically(paths.plistPath, buildRecoveryPlist({ paths, programArgs: launchArgs, env }), 0o644);

  // A `~/Library/LaunchAgents` plist is loaded by launchd at the next GUI
  // login. Deliberately do not bootstrap it here: enabling recovery must not
  // turn a configuration command into a surprise VM/tunnel/sync restart.
  return {
    paths,
    launchAgent: { label: RECOVERY_LABEL, loaded: false, nextLogin: true },
    health: { ok: true, code: 'next_login' },
  };
}

export async function inspectExecutionHostRecovery({
  profile,
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  boundary,
} = {}) {
  const paths = resolveExecutionHostRecoveryPaths({ profile, env, homeDir });
  let configured = true;
  try {
    await readFile(paths.plistPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') configured = false;
    else throw error;
  }
  if (!configured) {
    return {
      configured: false,
      paths,
      launchAgent: { label: RECOVERY_LABEL, loaded: false, nextLogin: false },
      health: { ok: true, code: 'not_configured' },
    };
  }
  let loaded = false;
  if (platform === 'darwin') {
    const processBoundary = boundary ?? defaultBoundary(env);
    if (!processBoundary?.capture) throw new Error('[dev-vm] recovery requires a macOS process boundary');
    const result = await processBoundary.capture('launchctl', ['print', launchctlTarget(uid)]).catch(() => null);
    loaded = result?.exitCode === 0;
  }
  return {
    configured: true,
    paths,
    launchAgent: { label: RECOVERY_LABEL, loaded, nextLogin: !loaded },
    health: { ok: true, code: loaded ? 'loaded' : 'next_login' },
  };
}

export async function removeExecutionHostRecovery({
  profile,
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  boundary,
} = {}) {
  if (platform !== 'darwin') {
    throw new Error('[dev-vm] recovery is supported only by macOS user LaunchAgents');
  }
  const paths = resolveExecutionHostRecoveryPaths({ profile, env, homeDir });
  const processBoundary = boundary ?? defaultBoundary(env);
  if (!processBoundary?.capture) throw new Error('[dev-vm] recovery requires a macOS process boundary');
  await processBoundary.capture('launchctl', ['bootout', launchctlTarget(uid)]).catch(() => null);
  await rm(paths.plistPath, { force: true });
  return {
    removed: true,
    paths,
    launchAgent: { label: RECOVERY_LABEL, loaded: false, nextLogin: false },
  };
}

export async function runExecutionHostRecovery({
  profile,
  executor,
  env = process.env,
} = {}) {
  requireActiveManagedProfile(profile);
  if (!executor?.capture || !executor?.run) {
    throw new Error('[dev-vm] recovery requires the managed Lima executor');
  }

  const vmOutcome = await safeOutcome(
    async () => await startManagedLimaInstance({ executor, instance: profile.instance }),
    { changed: false, status: 'failed' },
  );
  if (!vmOutcome.ok) {
    return {
      vm: vmOutcome.result,
      mount: { status: 'skipped', health: { ok: false, code: 'vm_unavailable' } },
      serviceTunnels: configuredWorkspaces(profile).map((workspace) => ({
        workspaceId: String(workspace.id ?? ''), status: 'skipped', healthy: false,
      })),
      sync: { workspaceId: profile.version === 2 ? '0.3' : '', status: 'skipped' },
      health: { ok: false, code: 'vm_unavailable' },
    };
  }

  const mountOutcome = profile.autoMount === true
    ? await safeOutcome(
      async () => await mountExecutionHostWorkspace({
        profile,
        env,
        mountDir: profile.hostMountDir || '',
        executor,
      }),
      { status: 'failed', health: { ok: false, code: 'failed' } },
    )
    : { ok: true, result: { status: 'disabled', health: { ok: true, code: 'disabled' } } };

  const serviceTunnels = [];
  for (const workspace of configuredWorkspaces(profile)) {
    // A workspace's declared public ports can overlap another's, so preserve
    // the existing service-tunnel owner's serial reconciliation order.
    // eslint-disable-next-line no-await-in-loop
    const outcome = await safeOutcome(
      async () => await ensureExecutionHostServiceTunnel({
        profile,
        workspaceId: String(workspace.id ?? ''),
        stackName: String(workspace.stackName ?? ''),
        executor,
        env,
      }),
      { workspaceId: String(workspace.id ?? ''), status: 'failed', healthy: false },
    );
    serviceTunnels.push({ ...outcome.result, healthy: outcome.ok });
  }

  const syncOutcome = await safeOutcome(
    async () => await resumeIndependentDevTargetSync({
      profile,
      workspace: devTargetSyncWorkspace(profile),
      executor,
    }),
    { workspaceId: profile.version === 2 ? '0.3' : '', status: 'failed' },
  );
  const sync = syncOutcome.result;
  const healthy = mountOutcome.ok
    && serviceTunnels.every((tunnel) => tunnel.healthy === true)
    && syncOutcome.ok
    && sync.status === 'started';
  return {
    vm: vmOutcome.result,
    mount: mountOutcome.result,
    serviceTunnels,
    sync,
    health: healthy ? { ok: true, code: 'ready' } : { ok: false, code: 'reconcile_failed' },
  };
}
