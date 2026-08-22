import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { repoRootDir } from '../paths';
import {
  inspectOwnedProcess,
  registerProcessOwnershipLease,
  resolveProcessOwnershipLeasesDir,
  sweepProcessOwnershipLeases,
} from '../process/processOwnershipLease';
import { redactHarnessLogText } from '../process/harnessLogRedaction';
import { spawnLoggedProcess, type SpawnedProcess } from '../process/spawnProcess';
import {
  resolveCliTestLaunchSpec,
  resolveCliTestLaunchSpecOrOverride,
  shouldUseCliSourceEntrypoint,
  type CliTestLaunchSpec,
} from '../process/cliLaunchSpec';
import { terminateProcessTreeByPid } from '../process/processTree';
import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { sanitizeDaemonSpawnEnv } from '@happier-dev/cli-common/process';

export type DaemonState = {
  pid: number;
  httpPort: number;
  controlToken?: string;
  startTime?: string;
  startedWithCliVersion?: string;
  lastHeartbeat?: string;
  daemonLogPath?: string;
};

export function daemonStatePath(happyHomeDir: string): string {
  return join(happyHomeDir, 'daemon.state.json');
}

function isDaemonStateBasename(name: string): boolean {
  return /^daemon(?:\.[a-z0-9_-]+)?\.state\.json$/i.test(name);
}

function daemonStateCandidatePriority(path: string): number {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.endsWith('/daemon.state.json')) return 0;
  return 1;
}

async function listDaemonStateCandidatesInDir(dir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!isDaemonStateBasename(entry.name)) continue;
      const candidatePath = join(dir, entry.name);
      try {
        const s = await stat(candidatePath);
        candidates.push({ path: candidatePath, mtimeMs: s.mtimeMs });
      } catch {
        // ignore missing / unreadable
      }
    }
    candidates.sort((a, b) => {
      const priorityDelta = daemonStateCandidatePriority(a.path) - daemonStateCandidatePriority(b.path);
      if (priorityDelta !== 0) return priorityDelta;
      return b.mtimeMs - a.mtimeMs;
    });
    return candidates;
  } catch {
    return [];
  }
}

function isPreparedPerTestCliSnapshot(snapshotDir: string): boolean {
  const distSnapshotReady = existsSync(resolve(snapshotDir, '.cli-dist-snapshot.ready.json'))
    && existsSync(resolve(snapshotDir, 'dist', 'index.mjs'));
  if (distSnapshotReady) return true;

  // Source-entrypoint mode does not write the dist snapshot marker.
  const sourceSnapshotReady = existsSync(resolve(snapshotDir, 'src', 'index.ts'))
    && existsSync(resolve(snapshotDir, 'tsconfig.json'));
  return sourceSnapshotReady;
}

function resolveDaemonCliSnapshotDir(params: { testDir: string }): string {
  const raw = (process.env.HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE ?? '').toString().trim().toLowerCase();
  const perTestSnapshotDir = resolve(params.testDir, 'cli-dist');
  if (raw === 'testdir' || raw === 'per-test' || raw === 'per_test' || raw === 'pertest') {
    return perTestSnapshotDir;
  }

  // Default to a shared snapshot to avoid paying the node_modules snapshot cost per test (which can
  // otherwise consume most of the core slow E2E timeout budget).
  if (isPreparedPerTestCliSnapshot(perTestSnapshotDir)) {
    return perTestSnapshotDir;
  }
  return resolve(repoRootDir(), '.project', 'tmp', 'cli-dist-snapshot');
}

function resolveDaemonLaunchSnapshotDir(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
  snapshotDir?: string;
}): string {
  if (params.snapshotDir) {
    return params.snapshotDir;
  }

  const raw = (process.env.HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE ?? '').toString().trim().toLowerCase();
  const perTestSnapshotMode = raw === 'testdir' || raw === 'per-test' || raw === 'per_test' || raw === 'pertest';
  if (perTestSnapshotMode && shouldUseCliSourceEntrypoint(params.env)) {
    const perTestSnapshotDir = resolve(params.testDir, 'cli-dist');
    if (params.env.HAPPIER_E2E_LOGS_DIR?.trim()) {
      return perTestSnapshotDir;
    }
    const sharedSnapshotDir = resolve(repoRootDir(), '.project', 'tmp', 'cli-dist-snapshot');
    if (!isPreparedPerTestCliSnapshot(perTestSnapshotDir) && isPreparedPerTestCliSnapshot(sharedSnapshotDir)) {
      return sharedSnapshotDir;
    }
    return perTestSnapshotDir;
  }

  if (shouldUseCliSourceEntrypoint(params.env)) {
    return resolve(repoRootDir(), '.project', 'tmp', 'cli-source-snapshot');
  }

  return resolveDaemonCliSnapshotDir({ testDir: params.testDir });
}

async function resolveActiveServerIdFromSettings(happyHomeDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(happyHomeDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { schemaVersion?: number; activeServerId?: unknown } | null;
    if (!parsed || typeof parsed.schemaVersion !== 'number') return null;
    if (parsed.schemaVersion < 5) return null;
    if (typeof parsed.activeServerId !== 'string' || !parsed.activeServerId) return null;
    return parsed.activeServerId;
  } catch {
    return null;
  }
}

async function listPreferredDaemonStateCandidates(
  happyHomeDir: string,
  activeServerId: string | null,
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  if (activeServerId) {
    candidates.push(...await listDaemonStateCandidatesInDir(join(happyHomeDir, 'servers', activeServerId)));
  }
  candidates.push(...await listDaemonStateCandidatesInDir(happyHomeDir));
  return candidates;
}

