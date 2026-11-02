import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** One account-visible OS snapshot, never a persisted PID registry. */
export function readLinuxWorkerProcesses({ readSmapsRollup = path => readFileSync(path, 'utf8') } = {}) {
  const processes = new Map();
  const metadata = spawnSync('ps', ['-u', String(process.getuid()), '-o', 'pid=,ppid=,rss=,etimes=,times=,stat='], { encoding: 'utf8' });
  if (metadata.error || metadata.status !== 0) throw new Error('worker process memory observation is unavailable');
  const generationPids = new Set();
  for (const line of metadata.stdout.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
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
    processes.set(pid, { pid, parentPid: Number(row[2]), rssKiB: Number(row[3]), ageSeconds: Number(row[4]), cpuSeconds: Number(row[5]), state: row[6][0], fingerprint: null, env,
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

export function readWorkerMemoryReservations({ readProcesses = readLinuxWorkerProcesses, serviceMemoryCeilingKiB = null } = {}) {
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
  // A caller-provided ceiling can prove summed RSS is sufficient. Otherwise
  // service diagnostics retain exact proportional accounting.
  let serviceRssKiB = 0;
  if (Number.isSafeInteger(serviceMemoryCeilingKiB) && serviceMemoryCeilingKiB >= 0
    && Number.isSafeInteger(serviceRssUpperBound) && serviceRssUpperBound >= 0
    && serviceRssUpperBound <= serviceMemoryCeilingKiB) {
    serviceRssKiB = serviceRssUpperBound;
  } else {
    for (const pid of servicePids) serviceRssKiB += memoryKiB(pid);
  }
  return { serviceRssKiB, servicePids: [...servicePids], rssFallbackPids: [...rssFallbackPids] };
}

export function renderWorkerMemoryReservationRows(sample) {
  return `service ${sample.serviceRssKiB}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--admission-status')) {
    if (process.platform !== 'linux') {
      process.stdout.write(JSON.stringify({ state: 'unsupported' }) + '\n');
    } else {
      const argument = process.argv.slice(2).find(value => value.startsWith('--admission-root='));
      const root = argument?.slice('--admission-root='.length) ?? spawnSync('/bin/sh', ['-c', '. "$1" && resolve_native_host_admission_root',
        'admission-observation', fileURLToPath(new URL('./native_host_admission_state.sh', import.meta.url))], { encoding: 'utf8' }).stdout?.trim();
      const { requestAdmissionSample } = await import('./admission_client.mjs');
      const sample = await requestAdmissionSample(root);
      let disk;
      if (process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR) {
        try {
          const { inspectWorkerDiskBudget } = await import('../dev_targets/worker_disk_budget.mjs');
          disk = { state: 'observed', ...await inspectWorkerDiskBudget({ repoDir: process.cwd(), cacheBaseDir: process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR }) };
        } catch (error) { disk = { state: 'unavailable', error: error.message }; }
      }
      process.stdout.write(JSON.stringify({ state: 'observed', ...sample, ...(disk ? { disk } : {}) }) + '\n');
    }
  } else {
    const sample = readWorkerMemoryReservations();
    process.stdout.write(renderWorkerMemoryReservationRows(sample));
    if (sample.rssFallbackPids.length) process.stderr.write(`[preferred-execution] PSS unavailable; using RSS for accounted PIDs: ${sample.rssFallbackPids.join(',')}\n`);
  }
}
