import { isPidPlaceholderSessionId } from '../sessionRegistry';
import { logger } from '@/ui/logger';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { Metadata } from '@/api/types';
import type { TrackedSession } from '../types';
import { readProcessCensus } from '@/processes/census/processCensus';
import { processIdentityMatches, type ProcessIdentityWitness } from '@happier-dev/cli-common/processInstance';
import { readProcessIdentityByPid } from '../processIdentity';
import { captureExactWindowsTerminalLaunchProcess, readAllWindowsProcessFacts, type ExactWindowsProcessCancellationIdentity } from '../platform/windows/windowsProcessCustody';
import type { ProcessCensusProcessFact } from '@/processes/census/processFacts';
import { resolveWindowsHostedIdentity } from '../platform/windows/windowsHostedSessionRuntime';
import { trackedSessionForSingleSessionProcess, trackedSessionOnProcess, type ReadonlyTrackedSessionMap, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

/**
 * Get the parent PID of a process.
 *
 * Used to detect wrapper-script scenarios where the daemon spawns a wrapper
 * (e.g. Node.js entrypoint) that in turn spawns the actual session binary.
 * Returns null on Windows or if the lookup fails.
 */
export async function getParentPid(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    const snapshot = await readProcessCensus({ freshness: 'fresh', pids: [pid], fields: [] });
    if (snapshot.status !== 'ok') return null;
    const ppid = snapshot.rows.find(row => row.pid === pid)?.ppid;
    return typeof ppid === 'number' && Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

export function findTrackedSessionByRunnerPid(
  trackedSessionsByKey: ReadonlyTrackedSessionMap,
  runnerPid: number,
): TrackedSession | null {
  for (const tracked of trackedSessionsByKey.values()) {
    if (tracked.sessionRunnerPid === runnerPid) return tracked;
  }
  return null;
}

type PendingWindowsTerminalMatch =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'refused' }>
  | Readonly<{
      kind: 'matched';
      tracked: TrackedSession;
      cancellationIdentity:
        ExactWindowsProcessCancellationIdentity;
    }>;

export async function findPendingWindowsTerminalTrackedSession(params: Readonly<{
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
  webhookPid: number;
  metadata: Metadata;
  readProcessIdentityByPidFn: typeof readProcessIdentityByPid;
  readAllWindowsProcessFactsFn: () => Promise<
    ReadonlyMap<number, ProcessCensusProcessFact>
  >;
}>): Promise<PendingWindowsTerminalMatch> {
  if (params.metadata.startedBy !== 'daemon') {
    return { kind: 'none' };
  }
  const pending: TrackedSession[] = [];
  for (const tracked of params.trackedSessionsByKey.values()) {
    if (tracked.pid === params.webhookPid) continue;
    if (tracked.startedBy !== 'daemon') continue;
    if (!tracked.windowsTerminalLaunchCustody) continue;
    pending.push(tracked);
  }
  if (pending.length === 0) return { kind: 'none' };

  const reported =
    resolveWindowsHostedIdentity(params.metadata.terminal);
  if (!reported) return { kind: 'refused' };

  const matches: TrackedSession[] = [];
  for (const tracked of pending) {
    const expected =
      resolveWindowsHostedIdentity(tracked.hostedTerminal);
    if (
      expected?.mode !== reported.mode
      || (
        expected.mode === 'windows_terminal'
        && reported.mode === 'windows_terminal'
        && (
          expected.windowId !== reported.windowId
          || expected.title !== reported.title
        )
      )
    ) {
      continue;
    }
    matches.push(tracked);
  }
  if (matches.length === 0) return { kind: 'refused' };

  let inventory:
    ReadonlyMap<number, ProcessCensusProcessFact>;
  try {
    inventory =
      await params.readAllWindowsProcessFactsFn();
  } catch {
    return { kind: 'refused' };
  }
  const exactMatches = matches.flatMap((tracked) => {
    const launch = tracked.windowsTerminalLaunchCustody;
    if (!launch) return [];
    return [...inventory.values()].flatMap((process) => {
      const cancellationIdentity =
        captureExactWindowsTerminalLaunchProcess({
          process,
          launch,
        });
      return cancellationIdentity
        ? [{ tracked, cancellationIdentity }]
        : [];
    });
  });
  if (
    exactMatches.length !== 1
    || exactMatches[0]!.cancellationIdentity.pid
      !== params.webhookPid
  ) {
    return { kind: 'refused' };
  }
  const current =
    await params.readProcessIdentityByPidFn(
      params.webhookPid,
    );
  const launch =
    exactMatches[0]!.tracked.windowsTerminalLaunchCustody;
  const revalidated =
    current && launch
      ? captureExactWindowsTerminalLaunchProcess({
          process: current,
          launch,
        })
      : null;
  return (
    revalidated
    && processIdentityMatches(exactMatches[0]!.cancellationIdentity, revalidated)
  )
    ? {
        kind: 'matched',
        tracked: exactMatches[0]!.tracked,
        cancellationIdentity: revalidated,
      }
    : { kind: 'refused' };
}


export async function resolveOrdinaryDaemonParentCorrelation(params: Readonly<{
  metadata: Metadata;
  pid: number;
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
  spawnAwaiterByKey: ReadonlyMap<SessionTrackingKey, unknown>;
  getParentPidFn: (pid: number) => number | null | Promise<number | null>;
}>) {
  const parentPid = params.metadata.startedBy === 'daemon'
    ? await params.getParentPidFn(params.pid) : null;
  // Wrapper correlation: a launcher process starts exactly one runner.
  const tracked = typeof parentPid === 'number'
    ? trackedSessionForSingleSessionProcess(params.trackedSessionsByKey, parentPid) ?? null
    : null;
  const hasAwaiter = tracked !== null && params.spawnAwaiterByKey.has(tracked.trackingKey);
  const hasChildHandle = typeof parentPid === 'number' && tracked?.childProcess?.pid === parentPid;
  return { parentPid, tracked, hasAwaiter, hasChildHandle,
    eligible: typeof parentPid === 'number' && tracked?.startedBy === 'daemon' && (hasAwaiter || hasChildHandle) };
}

export async function resolveSessionReportTrackedCorrelation(params: Readonly<{
  metadata: Metadata;
  pid: number;
  sessionId?: string;
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
  spawnAwaiterByKey: ReadonlyMap<SessionTrackingKey, unknown>;
  getParentPidFn?: (pid: number) => number | null | Promise<number | null>;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
  readAllWindowsProcessFactsFn?: () => Promise<ReadonlyMap<number, ProcessCensusProcessFact>>;
}>) {
  const direct = trackedSessionOnProcess(params.trackedSessionsByKey, params.pid, params.sessionId);
  if (direct?.pid === params.pid) return { kind: 'matched' as const, tracked: direct };
  const runner = direct ?? findTrackedSessionByRunnerPid(params.trackedSessionsByKey, params.pid);
  if (runner && (!runner.windowsTerminalLaunchCustody || runner.pid === params.pid)) {
    return { kind: 'matched' as const, tracked: runner };
  }
  const parent = await resolveOrdinaryDaemonParentCorrelation({
    ...params, getParentPidFn: params.getParentPidFn ?? getParentPid,
  });
  if (!runner && parent.eligible && parent.tracked) return { kind: 'matched' as const, tracked: parent.tracked };
  const windows = await findPendingWindowsTerminalTrackedSession({
    trackedSessionsByKey: params.trackedSessionsByKey,
    webhookPid: params.pid, metadata: params.metadata,
    readProcessIdentityByPidFn: params.readProcessIdentityByPidFn ?? readProcessIdentityByPid,
    readAllWindowsProcessFactsFn: params.readAllWindowsProcessFactsFn ?? readAllWindowsProcessFacts,
  });
  if (runner && (windows.kind !== 'matched' || windows.tracked !== runner)) return { kind: 'refused' as const };
  return windows;
}

/** A launcher's birth witness cannot establish a distinct runner PID. */
export function resolveTrackedSessionRunnerIdentity(tracked: TrackedSession): ProcessIdentityWitness | null {
  const pid = tracked.sessionRunnerPid ?? tracked.pid;
  if (tracked.runnerProcessIdentity) {
    return tracked.runnerProcessIdentity.pid === pid ? tracked.runnerProcessIdentity : null;
  }
  if (pid !== tracked.pid) return null;
  return {
    pid,
    processStartTimeMs: tracked.processStartTimeMs,
    processCommandHash: tracked.processCommandHash,
  };
}

export function adoptTrackedSessionRunnerIdentity(
  tracked: TrackedSession,
  identity: NonNullable<TrackedSession['runnerProcessIdentity']>,
): void {
  tracked.sessionRunnerPid = identity.pid;
  tracked.runnerProcessIdentity = identity;
}

export function bindTrackedSessionIdentity(tracked: TrackedSession, sessionId: string, lockCanonicalIdentity = false): boolean {
  if (tracked.reportMarkerCustody?.retiring) {
    logger.infoFile('[DAEMON RUN] Warning: rejected session report during tracked retirement', { pid: tracked.pid });
    throw new Error('Tracked session marker custody is retiring');
  }
  if (!isPidPlaceholderSessionId(sessionId) && tracked.startedBy === 'daemon') {
    const currentSessionId =
      typeof tracked.happySessionId === 'string'
        ? tracked.happySessionId.trim()
        : '';
    const lockedSessionId =
      tracked.spawnStartupCanonicalSessionId
      ?? (
        currentSessionId
        && !isPidPlaceholderSessionId(currentSessionId)
          ? currentSessionId
          : undefined
      );
    if (lockedSessionId && lockedSessionId !== sessionId) {
      tracked.spawnStartupReadinessFailure ??= {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'connected_account_canonical_session_identity_conflict',
      };
      return false;
    }
    if (lockCanonicalIdentity) tracked.spawnStartupCanonicalSessionId ??= sessionId;
  }
  tracked.happySessionId = sessionId;
  return true;
}
