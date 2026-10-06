import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { expandHome } from '../paths/canonical_home.mjs';
import { resolveStackBaseDir } from '../paths/paths.mjs';

const SERVICE_PROCESS_KEYS = [
  'serverPid', 'serverWrapperPid', 'proxyPid', 'serverBackendPid', 'serverDrainingPid', 'expoPid',
];
const OBSERVED_ENVIRONMENT_KEYS = new Set([
  'HOME', 'HAPPIER_STACK_STACK', 'HAPPIER_STACK_ENV_FILE', 'HAPPIER_STACK_STORAGE_DIR',
  'HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT', 'HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN',
]);

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
export function readLinuxWorkerProcesses() {
  const processes = new Map();
  const metadata = spawnSync('ps', ['-e', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (metadata.error || metadata.status !== 0) throw new Error('worker process memory observation is unavailable');
  const generationPids = new Set();
  for (const line of metadata.stdout.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
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
    processes.set(pid, { pid, parentPid: Number(row[2]), rssKiB: Number(row[3]), fingerprint: null, env });
  }
  // Check generations only for actual positive bindings, not every unrelated
  // descendant or host process. Service roots below may be untagged listeners.
  for (const pid of generationPids) {
    const current = processes.get(pid);
    if (current) current.fingerprint = readProcessInstanceFingerprintSync(pid);
  }
  return processes;
}

function readServiceRoots(processes) {
  const scopes = new Map();
  for (const { env } of processes.values()) {
    const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim();
    const envFile = expandHome(env.HAPPIER_STACK_ENV_FILE ?? '', env);
    if (!stackName || !isAbsolute(envFile)) continue;
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
    current.fingerprint ??= readProcessInstanceFingerprintSync(pid);
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
  return roots;
}

function readLegacyOwners(processes, admissionRoot) {
  const owners = new Map();
  const currentRoot = canonicalPath(admissionRoot);
  for (const { env } of processes.values()) {
    const root = String(env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT ?? '');
    const token = /^(\d+):(\d+)$/.exec(String(env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN ?? ''));
    if (!isAbsolute(root) || !token || canonicalPath(root) === currentRoot) continue;
    const pid = Number(token[1]);
    const start = token[2];
    const identity = `${pid}:${start}`;
    if (owners.has(identity) || processes.get(pid)?.fingerprint !== `linux-proc:${start}`) continue;
    try {
      const ownerPath = join(root, 'owners', `${pid}-${start}`);
      const recorded = readFileSync(join(ownerPath, 'process'), 'utf8').trim();
      const className = readFileSync(join(ownerPath, 'class'), 'utf8').trim();
      if (recorded !== `${pid} ${start}` || !/^[a-z][a-z-]*$/.test(className)) continue;
      owners.set(identity, { pid, token: start, className });
    } catch {
      // An inherited token alone is not an admitted owner.
    }
  }
  return [...owners.values()];
}

export function readWorkerMemoryReservations({ admissionRoot, readProcesses = readLinuxWorkerProcesses }) {
  if (!admissionRoot) throw new Error('canonical host admission root is required');
  const processes = readProcesses();
  const roots = readServiceRoots(processes);
  const children = new Map();
  for (const record of processes.values()) {
    if (!children.has(record.parentPid)) children.set(record.parentPid, []);
    children.get(record.parentPid).push(record.pid);
  }
  const servicePids = new Set();
  const pending = [...roots];
  for (let index = 0; index < pending.length; index += 1) {
    const pid = pending[index];
    if (servicePids.has(pid)) continue;
    servicePids.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  let serviceRssKiB = 0;
  for (const pid of servicePids) serviceRssKiB += processes.get(pid).rssKiB;
  return { serviceRssKiB, servicePids: [...servicePids], legacyOwners: readLegacyOwners(processes, admissionRoot) };
}

export function renderWorkerMemoryReservationRows(sample) {
  return `service ${sample.serviceRssKiB}\n` + sample.legacyOwners
    .map(owner => `legacy ${owner.pid} ${owner.token} ${owner.className}\n`).join('');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argument = process.argv.slice(2).find(value => value.startsWith('--admission-root='));
  const sample = readWorkerMemoryReservations({ admissionRoot: argument?.slice('--admission-root='.length) });
  process.stdout.write(renderWorkerMemoryReservationRows(sample));
}
