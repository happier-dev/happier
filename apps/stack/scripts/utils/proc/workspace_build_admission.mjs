import { readFileSync, readdirSync } from 'node:fs';
import { constants } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callerHoldsWorkspaceBundleLock, createWorkspaceBundleLockPriorityScope, isWorkspaceBundleLockPriorityChange,
  observeWorkspaceBundleLock, observeWorkspaceBundleLockPriority, withWorkspaceBundleLock, WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { parseWorkspaceLockLeaseValue } from '../../../../../packages/cli-common/workspaceLockLease.mjs';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { spawnForegroundCommand } from './proc.mjs';
import { callerHoldsDependencyConsumption, callerHoldsDependencyResourceBlocking, resolveDependencyRefreshLockPath, resolveLockedInstallEnv, withDependencyConsumption, withDependencyRefreshLock } from './dependency_refresh.mjs';
import { JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE } from './jsonOwnerFileLock.mjs';

const workerPath = fileURLToPath(import.meta.url);
const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

function isWorkspaceResourceBusy(error) {
  return error?.code === WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE || error?.code === JSON_OWNER_FILE_LOCK_BUSY_ERROR_CODE;
}

export function createWorkspaceBuildResourcePriorityScope({ locks = [], env = process.env, signal } = {}) {
  return createWorkspaceBundleLockPriorityScope({ resources: locks, env, signal,
    isHeldResourceContinuation: callerHoldsDependencyResourceBlocking });
}

/** One nonblocking canonical resource attempt for the host admission broker.
 * The returned release closes every acquired lease; a busy attempt retains none.
 * A supplied soft-priority scope belongs to the waiting client across attempts.
 */
export async function tryWorkspaceBuildResources({ locks = [], env = process.env, signal, priorityScope: suppliedPriorityScope } = {}) {
  let resolveAttempt;
  const attempt = new Promise(resolve => { resolveAttempt = resolve; });
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const priorityScope = suppliedPriorityScope ?? createWorkspaceBuildResourcePriorityScope({ locks, env, signal });
  priorityScope.activate();
  let entered = false;
  let releaseError;
  const completion = withLocks(locks, env, signal, async acquiredEnv => {
    entered = true;
    // Resources can still unwind before the broker admits the payload. Keep a
    // client-owned scope reusable across that reconnect, without preference
    // files while the actual leases provide exclusion.
    if (suppliedPriorityScope) priorityScope.suspend();
    else priorityScope.dispose();
    resolveAttempt({ acquired: true, env: acquiredEnv,
      release: async () => { finish(); await completion; if (releaseError) throw releaseError; } });
    await held;
  }, priorityScope).catch(error => {
    if (!entered && isWorkspaceResourceBusy(error)) {
      console.error(error.message.replace(/^HSTACK_WORKSPACE_ADMISSION_ORDER: /u, ''));
      resolveAttempt({ acquired: false });
    }
    else if (entered) releaseError = error;
    else resolveAttempt({ acquired: false, error });
  }).finally(() => {
    if (!suppliedPriorityScope) priorityScope.dispose();
  });
  const result = await attempt;
  if (result.error) throw result.error;
  return result;
}

/** The startup worker owns this policy for its entire finite construction,
 * including nested compiler leaves. Routing markers alone grant no exemption. */
export function isWorkspaceBuildStartup({ env = process.env, devStartup = false } = {}) {
  return devStartup || env.HAPPIER_WORKSPACE_BUILD_STARTUP === '1';
}

export async function hasInheritedPackageBuildCustody(env) {
  const { callerHoldsWorkspaceBundleLock } = await import('../../../../../packages/cli-common/workspaceBundleLock.mjs');
  let leases;
  try { leases = JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES || '[]'); }
  catch { leases = []; }
  const values = [env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
    ...(Array.isArray(leases) ? leases : [])];
  return values.some(value => {
    const lease = parseWorkspaceLockLeaseValue(value);
    return lease !== null && callerHoldsWorkspaceBundleLock(lease.path, value);
  });
}

/** Finite build transport. The native owner decides capacity; this adapter
 * supplies only its existing canonical workspace leases and process boundary.
 */
