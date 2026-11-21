import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, isAbsolute, join, posix, relative } from 'node:path';
import { availableParallelism } from 'node:os';
import { COLD_ADMISSION_CPU_CORES, FOCUSED_TEST_ADMISSION_CLASSES, HEAVYWEIGHT_COMMAND_RESOURCES, SOURCE_RELOAD_ADMISSION_CLASS, SOURCE_WEB_EXPORT_ADMISSION_CLASS, SOURCE_WEB_EXPORT_MEMORY, resolveSourceWebExportMemoryFloorKiB, resolveColdAdmissionCpuCost, usesElasticAdmissionWorkers } from '../dev_targets/command_resources.mjs';
import { createInterface } from 'node:readline';
import { DURATION_WINDOW, nearestRankP99 } from '../dev_targets/execution_provenance.mjs';
import { pathToFileURL } from 'node:url';
import { admitWorkerDiskBudget } from '../dev_targets/worker_disk_budget.mjs';
import { readLinuxWorkerProcesses } from './service_memory.mjs';
import { createWorkspaceBuildResourceObservation } from './workspace_build_admission.mjs';
import { DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { brokerAddress, readSlotAddress, slotAddress } from './admission_socket.mjs';
import { isInAdmissionJobsSlice, readAdmittedRunnableThreads, readLinuxAdmissionMemory, readProcessJobScopeCpuUsageUsec, readProcessJobScopeWorkingSetKiB } from './admission_memory.mjs';
export { brokerAddress } from './admission_socket.mjs';

// Nearest-rank p95 of 63,482 successful targeted-validation wrapper durations
// (2026-11-13 provenance census; includes preparation/admission). Give backfills
// this measured opportunity window, then accumulate releases for the old head.
const HEAD_RESERVATION_DELAY_MS = 1_344_000;
const RECENT_JUDGMENT_WINDOW_MS = 15 * 60 * 1000;
const STALL_CPU_WINDOW_MS = 30 * 60 * 1000;
const STALL_CPU_SAMPLE_MS = 60 * 1000;
// CPU use below 1% of one core over a full window is treated as idle.
const STALL_CPU_BUDGET_USEC = STALL_CPU_WINDOW_MS * 10;
const GIT_TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMAND_DIGEST = /^[0-9a-f]{64}$/;

function queueJudgment(value) {
  if (typeof value?.commandDigest !== 'string' || !COMMAND_DIGEST.test(value.commandDigest)) {
    return { treeIds: [], commandDigest: null };
  }
  const validTrees = Array.isArray(value.treeIds) && value.treeIds.every(id => typeof id === 'string' && GIT_TREE_ID.test(id));
  return { treeIds: validTrees ? [...new Set(value.treeIds)].sort() : [], commandDigest: value.commandDigest };
}

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
const DECLARATION_COMPARISON_ENTRY = 'compilation scripts/workspaces/commitGateTypecheck.mjs';
const DECLARATION_IDLE_MS = 5 * 60 * 1000;
const DECLARATION_COMPARISON_ENTRIES = new Set([
  DECLARATION_COMPARISON_ENTRY,
  'gate-declaration-comparison scripts/workspaces/commitGateTypecheck.mjs',
  'gate-final-recheck scripts/workspaces/commitGateTypecheck.mjs',
  'gate-package-typecheck scripts/workspaces/commitGateTypecheck.mjs',
]);
const HEAD_PRIORITY_RANKS = new Map([
  ['source-bundle apps/stack/scripts/build/build_source_runtime.mjs', 2],
  // The shared web export every stack's QA browsers consume (one per revision).
  ['source-web-export apps/stack/scripts/build/build_source_web_ui.mjs', 2],
  // A stack's Expo dev-startup web UI build: same producer script, admitted as validation;
  // every borrowed-UI lane waits on it (Systemic 2026-11-16 21:15Z, owner-approved).
  ['validation apps/stack/scripts/build/build_source_web_ui.mjs', 2],
  ['compilation scripts/workspaces/checkCommitTypeCoherence.mjs', 1],
  ['compilation scripts/workspaces/commitPackageTypecheck.mjs', FOCUSED_TEST_PRIORITY_RANK],
  // P03-GATE-TC 2026-11-18: the commit gate's typecheck delta (its worker compile) holds a committing lane and decides
  // whether a type error reaches every other lane's build, so it takes the top rank with the shared producers.
  [DECLARATION_COMPARISON_ENTRY, 2],
]);
const FOCUSED_TEST_CLASSES = new Set(FOCUSED_TEST_ADMISSION_CLASSES);
const PRODUCER_RANK = 2;
// P03 ORCH 2026-11-17: a preparation step is a prerequisite of every run waiting
// on its output, so it takes the highest class rank among the runs currently
// waiting on it (`preparesClass`; never a script rank), or its own rank when that
// is higher. Only these classes share preparation ranks.
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
  return HEAD_PRIORITY_RANKS.get(admissionScriptClass(request)) ?? 0;
}
function admissionScriptClass(request) {
  const script = typeof request.entry === 'string' ? request.entry.split(' ')[1] : undefined;
  if (!script || (isAbsolute(script) && typeof request.repoDir !== 'string')) return null;
  const path = isAbsolute(script) ? relative(request.repoDir, script) : posix.normalize(script);
  return `${request.resourceClass ?? request.className} ${path}`;
}

