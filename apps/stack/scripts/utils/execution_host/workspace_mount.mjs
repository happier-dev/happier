import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { parseDevTargetsConfig, resolveDevTargetsConfigPath } from '../dev_targets/config.mjs';
import { runCaptureResult } from '../proc/proc.mjs';
import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';
import { getHappyStacksHomeDir } from '../paths/paths.mjs';
import { resolveSshPrimaryTarget } from './primary.mjs';
import { buildSshWorkerArgs, posixQuote, prependRemotePath } from '../dev_targets/remote_commands.mjs';
import { runDevTargetSshProcess } from '../dev_targets/ssh_transport.mjs';

const MACFUSE_FILESYSTEM_PATH = '/Library/Filesystems/macfuse.fs';
const MOUNT_PROBE_TIMEOUT_MS = 5_000;
// Recheck at the same cadence as the SSH connection heartbeat. The latter
// cannot recover if the SSHFS process itself aborts.
const MOUNT_RECONCILE_INTERVAL_MS = 15_000;

function requireAbsolutePath(value, label) {
  const path = String(value ?? '').trim();
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) {
    throw new Error(`[dev-vm] ${label} must be an absolute path`);
  }
  return resolve(path);
}

export function resolveExecutionHostWorkspaceMount(profile, env = process.env, explicitMountDir = '', connection = null) {
  if (profile?.mode === 'ssh-dev-target') {
    const targetName = String(profile.sshPrimary?.targetName ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(targetName) || !connection?.target) {
      throw new Error('[execution-host] enrolled SSH primary transport is required');
    }
    return {
      mountDir: requireAbsolutePath(explicitMountDir || join(getHappyStacksHomeDir(env), `${targetName}-home`), 'mount directory'),
      sshConfigFile: connection.sshConfigFile,
      sshHost: connection.target.ssh,
      remote: `${connection.target.ssh}:`,
      volumeName: `Happier ${targetName}`,
    };
  }
  const mountDir = requireAbsolutePath(
    explicitMountDir || join(getHappyStacksHomeDir(env), 'vm-home'),
    'mount directory',
  );
  const sshConfigFile = join(
    requireAbsolutePath(profile?.limaHome, 'Lima home'),
    String(profile?.instance ?? ''),
    'ssh.config',
  );
  const sshHost = `lima-${String(profile?.instance ?? '').trim()}`;
  if (!/^lima-[A-Za-z0-9._-]+$/.test(sshHost)) {
    throw new Error('[dev-vm] invalid managed Lima instance name');
  }
  return {
    mountDir,
    sshConfigFile,
    sshHost,
    // An empty SSHFS remote path resolves to the authenticated Lima user's
    // home directory. This exposes the authoritative workspaces and the
    // agent configuration through one exact guest view.
    remote: `${sshHost}:`,
    volumeName: 'Happier VM',
  };
}

export async function resolveExecutionHostWorkspaceConnection(profile, env = process.env, mountDir = '') {
  const connection = profile.mode === 'ssh-dev-target' ? await resolveSshPrimaryTarget({ profile, env }) : null;
  return resolveExecutionHostWorkspaceMount(profile, env, mountDir, connection);
}

export async function captureExecutionHostGuestCommand({ profile, executor, env = process.env, cwd = '', args }) {
  const capture = executor?.capture?.bind(executor) ?? ((command, argv, options = {}) => runCaptureResult(command, argv, { env, ...options }));
  if (profile.mode !== 'ssh-dev-target') {
    return await capture('limactl', ['shell', ...(cwd ? ['--workdir', cwd] : []), profile.instance, '--', ...args]);
  }
  const { target, sshConfigFile } = await resolveSshPrimaryTarget({ profile, env });
  const command = `${cwd ? `cd -- ${posixQuote(cwd)} && ` : ''}exec ${args.map(posixQuote).join(' ')}`;
  return await runDevTargetSshProcess({ command: 'ssh', args: buildSshWorkerArgs(target, {
    remoteCommand: `exec bash -lc ${posixQuote(prependRemotePath(target, command))}`,
    sshArgs: [...(sshConfigFile ? ['-F', sshConfigFile] : []), '-o', 'ConnectTimeout=10'], tty: false,
  }) }, async input => {
    const result = await capture(input.command, input.args);
    if (result.exitCode === 255) {
      // Keep the canonical transport's connect-only recovery classification.
      return { ...result, code: result.exitCode };
    }
    return result;
  });
}