export function resolveWorkspaceBuildAdmissionInvocation({ command, args = [], locks = [],
  repoDir = sourceRoot, launcherPath = resolve(repoDir, 'apps/stack/bin/hstack-exec'), env = process.env,
  admissionClass = 'package-dist', admissionRequired = true, devStartup = false,
  inheritedAdmission = false }) {
  if (inheritedAdmission) {
    const workerArgs = [workerPath, '--inherited-resources', JSON.stringify(locks), launcherPath, admissionClass, '--', command, ...args];
    return { command: process.execPath, args: workerArgs };
  }
  if (isWorkspaceBuildStartup({ env, devStartup })) {
    // Stack's own source construction is startup-critical, with private
    // outputs. Reuse protected local jobs placement and resource custody,
    // without joining validation's capacity queue.
    const workerArgs = [workerPath, '--dev-startup', JSON.stringify(locks), launcherPath, admissionClass, '--', command, ...args];
    return process.platform === 'win32'
      ? { command: process.execPath, args: workerArgs }
      : { command: '/bin/sh', args: [launcherPath, '--local', '--', process.execPath, ...workerArgs] };
  }
  return process.platform === 'win32' || !admissionRequired
    ? { command: process.execPath, args: [workerPath, '--standalone', JSON.stringify(locks), launcherPath, admissionClass, '--', command, ...args] }
    : { command: '/bin/sh', args: [launcherPath, '--heavyweight-admission', `--class=${admissionClass}`,
      `--machine=${env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local'}`,
      `--workspace-locks=${JSON.stringify(locks)}`, '--', command, ...args] };
}

export async function runWorkspaceBuildAdmission({ command, args = [], locks = [], cwd = process.cwd(),
  repoDir = sourceRoot, launcherPath = resolve(repoDir, 'apps/stack/bin/hstack-exec'), env = process.env,
  signal, admissionClass = 'package-dist', admissionRequired = true, devStartup = false,
  inheritedAdmission = false,
  stdio = 'inherit', onStdout, onStderr, captureStdout = true, captureStderr = true }) {
  const invocation = resolveWorkspaceBuildAdmissionInvocation({ command, args, locks, repoDir,
    launcherPath, env, admissionClass, admissionRequired, devStartup, inheritedAdmission });
  if (isWorkspaceBuildStartup({ env, devStartup })) env = { ...env, HAPPIER_HSTACK_DISPATCH_CONTROL: '1' };
  return await new Promise(resolveResult => {
    const child = spawnForegroundCommand(invocation.command, invocation.args, {
      cwd, env, signal, stdio, ownedProcessGroup: true,
    });
    // Native admission settles interruption with a numeric shell status. Keep
    // the caller's actual signal distinct from an ordinary numeric child exit;
    // foreground custody still owns forwarding and waits for the tree to close.
    let callerSignal = null;
    const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(name =>
      [name, () => { callerSignal ??= name; }]));
    for (const [name, handler] of handlers) process.on(name, handler);
    let stdout = '', stderr = '', error;
    child.stdout?.on('data', value => { if (captureStdout) stdout += value; onStdout?.(value); });
    child.stderr?.on('data', value => { if (captureStderr) stderr += value; onStderr?.(value); });
    child.once('error', value => { error = value; });
    child.once('close', (status, terminalSignal) => {
      for (const [name, handler] of handlers) process.off(name, handler);
      resolveResult({ status: callerSignal ? null : status, signal: callerSignal ?? terminalSignal,
        ...(child.stdout ? { stdout } : {}), ...(child.stderr ? { stderr } : {}), ...(error ? { error } : {}) });
    });
  });
}

function parseLocks(raw) {
  const locks = JSON.parse(raw);
  if (!Array.isArray(locks)) throw new Error('Workspace admission requires a lock array');
  const workspaceLocks = locks;
  for (const lock of workspaceLocks) {
    if (['dependency-input-writer', 'dependency'].includes(lock?.kind) && typeof lock.installDir === 'string' && lock.installDir.trim()
      && lock.path === resolveDependencyRefreshLockPath(lock.installDir)) continue;
    if (!lock || typeof lock.path !== 'string' || !lock.path.trim()
      || (lock.kind !== undefined && lock.kind !== 'workspace')) {
      throw new Error('Workspace admission requires canonical workspace lock paths');
    }
  }
  return workspaceLocks;
}

/** An admitted descendant cannot extend the batch's lock set, even when a
 * missing resource happens to be free. Reuse the owners' authentication. */