async function readDaemonStateFromPath(path: string): Promise<DaemonState | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonState>;
    if (!parsed || typeof parsed.pid !== 'number' || typeof parsed.httpPort !== 'number') return null;
    return parsed as DaemonState;
  } catch {
    return null;
  }
}

async function listServerDaemonStateCandidates(happyHomeDir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const serversDir = join(happyHomeDir, 'servers');
  try {
    const entries = await readdir(serversDir, { withFileTypes: true });
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      candidates.push(...await listDaemonStateCandidatesInDir(join(serversDir, entry.name)));
    }
    return candidates;
  } catch {
    return [];
  }
}

type DaemonStateCandidate = Readonly<{
  path: string;
  mtimeMs: number;
  state: DaemonState;
}>;

function compareDaemonStateCandidates(a: DaemonStateCandidate, b: DaemonStateCandidate): number {
  const aHealthy = a.state.httpPort > 0 && a.state.pid > 0;
  const bHealthy = b.state.httpPort > 0 && b.state.pid > 0;
  if (aHealthy !== bHealthy) return aHealthy ? -1 : 1;

  const priorityDelta = daemonStateCandidatePriority(a.path) - daemonStateCandidatePriority(b.path);
  if (priorityDelta !== 0) return priorityDelta;

  return b.mtimeMs - a.mtimeMs;
}

export async function readDaemonState(happyHomeDir: string): Promise<DaemonState | null> {
  const activeServerId = await resolveActiveServerIdFromSettings(happyHomeDir);
  const preferredCandidates = await listPreferredDaemonStateCandidates(happyHomeDir, activeServerId);
  const preferredCandidatePaths = new Set(preferredCandidates.map((candidate) => candidate.path));
  const allCandidates = [
    ...preferredCandidates,
    ...(await listServerDaemonStateCandidates(happyHomeDir)).filter((candidate) => !preferredCandidatePaths.has(candidate.path)),
  ];

  const parsedCandidates: DaemonStateCandidate[] = [];
  for (const candidate of allCandidates) {
    const state = await readDaemonStateFromPath(candidate.path);
    if (!state) continue;
    parsedCandidates.push({
      path: candidate.path,
      mtimeMs: candidate.mtimeMs,
      state,
    });
  }

  if (parsedCandidates.length === 0) return null;
  parsedCandidates.sort(compareDaemonStateCandidates);
  return parsedCandidates[0]?.state ?? null;
}

type DaemonStatePresenceObservation = Readonly<{
  exists: boolean;
  candidateCount: number;
  firstCandidatePath: string | null;
}>;

type DaemonStatePresenceTracker = {
  everWritten: boolean;
  everRemoved: boolean;
  lastExists: boolean | null;
  lastCandidateCount: number;
  lastCandidatePath: string | null;
};

function createDaemonStatePresenceTracker(): DaemonStatePresenceTracker {
  return {
    everWritten: false,
    everRemoved: false,
    lastExists: null,
    lastCandidateCount: 0,
    lastCandidatePath: null,
  };
}

async function listObservableDaemonStateCandidates(happyHomeDir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const activeServerId = await resolveActiveServerIdFromSettings(happyHomeDir);
  const preferredCandidates = await listPreferredDaemonStateCandidates(happyHomeDir, activeServerId);
  const seen = new Set(preferredCandidates.map((candidate) => candidate.path));
  const serverCandidates = (await listServerDaemonStateCandidates(happyHomeDir))
    .filter((candidate) => !seen.has(candidate.path));
  return [...preferredCandidates, ...serverCandidates];
}

async function observeDaemonStatePresence(happyHomeDir: string): Promise<DaemonStatePresenceObservation> {
  const candidates = await listObservableDaemonStateCandidates(happyHomeDir);
  return {
    exists: candidates.length > 0,
    candidateCount: candidates.length,
    firstCandidatePath: candidates[0]?.path ?? null,
  };
}

function recordDaemonStatePresence(
  tracker: DaemonStatePresenceTracker | undefined,
  observation: DaemonStatePresenceObservation,
): void {
  if (!tracker) return;
  if (observation.exists) {
    tracker.everWritten = true;
    tracker.lastCandidatePath = observation.firstCandidatePath;
  } else if (tracker.lastExists === true) {
    tracker.everRemoved = true;
  }
  tracker.lastExists = observation.exists;
  tracker.lastCandidateCount = observation.candidateCount;
}

