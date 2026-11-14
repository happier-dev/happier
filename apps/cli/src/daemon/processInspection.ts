import { readProcessCensus, type DaemonOwnershipEnvironment, type ProcessCensusRow } from '@/processes/census/processCensus';
import { censusRowToProcessFact } from '@/processes/census/processFacts';
import { isJavaScriptRuntimeExecutable } from '@/daemon/service/runtimeTarget';

export type DaemonOwnershipEnvironmentVariables = DaemonOwnershipEnvironment;

export type HappyProcessInfo = {
  pid: number;
  command: string;
  type: string;
  daemonOwnershipEnvironmentVariables?: DaemonOwnershipEnvironmentVariables;
};

type RawProcessInfo = {
  pid: number;
  name?: string;
  cmd?: string;
  daemonOwnershipEnvironmentVariables?: DaemonOwnershipEnvironmentVariables;
};

function projectDoctorProcessInfo(row: ProcessCensusRow): RawProcessInfo {
  const fact = censusRowToProcessFact(row);
  return {
    pid: row.pid,
    name: fact.name,
    cmd: fact.command,
    ...(row.ownershipEnvironment ? { daemonOwnershipEnvironmentVariables: row.ownershipEnvironment } : {}),
  };
}

function normalizeProcessName(name: string | undefined): string {
  const normalized = String(name ?? '').trim().replaceAll('\\', '/').toLowerCase();
  return normalized.split('/').pop() ?? normalized;
}

