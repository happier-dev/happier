import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { constants } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { brokerAddress } from './admission_socket.mjs';
import { resolveAdmissionCpuCost, resolveAdmissionDiskClass, resolveRequestedAdmissionCpuCores } from '../dev_targets/command_resources.mjs';

const brokerPath = fileURLToPath(new URL('./admission_broker.mjs', import.meta.url));
const brokerDisconnected = error => ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOENT'].includes(error.code);

function connect(root) {
  return new Promise((resolveConnection, reject) => {
    const socket = createConnection(brokerAddress(root));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolveConnection(socket);
    });
  });
}

async function startBroker(root) {
  await new Promise((ready, reject) => {
    const child = spawn(process.execPath, [brokerPath, '--serve', root], {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
      // Admission's payload identity must not turn the persistent host producer
      // into a descendant charged to that payload's resources.
      env: { ...process.env, HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT: '',
        HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB: '' },
    });
    const lines = createInterface({ input: child.stdout });
    child.once('error', reject);
    child.once('exit', status => { if (status !== 0) reject(new Error('host admission broker startup failed')); });
    lines.once('line', line => {
      if (line !== 'ready') { reject(new Error('host admission broker readiness unavailable')); return; }
      lines.close();
      child.stdout.destroy();
      child.unref();
      ready();
    });
  });
}

async function assertPrivateAdmissionRoot(root) {
  const state = await lstat(root).catch(() => null);
  if (!state?.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) {
    throw Object.assign(new Error('host admission root is unavailable or not private to this account'), { code: 'EACCES' });
  }
}

export async function connectAdmissionBroker(root) {
  await assertPrivateAdmissionRoot(root);
  while (true) {
    try { return await connect(root); }
    catch (error) {
      if (!brokerDisconnected(error)) throw error;
      // A refused/missing listener enters the existing startup-only lock.
      // A reset connection simply reconnects; startup failures stay terminal.
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) await startBroker(root);
    }
  }
}

async function* brokerResponses(socket, request, signal) {
  const lines = createInterface({ input: socket, signal });
  try {
    socket.write(JSON.stringify(request) + '\n');
    for await (const line of lines) yield JSON.parse(line);
  } catch (error) {
    // A lost transport has the same meaning as EOF. Malformed replies and
    // explicit broker refusals remain terminal at their existing consumers.
    if (!brokerDisconnected(error)) throw error;
  } finally { lines.close(); }
}

export async function requestAdmissionSample(root, request = { kind: 'sample' }) {
  while (true) {
    const socket = await connectAdmissionBroker(root);
    try {
      for await (const response of brokerResponses(socket, request)) return response;
    } finally { socket.destroy(); }
  }
}

function failure(reason, failureId, cause) {
  const label = { HSTACK_MEMORY_BUSY: 'BUSY', HSTACK_CPU_BUSY: 'BUSY', HSTACK_WORKSPACE_RESOURCE_BUSY: 'BUSY',
    HSTACK_MEMORY_CAPACITY: 'CAPACITY', HSTACK_CPU_CAPACITY: 'CAPACITY', HSTACK_DISK_UNAVAILABLE: 'DISK' }[reason] ?? 'UNAVAILABLE';
  console.error(`[preferred-execution] heavyweight admission refused (${reason}${cause ? `: ${cause}` : ''})`);
  if (failureId) console.error(`HSTACK_ADMISSION_${label}:${failureId}`);
  return 75;
}

async function runPayload({ command, args, env, signal }) {
  const { getForegroundCommandResult, spawnForegroundCommand } = await import('./proc.mjs');
  return await new Promise((resolveResult, reject) => {
    const child = spawnForegroundCommand(command, args, { env, signal, stdio: 'inherit', ownedProcessGroup: true });
    child.once('error', reject);
    child.once('close', (nativeStatus, nativeSignal) => {
      const { status, signal: terminalSignal } = getForegroundCommandResult(child, nativeStatus, nativeSignal);
      resolveResult(terminalSignal ? 128 + (constants.signals[terminalSignal] ?? 0) : status ?? 1);
    });
  });
}

/** The client retains canonical filesystem custody and its kernel slot until
 * the payload finishes. Broker loss only reconnects control, never the payload.
 */