export async function waitForDaemonState(
  happyHomeDir: string,
  opts?: { timeoutMs?: number; statePresence?: DaemonStatePresenceTracker },
): Promise<DaemonState> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    recordDaemonStatePresence(opts?.statePresence, await observeDaemonStatePresence(happyHomeDir));
    const state = await readDaemonState(happyHomeDir);
    if (state && state.httpPort > 0 && state.pid > 0) return state;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for daemon.state.json in ${happyHomeDir}`);
}

type ProcessInspectionResult =
  | { ok: true; command: string; looksLikeDaemon: boolean }
  | { ok: false; reason: 'ps_missing' | 'inspect_failed' };

function looksLikeDaemonCommand(command: string): boolean {
  const normalized = command.replaceAll('\\', '/');
  const hasStartSync = normalized.includes('daemon start-sync');
  const hasCliDistEntrypoint =
    normalized.includes('apps/cli/dist/index.mjs') ||
    normalized.includes('apps/cli/dist/index.js') ||
    (normalized.includes('apps/cli') && normalized.includes('dist/index.mjs')) ||
    (normalized.includes('apps/cli') && normalized.includes('dist/index.js')) ||
    normalized.includes('dist/index.mjs') ||
    normalized.includes('dist/index.js') ||
    normalized.includes('happier') && normalized.includes('daemon start-sync') && normalized.includes('dist/index');
  const hasCliSourceSnapshotEntrypoint =
    normalized.includes('tsx') &&
    normalized.includes('src/index.ts') &&
    (
      normalized.includes('apps/cli') ||
      normalized.includes('@happier-dev/cli') ||
      normalized.includes('/cli-dist-snapshot/src/index.ts') ||
      normalized.includes('/cli-dist/src/index.ts') ||
      (
        (normalized.includes('/.project/logs/e2e/') || normalized.includes('/.project/tmp/')) &&
        /\/cli-[^/\s]+\/src\/index\.ts(?:\s|$)/.test(normalized)
      )
    );
  return hasStartSync && (hasCliDistEntrypoint || hasCliSourceSnapshotEntrypoint);
}

function looksLikeTestDaemonLeaseCommand(command: string): boolean {
  return command.replaceAll('\\', '/').includes('daemon start-sync');
}

function inspectProcess(pid: number): ProcessInspectionResult {
  try {
    // Use wide output to avoid truncating long monorepo entrypoint paths. Truncation can cause
    // false negatives (and then we refuse to hard-kill a leaked daemon).
    let res = spawnSync('ps', ['-o', 'command=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (res.status !== 0) {
      res = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    }
    if (res.status !== 0) return { ok: false, reason: 'inspect_failed' };
    const command = String(res.stdout || '').trim();
    if (!command) return { ok: false, reason: 'inspect_failed' };
    return {
      ok: true,
      command,
      looksLikeDaemon: looksLikeDaemonCommand(command),
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return { ok: false, reason: 'ps_missing' };
    return { ok: false, reason: 'inspect_failed' };
  }
}

type DaemonSessionMarkerCandidate = Readonly<{
  pid: number;
  markerPath: string;
  startedBy: string;
  processCommandHash: string;
}>;

function daemonSessionMarkersDir(happyHomeDir: string): string {
  return join(happyHomeDir, 'tmp', 'daemon-sessions');
}

function hashCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

function inspectProcessCommand(pid: number): string | null {
  try {
    // Use wide output to avoid truncation (PID reuse safety requires stable hashing).
    // Match the daemon's own marker hashing strategy (`ps-list` captures `args`).
    let res = spawnSync('ps', ['-o', 'args=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (res.status !== 0) {
      res = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    }
    if (res.status !== 0) return null;
    const command = String(res.stdout || '').trim();
    return command || null;
  } catch {
    return null;
  }
}

async function listDaemonSessionMarkerCandidates(happyHomeDir: string): Promise<DaemonSessionMarkerCandidate[]> {
  const dir = daemonSessionMarkersDir(happyHomeDir);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const candidates: DaemonSessionMarkerCandidate[] = [];
  for (const name of entries) {
    if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
    const markerPath = join(dir, name);
    try {
      const raw = await readFile(markerPath, 'utf8');
      const parsed = JSON.parse(raw) as any;
      const pid = typeof parsed?.pid === 'number' ? parsed.pid : Number(parsed?.pid);
      const startedBy = typeof parsed?.startedBy === 'string' ? parsed.startedBy.trim() : '';
      const processCommandHash = typeof parsed?.processCommandHash === 'string' ? parsed.processCommandHash.trim() : '';
      const markerHomeDir = typeof parsed?.happyHomeDir === 'string' ? parsed.happyHomeDir.trim() : '';

      if (!Number.isInteger(pid) || pid <= 1) continue;
      if (markerHomeDir && markerHomeDir !== happyHomeDir) continue;
      if (!startedBy) continue;
      if (!processCommandHash) continue;

      candidates.push({
        pid,
        markerPath,
        startedBy,
        processCommandHash,
      });
    } catch {
      // ignore unreadable markers
    }
  }
  return candidates;
}

async function stopDaemonLeakedSessionsFromMarkersBestEffort(happyHomeDir: string): Promise<void> {
  const candidates = await listDaemonSessionMarkerCandidates(happyHomeDir);
  for (const marker of candidates) {
    if (marker.startedBy !== 'daemon') continue;

    const command = inspectProcessCommand(marker.pid);
    if (!command) continue;
    const hash = hashCommand(command);
    if (hash !== marker.processCommandHash) continue;

    await terminateProcessTreeByPid(marker.pid, { graceMs: 3_000, pollMs: 50 }).catch(() => {});
    await unlink(marker.markerPath).catch(() => {});
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return true;
    }
  }
  return false;
}

async function waitForReplacementDaemonState(
  happyHomeDir: string,
  originalPid: number,
  opts?: { timeoutMs?: number },
): Promise<DaemonState> {
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readDaemonState(happyHomeDir);
    if (state && state.httpPort > 0 && state.pid > 0 && state.pid !== originalPid) {
      try {
        process.kill(state.pid, 0);
        return state;
      } catch {
        // Keep polling until the replacement process is observable.
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for replacement daemon.state.json in ${happyHomeDir}`);
}

type HardKillPhase = 'unreachable' | 'graceful-timeout';

type DaemonStartupPhase =
  | 'sweepProcessOwnershipLeases'
  | 'resolveCliTestLaunchSpec'
  | 'stopExistingDaemon'
  | 'reserveDirectPeerBindPort'
  | 'waitForDaemonState'
  | 'waitForOriginalDaemonExit'
  | 'afterOriginalDaemonExit'
  | 'waitForReplacementDaemonState';

