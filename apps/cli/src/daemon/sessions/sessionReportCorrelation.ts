import { isPidPlaceholderSessionId } from '../sessionRegistry';
import { logger } from '@/ui/logger';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { Metadata } from '@/api/types';
import type { TrackedSession } from '../types';
import { execFileSync } from 'node:child_process';
import { processIdentityMatches } from '@happier-dev/cli-common/processInstance';
import { readProcessIdentityByPid } from '../processIdentity';
import { captureExactWindowsTerminalLaunchProcess, readAllWindowsProcessFacts, type ExactWindowsProcessCancellationIdentity } from '../platform/windows/windowsProcessCustody';
import type { WindowsProcessInventoryFact } from '../platform/windows/windowsProcessInventory';
import { resolveWindowsHostedIdentity } from '../platform/windows/windowsHostedSessionRuntime';

const DEFAULT_PARENT_PID_LOOKUP_TIMEOUT_MS = 1000;
const PARENT_PID_LOOKUP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_PARENT_PID_LOOKUP_TIMEOUT_MS';

function resolveParentPidLookupTimeoutMs(): number {
  const raw = String(process.env[PARENT_PID_LOOKUP_TIMEOUT_ENV_KEY] ?? '').trim();
  if (!raw) return DEFAULT_PARENT_PID_LOOKUP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PARENT_PID_LOOKUP_TIMEOUT_MS;
  // Keep this intentionally small: this runs on a webhook path.
  return Math.max(50, Math.min(parsed, 5000));
}

/**
 * Get the parent PID of a process.
 *
 * Used to detect wrapper-script scenarios where the daemon spawns a wrapper
 * (e.g. Node.js entrypoint) that in turn spawns the actual session binary.
 * Returns null on Windows or if the lookup fails.
 */
export function getParentPid(pid: number): number | null {
  if (process.platform === 'win32') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    const stdout = execFileSync(
      'ps',
      ['-o', 'ppid=', '-p', String(pid)],
      { encoding: 'utf-8', timeout: resolveParentPidLookupTimeoutMs(), stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const ppid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(ppid) || ppid <= 0) return null;
    return ppid;
  } catch {
    return null;
  }
}

export function findTrackedSessionByRunnerPid(
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>,
  runnerPid: number,
): TrackedSession | null {
  for (const tracked of pidToTrackedSession.values()) {
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
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  webhookPid: number;
  metadata: Metadata;
  readProcessIdentityByPidFn: typeof readProcessIdentityByPid;
  readAllWindowsProcessFactsFn: () => Promise<
    ReadonlyMap<number, WindowsProcessInventoryFact>
  >;
}>): Promise<PendingWindowsTerminalMatch> {
  if (params.metadata.startedBy !== 'daemon') {
    return { kind: 'none' };
  }
  const pending: TrackedSession[] = [];
  for (
    const [trackedPid, tracked]
    of params.pidToTrackedSession.entries()
  ) {
    if (trackedPid === params.webhookPid) continue;
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
    ReadonlyMap<number, WindowsProcessInventoryFact>;
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


export function resolveOrdinaryDaemonParentCorrelation(params: Readonly<{
  metadata: Metadata;
  pid: number;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  pidToAwaiter: ReadonlyMap<number, unknown>;
  getParentPidFn: (pid: number) => number | null;
}>) {
  const parentPid = params.metadata.startedBy === 'daemon' && params.pidToAwaiter.size > 0
    ? params.getParentPidFn(params.pid) : null;
  const tracked = typeof parentPid === 'number' ? params.pidToTrackedSession.get(parentPid) ?? null : null;
  const hasAwaiter = typeof parentPid === 'number' && params.pidToAwaiter.has(parentPid);
  const hasChildHandle = typeof parentPid === 'number' && tracked?.childProcess?.pid === parentPid;
  return { parentPid, tracked, hasAwaiter, hasChildHandle,
    eligible: typeof parentPid === 'number' && tracked?.startedBy === 'daemon' && (hasAwaiter || hasChildHandle) };
}

export async function resolveSessionReportTrackedCorrelation(params: Readonly<{
  metadata: Metadata;
  pid: number;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  pidToAwaiter: ReadonlyMap<number, unknown>;
  getParentPidFn?: (pid: number) => number | null;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
  readAllWindowsProcessFactsFn?: () => Promise<ReadonlyMap<number, WindowsProcessInventoryFact>>;
}>) {
  const direct = params.pidToTrackedSession.get(params.pid);
  if (direct) return { kind: 'matched' as const, tracked: direct };
  const runner = findTrackedSessionByRunnerPid(params.pidToTrackedSession, params.pid);
  if (runner && (!runner.windowsTerminalLaunchCustody || runner.pid === params.pid)) {
    return { kind: 'matched' as const, tracked: runner };
  }
  const parent = resolveOrdinaryDaemonParentCorrelation({
    ...params, getParentPidFn: params.getParentPidFn ?? getParentPid,
  });
  if (!runner && parent.eligible && parent.tracked) return { kind: 'matched' as const, tracked: parent.tracked };
  const windows = await findPendingWindowsTerminalTrackedSession({
    pidToTrackedSession: params.pidToTrackedSession,
    webhookPid: params.pid, metadata: params.metadata,
    readProcessIdentityByPidFn: params.readProcessIdentityByPidFn ?? readProcessIdentityByPid,
    readAllWindowsProcessFactsFn: params.readAllWindowsProcessFactsFn ?? readAllWindowsProcessFacts,
  });
  if (runner && (windows.kind !== 'matched' || windows.tracked !== runner)) return { kind: 'refused' as const };
  return windows;
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