function guestStorageEnv(mountDir, env) {
  return {
    ...env,
    // The mount is the authenticated guest HOME, so project the guest's
    // default Stack storage through it and let the canonical resolver own the
    // per-Stack config path.
    HAPPIER_STACK_STORAGE_DIR: join(mountDir, '.happier', 'stacks'),
  };
}

export function resolveExecutionHostGuestDevTargetsConfigPath({
  profile,
  stackName,
  env = process.env,
  mountDir = '',
} = {}) {
  const mount = resolveExecutionHostWorkspaceMount(profile, env, mountDir || profile?.hostMountDir || '');
  return resolveDevTargetsConfigPath({
    stackName,
    env: guestStorageEnv(mount.mountDir, env),
  });
}

function guestConfigUnavailableError(mount) {
  const detail = String(mount?.health?.message ?? '').trim();
  return new Error(
    `[dev-vm] authoritative guest dev-target configuration is unavailable`
      + `${detail ? `: ${detail}` : '; mount the managed guest workspace before backup'}`,
  );
}

export async function loadExecutionHostGuestDevTargetsConfig({
  profile,
  stackName,
  env = process.env,
  mountDir = '',
  boundary,
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  const mount = await inspectExecutionHostWorkspaceMount({
    profile,
    env,
    mountDir: mountDir || profile?.hostMountDir || '',
    boundary,
    platform,
    fileExists,
  });
  if (!mount.mounted || mount.health?.ok !== true) throw guestConfigUnavailableError(mount);
  const path = resolveExecutionHostGuestDevTargetsConfigPath({
    profile,
    stackName,
    env,
    mountDir: mount.mountDir,
  });
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    return { path, config: parseDevTargetsConfig(raw) };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { path, config: { version: 1, targets: [] } };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`[dev-targets] invalid JSON at ${path}: ${error.message}`);
    }
    throw error;
  }
}

