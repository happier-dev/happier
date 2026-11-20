import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseLinuxProcStartTime } from '../../../../packages/cli-common/processInstance.mjs';
import os from 'node:os';
import { processSnapshot } from './host-snapshot.mjs';

const exec = promisify(execFile);
const docker = async args => (await exec('docker', args, { encoding: 'utf8' })).stdout;

const readProc = (path) => readFile(path, 'utf8').catch(() => '');
const kib = (text, name) => {
  const match = text.match(new RegExp('^' + name + ':\\s+(\\d+) kB$', 'm'));
  return match ? Number(match[1]) * 1024 : null;
};
const sum = (values) => values.every(Number.isFinite) ? values.reduce((total, value) => total + value, 0) : null;

async function readProcessFootprint(pid) {
  const root = '/proc/' + pid;
  const stat = await readProc(root + '/stat');
  const start = parseLinuxProcStartTime(stat);
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  if (!start || ['Z', 'X'].includes(fields[0])) return null;
  // proc_pid_stat fields 14 and 15 are process-wide user and system ticks.
  const cpuTicks = sum([Number(fields[11]), Number(fields[12])]);
  const [status, smaps, tids] = await Promise.all([
    readProc(root + '/status'), readProc(root + '/smaps_rollup'), readdir(root + '/task').catch(() => []),
  ]);
  const switches = new Map(await Promise.all(tids.map(async tid => {
    const thread = root + '/task/' + tid;
    const [stat, status] = await Promise.all([readProc(thread + '/stat'), readProc(thread + '/status')]);
    const start = parseLinuxProcStartTime(stat);
    const count = status.match(/^voluntary_ctxt_switches:\s+(\d+)$/m);
    return [tid + ':' + start, start && count ? Number(count[1]) : null];
  })));
  if (parseLinuxProcStartTime(await readProc(root + '/stat')) !== start) return null;
  return { start, cpuTicks, switches, rssBytes: kib(smaps, 'Rss') ?? kib(status, 'VmRSS'),
    pssBytes: kib(smaps, 'Pss'), ussBytes: sum([kib(smaps, 'Private_Clean'), kib(smaps, 'Private_Dirty'), kib(smaps, 'Private_Hugetlb') ?? 0]) };
}

/** Observe only exact PIDs supplied by the existing test topology and runner owner. */
export async function createLinuxFootprintReader() {
  if (process.platform !== 'linux') return null;
  const clockTicks = await exec('getconf', ['CLK_TCK']).then(({ stdout }) => Number(stdout.trim()), () => 0);
  if (!Number.isSafeInteger(clockTicks) || clockTicks <= 0) return null;
  return async (roles, during, { rates = false } = {}) => {
    const snapshot = async () => {
      const rolePids = Object.fromEntries(await Promise.all(Object.entries(roles).map(async ([role, pids]) =>
        [role, typeof pids === 'function' ? await pids() : pids])));
      const pids = [...new Set(Object.values(rolePids).flat().filter(pid => Number.isSafeInteger(pid) && pid > 1))];
      const processes = new Map(await Promise.all(pids.map(async pid => [pid, await readProcessFootprint(pid)])));
      return { rolePids, processes };
    };
    const before = await snapshot();
    const startedAt = performance.now();
    await during();
    const elapsedMs = performance.now() - startedAt;
    const after = await snapshot();
    return Object.fromEntries(Object.entries(before.rolePids).map(([role, pids]) => {
      const endPids = new Set(after.rolePids[role]);
      const processes = pids?.map(pid => [before.processes.get(pid), after.processes.get(pid)]);
      if (!processes?.length || new Set(pids).size !== pids.length || endPids.size !== pids.length
        || pids.some(pid => !endPids.has(pid))
        || processes.some(([first, last]) => !first || !last || first.start !== last.start)) return [role, null];
      const cpuMs = sum(processes.map(([first, last]) =>
        first.cpuTicks !== null && last.cpuTicks !== null && last.cpuTicks >= first.cpuTicks ? (last.cpuTicks - first.cpuTicks) * 1_000 / clockTicks : null));
      const switches = sum(processes.map(([first, last]) =>
        first.switches.size && first.switches.size === last.switches.size
          ? sum([...first.switches].map(([key, count]) => {
            const end = last.switches.get(key);
            return Number.isFinite(count) && Number.isFinite(end) && end >= count ? end - count : null;
          })) : null));
      return [role, { rssBytes: sum(processes.map(([, row]) => row.rssBytes)),
        pssBytes: sum(processes.map(([, row]) => row.pssBytes)), ussBytes: sum(processes.map(([, row]) => row.ussBytes)),
        heapUsedBytes: null, cpuMs: rates ? null : cpuMs,
        cpuMsPerMinute: rates && cpuMs !== null ? Math.round(cpuMs * 60_000 / elapsedMs) : null,
        voluntarySwitchesPerMinute: rates && switches !== null ? Math.round(switches * 60_000 / elapsedMs) : null }];
    }));
  };
}

