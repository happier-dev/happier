import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { constants } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relative, resolve } from 'node:path';
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

/** The broker pushes admission/release and deadline crossings on the existing
 * control transport. Reconnection uses the same succession owner as samples. */
export async function* watchAdmissionSamples(root, { signal } = {}) {
  while (!signal?.aborted) {
    const socket = await connectAdmissionBroker(root);
    const abort = () => socket.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const response of brokerResponses(socket, { kind: 'watch' }, signal)) {
        if (response.kind !== 'sample') {
          throw Object.assign(new Error('Admission broker watch requires succession'), { code: 'HSTACK_ADMISSION_WATCH_UNAVAILABLE' });
        }
        yield response;
      }
    } finally { signal?.removeEventListener('abort', abort); socket.destroy(); }
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
  exportMode, exportWorkers, requestedCpuCores, projects, component, entry, readJobPeakKiB,
  cacheBaseDir = process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR, env = process.env, signal } = {}, action) {
  if (typeof action !== 'function') throw new TypeError('Admission requires a task callback');
  const cancellation = new AbortController();
  const onExternalAbort = () => cancellation.abort(signal.reason);
  if (signal?.aborted) onExternalAbort();
  else signal?.addEventListener('abort', onExternalAbort, { once: true });
  let resources, slotServer, control, priorityScope;
  const slotConnections = new Set();
  let payload;
  const interrupt = name => {
    // A `timeout` around a queued command lands here; its output must not read as a run.
    if (!payload && !cancellation.signal.aborted) {
      process.stderr.write(`[admission] interrupted by ${name} while queued for admission; the command was not run\n`);
    }
    cancellation.abort();
  };
  for (const name of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(name, interrupt);
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
    const durationClass = env.HAPPIER_ADMISSION_DURATION_CLASS;
    const p99DurationMs = Number(env.HAPPIER_ADMISSION_DURATION_P99_MS);
    let admittedDuration;
    const request = { kind: 'acquire', className: resolveAdmissionDiskClass(className), resourceClass: className, floorKiB,
      ...(durationClass && Number.isFinite(p99DurationMs) && p99DurationMs > 0 ? { durationClass, p99DurationMs } : {}),
      cpuCost: resolveAdmissionCpuCost(className),
      requestedCpuCores: requestedCpuCores ?? resolveRequestedAdmissionCpuCores({ env }),
      pid: process.pid, arrivedAt: Date.now(),
      repoDir, cacheBaseDir, noWait, locks, projects,
      ...(typeof entry === 'string' && typeof component === 'string' ? { component, entry } : {}),
      // The routed run this preparation step belongs to; the broker ranks a preparation class by it.
      ...(env.HAPPIER_ADMISSION_PREPARES_CLASS ? { preparesClass: env.HAPPIER_ADMISSION_PREPARES_CLASS } : {}),
      ...(floorOptions ? { floorOptions } : {}) };
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
            console.error(`[preferred-execution] waiting for admission (class=${className}, floorKiB=${response.floorKiB ?? floorKiB}${position}, waiting=${response.waitingCount})`);
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
              if (admittedDuration) socket.write(JSON.stringify(admittedDuration) + '\n');
              // A successor broker re-sizes this recovered slot with its identity peak.
              if (request.entry !== undefined) socket.write(JSON.stringify({ kind: 'slot-identity', className: request.className,
                resourceClass: request.resourceClass, projects: request.projects, component: request.component, entry: request.entry }) + '\n');
            });
            await new Promise((ready, reject) => {
              slotServer.once('error', reject);
              slotServer.listen(response.slotAddress, ready);
            });
            control.write(JSON.stringify({ kind: 'ready' }) + '\n');
          }
          if (response.kind === 'admitted' && !payload) {
            if (request.p99DurationMs && response.slotId && response.admittedAt !== undefined) {
              admittedDuration = { kind: 'slot-duration', slotId: response.slotId, admittedAt: response.admittedAt,
                className: request.className, durationClass: request.durationClass, p99DurationMs: request.p99DurationMs };
            }
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
            // Report the scope's kernel peak on the slot before it closes, so the
            // broker records this identity's true high-water mark, success or not.
            payload = run(acquiredEnv).finally(async () => {
              // Only the outermost admission owns its jobs scope. A client nested in
              // another admitted payload shares that scope, so its peak is the parent's.
              if (env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT || env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN) return;
              const peakKiB = await (readJobPeakKiB ?? (await import('./admission_memory.mjs')).readJobScopePeakKiB)();
              if (!Number.isSafeInteger(peakKiB) || peakKiB <= 0) return;
              const line = JSON.stringify({ kind: 'slot-peak', peakKiB, className: request.className,
                resourceClass: request.resourceClass, projects: request.projects, component: request.component, entry: request.entry }) + '\n';
              await Promise.all([...slotConnections].map(socket => new Promise(done => socket.write(line, () => done()))));
            });
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

/** Systemic 20:31Z: identity is the component plus the command's entry (program,
 * package-manager script, or `--test`), never its argument list, so new file
 * lists or flags reuse the recorded peak. */
export function admissionCommandIdentity({ repoDir = process.cwd(), cwd = process.cwd(), command, args = [] }) {
  const separator = args[0] === '--heavyweight-admitted-exec' ? args.indexOf('--') : -1;
  const tokens = separator >= 0 ? args.slice(separator + 1) : [command, ...args];
  const entry = [String(tokens[0] ?? '').split('/').at(-1)];
  for (const token of tokens.slice(1)) {
    if (token === '--test') { entry.push(token); break; }
    if (token.startsWith('-')) continue;
    entry.push(token);
    if (!['run', 'exec', 'x', 'dlx'].includes(token)) break;
  }
  return { component: relative(repoDir, cwd) || '.', entry: entry.join(' ') };
}

export async function runAdmissionCommand({ command, args = [], ...options } = {}) {
  let payloadStarted = false;
  let payloadStartedAt;
  try {
    const identity = options.entry !== undefined ? {} : admissionCommandIdentity({ repoDir: options.repoDir, command, args });
    const status = await runAdmittedTask({ ...identity, ...options,
      requestedCpuCores: options.requestedCpuCores ?? resolveRequestedAdmissionCpuCores({ env: options.env ?? process.env, args }),
    }, (env, signal) => {
      payloadStarted = true;
      payloadStartedAt = Date.now();
      return runPayload({ command, args, env, signal });
    });
    // The dispatcher's wall clock includes queue wait. Report the admitted run
    // time on this host's clock for its duration projection (overrun p99).
    if (options.failureId) console.error(`HSTACK_ADMISSION_RUN_MS:${options.failureId}:${Date.now() - payloadStartedAt}`);
    return status;
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
  // A routed dispatch admits its \`bash -c\` wrapper; the dispatcher forwards the
  // command's own argv and cwd so the identity is the command's, not the wrapper's.
  const identityArgs = options.filter(item => item.startsWith('--identity-arg=')).map(item => item.slice('--identity-arg='.length));
  const repoDir = value('repo') ?? process.cwd();
  const identity = identityArgs.length ? admissionCommandIdentity({ repoDir,
    cwd: resolve(repoDir, value('identity-cwd') ?? '.'), command: identityArgs[0], args: identityArgs.slice(1) }) : {};
  process.exitCode = await runAdmissionCommand({ ...identity, root, className: value('class'),
    floorKiB: Number(value('floor-kib')), machine: value('machine'),
    projects: value('projects')?.split('\n').filter(Boolean),
    exportMode: value('export-mode'), exportWorkers: Number(value('export-workers')),
    requestedCpuCores: value('cpu-cores') === undefined ? undefined
      : value('cpu-cores') === 'host' ? 'host' : Number(value('cpu-cores')),
    repoDir, locks: JSON.parse(value('workspace-locks') ?? '[]'),
    noWait: options.includes('--no-wait'), requireInherited: options.includes('--require-inherited'),
    failureId: value('failure-id'), command: argv[delimiter + 1], args: argv.slice(delimiter + 2) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runAdmissionClient().catch(error => {
    console.error(`[preferred-execution] admission client unavailable (${error.code ?? error.name})`);
    process.exitCode = 1;
  });
}