type DaemonStartupDiagnostics = Readonly<{
  phase: DaemonStartupPhase;
  timeoutMs?: number;
  testDir: string;
  happyHomeDir: string;
  stdoutPath: string;
  stderrPath: string;
  processPid?: number | null;
  statePresence?: DaemonStatePresenceTracker;
}>;

function parsePositiveInteger(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveDaemonStartupPhaseTimeoutMs(env: NodeJS.ProcessEnv, startupTimeoutMs: number | undefined): number {
  return parsePositiveInteger(env.HAPPIER_E2E_DAEMON_STARTUP_PHASE_TIMEOUT_MS) ?? startupTimeoutMs ?? 300_000;
}

function sanitizeDiagnosticText(text: string): string {
  return redactHarnessLogText(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(
      /(\bcontrolToken"?\s*[:=]\s*)("[^"\r\n]*"|[^\s,}\r\n]+)/gi,
      (_match, prefix: string, value: string) => (
        `${prefix}${value.startsWith('"') ? '"<redacted>"' : '<redacted>'}`
      ),
    );
}

async function readSanitizedDiagnosticTail(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    const sanitized = sanitizeDiagnosticText(text);
    return sanitized.slice(Math.max(0, sanitized.length - 4_000));
  } catch {
    return null;
  }
}

async function readInternalDaemonLogTail(happyHomeDir: string): Promise<string | null> {
  const logsDir = join(happyHomeDir, 'logs');
  try {
    const entries = await readdir(logsDir, { withFileTypes: true });
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.log')) continue;
      const path = join(logsDir, entry.name);
      try {
        const s = await stat(path);
        candidates.push({ path, mtimeMs: s.mtimeMs });
      } catch {
        // ignore files that disappear while collecting diagnostics
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = candidates[0];
    if (!latest) return null;
    const tail = await readSanitizedDiagnosticTail(latest.path);
    if (tail === null) return null;
    return `${latest.path}:${tail}`;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function formatDaemonStartupDiagnostics(params: DaemonStartupDiagnostics): Promise<string> {
  const state = await readDaemonState(params.happyHomeDir).catch(() => null);
  const statePath = daemonStatePath(params.happyHomeDir);
  const processPid = params.processPid ?? null;
  const processStatus = processPid == null
    ? 'not-spawned'
    : isPidAlive(processPid)
      ? 'alive'
      : 'not-alive';
  const statePresence = params.statePresence;
  const [stdoutTail, stderrTail] = await Promise.all([
    readSanitizedDiagnosticTail(params.stdoutPath),
    readSanitizedDiagnosticTail(params.stderrPath),
  ]);
  const internalDaemonLogTail = await readInternalDaemonLogTail(params.happyHomeDir);

  return [
    `phase=${params.phase}`,
    params.timeoutMs == null ? null : `timeoutMs=${params.timeoutMs}`,
    `testDir=${params.testDir}`,
    `happyHomeDir=${params.happyHomeDir}`,
    `daemonStatePath=${statePath}`,
    `daemonStateExists=${state ? 'yes' : 'no'}`,
    state ? `daemonStatePid=${state.pid}` : null,
    state ? `daemonStateHttpPort=${state.httpPort}` : null,
    statePresence ? `daemonStateEverWritten=${statePresence.everWritten ? 'yes' : 'no'}` : null,
    statePresence ? `daemonStateEverRemoved=${statePresence.everRemoved ? 'yes' : 'no'}` : null,
    statePresence ? `daemonStateLastCandidateCount=${statePresence.lastCandidateCount}` : null,
    statePresence?.lastCandidatePath ? `daemonStateLastCandidatePath=${statePresence.lastCandidatePath}` : null,
    `processPid=${processPid == null ? 'not-spawned' : processPid}`,
    `processStatus=${processStatus}`,
    `stdoutPath=${params.stdoutPath}`,
    `stderrPath=${params.stderrPath}`,
    `daemonStdoutTail=${JSON.stringify(stdoutTail ?? 'none')}`,
    `daemonStderrTail=${JSON.stringify(stderrTail ?? 'none')}`,
    `internalDaemonLogTail=${JSON.stringify(internalDaemonLogTail ?? 'none')}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

async function createDaemonStartupPhaseError(
  message: string,
  params: DaemonStartupDiagnostics,
): Promise<Error> {
  return new Error(`${message}. ${await formatDaemonStartupDiagnostics(params)}`);
}

async function runDaemonStartupPhase<T>(
  phase: DaemonStartupPhase,
  promise: Promise<T>,
  params: Omit<DaemonStartupDiagnostics, 'phase'>,
  options: Readonly<{
    onLateResolve?: (value: T) => void | Promise<void>;
  }> = {},
): Promise<T> {
  const timeoutMs = params.timeoutMs;
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = timeoutMs == null
      ? null
      : setTimeout(() => {
          if (settled) return;
          settled = true;
          void createDaemonStartupPhaseError(
            `Timed out during daemon startup`,
            { ...params, phase },
          ).then(rejectPromise, rejectPromise);
        }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) {
          void Promise.resolve(options.onLateResolve?.(value)).catch(() => {
            process.emitWarning(
              `Late daemon startup cleanup failed after timeout (phase=${phase})`,
              {
                code: 'HAPPIER_TEST_DAEMON_LATE_CLEANUP_FAILED',
                type: 'HappierTestDaemonCleanupWarning',
              },
            );
          });
          return;
        }
        settled = true;
        if (timer) clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const causeMessage = error instanceof Error ? error.message : String(error);
        void createDaemonStartupPhaseError(
          `Daemon startup failed during ${phase}: ${causeMessage}`,
          { ...params, phase },
        ).then(rejectPromise, rejectPromise);
      },
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function collectCleanupErrors(
  actions: readonly (() => void | Promise<void>)[],
): Promise<Error[]> {
  const errors: Error[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(asError(error));
    }
  }
  return errors;
}

function throwWithCleanupErrors(primaryError: unknown, cleanupErrors: readonly Error[], context: string): never {
  const primary = asError(primaryError);
  if (cleanupErrors.length === 0) throw primary;
  throw new AggregateError(
    [primary, ...cleanupErrors],
    `${context}: ${[primary, ...cleanupErrors].map((error) => error.message).join('; ')}`,
  );
}

function hardKillContext(params: { phase: HardKillPhase; state: DaemonState }): string {
  return `phase=${params.phase} pid=${params.state.pid} httpPort=${params.state.httpPort}`;
}

function throwHardKillError(params: { phase: HardKillPhase; state: DaemonState; message: string }): never {
  throw new Error(`${hardKillContext(params)} ${params.message}`);
}

async function hardKillDaemonPid(params: {
  phase: HardKillPhase;
  state: DaemonState;
  inspector: (pid: number) => ProcessInspectionResult;
}): Promise<void> {
  const inspected = params.inspector(params.state.pid);
  if (!inspected.ok) {
    if (inspected.reason === 'ps_missing') {
      throwHardKillError({
        phase: params.phase,
        state: params.state,
        message: 'cannot safely hard-kill: required process inspection command "ps" is unavailable on this platform.',
      });
    }
    throwHardKillError({
      phase: params.phase,
      state: params.state,
      message: 'cannot safely hard-kill: failed to inspect the process command line.',
    });
  }
  if (!inspected.looksLikeDaemon) {
    throwHardKillError({
      phase: params.phase,
      state: params.state,
      message: `refusing to hard-kill: daemon.state.json points to a non-daemon process (${inspected.command}).`,
    });
  }

  try {
    process.kill(params.state.pid, 'SIGTERM');
  } catch {
    return;
  }

  const exitedAfterTerm = await waitForPidExit(params.state.pid, 3_000);
  if (exitedAfterTerm) return;

  try {
    process.kill(params.state.pid, 'SIGKILL');
  } catch {
    // ignore
  }
}

export async function stopDaemonFromHomeDir(
  happyHomeDir: string,
  opts?: {
    gracefulTimeoutMs?: number;
    hardKill?: boolean;
    inspectProcess?: (pid: number) => ProcessInspectionResult;
  },
): Promise<void> {
  const state = await readDaemonState(happyHomeDir);
  if (!state) return;

  const inspector = opts?.inspectProcess ?? inspectProcess;

  const controlToken = typeof state.controlToken === 'string' ? state.controlToken.trim() : '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(controlToken ? { 'x-happier-daemon-token': controlToken } : {}),
  };

  const stopRes = await fetch(`http://127.0.0.1:${state.httpPort}/stop`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ stopSessions: true }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null);

  // Treat auth failures like an unreachable daemon (don't wait full graceful timeout for a 401).
  if (!stopRes || stopRes.status === 401) {
    // If the daemon isn't reachable, avoid waiting a full graceful timeout on stale state.
    // Fail closed before hard-killing: only kill if we can reliably inspect the PID.
    let daemonPidAlive = false;
    try {
      process.kill(state.pid, 0);
      daemonPidAlive = true;
    } catch {
      daemonPidAlive = false;
    }

    const hardKill = opts?.hardKill ?? true;
    if (daemonPidAlive && hardKill) {
      await hardKillDaemonPid({ phase: 'unreachable', state, inspector });
    }

    // Even if the daemon is already gone, detached daemon-started sessions can remain.
    await stopDaemonLeakedSessionsFromMarkersBestEffort(happyHomeDir).catch(() => {});
    return;
  }

  const gracefulTimeoutMs = opts?.gracefulTimeoutMs ?? 30_000;
  const exited = await waitForPidExit(state.pid, gracefulTimeoutMs);
  if (exited) {
    // A daemon can still leave detached daemon-owned session processes behind even after
    // acknowledging /stop and exiting cleanly. Sweep marker-owned leftovers on the clean path too.
    await stopDaemonLeakedSessionsFromMarkersBestEffort(happyHomeDir).catch(() => {});
    return;
  }

  const hardKill = opts?.hardKill ?? true;
  if (!hardKill) return;

  // Best-effort hard stop to avoid leaking daemons across test runs.
  // Fail closed: only kill if it looks like our daemon.
  await hardKillDaemonPid({ phase: 'graceful-timeout', state, inspector });

  // If we had to hard-kill the daemon, it may not have had a chance to stop detached sessions.
  await stopDaemonLeakedSessionsFromMarkersBestEffort(happyHomeDir).catch(() => {});
}

export type StartedDaemon = {
  happyHomeDir: string;
  state: DaemonState;
  proc: SpawnedProcess;
  stop: () => Promise<void>;
};

function createStartedDaemon(params: Readonly<{
  happyHomeDir: string;
  state: DaemonState;
  proc: SpawnedProcess;
}>): StartedDaemon {
  return {
    happyHomeDir: params.happyHomeDir,
    state: params.state,
    proc: params.proc,
    stop: async () => {
      const cleanupErrors = await collectCleanupErrors([
        () => stopDaemonFromHomeDir(params.happyHomeDir),
        () => params.proc.stop(),
      ]);
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(
          cleanupErrors,
          `Failed to stop test daemon: ${cleanupErrors.map((error) => error.message).join('; ')}`,
        );
      }
    },
  };
}

export function resolveTestDaemonOwnershipLeasesDir(rootDir: string = repoRootDir()): string {
  return resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'test-daemon' });
}

export const sanitizeDaemonEnvForSpawn = sanitizeDaemonSpawnEnv;

function buildIsolatedDaemonServiceEnv(
  env: NodeJS.ProcessEnv,
  happyHomeDir: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: happyHomeDir,
    HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happyHomeDir,
  };
}

function resolveDaemonSourceSnapshotEnv(
  cliLaunchSpec: Readonly<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }>,
): NodeJS.ProcessEnv {
  if (cliLaunchSpec.command !== process.execPath) return {};
  const sourceEntrypoint = cliLaunchSpec.args.at(-1)?.trim() ?? '';
  if (
    !cliLaunchSpec.args.includes('--import')
    || (!sourceEntrypoint.endsWith('.ts') && !sourceEntrypoint.endsWith('.mts') && !sourceEntrypoint.endsWith('.cts'))
  ) {
    return {};
  }

  const snapshotRoot = resolve(dirname(sourceEntrypoint), '..');
  const tsxTsconfigPath =
    typeof cliLaunchSpec.env?.TSX_TSCONFIG_PATH === 'string' && cliLaunchSpec.env.TSX_TSCONFIG_PATH.trim().length > 0
      ? cliLaunchSpec.env.TSX_TSCONFIG_PATH.trim()
      : resolve(snapshotRoot, 'tsconfig.json');

  return {
    TSX_TSCONFIG_PATH: tsxTsconfigPath,
  };
}