export async function runAdmittedTask({ root, className, floorKiB, machine,
  locks = [], noWait = false, requireInherited = false, failureId, repoDir = process.cwd(),
  exportMode, exportWorkers, requestedCpuCores,
  cacheBaseDir = process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR, env = process.env, signal } = {}, action) {
  if (typeof action !== 'function') throw new TypeError('Admission requires a task callback');
  const cancellation = new AbortController();
  const onExternalAbort = () => cancellation.abort(signal.reason);
  if (signal?.aborted) onExternalAbort();
  else signal?.addEventListener('abort', onExternalAbort, { once: true });
  const interrupt = () => cancellation.abort();
  for (const name of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(name, interrupt);
  let resources, slotServer, control, priorityScope;
  const slotConnections = new Set();
  let payload;
  const closeSlot = async () => {
    for (const socket of slotConnections) socket.destroy();
    if (slotServer) {
      await new Promise(done => slotServer.close(done));
      slotServer = null;
    }
  };
  const run = acquiredEnv => Promise.resolve().then(() => action(acquiredEnv, cancellation.signal));
  const modernInherited = env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT === root
    && env.HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE === machine
    && env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT;
  const legacyIdentity = !env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT && env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN;
  let inherited = modernInherited;
  try {
    // Pre-broker hstack-exec parents retain their admitted envelope. Remove
    // this read-only adapter in D7 or when every host's pre-T cohort is zero,
    // whichever comes first (Coordination 2026-10-30 15:45).
    if (legacyIdentity) {
      await assertPrivateAdmissionRoot(env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT);
      inherited = await new Promise((resolveInherited, reject) => {
        const helper = spawn('/bin/sh', ['-c', '. "$1" && . "$2" && has_legacy_inherited_admission',
          'legacy-inherited-admission', fileURLToPath(new URL('./native_process_identity.sh', import.meta.url)),
          fileURLToPath(new URL('./native_admission_client.sh', import.meta.url))],
        { env, signal: cancellation.signal, stdio: 'ignore' });
        helper.once('error', reject);
        helper.once('close', status => resolveInherited(status === 0));
      });
      if (!inherited) {
        throw Object.assign(new Error('producer requires authenticated inherited native admission'),
          { code: 'HSTACK_ADMISSION_INHERITANCE_REQUIRED' });
      }
    }
    if (inherited) {
      // A compiler leaf is a phase of the admitted workload. Its standalone
      // class does not replace the parent's reservation or require admission
      // again (for example, a UI typecheck's declaration/compiler phases).
      const { withWorkspaceBuildResources, assertInheritedWorkspaceBuildResources } = await import('./workspace_build_admission.mjs');
      if (requireInherited) assertInheritedWorkspaceBuildResources({ locks, env });
      // This is already-admitted work, not a capacity waiter. Preserve the
      // canonical resource owner's finite wait when no other writer is held.
      return await withWorkspaceBuildResources({ locks, env, signal: cancellation.signal,
        admittedResourceWait: !requireInherited }, run);
    }
    if (requireInherited) {
      throw Object.assign(new Error('producer requires inherited native admission'),
        { code: 'HSTACK_ADMISSION_INHERITANCE_REQUIRED' });
    }
    // A caller retaining publication custody must settle immediately, never
    // retain its lease while joining the host capacity queue.
    if (env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD || env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES) {
      const { hasInheritedPackageBuildCustody } = await import('./workspace_build_admission.mjs');
      noWait ||= await hasInheritedPackageBuildCustody(env);
    }
    let floorOptions;
    if (className === 'source-web-export' && exportMode === 'managed' && exportWorkers > 0) {
      const { resolveHeavyweightMemoryFloorKiB } = await import('../dev_targets/remote_commands.mjs');
      floorOptions = Array.from({ length: exportWorkers }, (_, index) => ({ workers: index + 1,
        floorKiB: resolveHeavyweightMemoryFloorKiB(className, { machine: 'worker', workers: index + 1 }) }));
    }
    // Reuse the first arrival when this same waiter reconnects after broker loss.
    // Resolve policy from the current catalog, rather than a retained broker's
    // older module. The broker alone owns host capacity and reservations.
    const request = { kind: 'acquire', className: resolveAdmissionDiskClass(className), floorKiB,
      cpuCost: resolveAdmissionCpuCost(className),
      requestedCpuCores: requestedCpuCores ?? resolveRequestedAdmissionCpuCores({ env }),
      pid: process.pid, arrivedAt: Date.now(),
      repoDir, cacheBaseDir, noWait, locks, ...(floorOptions ? { floorOptions } : {}) };
    if (locks.length) {
      const { createWorkspaceBuildResourcePriorityScope } = await import('./workspace_build_admission.mjs');
      priorityScope = createWorkspaceBuildResourcePriorityScope({ locks, env, signal: cancellation.signal });
    }
    let selectedFloorKiB = floorKiB;
    let selectedWorkers;
    let selectedCpuCores;
    while (!cancellation.signal.aborted) {
      control = await connectAdmissionBroker(root);
      cancellation.signal.throwIfAborted();
      const onAbort = () => control.destroy();
      cancellation.signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const response of brokerResponses(control, request, cancellation.signal)) {
          if (response.kind === 'refused') throw new AdmissionRefusal(response.reason, response.cause);
          if (response.kind === 'queued') {
            const position = response.queuePosition === undefined ? ''
              : `, position=${response.queuePosition}, ahead=${response.countAhead}`;
            console.error(`[preferred-execution] waiting for admission (class=${className}, floorKiB=${floorKiB}${position}, waiting=${response.waitingCount})`);
          }
          if (response.kind === 'capacity-wait') priorityScope?.suspend();
          if (response.kind === 'reserved') {
            selectedFloorKiB = response.floorKiB;
            selectedWorkers = response.workers;
            // Retained pre-CPU brokers cannot enforce CPU capacity. Keep their
            // payload defaults at the existing minimum worker unit rather than
            // restoring unrestricted tool fan-out while succession is pending.
            selectedCpuCores = response.cpuCores ?? 1;
            if (locks.length === 0) resources = { acquired: true, env };
            else {
              const { tryWorkspaceBuildResources } = await import('./workspace_build_admission.mjs');
              resources = await tryWorkspaceBuildResources({ locks, env, signal: cancellation.signal, priorityScope });
            }
            if (!resources.acquired) {
              control.write(JSON.stringify({ kind: 'resources-busy' }) + '\n');
              continue;
            }
            slotServer = createServer(socket => {
              slotConnections.add(socket);
              socket.once('close', () => slotConnections.delete(socket));
              socket.on('error', () => socket.destroy());
            });
            await new Promise((ready, reject) => {
              slotServer.once('error', reject);
              slotServer.listen(response.slotAddress, ready);
            });
            control.write(JSON.stringify({ kind: 'ready' }) + '\n');
          }
          if (response.kind === 'admitted' && !payload) {
            const acquiredEnv = { ...resources.env, HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: root,
              HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: machine,
              HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT: String(process.pid),
              HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB: String(selectedFloorKiB),
              HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' };
            if (selectedWorkers !== undefined) acquiredEnv.GOMAXPROCS = String(selectedWorkers);
            if (selectedCpuCores !== undefined) {
              if (!acquiredEnv.GOMAXPROCS) acquiredEnv.GOMAXPROCS = String(selectedCpuCores);
              if (!acquiredEnv.HAPPIER_VITEST_GOVERNOR_MAX_WORKERS) {
                acquiredEnv.HAPPIER_VITEST_GOVERNOR_MAX_WORKERS = String(selectedCpuCores);
              }
            }
            payload = run(acquiredEnv);
            payload.then(() => control?.destroy(), () => control?.destroy());
          }
          if (payload) return await payload;
        }
      } finally {
        cancellation.signal.removeEventListener('abort', onAbort);
        control.destroy();
        if (!payload) {
          await resources?.release?.();
          resources = null;
          await closeSlot();
        }
      }
      // Waiting clients reconnect on broker close. Admitted clients retain
      // their kernel slot, which a replacement broker discovers independently.
    }
    cancellation.signal.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', onExternalAbort);
    control?.destroy();
    await closeSlot();
    await resources?.release?.();
    priorityScope?.dispose();
    for (const name of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.off(name, interrupt);
  }
}

class AdmissionRefusal extends Error {
  constructor(reason, cause) {
    super('Host admission refused the task');
    this.code = reason;
    this.cause = cause;
  }
}

export async function runAdmissionCommand({ command, args = [], ...options } = {}) {
  let payloadStarted = false;
  try {
    return await runAdmittedTask({ ...options,
      requestedCpuCores: options.requestedCpuCores ?? resolveRequestedAdmissionCpuCores({ env: options.env ?? process.env, args }),
    }, (env, signal) => {
      payloadStarted = true;
      return runPayload({ command, args, env, signal });
    });
  } catch (error) {
    if (error.name === 'AbortError') return 130;
    const env = options.env ?? process.env;
    if (options.requireInherited || env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT
      || env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    if (!(error instanceof AdmissionRefusal)) {
      console.error(`[preferred-execution] admission client failed (${error.code ?? error.name})`);
    }
    return failure(error instanceof AdmissionRefusal ? error.code : 'unavailable',
      payloadStarted ? undefined : options.failureId, error.cause);
  }
}

async function resolveNativeHostAdmissionContext(env, signal) {
  // The native owner defines host identity. This one-shot metadata query runs
  // before cold mutation admission; a queued client never runs it again.
  const owner = fileURLToPath(new URL('./native_host_admission_state.sh', import.meta.url));
  return await new Promise((resolveContext, reject) => {
    const child = spawn('/bin/sh', ['-c',
      '. "$1" && resolve_native_host_admission_root && printf "\\n" && resolve_native_host_admission_machine',
      'host-admission-identity', owner], { env, signal, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', value => { stdout += value; });
    child.once('error', reject);
    child.once('close', status => {
      const [root, machine] = stdout.trim().split('\n');
      if (status !== 0 || !root || !machine) {
        reject(new Error('Native host admission identity is unavailable'));
      } else resolveContext({ root, machine });
    });
  });
}

/** In-process mutation shares the native command's reservation and lifecycle. */
export async function runHostAdmittedTask({ className, repoDir = process.cwd(), locks = [],
  env = process.env, signal } = {}, action) {
  if (process.platform !== 'linux') return await action(env, signal);
  const hostIdentity = env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT
    && env.HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE;
  const context = hostIdentity ? { root: env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT,
    machine: env.HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE } : await resolveNativeHostAdmissionContext(env, signal);
  const { resolveHeavyweightMemoryFloorKiB } = await import('../dev_targets/remote_commands.mjs');
  const floorKiB = resolveHeavyweightMemoryFloorKiB(className,
    { machine: env.HAPPIER_DEV_TARGET_EXECUTION === '1' ? 'worker' : 'local' });
  return await runAdmittedTask({ ...context, className, floorKiB, repoDir, locks, env, signal }, action);
}

export async function runAdmissionClient(argv = process.argv.slice(2)) {
  const delimiter = argv.indexOf('--');
  const options = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const value = name => options.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = value('root');
  if (!root) throw new Error('host admission root is required');
  if (options.some(option => ['--sample', '--active-count', '--waiting-count', '--unreserved-memory', '--check'].includes(option))) {
    const sample = await requestAdmissionSample(root, options.includes('--check')
      ? { kind: 'check', floorKiB: Number(value('floor-kib')),
        cpuCost: resolveAdmissionCpuCost(value('class')),
        requestedCpuCores: value('cpu-cores') === 'host' ? 'host' : Number(value('cpu-cores') ?? 0) } : { kind: 'sample' });
    if (options.includes('--check')) process.exitCode = sample.kind === 'admitted' ? 0 : 1;
    else {
      const selected = options.includes('--active-count') ? sample.activeCount
        : options.includes('--waiting-count') ? sample.waitingCount
          : options.includes('--unreserved-memory') ? sample.unreservedMemoryKiB : JSON.stringify(sample);
      process.stdout.write(String(selected) + '\n');
    }
    return;
  }
  if (!options.includes('--run') || delimiter < 0 || !argv[delimiter + 1]) throw new Error('admission requires a command');
  process.exitCode = await runAdmissionCommand({ root, className: value('class'),
    floorKiB: Number(value('floor-kib')), machine: value('machine'),
    exportMode: value('export-mode'), exportWorkers: Number(value('export-workers')),
    requestedCpuCores: value('cpu-cores') === undefined ? undefined
      : value('cpu-cores') === 'host' ? 'host' : Number(value('cpu-cores')),
    repoDir: value('repo') ?? process.cwd(), locks: JSON.parse(value('workspace-locks') ?? '[]'),
    noWait: options.includes('--no-wait'), requireInherited: options.includes('--require-inherited'),
    failureId: value('failure-id'), command: argv[delimiter + 1], args: argv.slice(delimiter + 2) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runAdmissionClient().catch(error => {
    console.error(`[preferred-execution] admission client unavailable (${error.code ?? error.name})`);
    process.exitCode = 1;
  });
}
