import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, isAbsolute, join, posix, relative } from 'node:path';
import { availableParallelism } from 'node:os';
import { FOCUSED_TEST_ADMISSION_CLASSES, HEAVYWEIGHT_COMMAND_RESOURCES, SOURCE_RELOAD_ADMISSION_CLASS, resolveAdmissionCpuCores } from '../dev_targets/command_resources.mjs';
import { createInterface } from 'node:readline';
import { DURATION_WINDOW, nearestRankP99 } from '../dev_targets/execution_provenance.mjs';
import { pathToFileURL } from 'node:url';
import { admitWorkerDiskBudget } from '../dev_targets/worker_disk_budget.mjs';
import { readLinuxWorkerProcesses } from './service_memory.mjs';
import { createWorkspaceBuildResourceObservation } from './workspace_build_admission.mjs';
import { DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { brokerAddress, readSlotAddress, slotAddress } from './admission_socket.mjs';
import { isInAdmissionJobsSlice, readLinuxAdmissionMemory, readProcessJobScopeCurrentKiB } from './admission_memory.mjs';
export { brokerAddress } from './admission_socket.mjs';

// Nearest-rank p95 of 63,482 successful targeted-validation wrapper durations
// (2026-11-13 provenance census; includes preparation/admission). Give backfills
// this measured opportunity window, then accumulate releases for the old head.
const HEAD_RESERVATION_DELAY_MS = 1_344_000;

// Systemic 18:47Z: work that unblocks every lane is served before ordinary
// waiters: first the shared runtime producer (one build at a time under its
// lock), then the blocking commit compiler (every commit gate: whether a
// candidate repairs HEAD is only known after its gate). Derived from the admitted
// command identity, which the canonical client builds from the payload argv; a
// caller-supplied flag grants nothing.
// The rolling HEAD typecheck (P03, 2026-11-16) is the commit compiler for every
// commit packet since per-commit TS compiles moved to it. P03 ORCH 2026-11-17: it
// shares the focused-test rank, so arrival orders them and later focused runs
// cannot starve it (at rank 1 it slid behind them with 49 waiting).
// Owner ruling 2026-11-16 ("small suites local"): focused test runs (up to ten
// explicit files; the command-policy classifier names their class from argv)
// start at the next free slot, after the shared producers and ahead of the
// commit gate compiler (between ranks 2 and 1): they are small (1-3 GiB) and short.
const FOCUSED_TEST_PRIORITY_RANK = 1.5;
const HEAD_PRIORITY_RANKS = new Map([
  ['source-bundle apps/stack/scripts/build/build_source_runtime.mjs', 2],
  // The shared web export every stack's QA browsers consume (one per revision).
  ['source-web-export apps/stack/scripts/build/build_source_web_ui.mjs', 2],
  // A stack's Expo dev-startup web UI build: same producer script, admitted as validation;
  // every borrowed-UI lane waits on it (Systemic 2026-11-16 21:15Z, owner-approved).
  ['validation apps/stack/scripts/build/build_source_web_ui.mjs', 2],
  ['compilation scripts/workspaces/checkCommitTypeCoherence.mjs', 1],
  ['compilation scripts/workspaces/commitPackageTypecheck.mjs', FOCUSED_TEST_PRIORITY_RANK],
]);
const FOCUSED_TEST_CLASSES = new Set(FOCUSED_TEST_ADMISSION_CLASSES);
const PRODUCER_RANK = 2;
// P03 ORCH 2026-11-17: a preparation step is a prerequisite of every run waiting
// on its output, so it takes the highest class rank among the runs currently
// waiting on it (`preparesClass`; never a script rank), or its own rank when that
// is higher. Only these classes take `preparesClass`.
const PREPARATION_CLASSES = new Set(['native-custody', 'package-dist', 'source-asset', 'dependency-install']);
function preparedRank(request) {
  return PREPARATION_CLASSES.has(request.resourceClass ?? request.className) && typeof request.preparesClass === 'string'
    && !PREPARATION_CLASSES.has(request.preparesClass) ? headPriorityRank({ className: request.preparesClass }) : 0;
}
// Requests for the same step share its output: the same class and publication
// locks, or (without locks) the same command identity.
function preparationStepKey(item) {
  const paths = item.locks.map(lock => lock.path).sort();
  return JSON.stringify([item.resourceClass ?? item.className, paths.length ? paths : identityKey(item) ?? item.arrivalOrder]);
}
function headPriorityRank(request) {
  const classPriority = HEAVYWEIGHT_COMMAND_RESOURCES[request.resourceClass ?? request.className]?.headPriority;
  if (classPriority !== undefined) return classPriority;
  if (FOCUSED_TEST_CLASSES.has(request.resourceClass ?? request.className)) return FOCUSED_TEST_PRIORITY_RANK;
  const script = typeof request.entry === 'string' ? request.entry.split(' ')[1] : undefined;
  if (!script || typeof request.repoDir !== 'string') return 0;
  const path = isAbsolute(script) ? relative(request.repoDir, script) : posix.normalize(script);
  return HEAD_PRIORITY_RANKS.get(`${request.resourceClass ?? request.className} ${path}`) ?? 0;
}

// Coordination 2026-11-14 18:21Z (Systemic) and the coordinator's follow-up:
// a recorded job identity reserves its maximum kernel-observed peak (the
// dispatch scope's cgroup memory.peak), rounded up to 0.5 GiB. Event samples are
// lower bounds and never size a reservation. Identities without a kernel peak,
// or requests without a command identity, keep the client's class floor.
const IDENTITY_FLOOR_ROUNDING_KIB = 512 * 1024;
const IDENTITY_PEAKS_FILENAME = 'identity-kernel-peaks.json';
// P03 ORCH 2026-11-18 (P03-BROKER-W2): a request without its run's duration (a
// preparation step or a producer inside a run) is projected by its own identity's
// successful admitted run times, with the same window and nearest-rank p99 as the
// controller's run history. Without a recorded success it has no duration.
const IDENTITY_DURATIONS_FILENAME = 'identity-durations.json';
const IDENTITY_DURATION_CLASS = 'identity-history';
// Systemic 20:31Z: class + component + script/entry + sorted projects, never argv.
const identityKey = item => typeof item.entry === 'string' && item.entry && typeof item.component === 'string'
  ? JSON.stringify([item.resourceClass ?? item.className, item.component, item.entry, [...(item.projects ?? [])].sort()]) : null;

const socketGone = error => error.code === 'ECONNREFUSED' || error.code === 'ENOENT';
const validDuration = value => (value.p99DurationMs === undefined && value.durationClass === undefined)
  || (Number.isFinite(value.p99DurationMs) && value.p99DurationMs > 0
    && typeof value.durationClass === 'string' && /^[a-z][a-z0-9-]*$/.test(value.durationClass));

async function lockFile(fd) {
  // flock locks the inherited open-file description. Retaining the original
  // FD keeps the lock after this one-shot utility exits.
  await new Promise((resolveLocked, reject) => {
    const child = spawn('flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    child.once('error', reject);
    child.once('exit', status => status === 0 ? resolveLocked()
      : reject(Object.assign(new Error('Admission lock unavailable'), { code: 'HSTACK_ADMISSION_UNAVAILABLE' })));
  });
}

async function withStartupLock(root, run, inheritedFd) {
  const fd = inheritedFd ?? openSync(join(root, 'broker-start.lock'), 'a', 0o600);
  try {
    if (inheritedFd === undefined) await lockFile(fd);
    return await run();
  } finally { closeSync(fd); }
}

async function socketListening(address) {
  const peer = createConnection(address);
  try {
    await new Promise((resolveConnected, reject) => {
      peer.once('connect', resolveConnected);
      peer.once('error', reject);
    });
    return true;
  } catch (error) {
    if (socketGone(error)) return false;
    throw error;
  } finally { peer.destroy(); }
}

/** Physical availability already excludes resident pages. Credit each admitted
 * tree's resident pages once, reserving only the part of its floor still free. */
export async function readAdmissionMemorySample({ slots = [], waiters = [], readProcesses = readLinuxWorkerProcesses,
  readMemory = readLinuxAdmissionMemory, inJobsSlice = isInAdmissionJobsSlice } = {}) {
  const processes = slots.length || waiters.length ? await readProcesses() : new Map();
  const roots = new Set(slots.map(slot => slot.pid));
  const waitingPids = new Set(waiters.map(item => item.pid));
  let waitingResidentMemoryKiB = 0;
  let waitingSliceResidentMemoryKiB = 0;
  const residentByRoot = new Map();
  const slotRssKiB = new Map();
  for (const process of processes.values()) {
    let pid = process.pid;
    while (pid > 1 && !roots.has(pid)) {
      const parent = processes.get(pid)?.parentPid;
      if (!parent || parent === pid) { pid = 0; break; }
      pid = parent;
    }
    if (roots.has(pid)) {
      if (Number.isSafeInteger(process.rssKiB) && process.rssKiB >= 0) {
        slotRssKiB.set(pid, (slotRssKiB.get(pid) ?? 0) + process.rssKiB);
      }
      const proportional = process.pssKiB;
      const exact = Number.isSafeInteger(proportional) && proportional >= 0;
      const resident = exact ? proportional : 0;
      residentByRoot.set(pid, (residentByRoot.get(pid) ?? 0) + resident);
    } else if (waitingPids.has(process.pid)) {
      // Credit only the client itself, never its parent or descendants. PSS
      // avoids counting shared Node pages repeatedly across queued clients.
      const resident = process.pssKiB;
      if (Number.isSafeInteger(resident) && resident >= 0) {
        waitingResidentMemoryKiB += resident;
        if (inJobsSlice(process.pid)) waitingSliceResidentMemoryKiB += resident;
      }
    }
  }
  // Host credit applies before the OS owner clamps to the jobs slice; only
  // clients inside that slice also return their pages to its headroom.
  // A queued control client must not consume the capacity it is waiting for.
  const memory = await readMemory({ waitingResidentMemoryKiB, waitingSliceResidentMemoryKiB });
  if (!Number.isSafeInteger(memory.availableMemoryKiB) || memory.availableMemoryKiB < 0
    || !Number.isSafeInteger(memory.totalMemoryKiB) || memory.totalMemoryKiB < 0) {
    throw Object.assign(new Error('Memory observation unavailable'), { code: 'HSTACK_MEMORY_UNAVAILABLE' });
  }
  const residentMemoryKiB = [...residentByRoot.values()].reduce((sum, value) => sum + value, 0);
  const creditedResidentMemoryKiB = slots.reduce((sum, slot) => sum + Math.min(slot.floorKiB, residentByRoot.get(slot.pid) ?? 0), 0);
  const reservedMemoryKiB = slots.reduce((sum, slot) => sum + slot.floorKiB, 0);
  const achievableMemoryKiB = Math.min(memory.totalMemoryKiB, memory.availableMemoryKiB + residentMemoryKiB);
  return { ...memory, slotRssKiB, reservedMemoryKiB, residentMemoryKiB, creditedResidentMemoryKiB, waitingResidentMemoryKiB,
    achievableMemoryKiB,
    unreservedMemoryKiB: Math.max(0, memory.availableMemoryKiB + creditedResidentMemoryKiB - reservedMemoryKiB) };
}

/** One Linux host authority. The control connection carries the finite
 * admission handshake; a client-owned pathname listener carries job lifetime.
 * The existing private root's OS permissions are the sole peer boundary. */
// The host's admission root (native_host_admission_state.sh) and the legacy
// launchers' host-wide mutex. Only the host broker takes that mutex; a broker for
// any other root (tests, scratch) keeps its own under that root, so it can never
// block the host broker's succession (2026-11-17 20:47Z: a leaked test broker held
// it and the controller's successor waited 8 min).
const HOST_ADMISSION_ROOT = `/tmp/happier-heavyweight-admission-v3-${process.getuid?.()}`;
const HOST_LEGACY_LOCK_PATH = '/tmp/happier-heavyweight-admission-v3/lock';
export function createAdmissionBroker({ root,
  oldLockPath = root === HOST_ADMISSION_ROOT ? HOST_LEGACY_LOCK_PATH : join(root, 'old-admission.lock'),
  oldLockFd, startupLockFd, sampleResources = readAdmissionMemorySample, readCpuCapacity = availableParallelism,
  readRecoveredSlotMemoryKiB = readProcessJobScopeCurrentKiB,
  admitDisk = request => request.cacheBaseDir
    ? admitWorkerDiskBudget({ ...request, commandClass: request.className }) : { admitted: true } } = {}) {
  const slots = new Map();
  const waiting = [];
  const controls = new Set();
  const pendingConnections = new Set();
  const subscribers = new Map();
  let overrunWake;
  const watchers = new Map();
  const pendingResourceChanges = new Set();
  let resourceCatchUp;
  let rootWatcher;
  let sample = { availableMemoryKiB: 0, totalMemoryKiB: 0, reservedMemoryKiB: 0,
    residentMemoryKiB: 0, unreservedMemoryKiB: 0, achievableMemoryKiB: 0 };
  let totalCpuCores;
  let sampleCount = 0;
  let arrivalOrder = 0;
  let headPledge;
  let serial = Promise.resolve();
  let closing = false;
  let server;
  let started = false;
  let heldOldLockFd = oldLockFd;

  let identityPeaks;
  function recordedIdentityPeaks() {
    if (identityPeaks) return identityPeaks;
    identityPeaks = new Map();
    try {
      for (const [key, peak] of Object.entries(JSON.parse(readFileSync(join(root, IDENTITY_PEAKS_FILENAME), 'utf8')))) {
        if (Number.isSafeInteger(peak) && peak > 0) identityPeaks.set(key, peak);
      }
    } catch (error) { if (error.code !== 'ENOENT') recordFailure(error); }
    return identityPeaks;
  }
  let identityDurations;
  function recordedIdentityDurations() {
    if (identityDurations) return identityDurations;
    identityDurations = new Map();
    try {
      for (const [key, durations] of Object.entries(JSON.parse(readFileSync(join(root, IDENTITY_DURATIONS_FILENAME), 'utf8')))) {
        if (Array.isArray(durations) && durations.every(value => Number.isFinite(value) && value > 0)) identityDurations.set(key, durations);
      }
    } catch (error) { if (error.code !== 'ENOENT') recordFailure(error); }
    return identityDurations;
  }
  function recordIdentityDuration(key, durationMs) {
    const durations = recordedIdentityDurations();
    durations.set(key, [...(durations.get(key) ?? []), durationMs].slice(-DURATION_WINDOW));
    const target = join(root, IDENTITY_DURATIONS_FILENAME);
    writeFileSync(`${target}.tmp`, JSON.stringify(Object.fromEntries(durations)), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  }
  function recordedIdentityDuration(item) {
    const key = identityKey(item);
    const p99DurationMs = key === null ? null : nearestRankP99(recordedIdentityDurations().get(key) ?? []);
    return p99DurationMs > 0 ? { durationClass: IDENTITY_DURATION_CLASS, p99DurationMs } : {};
  }
  const roundPeak = peakKiB => Math.ceil(peakKiB / IDENTITY_FLOOR_ROUNDING_KIB) * IDENTITY_FLOOR_ROUNDING_KIB;
  function classKernelMaximumKiB(resourceClass) {
    let maximum;
    for (const [key, peak] of recordedIdentityPeaks()) {
      if (JSON.parse(key)[0] === resourceClass) maximum = Math.max(maximum ?? 0, peak);
    }
    return maximum;
  }
  // A project contains another when it is the same path, an ancestor directory, or the whole repository.
  const projectContains = (outer, inner) => outer === '.' || outer === inner || inner.startsWith(`${outer}/`);
  /** An unrecorded identity starts from its relatives in the same class, most specific first: recorded
   * runs of the same command (entry) over a superset of its projects (the smallest such peak bounds
   * it); otherwise that command's maximum; otherwise the maximum over runs of its exact project set.
   * Only with no related record does it take the class kernel maximum. Its own first completion then
   * records its real peak, which sizes every later run. */
  function relatedIdentityPeakKiB(item) {
    const resourceClass = item.resourceClass ?? item.className;
    const projects = [...(item.projects ?? [])].sort();
    let supersetMinimum; let familyMaximum; let projectSetMaximum;
    for (const [key, peak] of recordedIdentityPeaks()) {
      const [recordedClass, , entry, recordedProjects] = JSON.parse(key);
      if (recordedClass !== resourceClass) continue;
      if (entry === item.entry) {
        familyMaximum = Math.max(familyMaximum ?? 0, peak);
        if (projects.length && projects.every(inner => recordedProjects.some(outer => projectContains(outer, inner)))) {
          supersetMinimum = Math.min(supersetMinimum ?? Infinity, peak);
        }
      } else if (projects.length && JSON.stringify(recordedProjects) === JSON.stringify(projects)) {
        projectSetMaximum = Math.max(projectSetMaximum ?? 0, peak);
      }
    }
    return supersetMinimum ?? familyMaximum ?? projectSetMaximum ?? classKernelMaximumKiB(resourceClass);
  }
  function recordedIdentityPeakKiB(item) {
    const key = identityKey(item);
    // Never below the identity's observed maximum, even above the class floor.
    // Unrecorded identities start from related records (relatedIdentityPeakKiB); no history, none.
    return (key === null ? undefined : recordedIdentityPeaks().get(key) ?? relatedIdentityPeakKiB(item))
      ?? classKernelMaximumKiB(item.resourceClass ?? item.className);
  }
  function recordedIdentityFloorKiB(item) {
    const peak = recordedIdentityPeakKiB(item);
    return peak === undefined ? item.floorKiB : roundPeak(peak);
  }
  /** Worker-count options follow the same identity rule: with a recorded peak,
   * offer the worker counts whose modelled floor fits inside it (else the
   * smallest), each reserving that peak, never the modelled maximum. */
  function recordedIdentityFloorOptions(item) {
    const peak = item.floorOptions && recordedIdentityPeakKiB(item);
    if (peak === undefined || !item.floorOptions) return item.floorOptions;
    const floorKiB = roundPeak(peak);
    const within = item.floorOptions.filter(option => option.floorKiB <= floorKiB);
    const offered = within.length ? within
      : [item.floorOptions.reduce((smallest, option) => option.workers < smallest.workers ? option : smallest)];
    return offered.map(option => ({ ...option, floorKiB }));
  }
  function recordIdentityPeak(identity, peakKiB) {
    const key = identityKey(identity);
    if (key === null) return;
    const peaks = recordedIdentityPeaks();
    if ((peaks.get(key) ?? 0) >= peakKiB) return;
    peaks.set(key, peakKiB);
    const target = join(root, IDENTITY_PEAKS_FILENAME);
    writeFileSync(`${target}.tmp`, JSON.stringify(Object.fromEntries(peaks)), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  }

  // Higher priority ranks go first; arrival orders waiters within a rank.
  // Owner 2026-11-13 (capped head reservation): a waiter past the measured bound
  // has a guaranteed start, so overdue waiters are served first, in arrival order,
  // whatever their rank. Without this, ranked arrivals headed nl1's queue for
  // 2.5 h while rank-0 work never reserved (P03-ADMISSION-3, 2026-11-17).
  // P03 ORCH RULING 2026-11-17 (owner 15:31Z): QA reload preparation runs ahead of
  // tests, so it precedes overdue waiters: source-reload, then overdue FIFO, then rank.
  const overdue = (item, now) => now - item.arrivedAt >= HEAD_RESERVATION_DELAY_MS;
  const reload = item => (item.resourceClass ?? item.className) === SOURCE_RELOAD_ADMISSION_CLASS;
  const compareService = now => (left, right) => Number(reload(right)) - Number(reload(left))
    || Number(overdue(right, now)) - Number(overdue(left, now))
    || (overdue(left, now) ? 0 : right.headPriority - left.headPriority)
    || left.arrivedAt - right.arrivedAt || left.arrivalOrder - right.arrivalOrder;
  // Order is a function of time and of who waits on a shared step; re-derive it
  // on every pass, never on a timer.
  const orderWaiting = () => {
    const stepRanks = new Map();
    for (const item of waiting) {
      if (item.slot || !PREPARATION_CLASSES.has(item.resourceClass ?? item.className)) continue;
      const key = preparationStepKey(item);
      stepRanks.set(key, Math.max(stepRanks.get(key) ?? 0, item.preparedPriority));
    }
    for (const item of waiting) {
      if (PREPARATION_CLASSES.has(item.resourceClass ?? item.className)) {
        item.headPriority = Math.max(item.ownPriority, stepRanks.get(preparationStepKey(item)) ?? 0);
      }
    }
    return waiting.sort(compareService(Date.now()));
  };

  function slotResourceBudget() {
    let reservedMemoryKiB = 0;
    let reservedCpuCores = 0;
    for (const slot of slots.values()) {
      reservedMemoryKiB += slot.floorKiB;
      reservedCpuCores += slot.cpuCores ?? 0;
    }
    return { reservedMemoryKiB, totalCpuCores, reservedCpuCores,
      unreservedCpuCores: Math.max(0, totalCpuCores - reservedCpuCores),
      unreservedMemoryKiB: Math.max(0, sample.availableMemoryKiB + (sample.creditedResidentMemoryKiB ?? 0) - reservedMemoryKiB) };
  }
  function cpuCost(item, workers) {
    // The current client resolves class policy, just like its memory floor.
    // A retained broker must not re-decide it from an older catalog. Legacy
    // clients without a CPU declaration reserve the host until they finish.
    return resolveAdmissionCpuCores(item.cpuCost ?? 'host',
      { totalCpuCores, workers, requestedCpuCores: item.requestedCpuCores });
  }
  // Only explicit per-job core declarations are counted against fixed host
  // capacity. 'host' and undeclared costs carry no measured core budget, so
  // they are admitted on memory alone, as before CPU accounting; counting them
  // as whole-host reservations serialized every heavyweight class per host.
  function accountedCpuCores(item, workers) {
    return (item.cpuCost ?? 'host') === 'host' ? 0 : cpuCost(item, workers);
  }
  function validCpuRequest(request) {
    return (request.cpuCost === undefined || request.cpuCost === 'host' || request.cpuCost === 'workers'
      || (Number.isSafeInteger(request.cpuCost) && request.cpuCost > 0))
      && (request.requestedCpuCores === undefined || request.requestedCpuCores === 'host'
        || (Number.isSafeInteger(request.requestedCpuCores) && request.requestedCpuCores >= 0));
  }
  function minimumCpuCores(item) {
    return item.floorOptions ? Math.min(...item.floorOptions.map(option => accountedCpuCores(item, option.workers))) : accountedCpuCores(item);
  }
  function reserveHead(head) {
    // Eligibility can flap with achievable memory or publication pressure.
    // Keep earned releases on the waiting item until it is admitted or gone.
    headPledge = head ? (head.headPledge ??= { item: head, memoryKiB: 0, cpuCores: 0 }) : undefined;
  }
  function headReservation(head) {
    // A priority head pledges releases at once; ordinary heads after the aging bound.
    const active = Boolean(head && (head.headPriority > 0 || Date.now() - head.arrivedAt >= HEAD_RESERVATION_DELAY_MS));
    const pledged = active && headPledge?.item === head;
    const floorKiB = head?.floorOptions?.at(-1).floorKiB ?? head?.floorKiB;
    return {
      active,
      // Systemic 18:35Z: a shared-producer head holds every unit up to its
      // floor, free or released, so nothing backfills past it once it is next.
      // Other heads hold only released memory (priority ranks at once).
      memoryKiB: !active ? 0 : head.headPriority >= PRODUCER_RANK ? floorKiB : pledged ? Math.min(floorKiB, headPledge.memoryKiB) : 0,
      cpuCores: pledged ? Math.min(minimumCpuCores(head), headPledge.cpuCores) : 0,
    };
  }
  function canReserveHead(item) {
    const minimumFloorKiB = item.floorOptions?.at(-1).floorKiB ?? item.floorKiB;
    // Non-admitted memory cannot be recovered by draining broker slots. Keep
    // this request's age, but reserve only once the observed floor is achievable.
    return !item.slot && !item.blocked && !item.socket.destroyed && minimumFloorKiB <= sample.achievableMemoryKiB
      && minimumCpuCores(item) <= totalCpuCores;
  }
  function status() {
    const now = Date.now();
    const overruns = [];
    let nextOverrunAt = null;
    let durationHistoryUnavailableCount = 0;
    for (const slot of slots.values()) {
      if (!(slot.p99DurationMs > 0)) {
        durationHistoryUnavailableCount += 1;
        continue;
      }
      if (!Number.isFinite(slot.admittedAt)) continue;
      const ageMs = Math.max(0, now - slot.admittedAt);
      const thresholdAt = slot.admittedAt + 2 * slot.p99DurationMs;
      if (now > thresholdAt) overruns.push({ slotId: slot.slotId,
        className: Object.hasOwn(HEAVYWEIGHT_COMMAND_RESOURCES, slot.className) ? slot.className : 'unknown',
        durationClass: slot.durationClass, ageMs, p99DurationMs: slot.p99DurationMs });
      else nextOverrunAt = nextOverrunAt === null ? thresholdAt + 1 : Math.min(nextOverrunAt, thresholdAt + 1);
    }
    const budget = slotResourceBudget();
    orderWaiting();
    const head = waiting.find(canReserveHead);
    const reservation = headReservation(head);
    // Only catalog symbols and numeric resource facts leave this private queue.
    // Never expose request env, paths, PIDs or an arbitrary caller label.
    const symbolicClass = item => Object.hasOwn(HEAVYWEIGHT_COMMAND_RESOURCES, item.className) ? item.className : 'unknown';
    const minimumFloor = item => item.floorOptions?.at(-1).floorKiB ?? item.floorKiB;
    const buckets = new Map();
    for (const item of waiting) {
      if (item.slot) continue;
      const bucket = { className: symbolicClass(item), floorKiB: item.floorKiB,
        minimumFloorKiB: minimumFloor(item),
        ...(item.floorOptions ? { floorOptions: item.floorOptions.map(({ floorKiB, workers }) => ({ floorKiB, workers })) } : {}) };
      const key = JSON.stringify(bucket);
      const existing = buckets.get(key);
      if (existing) existing.count += 1;
      else buckets.set(key, { ...bucket, count: 1 });
    }
    // Publish the same head reservation used by drain and read-only checks.
    // Publication-blocked demand has no memory reservation.
    return { ...sample, ...budget, overruns, nextOverrunAt, durationHistoryUnavailableCount,
      head: head ? { className: symbolicClass(head), minimumFloorKiB: minimumFloor(head),
        ageMs: Math.max(0, Date.now() - head.arrivedAt), reservationKiB: reservation.memoryKiB,
        reservationActive: reservation.active, reservationDelayMs: HEAD_RESERVATION_DELAY_MS, headPriority: head.headPriority,
        ...(headPledge?.item === head && headPledge.lastHostBoundAdmissionKiB !== undefined
          ? { lastHostBoundAdmissionKiB: headPledge.lastHostBoundAdmissionKiB } : {}) } : null,
      waitingByClassAndFloor: [...buckets.values()],
      unreservedCpuCores: Math.max(0, budget.unreservedCpuCores - reservation.cpuCores),
      queuedCpuCores: waiting.reduce((sum, item) => sum + (item.slot ? 0 : accountedCpuCores(item, item.floorOptions?.[0]?.workers)), 0),
      unreservedMemoryKiB: Math.max(0, budget.unreservedMemoryKiB - reservation.memoryKiB),
      queuedMemoryKiB: waiting.reduce((sum, item) => sum + (item.slot ? 0 : item.floorKiB), 0),
      expectedStartMs: projectedArrivalStartMs(now),
      activeCount: slots.size, waitingCount: waiting.filter(item => !item.slot).length, sampleCount };
  }
  const send = (socket, value, snapshot = status()) => { if (!socket.destroyed) socket.write(JSON.stringify({ ...snapshot, ...value }) + '\n'); };
  function recordFailure(error) {
    // Keep only a symbolic code and a source location, never exception text,
    // resource paths or OS payloads. Retain this evidence after recovery.
    const candidate = error?.code ?? error?.name;
    const code = typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(candidate) ? candidate : 'Error';
    const source = String(error?.stack ?? '').split('\n').slice(1)
      .map(line => /^\s+at .*?([A-Za-z0-9_.-]+\.mjs:\d+:\d+)\)?$/.exec(line)?.[1]).find(Boolean);
    sample = { ...sample, lastFailure: { code, ...(source ? { source } : {}) } };
  }
  function enqueue(run) {
    serial = serial.then(async () => { if (!closing) await run(); }).catch(error => {
      recordFailure(error);
      // A failed observation cannot authorize work from a stale capacity fact.
      sample = { ...sample, availableMemoryKiB: 0, creditedResidentMemoryKiB: 0, achievableMemoryKiB: 0, unreservedMemoryKiB: 0 };
      // The failed pass does not decide the fate of unrelated waiters. Keep
      // their order, watchers and existing catch-up so the next pass can decide.
    }).then(publishQueuePositions).then(publishAdmissionStatus);
    return serial;
  }
  function publishAdmissionStatus() {
    clearTimeout(overrunWake);
    overrunWake = undefined;
    if (closing || subscribers.size === 0) return;
    const snapshot = status();
    const identity = JSON.stringify({ activeCount: snapshot.activeCount,
      durationHistoryUnavailableCount: snapshot.durationHistoryUnavailableCount,
      nextOverrunAt: snapshot.nextOverrunAt, overruns: snapshot.overruns.map(({ ageMs, ...slot }) => slot) });
    for (const [socket, previous] of subscribers) {
      if (previous === identity) continue;
      subscribers.set(socket, identity);
      send(socket, { kind: 'sample' }, snapshot);
    }
    if (snapshot.nextOverrunAt !== null) {
      // Node timers support signed 32-bit milliseconds. Long recorded classes
      // wake at that platform boundary and then retain their real deadline.
      overrunWake = setTimeout(() => enqueue(async () => {}),
        Math.min(2_147_483_647, Math.max(1, snapshot.nextOverrunAt - Date.now())));
    }
  }
  function publishQueuePositions() {
    if (closing) return;
    orderWaiting();
    const queued = waiting.filter(item => !item.slot);
    let snapshot;
    for (const [index, item] of queued.entries()) {
      const queuePosition = index + 1;
      if (item.queuePosition === queuePosition) continue;
      item.queuePosition = queuePosition;
      // One shared status projection keeps a queue advance proportional to
      // its waiters instead of rescanning the queue for every notice.
      snapshot ??= status();
      // Name the floor this broker reserves (identity peak), not the client's class floor.
      send(item.socket, { kind: 'queued', queuePosition, countAhead: index, floorKiB: item.floorOptions?.at(-1).floorKiB ?? item.floorKiB }, snapshot);
    }
  }
  async function observe() {
    const { slotRssKiB, ...resources } = await sampleResources({
      slots: [...slots.values()].map(({ pid, floorKiB }) => ({ pid, floorKiB })),
      waiters: waiting.filter(item => !item.slot).map(({ pid }) => ({ pid })) });
    sample = { ...(sample.lastFailure ? { lastFailure: sample.lastFailure } : {}),
      ...resources };
    const now = Date.now();
    for (const slot of slots.values()) {
      const rss = slotRssKiB?.get(slot.pid);
      if (!slot.admitted || rss === undefined) continue;
      slot.peakRssKiB = Math.max(slot.peakRssKiB ?? 0, rss);
      slot.samples = (slot.samples ?? 0) + 1;
      slot.maxGapMs = Math.max(slot.maxGapMs ?? 0, now - slot.lastSampleAt);
      slot.lastSampleAt = now;
    }
    sampleCount += 1;
  }
  function removeWaiting(item) {
    const index = waiting.indexOf(item);
    if (index !== -1) waiting.splice(index, 1);
    if (headPledge?.item === item) reserveHead();
  }
  function refuse(item, reason, cause) {
    removeWaiting(item);
    if (item.slot && !item.settled) {
      releaseReservation(item.slot);
      item.slot.peer?.destroy();
    }
    item.settled = true;
    send(item.socket, { kind: 'refused', reason, ...(cause ? { cause } : {}) });
    item.socket.end();
  }
  function readResources(item) {
    try { return item.observation.readState(); }
    catch (error) {
      recordFailure(error);
      refuse(item, 'HSTACK_RESOURCE_OBSERVATION_UNAVAILABLE', error.code ?? error.name);
      return null;
    }
  }
  function refreshWatchers() {
    const blocked = waiting.filter(item => item.blocked);
    const memoryWaiting = waiting.some(item => !item.slot && !item.blocked && item.waitingForMemory !== false);
    // External RAM recovery, process death and expired leases need not emit
    // filesystem events. Share the lock owner's existing catch-up cadence.
    // Unchanged workspace-only demand still performs no memory observation.
    if ((blocked.length || memoryWaiting) && !resourceCatchUp) {
      // Retain this handle while queued/running. Rearm only after recovery
      // drains, so slow OS observations cannot accumulate ticks or run back-to-back.
      const timer = setTimeout(() => enqueue(async () => {
        try {
          await resourcesChanged(waiting.filter(item => item.blocked),
            waiting.some(item => !item.slot && !item.blocked && item.waitingForMemory !== false));
        } finally {
          if (resourceCatchUp === timer) {
            resourceCatchUp = undefined;
            refreshWatchers();
          }
        }
      }), DEFAULT_FILE_CHANGE_CATCH_UP_MS);
      resourceCatchUp = timer;
      timer.unref();
    } else if (!blocked.length && !memoryWaiting && resourceCatchUp) {
      clearTimeout(resourceCatchUp);
      resourceCatchUp = undefined;
    }
    const directories = new Set(blocked.flatMap(item => item.observation.directories));
    for (const [directory, watcher] of watchers) if (!directories.has(directory)) { watcher.close(); watchers.delete(directory); }
    for (const directory of directories) {
      if (watchers.has(directory)) continue;
      let watcher;
      try {
        watcher = watch(directory, (_event, filename) => {
          const queued = pendingResourceChanges.size > 0;
          for (const item of waiting) {
            if (item.blocked && item.observation.directories.includes(directory)
              && item.observation.isRelevant(directory, filename)) pendingResourceChanges.add(item);
          }
          if (queued || !pendingResourceChanges.size) return;
          // A publication scope can update many watched files in one burst.
          // Read each affected waiter's current snapshot once, rather than
          // queueing full lock scans ahead of every control/status request.
          setImmediate(() => enqueue(() => {
            const consumers = [...pendingResourceChanges];
            pendingResourceChanges.clear();
            return resourcesChanged(consumers);
          }));
        });
      } catch (error) {
        // An unvisited resource's parent may not exist yet. The client's
        // canonical attempt creates it before that resource can block.
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      watcher.on('error', () => enqueue(async () => {
        watcher.close();
        watchers.delete(directory);
        for (const item of waiting.filter(item => item.blocked)) {
          if (item.observation.directories.includes(directory)) {
            refuse(item, 'HSTACK_RESOURCE_OBSERVATION_UNAVAILABLE');
          }
        }
        refreshWatchers();
      }));
      watchers.set(directory, watcher);
    }
    // Arm before comparing the offer's canonical snapshot, so a release
    // between the client's busy reply and watcher registration cannot be lost.
    const changed = blocked.filter(item => {
      const resources = readResources(item);
      return resources !== null && resources.snapshot !== item.resourceSnapshot;
    });
    if (changed.length) {
      enqueue(() => resourcesChanged(changed));
    }
  }
  async function resourcesChanged(consumers, resampleMemory) {
    let changed = resampleMemory;
    for (const item of consumers) {
      if (!waiting.includes(item) || !item.blocked || !resourceChanged(item)) continue;
      changed = true;
      item.blocked = false;
    }
    if (changed) { await observe(); await drain(); }
  }
  function resourceChanged(item) {
    const resources = readResources(item);
    if (!resources || resources.snapshot === item.resourceSnapshot) return false;
    item.resourceSnapshot = resources.snapshot;
    return true;
  }
  function releaseReservation(slot) {
    if (!slots.delete(slot.address)) return false;
    // Before the measured wait bound, releases remain reusable by backfills.
    // After it, include recovered slots too so sustained traffic cannot starve
    // the head. Evaluate on this release, never retroactively or on a new timer.
    if (headReservation(headPledge?.item).active) {
      headPledge.memoryKiB += slot.floorKiB;
      headPledge.cpuCores += slot.cpuCores ?? 0;
    }
    return true;
  }
  async function release(slot) {
    if (!releaseReservation(slot)) return;
    slot.peer?.destroy();
    // A closed slot connection means its holder is gone. A killed holder never
    // unlinks its listener, so remove the path as restart recovery already does
    // for absent listeners; a filesystem census then shows only held slots.
    try { unlinkSync(slot.address); } catch (error) { if (error.code !== 'ENOENT') recordFailure(error); }
    // Reuse event/catch-up observations only. These are sampled lower bounds,
    // not kernel lifetime peaks or proof that the payload succeeded. Recovered
    // slots lack a class and full lifetime, so they cannot calibrate a floor.
    if (slot.admitted && slot.samples && Object.hasOwn(HEAVYWEIGHT_COMMAND_RESOURCES, slot.className)) {
      const now = Date.now();
      try {
        appendFileSync(join(root, 'completed-slot-memory.jsonl'), JSON.stringify({
          className: slot.className, resourceClass: slot.resourceClass, projects: slot.projects, floorKiB: slot.floorKiB, peakRssKiB: slot.peakRssKiB,
          samples: slot.samples, maxGapMs: Math.max(slot.maxGapMs, now - slot.lastSampleAt),
          completedAt: new Date(now).toISOString(), method: 'broker-event-sampled-tree-rss',
        }) + '\n', { mode: 0o600 });
      } catch (error) { recordFailure(error); }
    }
    if (slot.kernelPeak) {
      try { recordIdentityPeak(slot.kernelPeak, slot.kernelPeak.peakKiB); } catch (error) { recordFailure(error); }
    }
    if (slot.succeeded && slot.identityKey && slot.admitted && Number.isFinite(slot.admittedAt)) {
      try { recordIdentityDuration(slot.identityKey, Math.max(1, Date.now() - slot.admittedAt)); } catch (error) { recordFailure(error); }
    }
    await releaseDecision();
  }
  async function releaseDecision() {
    await observe();
    await drain();
  }
  /** The one start simulation behind every projection (AUTO placement and EASY
   * backfill): admitted slots release at their remaining recorded p99 (a slot
   * without one at `unrecordedMs`) against the achievable memory, and a floor
   * above capacity runs alone. The returned `startAt(floorKiB, runMs)` gives the
   * earliest start (ms from now) of a job after those already started, and
   * starts it when `runMs` is given. */
  function simulateServiceOrder(now, unrecordedMs) {
    const capacityKiB = sample.achievableMemoryKiB;
    // Running jobs as [end, floor].
    const running = [...slots.values()].map(slot => [slot.p99DurationMs > 0 && Number.isFinite(slot.admittedAt)
      ? Math.max(0, slot.admittedAt + slot.p99DurationMs - now) : unrecordedMs, Math.min(slot.floorKiB, capacityKiB)]);
    let at = 0;
    let usedKiB = running.reduce((sum, [, floorKiB]) => sum + floorKiB, 0);
    const releaseNext = () => {
      running.sort((left, right) => left[0] - right[0]);
      const [end, floorKiB] = running.shift();
      at = Math.max(at, end);
      usedKiB -= floorKiB;
    };
    return (floorKiB, runMs) => {
      const neededKiB = Math.min(floorKiB, capacityKiB);
      while (running.length && running.some(([end]) => end <= at)) releaseNext();
      while (capacityKiB - usedKiB < neededKiB && running.length) releaseNext();
      if (runMs !== undefined) {
        running.push([at + runMs, neededKiB]);
        usedKiB += neededKiB;
      }
      return at;
    };
  }
  /** AUTO placement compares hosts by when a new arrival would start. Simulate
   * the queue in its service order, so floors that cannot run together run one
   * after another (windows2-linux 2026-11-17: 16 GiB waiters on a 21 GiB host).
   * The arrival starts once every waiter ahead has started and the memory left
   * fits the smallest floor ahead (any memory when none waits), else at the next
   * release. A slot or waiter without a recorded p99 takes the mean recorded p99;
   * with none recorded, or no achievable memory, there is no projection (null). */
  function projectedArrivalStartMs(now) {
    const queued = waiting.filter(item => !item.slot).map(item => ({ floorKiB: item.floorOptions?.at(-1).floorKiB ?? item.floorKiB,
      runMs: item.p99DurationMs > 0 ? item.p99DurationMs : undefined }));
    const recorded = [...[...slots.values()].filter(slot => slot.p99DurationMs > 0 && Number.isFinite(slot.admittedAt)).map(slot => slot.p99DurationMs),
      ...queued.filter(entry => entry.runMs !== undefined).map(entry => entry.runMs)];
    const work = slots.size + queued.length;
    if (!(sample.achievableMemoryKiB > 0) || (work && !recorded.length)) return work ? null : 0;
    const meanMs = recorded.reduce((sum, ms) => sum + ms, 0) / recorded.length;
    const startAt = simulateServiceOrder(now, meanMs);
    for (const entry of queued) startAt(entry.floorKiB, entry.runMs ?? meanMs);
    return Math.ceil(startAt(queued.length ? Math.min(...queued.map(entry => entry.floorKiB)) : 1));
  }
  /** EASY backfill: when the head's minimum floor fits in that simulation. A
   * slot without a duration or past its p99 releases now, which only moves the
   * projection earlier and so never admits a backfill that could delay the head. */
  function projectedHeadStartAt(head, now) {
    return now + simulateServiceOrder(now, 0)(head.floorOptions?.at(-1).floorKiB ?? head.floorKiB);
  }
  async function drain() {
    // Capacity already free when a request becomes head remains available to
    // backfill; releases are held only after that head reaches the wait bound.
    const budget = slotResourceBudget();
    let availableMemoryKiB = budget.unreservedMemoryKiB;
    let availableCpuCores = budget.unreservedCpuCores;
    let head;
    let lendableKiB = 0;
    let headStartAt;
    orderWaiting();
    const pledgingHead = waiting.find(canReserveHead);
    const reservation = headReservation(pledgingHead);
    // Coordination 2026-11-13 11:22Z: source bundles (including stack reloads)
    // cannot move hosts. Let fitting ones use a relocatable head's pledge first.
    // Reorder only this pass, never the arrival queue or the retained pledge.
    const hostBoundFirst = new Set(pledgingHead?.className !== 'source-bundle' && !(pledgingHead?.headPriority > 0) && reservation.memoryKiB > 0
      ? waiting.filter(item => item.className === 'source-bundle' && canReserveHead(item)
        && item.floorKiB <= Math.min(reservation.memoryKiB, availableMemoryKiB)
        && minimumCpuCores(item) <= availableCpuCores) : []);
    const ordered = hostBoundFirst.size
      ? [...hostBoundFirst, ...waiting.filter(item => !hostBoundFirst.has(item))] : [...waiting];
    const assignHead = item => {
      head = item;
      reserveHead(head);
      const reservation = headReservation(head);
      // A producer head lends nothing (no EASY backfill past it).
      lendableKiB = head.headPriority >= PRODUCER_RANK ? 0 : Math.min(reservation.memoryKiB, availableMemoryKiB);
      availableMemoryKiB = Math.max(0, availableMemoryKiB - reservation.memoryKiB);
      availableCpuCores = Math.max(0, availableCpuCores - reservation.cpuCores);
      if (lendableKiB > 0) headStartAt = projectedHeadStartAt(head, Date.now());
    };
    for (const item of ordered) {
      if (item.slot || item.blocked) continue;
      if (item.socket.destroyed) { removeWaiting(item); continue; }
      const minimumFloorKiB = item.floorOptions?.at(-1).floorKiB ?? item.floorKiB;
      if (minimumFloorKiB > sample.totalMemoryKiB) {
        refuse(item, 'HSTACK_MEMORY_CAPACITY');
        continue;
      }
      if (minimumCpuCores(item) > totalCpuCores) {
        refuse(item, 'HSTACK_CPU_CAPACITY');
        continue;
      }
      const fitting = item.floorOptions?.find(option => option.floorKiB <= availableMemoryKiB
        && accountedCpuCores(item, option.workers) <= availableCpuCores);
      // A job projected to finish before the head can start may borrow the
      // head's pledged memory; its release returns it before it is needed.
      const borrowKiB = !item.floorOptions && headStartAt !== undefined
        && item.p99DurationMs > 0 && Date.now() + item.p99DurationMs <= headStartAt
        && item.floorKiB > availableMemoryKiB && item.floorKiB <= availableMemoryKiB + lendableKiB
        && accountedCpuCores(item) <= availableCpuCores ? item.floorKiB - availableMemoryKiB : 0;
      // Announced to the waiter (its client logs it), so a backfill is visible in the run's log.
      const backfill = borrowKiB > 0 ? { borrowedKiB: borrowKiB, headStartInMs: Math.max(0, headStartAt - Date.now()) } : undefined;
      if (borrowKiB > 0) {
        availableMemoryKiB += borrowKiB;
        lendableKiB -= borrowKiB;
        // The counter can exceed the capped reservation; lend from the cap.
        headPledge.memoryKiB = Math.min(headPledge.memoryKiB, headReservation(head).memoryKiB) - borrowKiB;
      }
      item.waitingForMemory = minimumFloorKiB > availableMemoryKiB;
      if (item.floorOptions ? !fitting : item.floorKiB > availableMemoryKiB || accountedCpuCores(item) > availableCpuCores) {
        if (item.noWait) refuse(item, item.waitingForMemory ? 'HSTACK_MEMORY_BUSY' : 'HSTACK_CPU_BUSY');
        else {
          // Publication preference cannot block admitted work while this
          // request waits for that work to release its memory reservation.
          if (item.locks.length) send(item.socket, { kind: 'capacity-wait' });
          // A head that cannot fit has not reached the client's resource
          // attempt yet. An active publication must not reserve its floor.
          const resources = readResources(item);
          if (!resources) continue;
          if (resources.publicationBlocked) {
            item.blocked = true;
            item.resourceSnapshot = resources.snapshot;
          } else if (!head && canReserveHead(item)) assignHead(item);
        }
        continue;
      }
      const floorKiB = fitting?.floorKiB ?? item.floorKiB;
      const cpuCores = accountedCpuCores(item, fitting?.workers);
      const clientCpuCores = cpuCost(item, fitting?.workers);
      item.waitingForMemory = false;
      if (item.socket.destroyed) { removeWaiting(item); continue; }
      // Observe before publishing a reservation: a failed request must not
      // leave a slot that its client was never offered.
      const resources = readResources(item);
      if (!resources) continue;
      const slotId = randomUUID();
      const address = slotAddress(root, item.pid, floorKiB, slotId, cpuCores);
      const slot = { address, pid: item.pid, className: item.className, resourceClass: item.resourceClass, projects: item.projects, floorKiB, cpuCores, clientCpuCores, workers: fitting?.workers, control: item.socket,
        slotId, durationClass: item.durationClass, p99DurationMs: item.p99DurationMs, identityKey: identityKey(item),
        arrivedAt: item.arrivedAt, arrivalOrder: item.arrivalOrder };
      slots.set(address, slot);
      availableMemoryKiB -= floorKiB;
      availableCpuCores -= cpuCores;
      item.slot = slot;
      if (hostBoundFirst.has(item) && headPledge?.item === pledgingHead) {
        headPledge.lastHostBoundAdmissionKiB = floorKiB;
      }
      if (headPledge?.item === item) reserveHead();
      item.resourceSnapshot = resources.snapshot;
      send(item.socket, { kind: 'reserved', slotAddress: address, floorKiB, cpuCores: clientCpuCores, workers: slot.workers,
        ...(backfill ? { backfill } : {}) });
    }
    reserveHead(head);
    refreshWatchers();
  }
  async function connectSlot(slot) {
    const peer = createConnection(slot.address);
    slot.peer = peer;
    await new Promise((resolveConnected, reject) => {
      peer.once('connect', resolveConnected);
      peer.once('error', reject);
    });
    peer.on('error', () => {});
    // Current clients retain admitted duration metadata with their existing
    // lifetime socket. A successor adopts it without another job or timer.
    const lines = createInterface({ input: peer });
    lines.on('error', () => {});
    lines.on('line', line => {
      let metadata;
      try { metadata = JSON.parse(line); } catch { return; }
      if (metadata.kind === 'slot-peak') {
        if (!Number.isSafeInteger(metadata.peakKiB) || metadata.peakKiB <= 0 || typeof metadata.className !== 'string'
          || (metadata.resourceClass !== undefined && typeof metadata.resourceClass !== 'string')
          || (metadata.projects !== undefined && (!Array.isArray(metadata.projects) || metadata.projects.some(project => typeof project !== 'string')))) return;
        const { peakKiB, className, resourceClass, projects, component, entry } = metadata;
        enqueue(() => { if (!slot.kernelPeak || slot.kernelPeak.peakKiB < peakKiB) slot.kernelPeak = { peakKiB, className, resourceClass, projects, component, entry }; });
        return;
      }
      if (metadata.kind === 'slot-completed') {
        if (metadata.status === 0) enqueue(() => { slot.succeeded = true; });
        return;
      }
      if (metadata.kind === 'slot-identity') {
        if (typeof metadata.className !== 'string') return;
        enqueue(() => {
          slot.identityKey ??= identityKey(metadata);
          const key = slot.recovered ? identityKey(metadata) : null;
          const peak = key === null ? undefined : recordedIdentityPeaks().get(key);
          if (peak !== undefined) slot.floorKiB = Math.max(slot.floorKiB, roundPeak(peak));
        });
        return;
      }
      if (metadata.kind !== 'slot-duration' || !validDuration(metadata)
        || !Number.isSafeInteger(metadata.admittedAt) || metadata.admittedAt < 0
        || !/^[a-f0-9-]{36}$/.test(metadata.slotId ?? '')
        || !Object.hasOwn(HEAVYWEIGHT_COMMAND_RESOURCES, metadata.className)) return;
      enqueue(() => { Object.assign(slot, { admittedAt: metadata.admittedAt,
        slotId: metadata.slotId, className: metadata.className,
        durationClass: metadata.durationClass, p99DurationMs: metadata.p99DurationMs }); });
    });
    peer.once('close', () => enqueue(() => release(slot)));
    return slot;
  }
  function accept(socket) {
    controls.add(socket);
    let item;
    const lines = createInterface({ input: socket });
    // readline forwards input errors independently of the socket listener.
    // A disconnected control releases only its own unfinished admission.
    lines.on('error', () => socket.destroy());
    lines.on('line', line => enqueue(async () => {
      let request;
      try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      if (request.kind === 'watch') { subscribers.set(socket, null); return; }
      if (request.kind === 'sample') { send(socket, { kind: 'sample' }); socket.end(); return; }
      if (request.kind === 'check') {
        const valid = Number.isSafeInteger(request.floorKiB) && request.floorKiB > 0 && validCpuRequest(request);
        const available = status();
        const memoryFits = request.floorKiB <= available.unreservedMemoryKiB;
        const cpuCores = accountedCpuCores(request);
        const admitted = valid && memoryFits && cpuCores <= available.unreservedCpuCores;
        send(socket, { kind: admitted ? 'admitted' : 'refused',
          ...(!admitted ? { reason: !valid ? 'HSTACK_INVALID_ADMISSION'
            : request.floorKiB > sample.totalMemoryKiB ? 'HSTACK_MEMORY_CAPACITY'
              : cpuCores > totalCpuCores ? 'HSTACK_CPU_CAPACITY'
                : !memoryFits ? 'HSTACK_MEMORY_BUSY' : 'HSTACK_CPU_BUSY' } : {}) });
        socket.end(); return;
      }
      if (request.kind === 'ready' && item?.slot && !item.settled) {
        try {
          await connectSlot(item.slot);
          item.slot.admitted = true;
          item.slot.admittedAt = item.slot.lastSampleAt = Date.now();
          item.settled = true;
          removeWaiting(item);
          send(socket, { kind: 'admitted', slotId: item.slot.slotId, admittedAt: item.slot.admittedAt,
            floorKiB: item.slot.floorKiB, cpuCores: item.slot.clientCpuCores ?? item.slot.cpuCores, workers: item.slot.workers });
          refreshWatchers();
        } catch { refuse(item, 'HSTACK_SLOT_UNAVAILABLE'); await releaseDecision(); }
        return;
      }
      if (request.kind === 'resources-busy' && item?.slot && !item.settled) {
        releaseReservation(item.slot);
        item.slot = null;
        item.blocked = true;
        if (item.noWait) refuse(item, 'HSTACK_WORKSPACE_RESOURCE_BUSY');
        // A release may race the client's busy acknowledgement. Its offer's
        // snapshot closes that gap without a timer or retaining partial scopes.
        else if (resourceChanged(item)) {
          item.blocked = false;
          await observe();
        }
        await drain();
        return;
      }
      if (!validCpuRequest(request) || !validDuration(request)
        || request.kind !== 'acquire' || item || !Number.isSafeInteger(request.floorKiB) || request.floorKiB <= 0
        || (request.arrivedAt !== undefined && (!Number.isSafeInteger(request.arrivedAt) || request.arrivedAt < 0))
        || !Number.isSafeInteger(request.pid) || request.pid <= 1 || typeof request.className !== 'string'
        || (request.resourceClass !== undefined && typeof request.resourceClass !== 'string')
        || (request.component !== undefined && typeof request.component !== 'string')
        || (request.entry !== undefined && typeof request.entry !== 'string')
        || (request.preparesClass !== undefined && typeof request.preparesClass !== 'string')
        || (request.projects !== undefined && (!Array.isArray(request.projects)
          || request.projects.some(project => typeof project !== 'string')))
        || typeof request.repoDir !== 'string' || (request.cacheBaseDir !== undefined && typeof request.cacheBaseDir !== 'string')
        || (request.floorOptions !== undefined && (!Array.isArray(request.floorOptions) || request.floorOptions.length === 0
          || request.floorOptions.some(option => !Number.isSafeInteger(option?.floorKiB) || option.floorKiB <= 0
            || !Number.isSafeInteger(option.workers) || option.workers <= 0)))
        || !Array.isArray(request.locks ?? []) || (request.locks ?? []).some(lock => typeof lock?.path !== 'string')) {
        send(socket, { kind: 'refused', reason: 'HSTACK_INVALID_ADMISSION' }); socket.end(); return;
      }
      item = { ...request, socket, locks: request.locks ?? [], env: request.env ?? {}, settled: false,
        arrivedAt: request.arrivedAt ?? Date.now(), arrivalOrder: ++arrivalOrder, ownPriority: headPriorityRank(request),
        preparedPriority: preparedRank(request) };
      item.headPriority = Math.max(item.ownPriority, item.preparedPriority);
      item.floorKiB = recordedIdentityFloorKiB(item);
      item.floorOptions = recordedIdentityFloorOptions(item);
      if (item.p99DurationMs === undefined) Object.assign(item, recordedIdentityDuration(item));
      item.observation = createWorkspaceBuildResourceObservation({ locks: item.locks });
      if (item.floorOptions) item.floorOptions = [...item.floorOptions].sort((left, right) => right.floorKiB - left.floorKiB || right.workers - left.workers);
      // The existing client carries its first arrival through reconnects.
      // Connection order breaks ties, but cannot replace that original age.
      const next = waiting.findIndex(other => compareService(Date.now())(item, other) < 0);
      waiting.splice(next < 0 ? waiting.length : next, 0, item);
      refreshWatchers();
      let disk;
      try { disk = await admitDisk(item); }
      catch (error) {
        recordFailure(error);
        refuse(item, 'HSTACK_ADMISSION_UNAVAILABLE', error.code ?? error.name);
        refreshWatchers();
        return;
      }
      if (!disk.admitted) { refuse(item, 'HSTACK_DISK_UNAVAILABLE'); refreshWatchers(); return; }
      // Existing memory demand already has an observation and the shared
      // recovery loop. Another waiter changes neither physical capacity nor
      // admitted floors, including when many clients reconnect after restart.
      // Disk reclamation is a real resource change and still needs a new read.
      const memoryWaiting = waiting.some(other => other !== item && !other.slot && !other.blocked && other.waitingForMemory !== false);
      if ((!memoryWaiting && minimumCpuCores(item) <= slotResourceBudget().unreservedCpuCores) || disk.reclamation?.length) await observe();
      await drain();
    }));
    socket.on('error', () => {});
    socket.once('close', () => {
      controls.delete(socket);
      if (subscribers.delete(socket)) publishAdmissionStatus();
      if (!item || item.settled) return;
      enqueue(async () => {
        if (item.slot) { removeWaiting(item); await release(item.slot); }
        else { removeWaiting(item); await drain(); }
      });
    });
  }
  return {
    status,
    recordedIdentityFloorKiB,
    async start() {
      if (process.platform !== 'linux') throw new Error('Admission broker requires Linux');
      // The OS's available logical cores are the fixed resource boundary.
      // Read once at broker startup; admission never observes CPU load.
      totalCpuCores = readCpuCapacity();
      if (!Number.isSafeInteger(totalCpuCores) || totalCpuCores <= 0) throw new Error('Invalid CPU capacity');
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const directory = lstatSync(root);
      if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700) {
        throw Object.assign(new Error('Admission root must be a private owned directory'), { code: 'EACCES' });
      }
      await withStartupLock(root, async () => {
        const address = brokerAddress(root);
        if (await socketListening(address)) {
          throw Object.assign(new Error('Admission broker already listening'), { code: 'EADDRINUSE' });
        }
        if (heldOldLockFd === undefined) {
          mkdirSync(dirname(oldLockPath), { recursive: true, mode: 0o700 });
          heldOldLockFd = openSync(oldLockPath, 'a', 0o600);
          await lockFile(heldOldLockFd);
        }
        // At cutover this is the barrier's already-locked open description;
        // never unlock/reacquire it. Late parsed old launchers remain queued
        // on their existing mutex throughout this broker's runtime.
        try {
          if (!lstatSync(address).isSocket()) throw Object.assign(new Error('Admission socket path occupied'), { code: 'EEXIST' });
          unlinkSync(address);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        server = createServer(socket => {
          if (started) accept(socket);
          else {
            pendingConnections.add(socket);
            socket.on('error', () => {});
            socket.once('close', () => pendingConnections.delete(socket));
          }
        });
        await new Promise((resolveListening, reject) => { server.once('error', reject); server.listen(address, resolveListening); });
        try {
          for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isSocket()) continue;
            const slot = readSlotAddress(root, entry.name);
            if (!slot) continue;
            slot.recovered = true;
            try {
              await connectSlot(slot);
              // Systemic 20:31Z: a recovered slot reserves max(its scope's
              // memory.current, its identity kernel peak), not its old floor. The
              // identity peak applies when the client re-advertises its identity.
              const currentKiB = readRecoveredSlotMemoryKiB(slot.pid);
              if (Number.isSafeInteger(currentKiB) && currentKiB > 0) slot.floorKiB = roundPeak(currentKiB);
              slots.set(slot.address, slot);
            }
            catch (error) {
              slot.peer.destroy();
              // Only an absent listener proves its floor is gone. Descriptor,
              // permission and other observation failures cannot erase live work.
              if (!socketGone(error)) throw error;
              try { unlinkSync(slot.address); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
            }
          }
          await observe();
          // A removed root ends this broker: its state, slots and clients are gone with it.
          rootWatcher = watch(root, () => { if (!existsSync(root)) void this.close(); });
          rootWatcher.on('error', () => {});
          started = true;
          for (const socket of pendingConnections) if (!socket.destroyed) accept(socket);
          pendingConnections.clear();
        } catch (error) {
          await this.close();
          throw error;
        }
      }, startupLockFd);
      return this;
    },
    async close() {
      if (closing) return;
      closing = true;
      rootWatcher?.close();
      clearTimeout(overrunWake);
      clearTimeout(resourceCatchUp);
      resourceCatchUp = undefined;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      for (const socket of controls) socket.destroy();
      for (const socket of pendingConnections) socket.destroy();
      await serial;
      for (const slot of slots.values()) {
        slot.peer?.destroy();
      }
      await new Promise(resolveClosed => server?.listening ? server.close(resolveClosed) : resolveClosed());
      if (heldOldLockFd !== undefined) {
        closeSync(heldOldLockFd);
        heldOldLockFd = undefined;
      }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--serve') {
  const argument = name => process.argv.slice(4).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const descriptor = name => {
    const value = argument(name);
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 3) {
      throw new Error('Invalid inherited admission descriptor');
    }
    return Number(value);
  };
  const broker = createAdmissionBroker({ root: process.argv[3], oldLockPath: argument('old-lock-path'),
    oldLockFd: descriptor('old-lock-fd'), startupLockFd: descriptor('startup-lock-fd') });
  try { await broker.start(); process.stdout.write('ready\n'); }
  catch (error) {
    if (error.code === 'EADDRINUSE') process.stdout.write('ready\n');
    else { process.stderr.write('HSTACK_ADMISSION_BROKER_UNAVAILABLE\n'); process.exitCode = 76; }
    await broker.close();
  }
}
