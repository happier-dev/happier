import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { constants } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { brokerAddress } from './admission_socket.mjs';

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
  const label = { HSTACK_MEMORY_BUSY: 'BUSY', HSTACK_WORKSPACE_RESOURCE_BUSY: 'BUSY',
    HSTACK_MEMORY_CAPACITY: 'CAPACITY', HSTACK_DISK_UNAVAILABLE: 'DISK' }[reason] ?? 'UNAVAILABLE';
  console.error(`[preferred-execution] heavyweight admission refused (${reason}${cause ? `: ${cause}` : ''})`);
  if (failureId) console.error(`HSTACK_ADMISSION_${label}:${failureId}`);
  return 75;
}

async function runPayload({ command, args, env, signal }) {
  const { spawnForegroundCommand } = await import('./proc.mjs');
  return await new Promise((resolveResult, reject) => {
    const child = spawnForegroundCommand(command, args, { env, signal, stdio: 'inherit', ownedProcessGroup: true });
    child.once('error', reject);
    child.once('close', (status, terminalSignal) => {
      resolveResult(terminalSignal ? 128 + (constants.signals[terminalSignal] ?? 0) : status ?? 1);
    });
  });
}

/** The client retains canonical filesystem custody and its kernel slot until
 * the payload finishes. Broker loss only reconnects control, never the payload.
 */
export async function runAdmissionCommand({ root, className, floorKiB, machine, command, args = [],
  locks = [], noWait = false, requireInherited = false, failureId, repoDir = process.cwd(),
  exportMode, exportWorkers,
  cacheBaseDir = process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR, env = process.env } = {}) {
  const cancellation = new AbortController();
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
  const run = acquiredEnv => runPayload({ command, args, env: acquiredEnv, signal: cancellation.signal });
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
        console.error('[preferred-execution] producer requires authenticated inherited native admission');
        return 1;
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
      console.error('[preferred-execution] producer requires inherited native admission');
      return 1;
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
    const request = { kind: 'acquire', className, floorKiB, pid: process.pid, arrivedAt: Date.now(),
      repoDir, cacheBaseDir, noWait, locks, ...(floorOptions ? { floorOptions } : {}) };
    if (locks.length) {
      const { createWorkspaceBuildResourcePriorityScope } = await import('./workspace_build_admission.mjs');
      priorityScope = createWorkspaceBuildResourcePriorityScope({ locks, env, signal: cancellation.signal });
    }
    let selectedFloorKiB = floorKiB;
    let selectedWorkers;
    while (!cancellation.signal.aborted) {
      control = await connectAdmissionBroker(root);
      cancellation.signal.throwIfAborted();
      const onAbort = () => control.destroy();
      cancellation.signal.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const response of brokerResponses(control, request, cancellation.signal)) {
          if (response.kind === 'refused') return failure(response.reason, failureId, response.cause);
          if (response.kind === 'queued') {
            const position = response.queuePosition === undefined ? ''
              : `, position=${response.queuePosition}, ahead=${response.countAhead}`;
            console.error(`[preferred-execution] waiting for admission (class=${className}${position}, waiting=${response.waitingCount})`);
          }
          if (response.kind === 'capacity-wait') priorityScope?.suspend();
          if (response.kind === 'reserved') {
            selectedFloorKiB = response.floorKiB;
            selectedWorkers = response.workers;
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
    return 130;
  } catch (error) {
    if (cancellation.signal.aborted) return 130;
    if (inherited || legacyIdentity) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    console.error(`[preferred-execution] admission client failed (${error.code ?? error.name})`);
    return failure('unavailable', payload ? undefined : failureId);
  } finally {
    control?.destroy();
    await closeSlot();
    await resources?.release?.();
    priorityScope?.dispose();
    for (const name of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.off(name, interrupt);
  }
}

export async function runAdmissionClient(argv = process.argv.slice(2)) {
  const delimiter = argv.indexOf('--');
  const options = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const value = name => options.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = value('root');
  if (!root) throw new Error('host admission root is required');
  if (options.some(option => ['--sample', '--active-count', '--waiting-count', '--unreserved-memory', '--check'].includes(option))) {
    const sample = await requestAdmissionSample(root, options.includes('--check')
      ? { kind: 'check', floorKiB: Number(value('floor-kib')) } : { kind: 'sample' });
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