export function assertInheritedWorkspaceBuildResources({ locks = [], env = process.env } = {}) {
  let leases;
  try { leases = JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES || '[]'); }
  catch { throw new Error('Workspace producer requires valid inherited publication custody'); }
  if (!Array.isArray(leases)) throw new Error('Workspace producer requires valid inherited publication custody');
  const values = [env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, ...leases];
  for (const lock of locks) {
    if (lock.kind === 'dependency') {
      if (!callerHoldsDependencyConsumption({ installDir: lock.installDir, env })) {
        throw Object.assign(new Error('Workspace producer requires inherited dependency consumption custody'),
          { code: 'HSTACK_WORKSPACE_BUILD_RESOURCES_CHANGED' });
      }
      continue;
    }
    const valid = values.some(value => typeof value === 'string' && callerHoldsWorkspaceBundleLock(resolve(lock.path), value));
    if (!valid) throw Object.assign(new Error('Workspace producer requires every exact inherited resource lease'), {
      code: 'HSTACK_WORKSPACE_BUILD_RESOURCES_CHANGED',
    });
  }
}

export function createWorkspaceBuildResourceObservation({ locks = [], env = process.env, priorityScope } = {}) {
  const lockPaths = locks.flatMap(lock => [resolve(lock.path), resolve(lock.path) + '.priority-claim']);
  const publicationPaths = locks.filter(lock => lock.kind === undefined || lock.kind === 'workspace').map(lock => resolve(lock.path));
  const readerDirectories = locks.filter(lock => lock.kind === 'dependency-input-writer').map(lock => `${resolve(lock.path)}.readers`);
  const directories = [...new Set([...lockPaths.map(dirname), ...readerDirectories])];
  const isRelevant = (directory, filename) => filename == null
      || lockPaths.some(path => dirname(path) === directory && basename(path) === String(filename))
      || readerDirectories.includes(directory)
      || readerDirectories.some(path => dirname(path) === directory && basename(path) === String(filename))
      || publicationPaths.some(path => dirname(path) === directory && isWorkspaceBundleLockPriorityChange(path, filename, priorityScope));
  // This snapshot is shared by standalone waits and the host broker. Heartbeat
  // writes do not change resource identity. Canonical liveness can change even
  // when a crashed holder leaves every byte untouched.
  const readState = () => {
    const publications = publicationPaths.map(path => observeWorkspaceBundleLock(path));
    const snapshot = JSON.stringify([
      lockPaths.map(path => {
        let value;
        try { value = readFileSync(path, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        try {
          const { updatedAtMs, ...identity } = JSON.parse(value);
          return identity;
        } catch { return value; }
      }),
      publications,
      publicationPaths.map(path => observeWorkspaceBundleLockPriority(path, { priorityScope })),
      readerDirectories.map(path => {
        try { return readdirSync(path).sort(); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      }),
    ]);
    return { publicationBlocked: publications.some(publication => publication.active), snapshot };
  };
  const readSnapshot = () => readState().snapshot;
  return { directories, isRelevant, readSnapshot, readState };
}

/** Non-Linux and in-process publishers use the same all-resource attempt as
 * native admission. Contention unwinds every new scope before observation;
 * errors from an entered publisher are terminal and never replayed.
 */
export async function withWorkspaceBuildResources({ locks = [], env = process.env, signal,
  typecheckDeclarationPhase = false, admittedResourceWait = false }, run) {
  const priorityScope = createWorkspaceBuildResourcePriorityScope({ locks, env, signal });
  const resources = createWorkspaceBuildResourceObservation({ locks, env, priorityScope });
  const observation = { ...resources, observer: createFileChangeObserver(resources.directories, { isRelevant: resources.isRelevant }) };
  const inherited = await hasInheritedPackageBuildCustody(env);
  // Declaration emission reuses the containing compiler's capacity. It may
  // wait for publication without retaining another package writer. All partial
  // attempts unwind.
  const declarationWait = typecheckDeclarationPhase && !await hasInheritedPackageBuildCustody(env);
  let waited = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      priorityScope.activate();
      const snapshot = observation.observer.capture(observation.readSnapshot);
      let entered = false;
      try {
        return await withLocks(locks, env, signal, async acquiredEnv => {
          entered = true;
          priorityScope.dispose();
          return await run(acquiredEnv, { waited });
        }, priorityScope);
      } catch (error) {
        if (entered || !isWorkspaceResourceBusy(error)) throw error;
        if (!declarationWait && (inherited || (!admittedResourceWait
          && (env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED === '0'
            || process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED === '0')))) {
          throw error;
        }
        if (!waited) console.error(error.message.replace(/^HSTACK_WORKSPACE_ADMISSION_ORDER: /u, ''));
        waited = true;
      }
      await observation.observer.wait({ snapshot, readSnapshot: observation.readSnapshot,
        maxWaitMs: DEFAULT_FILE_CHANGE_CATCH_UP_MS, signal });
    }
  } finally {
    observation.observer.close();
    priorityScope.dispose();
  }
}

async function withLocks(locks, env, signal, run, priorityScope, index = 0) {
  if (index === locks.length) return await run(env);
  const lock = locks[index];
  if (lock.kind === 'dependency' || lock.kind === 'dependency-input-writer') {
    let entered = false;
    const next = acquiredEnv => {
      entered = true;
      return withLocks(locks, acquiredEnv, signal, run, priorityScope, index + 1);
    };
    try {
      return lock.kind === 'dependency'
        ? await withDependencyConsumption({ installDir: lock.installDir, env, signal, wait: false }, next)
        : await withDependencyRefreshLock({ installDir: lock.installDir, env, signal, wait: false },
          context => next(resolveLockedInstallEnv(env, context)));
    } catch (error) {
      if (!entered && isWorkspaceResourceBusy(error)) priorityScope.suspend();
      throw error;
    }
  }
  return await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const leases = env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES
      ? JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES) : [];
    if (!Array.isArray(leases) || leases.some(value => typeof value !== 'string')) {
      throw new Error('Workspace admission requires an array of existing lock leases');
    }
    return await withLocks(locks, { ...env,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD || heldLockValue,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: JSON.stringify([...new Set([...leases, heldLockValue])]),
    }, signal, run, priorityScope, index + 1);
  }, {
    lockPath: resolve(lock.path), env, signal, wait: false, priorityScope,
    ...(lock.timeoutMs !== undefined ? { timeoutMs: lock.timeoutMs === null ? Infinity : lock.timeoutMs } : {}),
    ...(lock.staleAfterMs !== undefined ? { staleAfterMs: lock.staleAfterMs === null ? Infinity : lock.staleAfterMs } : {}),
    ...(lock.pollIntervalMs !== undefined ? { pollIntervalMs: lock.pollIntervalMs } : {}),
    ...(lock.errorLabel !== undefined ? { errorLabel: lock.errorLabel } : {}),
  });
}

