import { spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveHeavyweightPressureRetryMilliseconds } from '../dev_targets/heavyweight_pressure_cadence.mjs';

import { expandHome } from '../paths/canonical_home.mjs';
import { resolveStackBaseDir } from '../paths/paths.mjs';
// The dependency-free source owner is available before workspace bootstrap.
import { readProcessInstanceFingerprintSync } from '../../../../../packages/cli-common/processInstance.mjs';

const SERVICE_PROCESS_KEYS = [
  'serverPid', 'serverWrapperPid', 'proxyPid', 'serverBackendPid', 'serverDrainingPid', 'expoPid', 'daemonPid',
];
const OBSERVED_ENVIRONMENT_KEYS = new Set([
  'HOME', 'HAPPIER_STACK_STACK', 'HAPPIER_STACK_ENV_FILE', 'HAPPIER_STACK_STORAGE_DIR',
  'HAPPIER_STACK_PROCESS_KIND',
  'HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT', 'HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN',
]);
const runtimeAdmissionPhases = ['awaiting-runtime-request', 'building-runtime'];

function readLinuxProcessFingerprintSync(pid) {
  return readProcessInstanceFingerprintSync(pid, { platform: 'linux' });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readAdmissionPhase(ownerPath) {
  try {
    const phase = readFileSync(join(ownerPath, 'phase'), 'utf8').trim();
    if (phase === 'admitted' || runtimeAdmissionPhases.includes(phase)) return phase;
  } catch { /* Older or exiting owners have no phase observation. */ }
  return undefined;
}

/** Diagnostic only: update an existing native ancestor's phase, never admission. */
export function writeRuntimeAdmissionPhase(phase, env = process.env) {
  if (!runtimeAdmissionPhases.includes(phase)) throw new Error('invalid runtime admission phase');
  if (process.platform !== 'linux') return false;
  const root = String(env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT ?? '');
  const token = /^(\d+):(\d+)$/.exec(String(env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN ?? ''));
  if (!isAbsolute(root) || !token) return false;
  const ownerPath = join(root, 'owners', `${token[1]}-${token[2]}`);
  // Native creation owns this optional field. Do not add it to already-loaded
  // older owners whose cleanup cannot release it.
  if (!readAdmissionPhase(ownerPath)) return false;
  try {
    const processes = readLinuxWorkerProcesses();
    const ownerPid = Number(token[1]);
    if (processes.get(ownerPid)?.fingerprint !== `linux-proc:${token[2]}`) return false;
    let ancestor = process.pid;
    while (ancestor !== ownerPid) {
      if (ancestor <= 1 || !processes.has(ancestor)) return false;
      ancestor = processes.get(ancestor).parentPid;
    }
    if (readFileSync(join(ownerPath, 'process'), 'utf8').trim() !== `${token[1]} ${token[2]}`
      || readFileSync(join(ownerPath, 'class'), 'utf8').trim() !== 'runtime-build') return false;
    // Open only the existing field: concurrent native release must not leave a
    // recreated phase file behind after unlinking the owner record.
    const phaseFile = openSync(join(ownerPath, 'phase'), 'r+');
    try {
      const content = phase + '\n';
      writeFileSync(phaseFile, content);
      ftruncateSync(phaseFile, Buffer.byteLength(content));
    } finally { closeSync(phaseFile); }
    return true;
  } catch { return false; }
}

/** One account-visible OS snapshot, never a persisted PID registry. */
export function readLinuxWorkerProcesses({ readSmapsRollup = path => readFileSync(path, 'utf8') } = {}) {
  const processes = new Map();
  const metadata = spawnSync('ps', ['-u', String(process.getuid()), '-o', 'pid=,ppid=,rss=,etimes=,times='], { encoding: 'utf8' });
  if (metadata.error || metadata.status !== 0) throw new Error('worker process memory observation is unavailable');
  const generationPids = new Set();
  for (const line of metadata.stdout.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!row) continue;
    const pid = Number(row[1]);
    if (pid <= 1) continue;
    const env = {};
    try {
      for (const binding of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const separator = binding.indexOf('=');
        const key = binding.slice(0, separator);
        if (separator > 0 && OBSERVED_ENVIRONMENT_KEYS.has(key)) env[key] = binding.slice(separator + 1);
      }
    } catch {
      // Non-visible accounts cannot supply service or admitted-owner roots.
    }
    const token = /^(\d+):(\d+)$/.exec(String(env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN ?? ''));
    if (token) generationPids.add(Number(token[1]));
    if (env.HAPPIER_STACK_ENV_FILE && env.HAPPIER_STACK_STACK) generationPids.add(pid);
    let pssKiB;
    processes.set(pid, { pid, parentPid: Number(row[2]), rssKiB: Number(row[3]), ageSeconds: Number(row[4]), cpuSeconds: Number(row[5]), fingerprint: null, env,
      // Only accounted trees need smaps; identity/CPU observers and unrelated
      // host processes must not pay for a system-wide page-table walk.
      get pssKiB() {
        if (pssKiB === undefined) {
          try {
            const value = /^Pss:\s+(\d+)\s+kB\s*$/m.exec(readSmapsRollup(`/proc/${pid}/smaps_rollup`));
            pssKiB = value && Number.isSafeInteger(Number(value[1])) ? Number(value[1]) : null;
          } catch (error) {
            // A vanished descendant consumes no memory. An existing process
            // with an unreadable/unsupported rollup still uses conservative RSS.
            pssKiB = null;
            if (error.code === 'ENOENT' || error.code === 'ESRCH') {
              try { readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (statError) {
                if (statError.code === 'ENOENT' || statError.code === 'ESRCH') pssKiB = 0;
              }
            }
          }
        }
        return pssKiB;
      },
    });
  }
  // Check generations only for actual positive bindings, not every unrelated
  // descendant or host process. Service roots below may be untagged listeners.
  for (const pid of generationPids) {
    const current = processes.get(pid);
    if (current) current.fingerprint = readLinuxProcessFingerprintSync(pid);
  }
  return processes;
}

function readServiceRoots(processes) {
  const scopes = new Map();
  const bindings = new Map();
  for (const { env } of processes.values()) {
    const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim();
    const envFile = expandHome(env.HAPPIER_STACK_ENV_FILE ?? '', env);
    if (!stackName || !isAbsolute(envFile)) continue;
    bindings.set(JSON.stringify([stackName, envFile, env.HOME, env.HAPPIER_STACK_STORAGE_DIR]), { stackName, envFile, env });
  }
  for (const { stackName, envFile, env } of bindings.values()) {
    // Runtime state uses the canonical storage owner; the env-file directory
    // also covers existing explicit worker state bound directly to that file.
    for (const base of [resolveStackBaseDir(stackName, env).baseDir, dirname(envFile)]) {
      const path = canonicalPath(base);
      if (!scopes.has(path)) scopes.set(path, new Set());
      scopes.get(path).add(stackName);
    }
  }
  const roots = new Set();
  const accept = (pidValue, fingerprint, base, stackNames) => {
    const pid = Number(pidValue);
    const current = processes.get(pid);
    if (!current) return;
    current.fingerprint ??= readLinuxProcessFingerprintSync(pid);
    if (!current.fingerprint) return;
    if (fingerprint) {
      if (current.fingerprint !== fingerprint) return;
    } else {
      // Older state is accepted only through the existing live Stack binding,
      // not merely because an unrelated process reused its recorded PID.
      const envFile = expandHome(current.env.HAPPIER_STACK_ENV_FILE ?? '', current.env);
      if (!isAbsolute(envFile) || canonicalPath(dirname(envFile)) !== base
        || !stackNames.has(current.env.HAPPIER_STACK_STACK)) return;
    }
    roots.add(pid);
  };
  for (const [base, stackNames] of scopes) {
    const state = readJson(join(base, 'stack.runtime.json'));
    if (state && stackNames.has(state.stackName)) {
      for (const key of SERVICE_PROCESS_KEYS) {
        const pid = state.processes?.[key];
        const instance = state.processInstances?.processes?.[key];
        const fingerprint = instance?.pid === Number(pid) ? instance.fingerprint : null;
        accept(pid, fingerprint, base, stackNames);
      }
      for (const pid of state.processes?.daemonPids ?? []) {
        const instance = state.processInstances?.processes?.daemonPids?.find(value => value.pid === Number(pid));
        accept(pid, instance?.fingerprint, base, stackNames);
      }
    }
    // Standalone mobile/Expo has the same existing canonical PID writer but
    // may have no stack.runtime.json entry. Do not probe Metro over the network.
    for (const kind of ['expo-dev', 'mobile']) {
      let entries;
      try { entries = readdirSync(join(base, kind), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const expo = readJson(join(base, kind, entry.name, 'expo.state.json'));
        if (expo) accept(expo.pid, expo.processInstanceFingerprint, base, stackNames);
      }
    }
  }
  for (const process of processes.values()) {
    const { env } = process;
    const envFile = expandHome(env.HAPPIER_STACK_ENV_FILE ?? '', env);
    if (env.HAPPIER_STACK_PROCESS_KIND !== 'browser' || !env.HAPPIER_STACK_STACK || !isAbsolute(envFile)) continue;
    accept(process.pid, null, canonicalPath(dirname(envFile)), new Set([env.HAPPIER_STACK_STACK]));
  }
  return roots;
}

function readLegacyOwners(processes, admissionRoot, observationRequired = false) {
  const owners = new Map();
  const currentRoot = canonicalPath(admissionRoot);
  for (const { env } of processes.values()) {
    const root = String(env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT ?? '');
    const token = /^(\d+):(\d+)$/.exec(String(env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN ?? ''));
    if (!isAbsolute(root) || !token || root === admissionRoot || canonicalPath(root) === currentRoot) continue;
    const pid = Number(token[1]);
    const start = token[2];
    const identity = `${pid}:${start}:${canonicalPath(root)}`;
    if (owners.has(identity) || processes.get(pid)?.fingerprint !== `linux-proc:${start}`) continue;
    try {
      const ownerPath = join(root, 'owners', `${pid}-${start}`);
      const recorded = readFileSync(join(ownerPath, 'process'), 'utf8').trim();
      const className = readFileSync(join(ownerPath, 'class'), 'utf8').trim();
      if (recorded !== `${pid} ${start}` || !/^[a-z][a-z-]*$/.test(className)) continue;
      const phase = readAdmissionPhase(ownerPath);
      owners.set(identity, { pid, token: start, className, ownerPath, ...(phase ? { phase } : {}) });
    } catch (error) {
      if (observationRequired && error.code !== 'ENOENT') throw error;
      // An inherited token alone is not an admitted owner.
    }
  }
  return [...owners.values()];
}

function processTreePids(roots, children) {
  const pids = new Set();
  const pending = [...roots];
  for (let index = 0; index < pending.length; index += 1) {
    const pid = pending[index];
    if (pids.has(pid)) continue;
    pids.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return pids;
}

function readAdmittedOwnerRss(processes, admissionRoot, legacyOwners, children, progress, memoryKiB, admittedOwnerRecords) {
  const owners = new Map();
  const accept = (pid, token, className, phase, ownerPath) => {
    const current = processes.get(pid);
    if (!current) return;
    current.fingerprint ??= readLinuxProcessFingerprintSync(pid);
    if (current.fingerprint !== `linux-proc:${token}`) return;
    const previous = owners.get(`${pid}:${token}`);
    const observedPhase = previous?.phase ?? phase;
    owners.set(`${pid}:${token}`, { pid, token, className: previous?.className ?? className,
      ownerPaths: [...new Set([...(previous?.ownerPaths ?? []), ownerPath])],
      ...(observedPhase ? { phase: observedPhase } : {}) });
  };
  let entries = [];
  try { entries = readdirSync(join(admissionRoot, 'owners'), { withFileTypes: true }); } catch (error) {
    if (progress && error.code !== 'ENOENT') throw error;
    // An absent root means no canonical owners yet. Missing RSS remains
    // conservative; diagnostics must not turn unreadable state into empty.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const identity = /^(\d+)-(\d+)$/.exec(entry.name);
    if (!identity) continue;
    try {
      const recorded = readFileSync(join(admissionRoot, 'owners', entry.name, 'process'), 'utf8').trim();
      const className = readFileSync(join(admissionRoot, 'owners', entry.name, 'class'), 'utf8').trim();
      if (recorded === `${identity[1]} ${identity[2]}` && /^[a-z][a-z-]*$/.test(className)) accept(Number(identity[1]), identity[2], className,
        progress ? readAdmissionPhase(join(admissionRoot, 'owners', entry.name)) : undefined,
        join(admissionRoot, 'owners', entry.name));
    } catch (error) {
      if (progress && error.code !== 'ENOENT') throw error;
      // A concurrent exit cannot supply an RSS credit or live diagnostics.
    }
  }
  for (const owner of legacyOwners) accept(owner.pid, owner.token, owner.className, owner.phase, owner.ownerPath);
  admittedOwnerRecords.push(...[...owners.values()].map(({ pid, token, ownerPaths }) => ({ pid, token, ownerPaths })));
  const result = [];
  for (const [identity, owner] of owners) {
    const roots = new Set([owner.pid]);
    for (const record of processes.values()) {
      if (record.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN !== identity) continue;
      const root = String(record.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT ?? '');
      if (!isAbsolute(root)) continue;
      try {
        // Inherited custody can survive reparenting. Credit it only while its
        // original owner and matching admission record remain authenticated.
        const recorded = readFileSync(join(root, 'owners', `${owner.pid}-${owner.token}`, 'process'), 'utf8').trim();
        if (recorded === `${owner.pid} ${owner.token}`) roots.add(record.pid);
      } catch { /* An environment token alone is not admission authority. */ }
    }
    const pids = processTreePids(roots, children);
    let rssKiB = 0;
    let available = true;
    for (const pid of pids) {
      const rss = memoryKiB(pid);
      if (!Number.isSafeInteger(rss) || rss < 0) { available = false; break; }
      rssKiB += rss;
    }
    if (progress) {
      const counters = [...pids].map(pid => processes.get(pid)?.cpuSeconds);
      const cpuSeconds = counters.every(value => Number.isSafeInteger(value) && value >= 0)
        ? counters.reduce((sum, value) => sum + value, 0) : null;
      const previous = progress.previous?.owners?.find(value => value.pid === owner.pid && value.token === owner.token);
      const elapsedMs = progress.sample.sampledAtMs - progress.previous?.sampledAtMs;
      const recentCpuPercent = cpuSeconds !== null && Number.isFinite(previous?.cpuSeconds)
        && cpuSeconds >= previous.cpuSeconds && elapsedMs > 0
        ? (cpuSeconds - previous.cpuSeconds) * 100_000 / elapsedMs : null;
      const { ownerPaths, ...diagnosticOwner } = owner;
      progress.sample.owners.push({ ...diagnosticOwner, ageSeconds: processes.get(owner.pid)?.ageSeconds ?? null, cpuSeconds, recentCpuPercent });
    }
    // Missing RSS retains the whole class reservation in the shell consumer.
    if (available && Number.isSafeInteger(rssKiB)) result.push({ pid: owner.pid, token: owner.token, rssKiB });
  }
  return result;
}

export function readWorkerMemoryReservations({ admissionRoot, readProcesses = readLinuxWorkerProcesses, includeAdmittedRss = false,
  includeOwnerProgress = false, previousProgress = null, nowMs = Date.now(), serviceMemoryCeilingKiB = null }) {
  if (!admissionRoot) throw new Error('canonical host admission root is required');
  const processes = readProcesses();
  const rssFallbackPids = new Set();
  const memoryKiB = pid => {
    const record = processes.get(pid);
    const pss = record?.pssKiB;
    if (Number.isSafeInteger(pss) && pss >= 0) return pss;
    rssFallbackPids.add(pid);
    return record?.rssKiB;
  };
  const roots = readServiceRoots(processes);
  const children = new Map();
  for (const record of processes.values()) {
    if (!children.has(record.parentPid)) children.set(record.parentPid, []);
    children.get(record.parentPid).push(record.pid);
  }
  const servicePids = processTreePids(roots, children);
  const serviceRssUpperBound = [...servicePids].reduce((sum, pid) => sum + processes.get(pid)?.rssKiB, 0);
  // The native budget supplies total - max(available, class floor). If even
  // summed RSS fits that envelope, exact PSS cannot constrain either available
  // memory or physical class capacity. Otherwise retain exact proportional
  // accounting. Admitted credits below always use PSS, never this upper bound.
  let serviceRssKiB = 0;
  if (Number.isSafeInteger(serviceMemoryCeilingKiB) && serviceMemoryCeilingKiB >= 0
    && Number.isSafeInteger(serviceRssUpperBound) && serviceRssUpperBound >= 0
    && serviceRssUpperBound <= serviceMemoryCeilingKiB) {
    serviceRssKiB = serviceRssUpperBound;
  } else {
    for (const pid of servicePids) serviceRssKiB += memoryKiB(pid);
  }
  const legacyOwners = readLegacyOwners(processes, admissionRoot, includeOwnerProgress);
  const ownerProgress = { sampledAtMs: nowMs, owners: [] };
  const admittedOwnerRecords = [];
  const admittedOwners = includeAdmittedRss || includeOwnerProgress
    ? readAdmittedOwnerRss(processes, admissionRoot, legacyOwners, children,
      includeOwnerProgress ? { sample: ownerProgress, previous: previousProgress } : null, memoryKiB, admittedOwnerRecords) : [];
  return {
    serviceRssKiB, servicePids: [...servicePids], legacyOwners,
    rssFallbackPids: [...rssFallbackPids],
    ...(includeAdmittedRss || includeOwnerProgress ? { admittedOwnerRecords } : {}),
    ...(includeAdmittedRss ? { admittedOwners } : {}),
    ...(includeOwnerProgress ? { ownerProgress } : {}),
  };
}

export function renderWorkerMemoryReservationRows(sample) {
  return `service ${sample.serviceRssKiB}\n` + sample.legacyOwners
    .map(owner => `legacy ${owner.pid} ${owner.token} ${owner.className}\n`).join('')
    + (sample.admittedOwners ?? []).map(owner => `admitted ${owner.pid} ${owner.token} ${owner.rssKiB}\n`).join('')
    + (sample.ownerProgress ? `progress ${JSON.stringify(sample.ownerProgress)}\nholder ${renderAdmissionOwnerProgress(sample.ownerProgress)}\n` : '');
}

export function renderAdmissionOwnerProgress(progress) {
  return progress.owners.map(owner => `${owner.className} owner pid ${owner.pid} (age=${owner.ageSeconds ?? 'unknown'}s, phase=${owner.phase ?? 'unknown'}, recent CPU=${owner.recentCpuPercent === null ? 'unknown' : '~' + owner.recentCpuPercent.toFixed(1) + '%'}, tree CPU=${owner.cpuSeconds ?? 'unknown'}s)`).join('; ');
}

function readNativeCallerServiceMemoryCeiling() {
  // Already-running native wrappers still call the old observer argv. Read
  // their actual class through the existing native policy, not a second table,
  // so they benefit immediately without restarting anybody else's operation.
  try {
    const caller = readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0');
    if (!caller.some(value => value.endsWith('/hstack-exec'))) return null;
    const className = caller.find(value => value.startsWith('--class='))?.slice('--class='.length);
    if (!className) return null;
    const policy = spawnSync('/bin/sh', ['-c', '. "$1"; heavyweight_memory_floor_kib "$2" local',
      'admission-memory-policy', fileURLToPath(new URL('../dev_targets/native_command_policy.sh', import.meta.url)), className], { encoding: 'utf8' });
    if (policy.error || policy.status !== 0) return null;
    const floor = Number(policy.stdout);
    const memory = readFileSync('/proc/meminfo', 'utf8');
    const total = Number(/^MemTotal:\s+(\d+)/m.exec(memory)?.[1]);
    const available = Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]);
    if (![floor, total, available].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
    return total - Math.max(available, floor);
  } catch { return null; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argument = process.argv.slice(2).find(value => value.startsWith('--admission-root='));
  const status = process.argv.includes('--admission-status');
  if (status && process.platform !== 'linux') {
    process.stdout.write(JSON.stringify({ state: 'unsupported', owners: [] }) + '\n');
  } else {
    const root = argument?.slice('--admission-root='.length) ?? spawnSync('/bin/sh', ['-c', '. "$1"; printf "%s" "$native_host_admission_root"',
      'admission-observation', fileURLToPath(new URL('./native_host_admission_state.sh', import.meta.url))], { encoding: 'utf8' }).stdout?.trim();
    const includeOwnerProgress = status || process.argv.includes('--include-owner-progress');
    const serviceCeiling = process.argv.slice(2).find(value => value.startsWith('--service-memory-ceiling-kib='));
    let previousProgress = null;
    if (includeOwnerProgress && !status) {
      try { previousProgress = JSON.parse(readFileSync(0, 'utf8')); } catch { /* First observation has no prior CPU sample. */ }
    }
    let sample = readWorkerMemoryReservations({
      admissionRoot: root,
      includeAdmittedRss: process.argv.includes('--include-admitted-rss'),
      includeOwnerProgress, previousProgress,
      serviceMemoryCeilingKiB: serviceCeiling ? Number(serviceCeiling.slice('--service-memory-ceiling-kib='.length)) : readNativeCallerServiceMemoryCeiling(),
    });
    if (status) {
      if (sample.ownerProgress.owners.length) {
        await new Promise(resolve => setTimeout(resolve, resolveHeavyweightPressureRetryMilliseconds()));
        sample = readWorkerMemoryReservations({ admissionRoot: root, includeOwnerProgress: true, previousProgress: sample.ownerProgress });
      }
      let disk;
      if (process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR) {
        try {
          const { inspectWorkerDiskBudget } = await import('../dev_targets/worker_disk_budget.mjs');
          disk = { state: 'observed', ...await inspectWorkerDiskBudget({ repoDir: process.cwd(), cacheBaseDir: process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR }) };
        } catch (error) { disk = { state: 'unavailable', error: error.message }; }
      }
      process.stdout.write(JSON.stringify({ state: 'observed', ...sample.ownerProgress, ...(disk ? { disk } : {}) }) + '\n');
    } else process.stdout.write(renderWorkerMemoryReservationRows(sample));
    if (sample.rssFallbackPids.length) process.stderr.write(`[preferred-execution] PSS unavailable; using RSS for accounted PIDs: ${sample.rssFallbackPids.join(',')}\n`);
  }
}