// A 20-completion p95 retains the high end while allowing one isolated
// outlier to stop sizing future runs. Each run contributes its maximum sampled
// working set; scalar lifetime peaks from the page-cache era are ignored.
const IDENTITY_PEAK_WINDOW = 20;
const nearestRank = (values, percentile) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * percentile) - 1];
const IDENTITY_FLOOR_ROUNDING_KIB = 512 * 1024;
const IDENTITY_PEAKS_FILENAME = 'identity-kernel-peaks.json';
// P03 ORCH 2026-11-18 (P03-BROKER-W2): a request without its run's duration (a
// preparation step or a producer inside a run) is projected by its own identity's
// successful admitted run times, with the same window and nearest-rank p99 as the
// controller's run history. Without a recorded success it has no duration.
// CPU uses the same tuple and integer-array history shape as working-set
// memory, under a reserved class prefix. Old brokers ignore these rows for
// memory sizing and preserve them when rewriting the shared host-local file.
const CPU_HISTORY_PREFIX = 'cpu-millicores/';
const cpuHistoryKey = key => key?.replace(/^\["/, `["${CPU_HISTORY_PREFIX}`) ?? null;
const MAX_COLD_CPU_CORES = Math.max(...Object.values(COLD_ADMISSION_CPU_CORES));

function readLinuxHostRunnable() {
  const runnable = Number(/^\S+ +\S+ +\S+ +(\d+)\/\d+ /.exec(readFileSync('/proc/loadavg', 'utf8'))?.[1]);
  // The broker itself is runnable while it reads /proc.
  return runnable - 1;
}

const IDENTITY_DURATIONS_FILENAME = 'identity-durations.json';
const IDENTITY_DURATION_CLASS = 'identity-history';
// Systemic 20:31Z: class + component + script/entry + sorted projects, never argv.
const identityKey = item => typeof item.entry === 'string' && item.entry && typeof item.component === 'string'
  ? JSON.stringify([item.resourceClass ?? item.className, item.component, item.entry, [...(item.projects ?? [])].sort()]) : null;

const safeDiagnosticPath = value => /^[A-Za-z0-9_.@-][A-Za-z0-9_.@/-]*$/.test(value)
  && !value.split('/').includes('..');
function diagnosticRequester(component, entry) {
  if (component === undefined) return null;
  // An interpreter's identity can be an opaque inline program. Report only
  // recognizable repository script paths and package script names.
  const [program, argument, script, ...extra] = entry.split(' ');
  let command = /^[A-Za-z0-9_.@-]+$/.test(program) ? program : null;
  if (command && extra.length === 0 && argument === 'run' && /^[A-Za-z0-9_.:@-]+$/.test(script ?? '')) {
    command = entry;
  } else if (command && script === undefined && argument && (argument === '--test'
    || (safeDiagnosticPath(argument) && (argument.includes('/') || /\.(?:[cm]?[jt]s|sh)$/.test(argument))))) {
    command = entry;
  }
  return { component: safeDiagnosticPath(component) ? component : null, entry: command };
}

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
  const creditedResidentMemoryKiB = slots.reduce((sum, slot) =>
    sum + (slot.workingSetKiB ?? Math.min(slot.floorKiB, residentByRoot.get(slot.pid) ?? 0)), 0);
  const reservedMemoryKiB = slots.reduce((sum, slot) => sum + (slot.workingSetKiB ?? slot.floorKiB), 0);
  const releasableResidentMemoryKiB = slots.reduce((sum, slot) =>
    sum + (slot.workingSetKiB ?? residentByRoot.get(slot.pid) ?? 0), 0);
  const achievableMemoryKiB = Math.min(memory.totalMemoryKiB, memory.availableMemoryKiB + releasableResidentMemoryKiB);
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
  readCpuPressure = sampleResources === readAdmissionMemorySample ? readLinuxHostRunnable : () => 0,
  readSlotWorkingSetKiB = readProcessJobScopeWorkingSetKiB, readSlotCpuUsageUsec = readProcessJobScopeCpuUsageUsec,
  admitDisk = request => request.cacheBaseDir
    ? admitWorkerDiskBudget({ ...request, commandClass: request.className }) : { admitted: true } } = {}) {
  const slots = new Map();
  const waiting = [];
  const observedSince = Date.now();
  const recentlyFinished = [];
  const controls = new Set();
  const pendingConnections = new Set();
  const subscribers = new Map();
  let overrunWake;
  let stallObservation;
  const watchers = new Map();
  const pendingResourceChanges = new Set();
  let resourceCatchUp;
  let rootWatcher;
  // Backfills admitted since this broker started (published in status).
  let backfillCount = 0;
  let sample = { availableMemoryKiB: 0, totalMemoryKiB: 0, reservedMemoryKiB: 0,
    residentMemoryKiB: 0, unreservedMemoryKiB: 0, achievableMemoryKiB: 0 };
  let totalCpuCores;
  let cpuPressureCores = 0;
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
      for (const [key, peaks] of Object.entries(JSON.parse(readFileSync(join(root, IDENTITY_PEAKS_FILENAME), 'utf8')))) {
        if (!Array.isArray(peaks) || !peaks.length || !peaks.every(peak => Number.isSafeInteger(peak) && peak > 0)) continue;
        try {
          const identity = JSON.parse(key);
          if (Array.isArray(identity) && identity.length === 4
            && identity.slice(0, 3).every(part => typeof part === 'string')
            && Array.isArray(identity[3]) && identity[3].every(project => typeof project === 'string')) {
            identityPeaks.set(key, peaks.slice(-IDENTITY_PEAK_WINDOW));
          }
        } catch (error) { recordFailure(error); }
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
    learnedClassMaximums = undefined;
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
  function recordedMemoryWarmupMs(key) {
    return key === null ? undefined : nearestRank(recordedIdentityDurations().get(key) ?? [], 0.5);
  }
  const roundPeak = peakKiB => Math.ceil(peakKiB / IDENTITY_FLOOR_ROUNDING_KIB) * IDENTITY_FLOOR_ROUNDING_KIB;
  function recordedIdentityPeakKiB(item) {
    const key = identityKey(item);
    const own = recordedIdentityPeaks().get(key);
    if (own) return nearestRank(own, 0.95);

    const resourceClass = item.resourceClass ?? item.className;
    const projects = [...(item.projects ?? [])].sort();
    const projectSet = JSON.stringify(projects);
    const supersets = [];
    const family = [];
    const sameProjects = [];
    const sameClass = [];
    // Use one vote per related identity so a frequently run job cannot
    // dominate the estimate for a newly seen command.
    for (const [recordedKey, peaks] of recordedIdentityPeaks()) {
      const [recordedClass, , entry, recordedProjects] = JSON.parse(recordedKey);
      if (recordedClass !== resourceClass) continue;
      const typical = nearestRank(peaks, 0.5);
      sameClass.push(typical);
      if (key === null) continue;
      if (entry === item.entry) {
        family.push(typical);
        if (projects.length && projects.every(inner => recordedProjects.some(outer =>
          outer === '.' || outer === inner || inner.startsWith(`${outer}/`)))) supersets.push(typical);
      }
      if (projects.length && JSON.stringify(recordedProjects) === projectSet) sameProjects.push(typical);
    }
    return nearestRank(supersets, 0.5) ?? nearestRank(family, 0.5)
      ?? nearestRank(sameProjects, 0.5) ?? nearestRank(sameClass, 0.5);
  }
  function workerCeiling(item) {
    const className = item.resourceClass ?? item.className;
    const cold = resolveColdAdmissionCpuCost(className);
    // A distinct numeric declaration specifies a fixed CPU limit, such as
    // the two-core single-threaded compiler mode. Older queued clients with
    // symbolic declarations follow the current broker's class policy.
    if (Number.isSafeInteger(item.cpuCost) && item.cpuCost !== cold) return item.cpuCost;
    const observed = nearestRank(recordedIdentityPeaks().get(cpuHistoryKey(identityKey(item))) ?? [], 0.95);
    return Math.min(totalCpuCores, observed === undefined ? cold : Math.ceil(observed * 1.5 / 1000));
  }
  function requestedColdFloorKiB(item) {
    // Pre-calibration clients retain the old catalog default in their acquire
    // message across broker succession. Translate only that class and value.
    if (item.resourceClass === 'compilation' && item.floorKiB === 38 * 1024 * 1024) {
      return HEAVYWEIGHT_COMMAND_RESOURCES.compilation.memoryKiB;
    }
    return item.floorKiB;
  }
  function recordedIdentityFloorKiB(item) {
    const peak = recordedIdentityPeakKiB(item);
    return peak === undefined ? requestedColdFloorKiB(item) : roundPeak(peak);
  }
  /** Worker-count options follow the same identity rule: with a recorded peak,
   * offer the worker counts whose modelled floor fits inside it (else the
   * smallest), each reserving that peak, never the modelled maximum. */
  function sizeWaitingItem(item, peak = recordedIdentityPeakKiB(item)) {
    item.floorKiB = peak === undefined ? requestedColdFloorKiB(item) : roundPeak(peak);
    const resourceClass = item.resourceClass ?? item.className;
    const workerGrant = usesElasticAdmissionWorkers(resourceClass);
    item.workerCeiling = workerCeiling(item);
    const sourceWebExport = resourceClass === SOURCE_WEB_EXPORT_ADMISSION_CLASS;
    const ceiling = Math.min(totalCpuCores, item.workerCeiling,
      sourceWebExport ? SOURCE_WEB_EXPORT_MEMORY.parallelThreads : totalCpuCores);
    const options = workerGrant ? Array.from({ length: ceiling }, (_, index) => {
      const workers = ceiling - index;
      return { workers, floorKiB: sourceWebExport ? resolveSourceWebExportMemoryFloorKiB(workers) : item.floorKiB };
    }) : item.requestedFloorOptions?.map(option => ({ ...option, workers: Math.min(option.workers, ceiling) }));
    if (peak === undefined || !options) {
      item.floorOptions = options;
      return;
    }
    const within = options.filter(option => option.floorKiB <= item.floorKiB);
    const offered = within.length ? within
      : [options.reduce((smallest, option) => option.workers < smallest.workers ? option : smallest)];
    item.floorOptions = offered.map(option => ({ ...option, floorKiB: item.floorKiB }))
      .sort((left, right) => right.workers - left.workers);
  }
  function recordIdentityResources(slot) {
    const memoryKey = slot.workingSetIdentity && identityKey(slot.workingSetIdentity);
    const cpuKey = slot.succeeded && slot.cpuMilliCores && cpuHistoryKey(slot.identityKey);
    if (!memoryKey && !cpuKey) return;
    const peaks = recordedIdentityPeaks();
    const append = (key, sample) => peaks.set(key, [...(peaks.get(key) ?? []), sample].slice(-IDENTITY_PEAK_WINDOW));
    if (memoryKey) append(memoryKey, slot.peakWorkingSetKiB);
    if (cpuKey) append(cpuKey, slot.cpuMilliCores);
    const target = join(root, IDENTITY_PEAKS_FILENAME);
    writeFileSync(`${target}.tmp`, JSON.stringify(Object.fromEntries(peaks)), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
    // A retained waiter can gain its first class, family or exact sample while queued.
    const resourceClass = slot.resourceClass ?? slot.className;
    for (const item of waiting) {
      if (!item.slot && (item.resourceClass ?? item.className) === resourceClass) sizeWaitingItem(item);
    }
  }

  // Higher priority ranks go first; arrival orders waiters within a rank.
  // Owner 2026-11-13 (capped head reservation): a waiter past the measured bound
  // has a guaranteed start, so overdue waiters are served first, in arrival order,
  // whatever their rank. Without this, ranked arrivals headed nl1's queue for
  // 2.5 h while rank-0 work never reserved (P03-ADMISSION-3, 2026-11-17).
  // P03 ORCH RULING 2026-11-17 (owner 15:31Z): QA reload preparation runs ahead of
  // tests, so it precedes overdue waiters: source-reload, then overdue FIFO, then rank.
  const overdue = (item, now) => now - item.arrivedAt >= HEAD_RESERVATION_DELAY_MS;
  const reload = item => {
    const resourceClass = item.resourceClass ?? item.className;
    // The shared checkout server prepares repo-dev readiness under the
    // source-bundle resource budget. Identity captures share its lock.
    return resourceClass === SOURCE_RELOAD_ADMISSION_CLASS
      || (resourceClass === 'source-bundle' && item.ownPriority === PRODUCER_RANK
        && item.preparesClass === SOURCE_RELOAD_ADMISSION_CLASS);
  };
  const pastLearnedDuration = (item, now) => now - item.arrivedAt >
    (collectLearnedClassMaximums().get(item.resourceClass ?? item.className) ?? Infinity);
  const compareService = now => (left, right) =>
    Number(pastLearnedDuration(right, now)) - Number(pastLearnedDuration(left, now))
    || (pastLearnedDuration(left, now) ? left.arrivedAt - right.arrivedAt || left.arrivalOrder - right.arrivalOrder : 0)
    || Number(reload(right)) - Number(reload(left))
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

  function remainingSlotTimeMs(slot, now) {
    return slot.p99DurationMs > 0 && Number.isFinite(slot.admittedAt)
      ? slot.admittedAt + slot.p99DurationMs - now : undefined;
  }
  function slotResourceBudget(now = Date.now(), pressure = cpuPressureCores) {
    let reservedMemoryKiB = 0;
    let reservedCpuCores = 0;
    let memoryReleasingWithinBoundKiB = 0;
    for (const slot of slots.values()) {
      const chargeKiB = slot.workingSetKiB ?? slot.floorKiB;
      reservedMemoryKiB += chargeKiB;
      reservedCpuCores += slot.cpuCores;
      const remainingMs = remainingSlotTimeMs(slot, now);
      // Keep the existing release assumption for slots without a duration.
      // A known deadline that passed or lies beyond the bound cannot justify a pledge.
      if (remainingMs === undefined || (remainingMs >= 0 && remainingMs <= HEAD_RESERVATION_DELAY_MS)) {
        memoryReleasingWithinBoundKiB += chargeKiB;
      }
    }
    const memoryBalanceKiB = sample.availableMemoryKiB + (sample.creditedResidentMemoryKiB ?? 0) - reservedMemoryKiB;
    return { reservedMemoryKiB, totalCpuCores, reservedCpuCores, cpuPressureCores: pressure,
      unreservedCpuCores: Math.max(0, totalCpuCores - reservedCpuCores - pressure),
      unreservedMemoryKiB: Math.max(0, memoryBalanceKiB),
      memoryWithinBoundKiB: memoryBalanceKiB + memoryReleasingWithinBoundKiB };
  }
  function readCpuPressureForOffer() {
    try {
      const pressure = readCpuPressure();
      if (!Number.isSafeInteger(pressure) || pressure < 0) {
        throw Object.assign(new Error('Invalid runnable CPU observation'), { code: 'HSTACK_CPU_OBSERVATION_UNAVAILABLE' });
      }
      const admittedPids = [...slots.values()].filter(slot => slot.admitted || slot.recovered).map(slot => slot.pid);
      return pressure - readAdmittedRunnableThreads(admittedPids, pressure);
    } catch (error) {
      recordFailure(error);
      return totalCpuCores;
    }
  }
  function accountedCpuCores(item, workers) {
    return workers ?? item.workerCeiling;
  }
  function validCpuRequest(request) {
    return request.cpuCost === undefined || request.cpuCost === 'host' || request.cpuCost === 'workers'
      || (Number.isSafeInteger(request.cpuCost) && request.cpuCost > 0);
  }
  function minimumCpuCores(item) {
    return item.floorOptions ? Math.min(...item.floorOptions.map(option => accountedCpuCores(item, option.workers))) : accountedCpuCores(item);
  }
  function reserveHead(head) {
    // Eligibility can flap with achievable memory or publication pressure.
    // Keep earned releases on the waiting item until it is admitted or gone.
    headPledge = head ? (head.headPledge ??= { item: head, memoryKiB: 0, cpuCores: 0 }) : undefined;
  }
  // Sample from the broker, outside the job's cgroup. The observer must
  // not count its own CPU as progress in the job it is watching.
  function monitorDeclarationComparison(slot) {
    if (slot.stallTimer || slot.stalled || slot.judgmentFinished || !slot.monitorsDeclaration
      || !slot.admittedAt || (!slot.admitted && !slot.recovered)) return;
    const durations = recordedIdentityDurations().get(slot.identityKey);
    const historicalMaxMs = durations?.length ? Math.max(...durations) : null;
    const elapsedLimitMs = historicalMaxMs === null ? null : 2 * historicalMaxMs;
    const peaks = recordedIdentityPeaks().get(slot.identityKey);
    const recordedPeakKiB = peaks?.length ? Math.max(...peaks) : null;
    let initialCpuUsec = readSlotCpuUsageUsec(slot.pid);
    let previousCpuUsec = initialCpuUsec;
    let lastProgressAt = Date.now();
    const sample = () => {
      if (closing || slot.judgmentFinished || slot.peer.destroyed) return;
      const now = Date.now();
      const cpuUsec = readSlotCpuUsageUsec(slot.pid);
      if (cpuUsec === null || previousCpuUsec === null || cpuUsec !== previousCpuUsec) lastProgressAt = now;
      if (cpuUsec === null || initialCpuUsec === null || cpuUsec < initialCpuUsec) initialCpuUsec = cpuUsec;
      previousCpuUsec = cpuUsec;
      const elapsedMs = now - slot.admittedAt;
      const cpuIdleMs = cpuUsec === null ? null : now - lastProgressAt;
      const cause = cpuIdleMs >= DECLARATION_IDLE_MS ? 'no-cpu-progress'
        : elapsedLimitMs !== null && elapsedMs >= elapsedLimitMs ? 'learned-duration' : null;
      if (cause) {
        slot.stalled = true;
        slot.peer.write(JSON.stringify({ kind: 'declaration-comparison-stalled', stall: {
          cause, elapsedMs, cpuIdleMs, cpuUsageUsec: cpuUsec === null ? null : cpuUsec - initialCpuUsec,
          elapsedLimitMs, historicalMaxMs, recordedPeakKiB,
        } }) + '\n');
        return;
      }
      schedule(elapsedMs);
    };
    const schedule = elapsedMs => {
      const delay = elapsedLimitMs === null ? DEFAULT_FILE_CHANGE_CATCH_UP_MS
        : Math.max(1, Math.min(DEFAULT_FILE_CHANGE_CATCH_UP_MS, elapsedLimitMs - elapsedMs));
      slot.stallTimer = setTimeout(sample, delay);
      slot.stallTimer.unref();
    };
    schedule(Date.now() - slot.admittedAt);
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
  function canReserveHead(item, memoryWithinBoundKiB, now, pressure = cpuPressureCores) {
    const minimumFloorKiB = item.floorOptions?.at(-1).floorKiB ?? item.floorKiB;
    const aged = now - item.arrivedAt >= HEAD_RESERVATION_DELAY_MS;
    // Keep the waiter's age and earned pledge while its floor cannot fit in
    // time. Non-admitted pressure cannot be recovered by releasing broker slots.
    return !item.slot && !item.blocked && !item.socket.destroyed && minimumFloorKiB <= sample.achievableMemoryKiB
      && (!aged || minimumFloorKiB <= memoryWithinBoundKiB) && minimumCpuCores(item) <= totalCpuCores - pressure;
  }
  function status(pressure = cpuPressureCores) {
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
    const { memoryWithinBoundKiB, ...budget } = slotResourceBudget(now, pressure);
    orderWaiting();
    const head = waiting.find(item => canReserveHead(item, memoryWithinBoundKiB, now, pressure));
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
    return { ...sample, ...budget, overruns, nextOverrunAt, durationHistoryUnavailableCount, backfillCount,
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
  function pruneFinished(now) {
    while (recentlyFinished[0]?.finishedAt < now - RECENT_JUDGMENT_WINDOW_MS) recentlyFinished.shift();
  }

  function stallMonitored(slot) {
    return (slot.admitted || slot.recovered) && Number.isFinite(slot.admittedAt)
      && slot.peer && !slot.peer.destroyed && !slot.judgmentFinished;
  }
  function refreshStallObservation() {
    if (closing || ![...slots.values()].some(stallMonitored)) {
      clearInterval(stallObservation);
      stallObservation = undefined;
    } else if (!stallObservation) {
      stallObservation = setInterval(sampleStallObservation, STALL_CPU_SAMPLE_MS);
      stallObservation.unref();
    }
  }
  let learnedClassMaximums;
  function collectLearnedClassMaximums() {
    if (learnedClassMaximums) return learnedClassMaximums;
    const maximums = new Map();
    for (const [key, durations] of recordedIdentityDurations()) {
      if (!durations.length) continue;
      let resourceClass;
      try { resourceClass = JSON.parse(key)?.[0]; } catch { continue; }
      if (!Object.hasOwn(HEAVYWEIGHT_COMMAND_RESOURCES, resourceClass)) continue;
      maximums.set(resourceClass, Math.max(maximums.get(resourceClass) ?? 0, ...durations));
    }
    learnedClassMaximums = maximums;
    return maximums;
  }
  // Use the job's dedicated scope so completed children remain in the cumulative
  // CPU counter. An unknown/reset counter cannot prove the job was idle.
  function sampleStallObservation() {
    const now = Date.now();
    const maximums = collectLearnedClassMaximums();
    for (const slot of slots.values()) {
      if (!stallMonitored(slot)) continue;
      const cpuUsec = readSlotCpuUsageUsec(slot.pid);
      const observations = slot.stallCpuObservations ??= [];
      const previous = observations.at(-1);
      if (cpuUsec === null || (previous && (cpuUsec < previous.cpuUsec || now <= previous.at))) {
        observations.length = 0;
      }
      const windowStart = now - STALL_CPU_WINDOW_MS;
      while (observations[1]?.at <= windowStart) observations.shift();
      const baseline = observations[0];
      if (cpuUsec !== null) observations.push({ at: now, cpuUsec });
      const [identityClass, component, entry] = slot.identityKey ? JSON.parse(slot.identityKey) : [];
      const resourceClass = slot.resourceClass ?? identityClass ?? slot.className;
      const className = Object.hasOwn(HEAVYWEIGHT_COMMAND_RESOURCES, resourceClass) ? resourceClass : 'unknown';
      const learnedMaxMs = maximums.get(className) ?? null;
      const ageMs = now - slot.admittedAt;
      const windowCpuUsec = cpuUsec === null || !baseline || baseline.at > windowStart ? null : cpuUsec - baseline.cpuUsec;
      if (windowCpuUsec === null || windowCpuUsec >= STALL_CPU_BUDGET_USEC
        || (learnedMaxMs !== null && ageMs <= 2 * learnedMaxMs)) {
        slot.idleDiagnostic = undefined;
        continue;
      }
      const diagnostic = { slotId: slot.slotId, pid: slot.pid, className,
        requester: diagnosticRequester(component, entry),
        windowCpuUsec, learnedMaxMs };
      if (!slot.idleDiagnostic) {
        try {
          appendFileSync(join(root, 'stalled-slot-cpu.jsonl'), JSON.stringify({
            ...diagnostic, ageMs, observedAt: new Date(now).toISOString(),
          }) + '\n', { mode: 0o600 });
        } catch (error) { recordFailure(error); }
      }
      slot.idleDiagnostic = diagnostic;
    }
    publishAdmissionStatus();
  }
  function observedStatus() {
    const now = Date.now();
    return { ...status(), stalledJobs: [...slots.values()].filter(slot => slot.idleDiagnostic && stallMonitored(slot))
      .map(slot => ({ ...slot.idleDiagnostic, ageMs: now - slot.admittedAt })) };
  }

  function queueSnapshot() {
    const sampledAt = Date.now();
    pruneFinished(sampledAt);
    return { sampledAt, observedSince: Math.max(observedSince, sampledAt - RECENT_JUDGMENT_WINDOW_MS),
      waiting: waiting.filter(item => !item.slot).map(item => item.judgment), recentlyFinished };
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
    const snapshot = observedStatus();
    const identity = JSON.stringify({ activeCount: snapshot.activeCount,
      durationHistoryUnavailableCount: snapshot.durationHistoryUnavailableCount,
      nextOverrunAt: snapshot.nextOverrunAt, overruns: snapshot.overruns.map(({ ageMs, ...slot }) => slot),
      stalledSlotIds: snapshot.stalledJobs.map(slot => slot.slotId) });
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
    const now = Date.now();
    const memorySlots = [...slots.values()].map(slot => {
      const warmupMs = slot.memoryWarmupMs ?? slot.p99DurationMs;
      const warmed = warmupMs > 0 && now - slot.admittedAt > warmupMs;
      const measured = (slot.admitted || slot.recovered) && (slot.identityKey || warmed)
        ? readSlotWorkingSetKiB(slot.pid) : null;
      const workingSetKiB = Number.isSafeInteger(measured) && measured > 0 ? measured : undefined;
      if (slot.admitted && slot.identityKey && workingSetKiB !== undefined) {
        slot.peakWorkingSetKiB = Math.max(slot.peakWorkingSetKiB ?? 0, workingSetKiB);
      }
      // Protect the expected peak through the identity's median run time.
      // Without identity history, use the request's p99, if available. After
      // warm-up only a measured working set can replace the original charge.
      slot.workingSetKiB = warmed ? workingSetKiB : undefined;
      return { pid: slot.pid, floorKiB: slot.floorKiB, workingSetKiB: slot.workingSetKiB };
    });
    const { slotRssKiB, ...resources } = await sampleResources({
      slots: memorySlots, waiters: waiting.filter(item => !item.slot).map(({ pid }) => ({ pid })) });
    sample = { ...(sample.lastFailure ? { lastFailure: sample.lastFailure } : {}),
      ...resources };
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
    const cpuWaiting = cpuPressureCores > 0 && waiting.some(item => !item.slot && !item.blocked && item.waitingForCpu);
    // External RAM or CPU recovery, process death and expired leases need not emit
    // filesystem events. Share the lock owner's existing catch-up cadence.
    // Unchanged workspace-only demand still performs no memory observation.
    if ((blocked.length || memoryWaiting || cpuWaiting) && !resourceCatchUp) {
      // Retain this handle while queued/running. Rearm only after recovery
      // drains, so slow OS observations cannot accumulate ticks or run back-to-back.
      const timer = setTimeout(() => enqueue(async () => {
        try {
          await resourcesChanged(waiting.filter(item => item.blocked),
            waiting.some(item => !item.slot && !item.blocked && item.waitingForMemory !== false),
            cpuPressureCores > 0 && waiting.some(item => !item.slot && !item.blocked && item.waitingForCpu));
        } finally {
          if (resourceCatchUp === timer) {
            resourceCatchUp = undefined;
            refreshWatchers();
          }
        }
      }), DEFAULT_FILE_CHANGE_CATCH_UP_MS);
      resourceCatchUp = timer;
      timer.unref();
    } else if (!blocked.length && !memoryWaiting && !cpuWaiting && resourceCatchUp) {
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
  async function resourcesChanged(consumers, resampleMemory, retryCpu) {
    let changed = resampleMemory;
    for (const item of consumers) {
      if (!waiting.includes(item) || !item.blocked || !resourceChanged(item)) continue;
      changed = true;
      item.blocked = false;
    }
    if (changed) await observe();
    if (changed || retryCpu) await drain({ memoryObserved: changed });
  }
  function resourceChanged(item) {
    const resources = readResources(item);
    if (!resources || resources.snapshot === item.resourceSnapshot) return false;
    item.resourceSnapshot = resources.snapshot;
    return true;
  }
  function releaseReservation(slot) {
    if (!slots.delete(slot.address)) return false;
    clearTimeout(slot.stallTimer);
    refreshStallObservation();
    // Before the measured wait bound, releases remain reusable by backfills.
    // After it, include recovered slots too so sustained traffic cannot starve
    // the head. Evaluate on this release, never retroactively or on a new timer.
    if (headReservation(headPledge?.item).active) {
      headPledge.memoryKiB += slot.workingSetKiB ?? slot.floorKiB;
      headPledge.cpuCores += slot.cpuCores;
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
    if (slot.admitted && !slot.recovered) {
      try { recordIdentityResources(slot); } catch (error) { recordFailure(error); }
    }
    if (slot.succeeded && slot.identityKey && slot.admitted && Number.isFinite(slot.admittedAt)) {
      try { recordIdentityDuration(slot.identityKey, Math.max(1, Date.now() - slot.admittedAt)); } catch (error) { recordFailure(error); }
    }
    await releaseDecision();
  }
  async function releaseDecision() {
    await observe();
    await drain({ memoryObserved: true });
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
    const running = [...slots.values()].map(slot => [
      Math.max(0, remainingSlotTimeMs(slot, now) ?? unrecordedMs), Math.min(slot.workingSetKiB ?? slot.floorKiB, capacityKiB),
    ]);
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
  // Only the actual service head may bypass outside CPU pressure. Keep
  // counting live CPU reservations, and carry ownership in the slot address.
  function cpuPressureHead(now) {
    if (cpuPressureCores === 0) return;
    const head = waiting.find(item => !item.slot && !item.blocked && !item.socket.destroyed
      && (item.floorOptions?.at(-1).floorKiB ?? item.floorKiB) <= sample.totalMemoryKiB
      && minimumCpuCores(item) <= totalCpuCores);
    if (head && (slots.size === 0 || overdue(head, now))) return head;
  }
  function hasCpuPressureExemption() {
    return [...slots.values()].some(slot => slot.pressureExempt);
  }
  async function drain({ memoryObserved = false, newArrival } = {}) {
    cpuPressureCores = readCpuPressureForOffer();
    orderWaiting();
    const initialBudget = slotResourceBudget();
    const initialPressureHead = cpuPressureHead(Date.now());
    const canRefreshForException = initialPressureHead && !hasCpuPressureExemption()
      && minimumCpuCores(initialPressureHead) <= totalCpuCores - initialBudget.reservedCpuCores;
    // A capacity-only wake is cheap. Before it can offer work, refresh memory
    // if the arrival or CPU-blocked request skipped its normal observation.
    if (!memoryObserved && (canRefreshForException || waiting.some(item => !item.slot && !item.blocked
      && (item === newArrival || item.waitingForCpu) && minimumCpuCores(item) <= initialBudget.unreservedCpuCores))) {
      await observe();
      cpuPressureCores = readCpuPressureForOffer();
      orderWaiting();
    }
    // Capacity already free when a request becomes head remains available to
    // backfill; releases are held only after that head reaches the wait bound.
    const now = Date.now();
    const budget = slotResourceBudget(now);
    let availableMemoryKiB = budget.unreservedMemoryKiB;
    let availableCpuCores = budget.unreservedCpuCores;
    let cpuCoresWithoutPressure = totalCpuCores - budget.reservedCpuCores;
    let head;
    let lendableKiB = 0;
    let headStartAt;
    const pressureHead = cpuPressureHead(now);
    const hasExemption = hasCpuPressureExemption();
    // Once the aged head fits memory, the next CPU release belongs to it.
    // The host-bound backfill shortcut must also honor that order.
    const protectPressureHead = pressureHead && overdue(pressureHead, now)
      && (pressureHead.floorOptions?.at(-1).floorKiB ?? pressureHead.floorKiB) <= availableMemoryKiB
      && minimumCpuCores(pressureHead) > availableCpuCores;
    const pledgingHead = waiting.find(item => canReserveHead(item, budget.memoryWithinBoundKiB, now));
    const reservation = headReservation(pledgingHead);
    const capacityHead = waiting.find(item => !item.slot && !item.blocked && !item.socket.destroyed
      && (item.floorOptions?.at(-1).floorKiB ?? item.floorKiB) <= sample.totalMemoryKiB
      && minimumCpuCores(item) <= totalCpuCores);
    // Coordination 2026-11-13 11:22Z: source bundles (including stack reloads)
    // cannot move hosts. Let fitting ones use a relocatable head's pledge first.
    // Reorder only this pass, never the arrival queue or the retained pledge.
    const hostBoundFirst = new Set(!protectPressureHead && !(capacityHead && pastLearnedDuration(capacityHead, now)) && pledgingHead?.className !== 'source-bundle' && !(pledgingHead?.headPriority > 0) && reservation.memoryKiB > 0
      ? waiting.filter(item => item.className === 'source-bundle' && canReserveHead(item, budget.memoryWithinBoundKiB, now)
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
    let protectingCpuHead = false;
    let backfillBlockedBy;
    let foundCapacityWaiter = false;
    for (const item of ordered) {
      if (item.slot || item.blocked) continue;
      if (protectingCpuHead && !FOCUSED_TEST_ADMISSION_CLASSES.includes(item.resourceClass ?? item.className)) continue;
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
      if (backfillBlockedBy) {
        if (item.noWait) refuse(item, backfillBlockedBy);
        continue;
      }
      const offerCpuCores = item === pressureHead && !hasExemption
        ? Math.max(availableCpuCores, cpuCoresWithoutPressure) : availableCpuCores;
      const fittingFor = cpuCores => item.floorOptions?.find(option => option.floorKiB <= availableMemoryKiB
        && accountedCpuCores(item, option.workers) <= cpuCores);
      const fitting = fittingFor(availableCpuCores)
        ?? (offerCpuCores > availableCpuCores ? fittingFor(offerCpuCores) : undefined);
      // A job projected to finish before the head can start may borrow the
      // head's pledged memory; its release returns it before it is needed.
      const borrowKiB = !item.floorOptions && headStartAt !== undefined
        && item.p99DurationMs > 0 && Date.now() + item.p99DurationMs <= headStartAt
        && item.floorKiB > availableMemoryKiB && item.floorKiB <= availableMemoryKiB + lendableKiB
        && accountedCpuCores(item) <= availableCpuCores ? item.floorKiB - availableMemoryKiB : 0;
      // Announced to the waiter (its client logs it), so a backfill is visible in the run's log.
      const backfill = borrowKiB > 0 ? { borrowedKiB: borrowKiB, headStartInMs: Math.max(0, headStartAt - Date.now()) } : undefined;
      if (backfill) backfillCount += 1;
      if (borrowKiB > 0) {
        availableMemoryKiB += borrowKiB;
        lendableKiB -= borrowKiB;
        // The counter can exceed the capped reservation; lend from the cap.
        headPledge.memoryKiB = Math.min(headPledge.memoryKiB, headReservation(head).memoryKiB) - borrowKiB;
      }
      item.waitingForMemory = minimumFloorKiB > availableMemoryKiB;
      if (item.floorOptions ? !fitting : item.waitingForMemory || accountedCpuCores(item) > offerCpuCores) {
        item.waitingForCpu = !item.waitingForMemory;
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
          } else {
            if (!foundCapacityWaiter) {
              foundCapacityWaiter = true;
              if (pastLearnedDuration(item, now)) {
                backfillBlockedBy = item.waitingForMemory ? 'HSTACK_MEMORY_BUSY' : 'HSTACK_CPU_BUSY';
              }
            }
            if (!head && canReserveHead(item, budget.memoryWithinBoundKiB, now)) assignHead(item);
            if (item === pressureHead && protectPressureHead && !item.waitingForMemory) {
              // Keep releases pledged to the head. Focused work can use the
              // already-free capacity without taking the pressure exception.
              protectingCpuHead = true;
            }
          }
        }
        continue;
      }
      const floorKiB = fitting?.floorKiB ?? item.floorKiB;
      const cpuCores = accountedCpuCores(item, fitting?.workers);
      item.waitingForMemory = item.waitingForCpu = false;
      if (item.socket.destroyed) { removeWaiting(item); continue; }
      // Observe before publishing a reservation: a failed request must not
      // leave a slot that its client was never offered.
      const resources = readResources(item);
      if (!resources) continue;
      const slotId = randomUUID();
      const pressureExempt = cpuCores > availableCpuCores;
      const address = slotAddress(root, item.pid, floorKiB, slotId, cpuCores, pressureExempt);
      const key = identityKey(item);
      const slot = { address, pid: item.pid, className: item.className, resourceClass: item.resourceClass, projects: item.projects, floorKiB, cpuCores, workers: cpuCores, control: item.socket,
        slotId, durationClass: item.durationClass, p99DurationMs: item.p99DurationMs, identityKey: key,
        monitorsDeclaration: item.acceptsDeclarationStall === true && DECLARATION_COMPARISON_ENTRIES.has(admissionScriptClass(item)),
        memoryWarmupMs: recordedMemoryWarmupMs(key), pressureExempt,
        arrivedAt: item.arrivedAt, arrivalOrder: item.arrivalOrder, judgment: item.judgment };
      slots.set(address, slot);
      availableMemoryKiB -= floorKiB;
      availableCpuCores = Math.max(0, availableCpuCores - cpuCores);
      cpuCoresWithoutPressure -= cpuCores;
      item.slot = slot;
      if (hostBoundFirst.has(item) && headPledge?.item === pledgingHead) {
        headPledge.lastHostBoundAdmissionKiB = floorKiB;
      }
      if (headPledge?.item === item) reserveHead();
      item.resourceSnapshot = resources.snapshot;
      send(item.socket, { kind: 'reserved', slotAddress: address, floorKiB, cpuCores, workers: slot.workers,
        ...(backfill ? { backfill } : {}) });
    }
    reserveHead(head);
    // Tell the pledging waiter what it holds, so it can resend it to a successor.
    if (head?.headPledge && !head.socket.destroyed) {
      const held = { memoryKiB: Math.min(head.headPledge.memoryKiB, head.floorOptions?.at(-1).floorKiB ?? head.floorKiB),
        cpuCores: Math.min(head.headPledge.cpuCores, minimumCpuCores(head)) };
      // Only a change from what it last heard (nothing held at first) is sent.
      if (held.memoryKiB !== (head.sentHold?.memoryKiB ?? 0) || held.cpuCores !== (head.sentHold?.cpuCores ?? 0)) {
        head.sentHold = held;
        send(head.socket, { kind: 'held', ...held });
      }
    }
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
      // Older retained clients sent lifetime memory.peak as slot-peak.
      // Only the working-set message may complete a new sample.
      if (metadata.kind === 'slot-working-set') {
        if (!Number.isSafeInteger(metadata.peakKiB) || metadata.peakKiB <= 0 || typeof metadata.className !== 'string'
          || (metadata.resourceClass !== undefined && typeof metadata.resourceClass !== 'string')
          || (metadata.projects !== undefined && (!Array.isArray(metadata.projects) || metadata.projects.some(project => typeof project !== 'string')))) return;
        enqueue(() => {
          if (!slot.admitted || slot.identityKey !== identityKey(metadata)) return;
          slot.workingSetIdentity = metadata;
          slot.peakWorkingSetKiB = Math.max(slot.peakWorkingSetKiB ?? 0, metadata.peakKiB);
        });
        return;
      }
      if (metadata.kind === 'slot-completed') {
        if (Number.isSafeInteger(metadata.status)) enqueue(() => {
          clearTimeout(slot.stallTimer);
          if (!slot.judgmentFinished) {
            const finishedAt = Date.now();
            pruneFinished(finishedAt);
            recentlyFinished.push({ ...(slot.judgment ?? queueJudgment()), finishedAt });
            slot.judgmentFinished = true;
            refreshStallObservation();
          }
          if (metadata.status === 0 && !slot.stalled) {
            slot.succeeded = true;
            if (Number.isSafeInteger(metadata.cpuMilliCores) && metadata.cpuMilliCores > 0) {
              slot.cpuMilliCores = metadata.cpuMilliCores;
            }
          }
        });
        return;
      }
      if (metadata.kind === 'slot-identity') {
        if (typeof metadata.className !== 'string'
          || (metadata.resourceClass !== undefined && typeof metadata.resourceClass !== 'string')
          || (metadata.projects !== undefined && (!Array.isArray(metadata.projects)
            || metadata.projects.some(project => typeof project !== 'string')))) return;
        enqueue(async () => {
          slot.identityKey ??= identityKey(metadata);
          slot.judgment ??= queueJudgment(metadata.judgment);
          const key = slot.recovered ? slot.identityKey : null;
          if (slot.recovered) {
            slot.memoryWarmupMs = recordedMemoryWarmupMs(key);
            slot.monitorsDeclaration = metadata.acceptsDeclarationStall === true && DECLARATION_COMPARISON_ENTRIES.has(admissionScriptClass(metadata));
            monitorDeclarationComparison(slot);
          }
          const peaks = recordedIdentityPeaks().get(key);
          const peak = peaks && nearestRank(peaks, 0.95);
          if (peak !== undefined) slot.floorKiB = Math.max(slot.floorKiB, roundPeak(peak));
          if (slot.missingCpuCharge && Object.hasOwn(COLD_ADMISSION_CPU_CORES, metadata.resourceClass ?? metadata.className)) {
            slot.cpuCores = hostCpuCores(metadata);
            slot.missingCpuCharge = false;
            if (started && waiting.length) await drain();
          }
        });
        return;
      }
      if (metadata.kind !== 'slot-duration' || !validDuration(metadata)
        || !Number.isSafeInteger(metadata.admittedAt) || metadata.admittedAt < 0
        || !/^[a-f0-9-]{36}$/.test(metadata.slotId ?? '')
        || !Object.hasOwn(HEAVYWEIGHT_COMMAND_RESOURCES, metadata.className)) return;
      enqueue(() => {
        Object.assign(slot, { admittedAt: metadata.admittedAt, slotId: metadata.slotId, className: metadata.className,
          durationClass: metadata.durationClass, p99DurationMs: metadata.p99DurationMs });
        monitorDeclarationComparison(slot);
        refreshStallObservation();
      });
    });
    peer.once('close', () => enqueue(() => release(slot)));
    return slot;
  }
  function hasAdmittedAncestor(pid) {
    const activeOwners = new Set();
    for (const slot of slots.values()) {
      if (slot.admitted || slot.recovered) activeOwners.add(slot.pid);
    }
    if (activeOwners.size === 0) return false;
    // The process tree is authoritative even when a launcher dropped the
    // inherited markers. Only the live slot listener can own a grant.
    while (pid > 1) {
      let status;
      try { status = readFileSync(`/proc/${pid}/status`, 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
        throw error;
      }
      const parent = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
      if (!Number.isSafeInteger(parent) || parent === pid) return false;
      if (activeOwners.has(parent)) return true;
      pid = parent;
    }
    return false;
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
      if (request.kind === 'sample') {
        // Placement names the routed command's identity and gets the floor this broker
        // would reserve for it (the same owner as acquire), never the class floor.
        const identity = request.identity;
        const valid = identity && typeof identity.resourceClass === 'string' && typeof identity.component === 'string'
          && typeof identity.entry === 'string' && Number.isSafeInteger(identity.floorKiB) && identity.floorKiB > 0
          && Array.isArray(identity.projects) && identity.projects.every(project => typeof project === 'string');
        const snapshot = observedStatus();
        send(socket, { kind: 'sample', ...(request.includeQueue === true ? { queue: queueSnapshot() } : {}),
          ...(valid ? { identityFloorKiB: recordedIdentityFloorKiB({ resourceClass: identity.resourceClass,
          className: identity.resourceClass, component: identity.component, entry: identity.entry,
          projects: identity.projects, floorKiB: identity.floorKiB }) } : {}) }, snapshot);
        socket.end(); return;
      }
      if (request.kind === 'check') {
        const valid = Number.isSafeInteger(request.floorKiB) && request.floorKiB > 0 && validCpuRequest(request);
        const available = status(readCpuPressureForOffer());
        const probe = { cpuCost: request.cpuCost, className: request.className, floorKiB: request.floorKiB };
        if (valid) sizeWaitingItem(probe);
        const minimumFloorKiB = probe.floorOptions?.at(-1).floorKiB ?? probe.floorKiB;
        const memoryFits = minimumFloorKiB <= available.unreservedMemoryKiB;
        const cpuCores = valid ? minimumCpuCores(probe) : 0;
        const admitted = valid && memoryFits && cpuCores <= available.unreservedCpuCores;
        send(socket, { kind: admitted ? 'admitted' : 'refused',
          ...(!admitted ? { reason: !valid ? 'HSTACK_INVALID_ADMISSION'
            : minimumFloorKiB > sample.totalMemoryKiB ? 'HSTACK_MEMORY_CAPACITY'
              : cpuCores > totalCpuCores ? 'HSTACK_CPU_CAPACITY'
                : !memoryFits ? 'HSTACK_MEMORY_BUSY' : 'HSTACK_CPU_BUSY' } : {}) }, available);
        socket.end(); return;
      }
      if (request.kind === 'ready' && item?.slot && !item.settled) {
        try {
          await connectSlot(item.slot);
          item.slot.admitted = true;
          item.slot.admittedAt = item.slot.lastSampleAt = Date.now();
          monitorDeclarationComparison(item.slot);
          refreshStallObservation();
          item.settled = true;
          removeWaiting(item);
          send(socket, { kind: 'admitted', slotId: item.slot.slotId, admittedAt: item.slot.admittedAt,
            floorKiB: item.slot.floorKiB, cpuCores: item.slot.cpuCores, workers: item.slot.workers });
          refreshWatchers();
        } catch { refuse(item, 'HSTACK_SLOT_UNAVAILABLE'); await releaseDecision(); }
        return;
      }
      if (request.kind === 'resources-busy' && item?.slot && !item.settled) {
        releaseReservation(item.slot);
        item.slot = null;
        sizeWaitingItem(item);
        item.blocked = true;
        if (item.noWait) refuse(item, 'HSTACK_WORKSPACE_RESOURCE_BUSY');
        // A release may race the client's busy acknowledgement. Its offer's
        // snapshot closes that gap without a timer or retaining partial scopes.
        else if (resourceChanged(item)) {
          item.blocked = false;
          await observe();
        }
        await drain({ memoryObserved: !item.blocked });
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
        || (request.heldKiB !== undefined && (!Number.isSafeInteger(request.heldKiB) || request.heldKiB < 0))
        || (request.heldCpuCores !== undefined && (!Number.isSafeInteger(request.heldCpuCores) || request.heldCpuCores < 0))
        || (request.projects !== undefined && (!Array.isArray(request.projects)
          || request.projects.some(project => typeof project !== 'string')))
        || typeof request.repoDir !== 'string' || (request.cacheBaseDir !== undefined && typeof request.cacheBaseDir !== 'string')
        || (request.floorOptions !== undefined && (!Array.isArray(request.floorOptions) || request.floorOptions.length === 0
          || request.floorOptions.some(option => !Number.isSafeInteger(option?.floorKiB) || option.floorKiB <= 0
            || !Number.isSafeInteger(option.workers) || option.workers <= 0)))
        || !Array.isArray(request.locks ?? []) || (request.locks ?? []).some(lock => typeof lock?.path !== 'string')) {
        send(socket, { kind: 'refused', reason: 'HSTACK_INVALID_ADMISSION' }); socket.end(); return;
      }
      if (hasAdmittedAncestor(request.pid)) {
        send(socket, { kind: 'refused', reason: 'HSTACK_ADMISSION_INHERITANCE_REQUIRED' });
        socket.end();
        return;
      }
      item = { ...request, socket, judgment: queueJudgment(request.judgment),
        locks: request.locks ?? [], env: request.env ?? {}, settled: false,
        arrivedAt: request.arrivedAt ?? Date.now(), arrivalOrder: ++arrivalOrder, ownPriority: headPriorityRank(request),
        preparedPriority: preparedRank(request) };
      item.headPriority = Math.max(item.ownPriority, item.preparedPriority);
      item.requestedFloorOptions = request.floorOptions?.toSorted((left, right) =>
        right.floorKiB - left.floorKiB || right.workers - left.workers);
      sizeWaitingItem(item);
      if (item.p99DurationMs === undefined) Object.assign(item, recordedIdentityDuration(item));
      // A waiter re-registering after a succession resends the releases it was holding
      // (`held`), so the successor does not admit work ahead of it. Capped by its own
      // minimum floor and cores; it still applies only while the waiter is the head.
      if (item.heldKiB > 0 || item.heldCpuCores > 0) {
        item.headPledge = { item, memoryKiB: Math.min(item.heldKiB ?? 0, item.floorOptions?.at(-1).floorKiB ?? item.floorKiB),
          cpuCores: Math.min(item.heldCpuCores ?? 0, minimumCpuCores(item)) };
      }
      item.observation = createWorkspaceBuildResourceObservation({ locks: item.locks });
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
      const reclaimed = Boolean(disk.reclamation?.length);
      if (reclaimed) await observe();
      await drain({ memoryObserved: reclaimed, newArrival: memoryWaiting ? undefined : item });
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
      // Read once at startup. Runnable pressure is sampled before offers.
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
            if (!(slot.cpuCores > 0)) {
              // Charge the largest cold class until the retained client identifies
              // itself. Old clients without identity keep this conservative charge.
              slot.cpuCores = Math.min(totalCpuCores, MAX_COLD_CPU_CORES);
              slot.missingCpuCharge = true;
            }
            try {
              await connectSlot(slot);
              // The socket carries the granted peak through succession. Keep it
              // until this client supplies its age and passes the same warm-up check.
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
          cpuPressureCores = readCpuPressureForOffer();
          // A removed root ends this broker: its state, slots and clients are gone with it.
          // Its own socket's removal is the observable part: inotify reports no removal of
          // a directory that still holds a bound socket, only the unlink of the entries in
          // it (P03-BROKER-W2: test brokers outlived their removed /tmp/ha-* roots). A
          // replaced socket also means clients now reach another broker, so this one ends.
          const ownSocket = lstatSync(address).ino;
          rootWatcher = watch(root, () => {
            let socketIno;
            try { socketIno = lstatSync(address).ino; } catch {}
            if (!existsSync(root) || socketIno !== ownSocket) void this.close();
          });
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
      clearInterval(stallObservation);
      clearTimeout(resourceCatchUp);
      resourceCatchUp = undefined;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      for (const socket of controls) socket.destroy();
      for (const socket of pendingConnections) socket.destroy();
      await serial;
      for (const slot of slots.values()) {
        clearTimeout(slot.stallTimer);
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