function resolveDaemonSubprocessEntrypointEnv(
  cliLaunchSpec: Readonly<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }>,
): NodeJS.ProcessEnv {
  if (cliLaunchSpec.command !== process.execPath) return {};
  const entrypoint = cliLaunchSpec.args[0]?.trim() ?? '';
  if (cliLaunchSpec.args.length === 1 && entrypoint.endsWith('.mjs')) {
    return {
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
    };
  }

  const sourceEntrypoint = cliLaunchSpec.args.at(-1)?.trim() ?? '';
  if (
    cliLaunchSpec.args.includes('--import')
    && (sourceEntrypoint.endsWith('.ts') || sourceEntrypoint.endsWith('.mts') || sourceEntrypoint.endsWith('.cts'))
  ) {
    return {
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1',
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
    };
  }

  return {};
}

function resolveDaemonChildDiagnosticsEnv(params: Readonly<{
  cliLaunchSpec: { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  env: NodeJS.ProcessEnv;
}>): NodeJS.ProcessEnv {
  if (params.env.DEBUG && params.env.DEBUG.trim().length > 0) {
    return {};
  }

  const noDevUiWeb = String(params.env.HAPPIER_E2E_UI_WEB_NO_DEV ?? '').trim().toLowerCase();
  if (noDevUiWeb !== '1' && noDevUiWeb !== 'true' && noDevUiWeb !== 'yes' && noDevUiWeb !== 'y') {
    return {};
  }

  const sourceEntrypoint = params.cliLaunchSpec.args.at(-1)?.trim() ?? '';
  const launchedFromSourceSnapshot =
    params.cliLaunchSpec.command === process.execPath
    && params.cliLaunchSpec.args.includes('--import')
    && (sourceEntrypoint.endsWith('.ts') || sourceEntrypoint.endsWith('.mts') || sourceEntrypoint.endsWith('.cts'));

  if (!launchedFromSourceSnapshot) {
    return {};
  }

  return {
    DEBUG: '1',
  };
}

export async function startTestDaemon(params: {
  testDir: string;
  happyHomeDir: string;
  env: NodeJS.ProcessEnv;
  snapshotDir?: string;
  startupTimeoutMs?: number;
  cleanupDescendantsOnExit?: boolean;
  cliLaunchSpec?: CliTestLaunchSpec;
}): Promise<StartedDaemon> {
  await mkdir(params.testDir, { recursive: true });
  const stdoutPath = resolve(params.testDir, 'daemon.stdout.log');
  const stderrPath = resolve(params.testDir, 'daemon.stderr.log');
  const phaseTimeoutMs = resolveDaemonStartupPhaseTimeoutMs(params.env, params.startupTimeoutMs);
  const baseDiagnostics = {
    testDir: params.testDir,
    happyHomeDir: params.happyHomeDir,
    stdoutPath,
    stderrPath,
    timeoutMs: phaseTimeoutMs,
  };

  const currentOwnerInspection = inspectOwnedProcess(process.pid);
  if (currentOwnerInspection.ok) {
    await runDaemonStartupPhase(
      'sweepProcessOwnershipLeases',
      sweepProcessOwnershipLeases({
        rootDir: repoRootDir(),
        leaseKind: 'test-daemon',
        currentOwnerPid: process.pid,
        currentOwnerStartTime: currentOwnerInspection.startTime,
        isOwnedProcessCommand: (command) => looksLikeTestDaemonLeaseCommand(command),
      }),
      baseDiagnostics,
    );
  }

  const cliLaunchSpec = await runDaemonStartupPhase(
    'resolveCliTestLaunchSpec',
    resolveCliTestLaunchSpecOrOverride(
      params.cliLaunchSpec,
      () => resolveCliTestLaunchSpec(
        {
          testDir: params.testDir,
          env: buildIsolatedDaemonServiceEnv({
            ...params.env,
            // Use an isolated snapshot node_modules copy by default. Symlink mode aliases the live
            // workspace tree and can observe transient file gaps while shared deps are being rebuilt.
            HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: params.env.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE ?? 'copy',
          }, params.happyHomeDir),
        },
        {
          snapshotDir: resolveDaemonLaunchSnapshotDir({
            testDir: params.testDir,
            env: params.env,
            snapshotDir: params.snapshotDir,
          }),
          skipDistIntegrityCheck: true,
          skipSourceFreshnessCheck: true,
        },
      ),
    ),
    baseDiagnostics,
    {
      onLateResolve: async (lateLaunchSpec) => {
        await lateLaunchSpec.cleanup?.();
      },
    },
  );

  let proc: SpawnedProcess | null = null;
  try {
    await runDaemonStartupPhase(
      'stopExistingDaemon',
      stopDaemonFromHomeDir(params.happyHomeDir).catch(() => {}),
      baseDiagnostics,
    );

    const directPeerBindPort = await runDaemonStartupPhase(
      'reserveDirectPeerBindPort',
      typeof params.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT === 'string'
      && params.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT.trim().length > 0
        ? Promise.resolve(params.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT.trim())
        : reserveAvailablePort().then(String),
      baseDiagnostics,
    );

    proc = spawnLoggedProcess({
      command: cliLaunchSpec.command,
      args: [...cliLaunchSpec.args, 'daemon', 'start-sync'],
      cwd: cliLaunchSpec.cwd ?? repoRootDir(),
      env: sanitizeDaemonEnvForSpawn({
        ...buildIsolatedDaemonServiceEnv(params.env, params.happyHomeDir),
        ...resolveDaemonSourceSnapshotEnv(cliLaunchSpec),
        ...(cliLaunchSpec.env ?? {}),
        ...resolveDaemonSubprocessEntrypointEnv(cliLaunchSpec),
        ...resolveDaemonChildDiagnosticsEnv({ cliLaunchSpec, env: params.env }),
        CI: '1',
        HAPPIER_HOME_DIR: params.happyHomeDir,
        HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT: directPeerBindPort,
      }),
      stdoutPath,
      stderrPath,
      cleanupDescendantsOnExit: params.cleanupDescendantsOnExit,
      cleanup: cliLaunchSpec.cleanup,
    });

    await registerProcessOwnershipLease({
      rootDir: repoRootDir(),
      leaseKind: 'test-daemon',
      child: proc.child,
      ownerPid: process.pid,
      ownerStartTime: currentOwnerInspection.ok ? currentOwnerInspection.startTime : null,
      metadata: {
        happyHomeDir: params.happyHomeDir,
        testDir: params.testDir,
      },
    });

    const startupTimeoutMs = phaseTimeoutMs;
    const exitStateGraceTimeoutMs = Math.min(startupTimeoutMs, 10_000);
    const statePresence = createDaemonStatePresenceTracker();
    const spawnedProc = proc;
    const state = await runDaemonStartupPhase(
      'waitForDaemonState',
      Promise.race([
        waitForDaemonState(params.happyHomeDir, { timeoutMs: startupTimeoutMs, statePresence }),
        new Promise<DaemonState>((resolveState, rejectState) => {
          spawnedProc.child.once('exit', (code, signal) => {
            void (async () => {
              try {
                const exitedState = await waitForDaemonState(params.happyHomeDir, {
                  timeoutMs: exitStateGraceTimeoutMs,
                  statePresence,
                });
                resolveState(exitedState);
              } catch {
                const detail = signal ? `signal=${String(signal)}` : `code=${String(code)}`;
                rejectState(
                  new Error(
                    `Daemon exited before writing daemon.state.json (${detail}). See logs: ${stdoutPath} and ${stderrPath}`,
                  ),
                );
              }
            })().catch((error) => rejectState(error instanceof Error ? error : new Error(String(error))));
          });
        }),
      ]),
      {
        ...baseDiagnostics,
        timeoutMs: startupTimeoutMs,
        processPid: spawnedProc.child.pid ?? null,
        statePresence,
      },
    );
    return createStartedDaemon({ happyHomeDir: params.happyHomeDir, state, proc: spawnedProc });
  } catch (error) {
    const cleanupErrors = await collectCleanupErrors(
      proc
        ? [
            () => stopDaemonFromHomeDir(params.happyHomeDir),
            () => proc!.stop(),
          ]
        : cliLaunchSpec.cleanup
          ? [() => cliLaunchSpec.cleanup!()]
          : [],
    );
    throwWithCleanupErrors(error, cleanupErrors, 'Daemon startup and cleanup failed');
  }
}

export async function replaceTestDaemonWithoutStoppingSessions(params: {
  testDir: string;
  happyHomeDir: string;
  env: NodeJS.ProcessEnv;
  snapshotDir?: string;
  originalDaemon?: StartedDaemon;
  stdoutPath?: string;
  stderrPath?: string;
  afterOriginalDaemonExit?: () => void | Promise<void>;
  cliLaunchSpec?: CliTestLaunchSpec;
}): Promise<StartedDaemon> {
  await mkdir(params.testDir, { recursive: true });
  const stdoutPath = params.stdoutPath ?? resolve(params.testDir, 'daemon.replace.stdout.log');
  const stderrPath = params.stderrPath ?? resolve(params.testDir, 'daemon.replace.stderr.log');
  const phaseTimeoutMs = resolveDaemonStartupPhaseTimeoutMs(params.env, undefined);
  const baseDiagnostics = {
    testDir: params.testDir,
    happyHomeDir: params.happyHomeDir,
    stdoutPath,
    stderrPath,
    timeoutMs: phaseTimeoutMs,
  };
  const originalState = await readDaemonState(params.happyHomeDir);
  if (!originalState || typeof originalState.pid !== 'number' || originalState.pid <= 0) {
    throw new Error(`Missing original daemon state for ${params.happyHomeDir}`);
  }

  const originalDaemonExit = params.originalDaemon
    ? Promise.race([
        new Promise<void>((resolveExit, rejectExit) => {
          const timeout = setTimeout(
            () => rejectExit(new Error(`Timed out waiting for daemon PID ${originalState.pid} to exit`)),
            30_000,
          );
          params.originalDaemon?.proc.child.once('exit', () => {
            clearTimeout(timeout);
            resolveExit();
          });
        }),
        waitForPidExit(originalState.pid, 30_000).then((exited) => {
          if (!exited) {
            throw new Error(`Timed out waiting for daemon PID ${originalState.pid} to exit`);
          }
        }),
      ])
    : waitForPidExit(originalState.pid, 30_000).then((exited) => {
        if (!exited) {
          throw new Error(`Timed out waiting for daemon PID ${originalState.pid} to exit`);
        }
      });

  try {
    process.kill(originalState.pid, 'SIGKILL');
  } catch (error) {
    throw new Error(`Failed to terminate daemon PID ${originalState.pid}: ${error instanceof Error ? error.message : String(error)}`);
  }

  await runDaemonStartupPhase(
    'waitForOriginalDaemonExit',
    originalDaemonExit,
    {
      ...baseDiagnostics,
      processPid: originalState.pid,
    },
  );

  await runDaemonStartupPhase(
    'afterOriginalDaemonExit',
    Promise.resolve().then(() => params.afterOriginalDaemonExit?.()),
    baseDiagnostics,
  );

  const cliLaunchSpec = await runDaemonStartupPhase(
    'resolveCliTestLaunchSpec',
    resolveCliTestLaunchSpecOrOverride(
      params.cliLaunchSpec,
      () => resolveCliTestLaunchSpec(
        {
          testDir: params.testDir,
          env: buildIsolatedDaemonServiceEnv(params.env, params.happyHomeDir),
        },
        {
          snapshotDir: resolveDaemonLaunchSnapshotDir({
            testDir: params.testDir,
            env: params.env,
            snapshotDir: params.snapshotDir,
          }),
          skipDistIntegrityCheck: true,
          skipSourceFreshnessCheck: true,
        },
      ),
    ),
    baseDiagnostics,
    {
      onLateResolve: async (lateLaunchSpec) => {
        await lateLaunchSpec.cleanup?.();
      },
    },
  );

  let proc: SpawnedProcess | null = null;
  try {
    const directPeerBindPort = await runDaemonStartupPhase(
      'reserveDirectPeerBindPort',
      typeof params.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT === 'string'
      && params.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT.trim().length > 0
        ? Promise.resolve(params.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT.trim())
        : reserveAvailablePort().then(String),
      baseDiagnostics,
    );

    proc = spawnLoggedProcess({
      command: cliLaunchSpec.command,
      args: [...cliLaunchSpec.args, 'daemon', 'start-sync', '--takeover'],
      cwd: cliLaunchSpec.cwd ?? repoRootDir(),
      env: sanitizeDaemonEnvForSpawn({
        ...buildIsolatedDaemonServiceEnv(params.env, params.happyHomeDir),
        ...(cliLaunchSpec.env ?? {}),
        ...resolveDaemonSubprocessEntrypointEnv(cliLaunchSpec),
        CI: '1',
        HAPPIER_HOME_DIR: params.happyHomeDir,
        HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT: directPeerBindPort,
      }),
      stdoutPath,
      stderrPath,
      cleanup: cliLaunchSpec.cleanup,
    });

    const currentOwnerInspection = inspectOwnedProcess(process.pid);
    await registerProcessOwnershipLease({
      rootDir: repoRootDir(),
      leaseKind: 'test-daemon',
      child: proc.child,
      ownerPid: process.pid,
      ownerStartTime: currentOwnerInspection.ok ? currentOwnerInspection.startTime : null,
      metadata: {
        happyHomeDir: params.happyHomeDir,
        testDir: params.testDir,
      },
    });

    const state = await runDaemonStartupPhase(
      'waitForReplacementDaemonState',
      waitForReplacementDaemonState(params.happyHomeDir, originalState.pid, { timeoutMs: phaseTimeoutMs }),
      {
        ...baseDiagnostics,
        processPid: proc.child.pid ?? null,
      },
    );
    return createStartedDaemon({ happyHomeDir: params.happyHomeDir, state, proc });
  } catch (error) {
    const cleanupErrors = await collectCleanupErrors(
      proc
        ? [
            () => stopDaemonFromHomeDir(params.happyHomeDir),
            () => proc!.stop(),
          ]
        : cliLaunchSpec.cleanup
          ? [() => cliLaunchSpec.cleanup!()]
          : [],
    );
    throwWithCleanupErrors(error, cleanupErrors, 'Replacement daemon startup and cleanup failed');
  }
}

export async function withTestDaemon<T>(params: {
  testDir: string;
  happyHomeDir: string;
  env: NodeJS.ProcessEnv;
  run: (daemon: StartedDaemon) => Promise<T>;
}): Promise<T> {
  const daemon = await startTestDaemon({ testDir: params.testDir, happyHomeDir: params.happyHomeDir, env: params.env });
  try {
    return await params.run(daemon);
  } finally {
    await daemon.stop().catch(() => {});
  }
}