async function localHolderPids(runnerPid) {
  const root = '/proc/' + runnerPid + '/task';
  const tids = await readdir(root).catch(() => []);
  const children = new Set((await Promise.all(tids.map(tid => readProc(root + '/' + tid + '/children'))))
    .flatMap(text => text.trim().split(/\s+/)).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1));
  return (await Promise.all([...children].map(async pid => {
    const executable = await readlink('/proc/' + pid + '/exe').catch(() => '');
    return /^happier-session-holder(?:\.[\w-]+)?$/.test(basename(executable)) ? pid : null;
  }))).filter(Boolean);
}

const settledMs = 15_000;
const idleWindowMs = 15_000;
const baseRoles = ['api', 'worker', 'daemon', 'runner', 'holder', 'ui'];
const phaseNames = ['idle0', 'idle1', 'idle3', 'active3', 'marginal1To3'];
const unavailableRoles = () => Object.fromEntries(baseRoles.map(role => [role, null]));

/** Adapter to the existing stress target. This observer never starts or stops services. */
export async function createStressHostObserver({ context, inspect, sqlStatements, wait = sleep }) {
  if (!/^happier-stress-[a-zA-Z0-9-]+$/.test(context.composeProjectName) || !context.containers.length) {
    throw new Error('Stress observation requires an owned compose topology');
  }
  const inspectContainers = inspect ?? (async () => {
    const format = '{"Id":{{json .Id}},"Image":{{json .Image}},"Config":{"Labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}}}},"State":{"Running":{{json .State.Running}},"Pid":{{json .State.Pid}}}}';
    const result = await docker(['inspect', '--format', format, ...context.containers.map(container => container.id)]);
    return result.trim().split('\n').map(line => JSON.parse(line));
  });
  let closed = false;
  const readOwnedContainers = async () => {
    if (closed) throw new Error('Stress observer already closed');
    const loaded = await inspectContainers();
    if (loaded.length !== context.containers.length || loaded.some((container, index) =>
      container.Id !== context.containers[index].id || container.Config?.Labels?.['com.docker.compose.project'] !== context.composeProjectName || container.State?.Running !== true)) {
      throw new Error('Stress container ownership or running identity changed');
    }
    if (loaded.some((container, index) => !container.Image || context.containers[index].image !== container.Image)) {
      throw new Error('Selected stress image identity differs from the loaded image');
    }
    return loaded;
  };
  const readStatements = sqlStatements ?? (async () => {
    const value = await docker(['exec', context.postgresContainerId, 'psql', '-U', 'stress', '-d', 'stressdb', '-v', 'ON_ERROR_STOP=1', '-At', '-c',
      "SELECT json_build_object('calls', (SELECT COALESCE(sum(calls),0) FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())), 'statsReset', stats_reset, 'dealloc', dealloc) FROM pg_stat_statements_info"]);
    const result = JSON.parse(value.trim());
    if (!Number.isSafeInteger(Number(result.calls)) || Number(result.calls) < 0) throw new Error('Physical SQL statement counter unavailable');
    return { calls: Number(result.calls), statsReset: result.statsReset, dealloc: Number(result.dealloc) };
  });
  const sample = async () => {
    const loaded = await readOwnedContainers();
    let sql;
    try {
      const statements = await readStatements();
      sql = typeof statements === 'number' ? { calls: statements, statsReset: null, dealloc: null } : statements;
    } catch {
      // SQL is informational. Keep observation/identity failures fatal, but
      // never substitute zero or expose a database diagnostic for this sensor.
      sql = { calls: null, statsReset: null, dealloc: null };
    }
    const serverIdentity = loaded.map(container => container.Image).join(',');
    const selected = context.containers.map(container => container.image).join(',');
    const daemon = context.daemonPid ? processSnapshot(context.daemonPid) : null;
    if (context.daemonPid && !daemon) throw new Error('Owned performance daemon exited');
    return {
      atMs: Date.now(), host: os.hostname(), platform: process.platform, arch: process.arch,
      cpus: os.cpus().length, load: os.loadavg(), freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem(),
      identity: { mode: 'stress', sourceUi: 'export', uiDir: context.uiDir,
        composeProjectName: context.composeProjectName,
        roles: { server: { selected, loaded: serverIdentity },
          ...(daemon ? { daemon: { selected: String(context.daemonPid), loaded: String(daemon.pid) } } : {}) } },
      server: { containerIds: loaded.map(container => container.Id), cpuSeconds: null, rssBytes: null }, daemon,
      sqlStatements: sql.calls, sqlStatistics: sql.calls === null ? null : { statsReset: sql.statsReset, dealloc: sql.dealloc },
      logs: { files: [], records: [] },
      unavailable: ['Container CPU/RSS and request diagnostic spans are not collected by this adapter',
        ...(sql.calls === null ? ['Physical SQL statement counter unavailable'] : []),
        ...(daemon ? [] : ['No daemon was started for this journey'])],
    };
  };
  const captureFootprint = async ({ fixture, startSession, runTurn, readServerHeap, readUiPids, signal }) => {
    const measure = await createLinuxFootprintReader();
    const phases = Object.fromEntries(phaseNames.map(phase => [phase, unavailableRoles()]));
    const cpus = os.cpus();
    const footprint = { workload: measure ? JSON.stringify(['full-compose-fake-claude-v2', fixture, process.platform,
      process.arch, process.versions.node, cpus.length, cpus[0]?.model, settledMs, idleWindowMs]) : null, phases, completedTurns: {} };
    if (!measure) return footprint;

    const pause = (ms) => wait(ms, undefined, { signal });
    const sessions = [];
    const readRoles = async () => {
      const loaded = await readOwnedContainers();
      const entries = await Promise.all(loaded.map(async ({ Id, State }, index) => {
        const pid = State.Pid;
        // Docker's PID is local only if this procfs can attest its container.
        const cgroup = Number.isSafeInteger(pid) && pid > 1 ? await readProc('/proc/' + pid + '/cgroup') : '';
        return [context.containers[index].service, cgroup.includes(Id) ? pid : null];
      }));
      const sessionCountsByRunner = new Map();
      for (const { runnerPid } of sessions) {
        sessionCountsByRunner.set(runnerPid, (sessionCountsByRunner.get(runnerPid) ?? 0) + 1);
      }
      // A Linux host can run several Sessions. Read it once and require one
      // local holder per Session on that host before attributing holder costs.
      const holdersByRunner = await Promise.all([...sessionCountsByRunner].map(async ([runnerPid, count]) => {
        const pids = await localHolderPids(runnerPid);
        return pids.length === count ? pids : [null];
      }));
      const roles = { api: [], worker: [], daemon: [context.daemonPid],
        runner: [...sessionCountsByRunner.keys()], holder: holdersByRunner.flat(), ui: readUiPids ?? [] };
      for (const [role, pid] of entries) roles[role].push(pid);
      return roles;
    };
    const idle = async (name) => {
      await pause(settledMs);
      const roles = await readRoles();
      const values = await measure(roles, () => pause(idleWindowMs), { rates: true });
      for (const role of ['api', 'worker']) {
        if (values[role]) values[role].heapUsedBytes = await readServerHeap(role).catch(() => null);
      }
      phases[name] = values;
    };

    try {
      await idle('idle0');
      for (let count = 1; count <= 3; count++) {
        signal.throwIfAborted();
        sessions.push(await startSession());
        await runTurn(sessions.at(-1), 1);
        if (count === 1) await idle('idle1');
      }
      await idle('idle3');
      phases.active3 = await measure(await readRoles(), async () => {
        const completed = await Promise.allSettled(sessions.map(session => runTurn(session, 2)));
        footprint.completedTurns.active3 = completed.filter(result => result.status === 'fulfilled').length;
        if (footprint.completedTurns.active3 !== sessions.length) throw new Error('Footprint turns incomplete');
      });
      phases.marginal1To3 = Object.fromEntries(baseRoles.map(role => {
        const a = phases.idle1[role], b = phases.idle3[role];
        return [role, a && b ? Object.fromEntries(Object.keys(a).map(metric => [metric,
          Number.isFinite(a[metric]) && Number.isFinite(b[metric]) ? (b[metric] - a[metric]) / 2 : null])) : null];
      }));
    } catch {
      signal.throwIfAborted();
      // Keep completed absolutes. A partially executed workload must not pair.
      footprint.workload = null;
    }
    return footprint;
  };
  const initial = await sample();
  return { readiness: { initial }, records: [], sample, captureFootprint,
    stop: async () => { closed = true; return { status: 'CLOSED', terminal: { atMs: Date.now() } }; } };
}