/** Standalone platform adapter. Linux capacity and queue custody are owned
 * by admission_client; inherited producers consume their parent's resources. */
export async function runWorkspaceBuildAdmissionWorker(argv) {
  if (argv.length === 1 && argv[0] === '--held-lock-probe') {
    process.exitCode = await hasInheritedPackageBuildCustody(process.env) ? 0 : 1;
    return;
  }
  const [mode, rawLocks, launcherPath, admissionClass, delimiter, command, ...args] = argv;
  if (!['--standalone', '--dev-startup', '--inherited-resources'].includes(mode) || delimiter !== '--' || !command) {
    throw new Error('Invalid workspace admission worker invocation');
  }
  const locks = parseLocks(rawLocks);
  if (mode === '--inherited-resources') assertInheritedWorkspaceBuildResources({ locks, env: process.env });
  if (mode === '--dev-startup') process.env.HAPPIER_WORKSPACE_BUILD_STARTUP = '1';
  if (mode === '--standalone' && process.platform === 'linux') {
    const { requiresTypeScriptAdmission } = await import('../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs');
    if (requiresTypeScriptAdmission({ env: process.env, platform: process.platform })) {
      throw new Error('A workspace build requiring native admission cannot use standalone execution');
    }
  }
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, interrupt);
  try {
    const run = async env => {
      cancellation.signal.throwIfAborted();
      const invocation = mode === '--inherited-resources' && process.platform === 'linux'
        ? { command: '/bin/sh', args: [launcherPath, '--heavyweight-admission', '--require-inherited', '--class=' + admissionClass,
          '--machine=' + (env.HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE || 'local'), '--', command, ...args] }
        : process.platform === 'win32'
          ? (await import('../process/resolveCommandInvocation.mjs')).resolveCommandInvocation({ command, args, env })
          : { command, args };
      const result = await new Promise((resolveResult, reject) => {
        const child = spawnForegroundCommand(invocation.command, invocation.args, { env, signal: cancellation.signal,
          stdio: 'inherit', ownedProcessGroup: true,
          ...(invocation.windowsVerbatimArguments !== undefined ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments } : {}) });
        child.once('error', reject);
        child.once('close', (status, terminalSignal) => resolveResult({ status, signal: terminalSignal }));
      });
      process.exitCode = result.signal ? 128 + (constants.signals[result.signal] ?? 0) : result.status ?? 1;
    };
    if (mode === '--inherited-resources') await run(process.env);
    else await withWorkspaceBuildResources({ locks, env: process.env, signal: cancellation.signal }, run);
  } catch (error) {
    if (!cancellation.signal.aborted) throw error;
    process.exitCode = 130;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runWorkspaceBuildAdmissionWorker(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