function isCliSourceSnapshotCommand(normalizedCommand: string): boolean {
  return /\/(?:cli-dist-snapshot|cli-dist|cli-source-snapshot-source-\d+-\d+-\d+)\/src\/index\.ts(?=["']?(?:\s|$))/u
    .test(normalizedCommand);
}

/**
 * Identify CLI roots for lifecycle safety and reattachment. This is not the
 * ownership classifier or the public process listing.
 */
export function classifyHappyProcess(proc: RawProcessInfo): HappyProcessInfo | null {
  const cmd = proc.cmd || '';
  const name = proc.name || '';
  const normalizedCommand = cmd.replaceAll('\\', '/');
  const normalizedName = normalizeProcessName(name);
  // Any JavaScript runtime that hosts the CLI bundle (Node, Bun, the packaged runtime): the one list
  // the daemon's runtime target owns. A census may report Node's main thread name instead.
  const isNodeHostProcess = isJavaScriptRuntimeExecutable(normalizedName) || normalizedName === 'mainthread';
  const isCliSourceSnapshot = isCliSourceSnapshotCommand(normalizedCommand);
  // The canonical source registration imports tsx internally, so its name need
  // not appear in argv. Recognize the CLI entrypoint for both source and builds.
  const isWorkspaceCli = /\/apps\/cli\/src\/index\.(?:mjs|ts)(?=["']?(?:\s|$))/u.test(normalizedCommand);

  // NOTE: Be intentionally strict here. This classification is used for PID reuse safety
  // (reattach + stopSession). A false positive could cause us to adopt/kill a non-Happy process.
  const isHappy =
    (isNodeHostProcess &&
      (normalizedCommand.includes('@happier-dev/cli') ||
        normalizedCommand.includes('dist/index.mjs') ||
        normalizedCommand.includes('package-dist/index.mjs') ||
        normalizedCommand.includes('bin/happier.mjs') ||
        isWorkspaceCli ||
        // Some runtime handoff paths execute snapshot `src/index.ts` directly under `node`
        // (without the tsx import hook), so keep this as a first-class Happy process shape.
        isCliSourceSnapshot ||
        (normalizedCommand.includes('tsx') &&
          normalizedCommand.includes('src/index.ts') &&
          (normalizedCommand.includes('apps/cli') ||
            normalizedCommand.includes('@happier-dev/cli') ||
            isCliSourceSnapshot)))) ||
    normalizedCommand.includes('happier.mjs') ||
    normalizedCommand.includes('@happier-dev/cli') ||
    normalizedCommand.includes('package-dist/index.mjs') ||
    normalizedName === 'happier' ||
    normalizedName === 'happier.exe';

  if (!isHappy) return null;

  // Classify process type
  let type = 'unknown';
  if (proc.pid === process.pid) {
    type = 'current';
  } else if (cmd.includes('--version')) {
    type = cmd.includes('tsx') ? 'dev-daemon-version-check' : 'daemon-version-check';
  } else if (cmd.includes('daemon start-sync') || cmd.includes('daemon start')) {
    type = cmd.includes('tsx') ? 'dev-daemon' : 'daemon';
  } else if (cmd.includes('--started-by daemon')) {
    type = cmd.includes('tsx') ? 'dev-daemon-spawned' : 'daemon-spawned-session';
  } else if (cmd.includes('doctor')) {
    type = cmd.includes('tsx') ? 'dev-doctor' : 'doctor';
  } else {
    type = cmd.includes('tsx') ? 'dev-session' : 'user-session';
  }

  return {
    pid: proc.pid,
    command: cmd || name,
    type,
    ...(proc.daemonOwnershipEnvironmentVariables
      ? { daemonOwnershipEnvironmentVariables: proc.daemonOwnershipEnvironmentVariables }
      : {}),
  };
}

export async function findAllHappyProcesses(): Promise<HappyProcessInfo[]> {
  const snapshot = await readProcessCensus({ freshness: 'shared', fields: ['argv', 'ownershipEnvironment'] });
  if (snapshot.status !== 'ok') return [];
  return snapshot.rows.flatMap(row => {
    const classified = classifyHappyProcess(projectDoctorProcessInfo(row));
    return classified ? [classified] : [];
  });
}

export type ProcessByPidClassification =
  | Readonly<{ kind: 'happy'; process: HappyProcessInfo }>
  | Readonly<{ kind: 'not_happy' }>
  | Readonly<{ kind: 'unknown' }>;

export type DaemonLifecycleProcessByPidClassification =
  | Readonly<{ kind: 'daemon'; process: HappyProcessInfo }>
  | Readonly<{ kind: 'not_daemon' }>
  | Readonly<{ kind: 'unknown' }>;

export async function classifyProcessByPid(pid: number): Promise<ProcessByPidClassification> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: 'unknown' };
  const snapshot = await readProcessCensus({ freshness: 'fresh', pids: [pid], fields: ['argv', 'ownershipEnvironment'] });
  if (snapshot.status !== 'ok') return { kind: 'unknown' };
  const row = snapshot.rows.find(process => process.pid === pid);
  // Missing command/principal evidence cannot prove an unrelated process for lifecycle replacement.
  if (!row || row.principal === null) return { kind: 'unknown' };
  const processInfo = projectDoctorProcessInfo(row);
  if (!processInfo.cmd) return { kind: 'unknown' };
  const happy = classifyHappyProcess(processInfo);
  return happy ? { kind: 'happy', process: happy } : { kind: 'not_happy' };
}

export async function findHappyProcessByPid(pid: number): Promise<HappyProcessInfo | null> {
  const classified = await classifyProcessByPid(pid);
  return classified.kind === 'happy' ? classified.process : null;
}

/**
 * Classify whether a PID can own the daemon lifecycle without collapsing a verified unrelated
 * process into the same result as an unreadable process. Lifecycle callers may replace the former
 * while preserving fail-closed behavior for the latter.
 */
export async function classifyDaemonLifecycleProcessByPid(
  pid: number,
): Promise<DaemonLifecycleProcessByPidClassification> {
  const classified = await classifyProcessByPid(pid);
  if (classified.kind === 'unknown') return classified;
  if (classified.kind === 'not_happy') return { kind: 'not_daemon' };
  return classified.process.type === 'daemon' || classified.process.type === 'dev-daemon'
    ? { kind: 'daemon', process: classified.process }
    : { kind: 'not_daemon' };
}