function defaultBoundary(env) {
  return {
    capture: (command, args, options = {}) => runCaptureResult(command, args, { env, ...options }),
    delay: (ms, options = {}) => delay(ms, undefined, options),
    reportWarning: (message) => process.stderr.write(`${message}\n`),
    start: (command, args) => {
      const child = spawn(command, args, {
        env,
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      child.once('error', (error) => {
        child.happierLaunchError = error;
      });
      child.unref();
      return child;
    },
  };
}

function mountOutputLine(output, mountDir) {
  return String(output ?? '').split(/\r?\n/).find((line) => (
    line.includes(` on ${mountDir} (`) || line.includes(` ${mountDir} `)
  ));
}

function mountOutputContains(output, mountDir) {
  return Boolean(mountOutputLine(output, mountDir));
}

function mountHealthError(code, message) {
  return { ok: false, code, message };
}

function isDefiniteDeadMount(health) {
  return health?.code === 'mount_unreachable'
    && /Device not configured|Transport endpoint is not connected/i.test(String(health.message ?? ''));
}

async function waitForMountedFilesystem({ boundary, mountDir, child, signal }) {
  while (true) {
    const observed = await boundary.capture('mount', []);
    if (observed.exitCode === 0 && mountOutputContains(observed.out, mountDir)) return;
    if (child?.happierLaunchError) {
      throw new Error(`[dev-vm] SSHFS mount failed: ${child.happierLaunchError.message}`);
    }
    if (child?.exitCode != null) {
      throw new Error(`[dev-vm] SSHFS mount failed with exit ${child.exitCode}`);
    }
    await boundary.delay(100, { signal });
  }
}

function terminateLaunchedMount(child) {
  if (!child || child.exitCode != null || typeof child.kill !== 'function') return;
  child.kill('SIGTERM');
}

function mountProbeFailureDetail(probe) {
  const detail = `${String(probe.out ?? '')}\n${String(probe.err ?? '')}`.trim();
  if (detail) return detail;
  if (probe.timedOut) return `probe timed out after ${MOUNT_PROBE_TIMEOUT_MS / 1000} seconds`;
  return `exit ${probe.exitCode ?? 'unknown'}`;
}

async function inspectMountHealth({ mounted, mountDir, boundary, platform, fileExists }) {
  if (mounted) {
    const probe = await boundary.capture('ls', ['-A', mountDir], { timeoutMs: MOUNT_PROBE_TIMEOUT_MS });
    if (probe.exitCode === 0) return { ok: true, code: 'mounted' };
    return mountHealthError(
      'mount_unreachable',
      `SSHFS mount is listed but its guest home is inaccessible: ${mountProbeFailureDetail(probe)}`,
    );
  }
  if (platform === 'darwin' && !fileExists(MACFUSE_FILESYSTEM_PATH)) {
    return mountHealthError(
      'macfuse_not_approved',
      'macFUSE is installed but its filesystem extension is unavailable; finish the vendor installer and approve it in System Settings',
    );
  }
  const sshfs = await boundary.capture('sshfs', ['--version']);
  if (sshfs.exitCode !== 0) {
    return mountHealthError('sshfs_unavailable', 'SSHFS is unavailable; install macFUSE and sshfs-mac first');
  }
  return { ok: true, code: 'ready' };
}

export async function resolveExecutionHostGuestHome({ profile, executor, env = process.env }) {
  if (!executor?.capture && profile.mode !== 'ssh-dev-target') return '';
  const result = await captureExecutionHostGuestCommand({ profile, executor, env,
    args: ['sh', '-lc', 'printf %s "$HOME"'] });
  const guestHome = String(result.out ?? '').trim();
  if (result.exitCode !== 0 || !guestHome.startsWith('/') || /[\0\r\n]/.test(guestHome)) {
    const detail = String(result.err ?? '').trim();
    throw new Error(
      `[dev-vm] unable to resolve the managed guest home${detail ? `: ${detail}` : '; start the VM first'}`,
    );
  }
  return guestHome;
}

function withGuestHome(resolved, guestHome) {
  if (!guestHome) return resolved;
  return {
    ...resolved,
    guestHome,
    remote: `${resolved.sshHost}:${guestHome}`,
  };
}

export async function inspectExecutionHostWorkspaceMount({
  profile,
  env = process.env,
  mountDir = '',
  boundary,
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  const resolved = await resolveExecutionHostWorkspaceConnection(profile, env, mountDir);
  const processBoundary = boundary ?? defaultBoundary(env);
  const observed = await processBoundary.capture('mount', []);
  if (observed.exitCode !== 0) {
    return {
      ...resolved,
      mounted: false,
      health: mountHealthError(
        'mount_status_unavailable',
        `unable to inspect mounted filesystems: ${String(observed.err ?? '').trim() || `exit ${observed.exitCode}`}`,
      ),
    };
  }
  const mounted = mountOutputContains(observed.out, resolved.mountDir);
  if (mounted && profile.mode === 'ssh-dev-target'
    && !mountOutputLine(observed.out, resolved.mountDir).startsWith(`${resolved.sshHost}:`)) {
    return { ...resolved, mounted,
      health: mountHealthError('mount_source_mismatch', 'mount has a different SSH source; existing mount left in place') };
  }
  return {
    ...resolved,
    mounted,
    health: await inspectMountHealth({
      mounted,
      mountDir: resolved.mountDir,
      boundary: processBoundary,
      platform,
      fileExists,
    }),
  };
}

async function mountExecutionHostWorkspaceUnlocked({
  profile,
  env = process.env,
  mountDir = '',
  boundary,
  executor,
  platform = process.platform,
  fileExists = existsSync,
  requireDefiniteStale = false,
  signal,
} = {}) {
  const processBoundary = boundary ?? defaultBoundary(env);
  const current = await inspectExecutionHostWorkspaceMount({
    profile,
    env,
    mountDir,
    boundary: processBoundary,
    platform,
    fileExists,
  });
  if (current.mounted && current.health?.ok === true) return current;
  // SSH primaries can adopt an operator's mount, but have no authority to
  // replace it. Leave unhealthy entries visible for the operator to detach.
  if (current.mounted && profile.mode === 'ssh-dev-target') {
    throw new Error(`[execution-host] leaving the existing SSH primary mount in place: ${current.health?.message ?? 'unknown failure'}`);
  }
  if (current.mounted && requireDefiniteStale && !isDefiniteDeadMount(current.health)) {
    throw new Error(`[dev-vm] workspace mount probe is inconclusive; leaving the listed mount in place: ${current.health?.message ?? 'unknown failure'}`);
  }
  if (current.mounted) {
    await unmountExecutionHostWorkspaceUnlocked({ profile, env, mountDir, boundary: processBoundary, platform });
  }
  const ready = current.mounted
    ? await inspectExecutionHostWorkspaceMount({
      profile,
      env,
      mountDir,
      boundary: processBoundary,
      platform,
      fileExists,
    })
    : current;
  if (ready.health?.ok !== true) throw new Error(`[dev-vm] ${ready.health?.message ?? 'workspace mount is unavailable'}`);
  if (ready.sshConfigFile && !fileExists(ready.sshConfigFile)) {
    throw new Error(`[dev-vm] execution-host SSH configuration is missing: ${ready.sshConfigFile}`);
  }
  await mkdir(ready.mountDir, { recursive: true, mode: 0o700 });
  if ((await readdir(ready.mountDir)).length > 0) {
    throw new Error(`[dev-vm] refusing to mount over a non-empty directory: ${ready.mountDir}`);
  }
  // Lima rewrites this file on lifecycle changes. Passing its current path to
  // SSHFS intentionally avoids a copied/stale SSH identity.
  const resolved = withGuestHome(ready, await resolveExecutionHostGuestHome({ profile, executor, env }));
  const child = await processBoundary.start('sshfs', [
    ...(resolved.sshConfigFile ? ['-F', resolved.sshConfigFile] : []),
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    resolved.remote,
    resolved.mountDir,
    '-o', `reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,defer_permissions,noappledouble,volname=${resolved.volumeName}`,
  ]);
  try {
    await waitForMountedFilesystem({ boundary: processBoundary, mountDir: resolved.mountDir, child, signal });
  } catch (error) {
    terminateLaunchedMount(child);
    throw error;
  }
  return { ...resolved, mounted: true, health: { ok: true, code: 'mounted' } };
}

async function unmountExecutionHostWorkspaceUnlocked({
  profile,
  env = process.env,
  mountDir = '',
  boundary,
  platform = process.platform,
} = {}) {
  const processBoundary = boundary ?? defaultBoundary(env);
  let current = await inspectExecutionHostWorkspaceMount({
    profile,
    env,
    mountDir,
    boundary: processBoundary,
    platform,
  });
  while (current.mounted) {
    const result = await processBoundary.capture('umount', [current.mountDir]);
    if (result.exitCode !== 0) {
      const detail = String(result.err ?? '').trim();
      let unmounted = false;
      if (platform === 'darwin' && /resource busy/i.test(detail)) {
        const fallback = await processBoundary.capture('diskutil', ['unmount', current.mountDir]);
        if (fallback.exitCode === 0) {
          unmounted = true;
        } else {
          const forcedFallback = await processBoundary.capture('diskutil', ['unmount', 'force', current.mountDir]);
          unmounted = forcedFallback.exitCode === 0;
        }
      }
      if (!unmounted) throw new Error(`[dev-vm] SSHFS unmount failed${detail ? `: ${detail}` : ''}`);
    }
    current = await inspectExecutionHostWorkspaceMount({
      profile,
      env,
      mountDir,
      boundary: processBoundary,
      platform,
    });
  }
  return { ...current, mounted: false, health: { ok: true, code: 'ready' } };
}

async function withWorkspaceMountLock({ profile, env, mountDir, signal }, operation) {
  const resolved = await resolveExecutionHostWorkspaceConnection(profile, env, mountDir);
  return withJsonOwnerFileLock(operation, {
    // The sibling remains accessible when the mountpoint itself is stale.
    lockPath: `${resolved.mountDir}.lock`,
    errorLabel: 'execution-host workspace mount lock',
    signal,
  });
}

export async function mountExecutionHostWorkspace(options = {}) {
  return await withWorkspaceMountLock(options, async () => await mountExecutionHostWorkspaceUnlocked(options));
}

export async function unmountExecutionHostWorkspace(options = {}) {
  return await withWorkspaceMountLock(options, async () => await unmountExecutionHostWorkspaceUnlocked(options));
}

export async function superviseExecutionHostWorkspaceMount({ signal, boundary, env = process.env, ...options } = {}) {
  const processBoundary = boundary ?? defaultBoundary(env);
  let previousError = '';
  while (!signal?.aborted) {
    try {
      await mountExecutionHostWorkspace({ ...options, env, boundary: processBoundary, signal, requireDefiniteStale: true });
      if (previousError) {
        processBoundary.reportWarning?.('[dev-vm] workspace mount recovered after a transient failure');
        previousError = '';
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') break;
      const message = String(error?.message ?? error);
      if (message !== previousError) {
        processBoundary.reportWarning?.(`[dev-vm] workspace mount reconciliation failed; retrying: ${message}`);
        previousError = message;
      }
    }
    try {
      await processBoundary.delay(MOUNT_RECONCILE_INTERVAL_MS, { signal });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') break;
      throw error;
    }
  }
  return { status: 'cancelled' };
}
