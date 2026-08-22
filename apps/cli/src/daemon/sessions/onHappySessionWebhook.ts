import type { Metadata, SessionCreationOutcome } from '@/api/types';
import { configuration } from '@/configuration';
import {
  SPAWN_SESSION_ERROR_CODES,
} from '@/session/shared/spawnSessionContract';
import type { SessionCreationTerminalSpawnErrorDetail } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import { readStoredCredentials } from '@/persistence';

import {
  getAgentResumeConfig,
  resolveAgentIdFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import { applyProviderSessionIdSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { execFileSync } from 'node:child_process';

import { findHappyProcessByPid } from '../doctor';
import { readProcessIdentityByPid } from '../processIdentity';
import type { TrackedSession } from '../types';
import {
  hashProcessCommand,
  listSessionMarkers,
  promoteSessionMarkerPid,
  removeSessionMarkerIfOwned,
  writeSessionMarker,
} from '../sessionRegistry';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';
import { hasSessionWebhookPidTimedOut } from '../spawn/waitForSessionWebhook';
import { promoteTrackedSessionPidCustody } from './promoteTrackedSessionPidCustody';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import {
  captureExactWindowsTerminalLaunchProcess,
  readAllWindowsProcessFacts,
  type ExactWindowsProcessCancellationIdentity,
} from '../platform/windows/windowsProcessCustody';
import type {
  WindowsProcessInventoryFact,
} from '../platform/windows/windowsProcessInventory';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';

const DEFAULT_PARENT_PID_LOOKUP_TIMEOUT_MS = 1000;
const PARENT_PID_LOOKUP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_PARENT_PID_LOOKUP_TIMEOUT_MS';

export function resolveSessionWebhookPath(
  inputPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return expandHomeDirPath(inputPath.trim(), env, platform);
}

function isPidPlaceholderSessionId(value: string): boolean {
  return /^PID-\d+$/.test(value);
}

function shouldRequireCanonicalRunnerMarkerAdoption(
  tracked: TrackedSession,
  isPlaceholderSessionId: boolean,
): boolean {
  return (
    !isPlaceholderSessionId
    && tracked.startedBy === 'daemon'
    && tracked.reattachedFromDiskMarker !== true
    && Boolean(
      tracked.agentRuntimeDaemonServiceAuthorityFilePath,
    )
    && (
      !tracked.happySessionId?.trim()
      || isPidPlaceholderSessionId(tracked.happySessionId)
    )
  );
}

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
function getParentPid(pid: number): number | null {
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

function findTrackedSessionByRunnerPid(
  pidToTrackedSession: Map<number, TrackedSession>,
  runnerPid: number,
): TrackedSession | null {
  for (const tracked of pidToTrackedSession.values()) {
    if (tracked.sessionRunnerPid === runnerPid) return tracked;
  }
  return null;
}

function resolveWindowsHostedIdentity(
  terminal: Metadata['terminal'] | undefined,
):
  | Readonly<{
      mode: 'windows_terminal';
      windowId: string;
      title: string;
    }>
  | Readonly<{ mode: 'windows_console' }>
  | null {
  if (
    terminal?.mode === 'windows_console'
    && terminal.windows?.host === 'console'
  ) {
    return { mode: 'windows_console' };
  }
  if (
    terminal?.mode !== 'windows_terminal'
    || terminal.windows?.host !== 'windows_terminal'
  ) {
    return null;
  }
  const windowId =
    typeof terminal.windows.windowId === 'string'
      ? terminal.windows.windowId.trim()
      : '';
  const title =
    typeof terminal.windows.title === 'string'
      ? terminal.windows.title.trim()
      : '';
  return windowId && title
    ? { mode: 'windows_terminal', windowId, title }
    : null;
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

async function findPendingWindowsTerminalTrackedSession(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
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
    && revalidated.processStartTimeMs
      === exactMatches[0]!
        .cancellationIdentity.processStartTimeMs
    && revalidated.processCommandHash
      === exactMatches[0]!
        .cancellationIdentity.processCommandHash
  )
    ? {
        kind: 'matched',
        tracked: exactMatches[0]!.tracked,
        cancellationIdentity: revalidated,
      }
    : { kind: 'refused' };
}

function didSessionWebhookTimeout(tracked: TrackedSession | null | undefined): boolean {
  return typeof tracked?.sessionWebhookTimedOutAtMs === 'number';
}

function hasSameSessionCreationOutcome(
  left: SessionCreationOutcome,
  right: SessionCreationOutcome,
): boolean {
  return left.disposition === right.disposition
    && left.organizationPlacement.folderId === right.organizationPlacement.folderId
    && left.organizationPlacement.tagIds.length === right.organizationPlacement.tagIds.length
    && left.organizationPlacement.tagIds.every(
      (tagId, index) => tagId === right.organizationPlacement.tagIds[index],
    );
}

function adoptReportedSessionIdentity(
  tracked: TrackedSession,
  sessionId: string,
  metadata: Metadata,
  isPlaceholderSessionId: boolean,
): void {
  if (!isPlaceholderSessionId && tracked.startedBy === 'daemon') {
    const currentSessionId =
      typeof tracked.happySessionId === 'string'
        ? tracked.happySessionId.trim()
        : '';
    const lockedSessionId =
      tracked.spawnStartupCanonicalSessionId
      ?? (
        currentSessionId
        && !isPidPlaceholderSessionId(
          currentSessionId,
        )
          ? currentSessionId
          : undefined
      );
    if (lockedSessionId && lockedSessionId !== sessionId) {
      tracked.spawnStartupReadinessFailure ??= {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'connected_account_canonical_session_identity_conflict',
      };
      return;
    }
    tracked.spawnStartupCanonicalSessionId ??=
      sessionId;
  }
  tracked.happySessionId = sessionId;
  tracked.happySessionMetadataFromLocalWebhook = metadata;
}

function didDaemonWebhookPidTimeOut(
  input: Readonly<{
    pid: number;
    metadata: Metadata;
    pidToTrackedSession: Map<number, TrackedSession>;
  }>,
): boolean {
  if (input.metadata.startedBy !== 'daemon') return false;
  const tracked = input.pidToTrackedSession.get(input.pid);
  if (tracked && !didSessionWebhookTimeout(tracked)) return false;
  return hasSessionWebhookPidTimedOut(input.pid);
}

function didDaemonWebhookParentTimeOut(
  input: Readonly<{
    parentPid: number | null;
    metadata: Metadata;
    pidToTrackedSession: Map<number, TrackedSession>;
  }>,
): boolean {
  if (input.metadata.startedBy !== 'daemon' || typeof input.parentPid !== 'number') return false;
  const trackedParent = input.pidToTrackedSession.get(input.parentPid);
  if (didSessionWebhookTimeout(trackedParent)) return true;
  if (trackedParent) return false;
  return hasSessionWebhookPidTimedOut(input.parentPid);
}

function createStartupReadinessGate(): Readonly<{
  promise: Promise<boolean>;
  resolve(ready: boolean): void;
}> {
  let resolvePromise = (_ready: boolean): void => {
    throw new Error('Session startup readiness gate was not initialized');
  };
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    promise,
    resolve: (ready) => resolvePromise(ready),
  });
}

/**
 * Settles the pre-existing spawn webhook waiter when the runner reaches the
 * server create-or-load boundary but receives its exact organization-placement
 * rejection before it has a Session to report. The nonce is the daemon-owned
 * attempt identity; a report must never select an arbitrary pending waiter.
 */
export function createOnDaemonSessionStartupFailure(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
}>): (input: Readonly<{
  spawnNonce: string;
  errorDetail: SessionCreationTerminalSpawnErrorDetail;
}>) => boolean {
  return (input) => {
    const spawnNonce = input.spawnNonce.trim();
    if (!spawnNonce) return false;

    const candidates = [...params.pidToTrackedSession.values()].filter((tracked) => {
      if (tracked.startedBy !== 'daemon' || didSessionWebhookTimeout(tracked)) {
        return false;
      }
      const trackedNonce = typeof tracked.spawnOptions?.spawnNonce === 'string'
        ? tracked.spawnOptions.spawnNonce.trim()
        : '';
      if (trackedNonce !== spawnNonce) return false;
      const currentSessionId = typeof tracked.happySessionId === 'string'
        ? tracked.happySessionId.trim()
        : '';
      if (!isPidPlaceholderSessionId(currentSessionId)) return false;
      const awaiterPid = tracked.spawnStartupAwaiterPid ?? tracked.pid;
      return params.pidToAwaiter.has(awaiterPid);
    });

    // A nonce must designate one live, pending spawn. Ambiguity and stale
    // reports deliberately do nothing rather than waking another attempt.
    if (candidates.length !== 1) return false;
    const tracked = candidates[0]!;
    const awaiterPid = tracked.spawnStartupAwaiterPid ?? tracked.pid;
    const awaiter = params.pidToAwaiter.get(awaiterPid);
    if (!awaiter) return false;

    tracked.spawnStartupReadinessFailure ??= {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: input.errorDetail.kind === 'session_creation_correspondence_conflict'
        ? 'Session creation correspondence conflicts with the existing Session'
        : 'Session creation organization placement is invalid',
      errorDetail: input.errorDetail,
    };
    // Claim before invoking the existing waiter so duplicate/later callbacks
    // cannot race its cleanup path or settle this spawn twice.
    params.pidToAwaiter.delete(awaiterPid);
    awaiter(tracked);
    return true;
  };
}

export function createOnHappySessionWebhook(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  spawnResourceCleanupByPid?: Map<
    number,
    () => void | Promise<void>
  >;
  sessionAttachCleanupByPid?: Map<
    number,
    () => Promise<void>
  >;
  deviceLocalSecretStorage?: DeviceLocalSecretStorage;
  findHappyProcessByPidFn?: typeof findHappyProcessByPid;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
  readAllWindowsProcessFactsFn?: () => Promise<
    ReadonlyMap<number, WindowsProcessInventoryFact>
  >;
  listSessionMarkersFn?: typeof listSessionMarkers;
  writeSessionMarkerFn?: typeof writeSessionMarker;
  promoteSessionMarkerFn?: typeof promoteSessionMarkerPid;
  removeSessionMarkerIfOwnedFn?: typeof removeSessionMarkerIfOwned;
  getParentPidFn?: (pid: number) => number | null;
  readCredentialsFn?: typeof readStoredCredentials;
  onTrackedSessionReady?: (tracked: TrackedSession) => Promise<void>;
  onTrackedSessionReported?: (tracked: TrackedSession) => Promise<void> | void;
  onPidPromoted?: (input: Readonly<{
    fromPid: number;
    toPid: number;
    trackedSession: TrackedSession;
  }>) => void;
}>): (
  sessionId: string,
  sessionMetadata: Metadata,
  reconcileCanonicalReadiness?: (tracked: TrackedSession) => Promise<void>,
  sessionCreationOutcome?: SessionCreationOutcome,
) => Promise<void> {
  const {
    pidToTrackedSession,
    pidToAwaiter,
    spawnResourceCleanupByPid,
    sessionAttachCleanupByPid,
    findHappyProcessByPidFn = findHappyProcessByPid,
    readProcessIdentityByPidFn = readProcessIdentityByPid,
    readAllWindowsProcessFactsFn =
      readAllWindowsProcessFacts,
    listSessionMarkersFn = listSessionMarkers,
    writeSessionMarkerFn = writeSessionMarker,
    promoteSessionMarkerFn = promoteSessionMarkerPid,
    removeSessionMarkerIfOwnedFn = removeSessionMarkerIfOwned,
    getParentPidFn = getParentPid,
    readCredentialsFn = readStoredCredentials,
    onTrackedSessionReady,
    onTrackedSessionReported,
    onPidPromoted,
  } = params;

  return async (
    sessionId: string,
    sessionMetadata: Metadata,
    reconcileCanonicalReadiness?: (tracked: TrackedSession) => Promise<void>,
    sessionCreationOutcome?: SessionCreationOutcome,
  ) => {
    const normalizedPath = resolveSessionWebhookPath(sessionMetadata.path);
    const normalizedMetadata =
      normalizedPath === sessionMetadata.path ? sessionMetadata : { ...sessionMetadata, path: normalizedPath };

    logger.debugLargeJson(`[DAEMON RUN] Session reported`, normalizedMetadata);

    // Safety: ignore cross-daemon/cross-stack reports.
    if (normalizedMetadata?.happyHomeDir && normalizedMetadata.happyHomeDir !== configuration.happyHomeDir) {
      logger.debug(`[DAEMON RUN] Ignoring session report for different happyHomeDir: ${normalizedMetadata.happyHomeDir}`);
      return;
    }

    const pidRaw = normalizedMetadata.hostPid;
    if (typeof pidRaw !== 'number' || !Number.isInteger(pidRaw) || pidRaw <= 0) {
      logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
      return;
    }
    const pid = pidRaw;

    logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${normalizedMetadata.startedBy || 'unknown'}`);
    logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

    if (didDaemonWebhookPidTimeOut({ pid, metadata: normalizedMetadata, pidToTrackedSession })) {
      logger.debug(`[DAEMON RUN] Ignoring late session webhook for timed-out daemon PID ${pid}: ${sessionId}`);
      return;
    }

    // Check if we already have this PID (daemon-spawned)
    const existingSession = pidToTrackedSession.get(pid);
    const isPlaceholderSessionId = isPidPlaceholderSessionId(sessionId);
    let trackedForPid: TrackedSession | null = null;
    let requiresCanonicalMarkerAdoption = false;
    let windowsTerminalHostPid: number | null = null;

    if (existingSession) {
      if (didSessionWebhookTimeout(existingSession)) {
        logger.debug(`[DAEMON RUN] Ignoring late session webhook for timed-out daemon spawn PID ${pid}: ${sessionId}`);
        return;
      }

      trackedForPid = existingSession;
      requiresCanonicalMarkerAdoption =
        shouldRequireCanonicalRunnerMarkerAdoption(
          existingSession,
          isPlaceholderSessionId,
        );
      // Update tracked session with latest webhook data.
      adoptReportedSessionIdentity(
        existingSession,
        sessionId,
        normalizedMetadata,
        isPlaceholderSessionId,
      );
      if (existingSession.startedBy === 'daemon') {
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);
        if (isPlaceholderSessionId && pidToAwaiter.has(pid)) {
          logger.debug(
            `[DAEMON RUN] Deferred awaiter resolution for PID ${pid}; waiting for canonical session id`,
          );
        }
      } else if (existingSession.reattachedFromDiskMarker) {
        existingSession.startedBy = normalizedMetadata.startedBy ?? existingSession.startedBy;
        logger.debug(`[DAEMON RUN] Refreshed reattached session ${sessionId} metadata`);
      } else {
        existingSession.startedBy = 'happy directly - likely by user from terminal';
        logger.debug(`[DAEMON RUN] Refreshed externally-started session ${sessionId}`);
      }
    } else if (!existingSession) {
      // PID not in tracked map. This can happen for:
      // - externally-started sessions, OR
      // - wrapper-script scenarios where the daemon spawned a wrapper PID (parent),
      //   but the webhook reports the actual session binary PID (child).
      //
      // First: check if we already associated this runner PID with a tracked daemon session.
      const trackedByRunnerPid = findTrackedSessionByRunnerPid(pidToTrackedSession, pid);
      if (trackedByRunnerPid) {
        if (didSessionWebhookTimeout(trackedByRunnerPid)) {
          logger.debug(`[DAEMON RUN] Ignoring late runner webhook for timed-out daemon spawn PID ${trackedByRunnerPid.pid}: ${sessionId}`);
          return;
        }

        if (
          trackedByRunnerPid.windowsTerminalLaunchCustody
          && trackedByRunnerPid.pid !== pid
        ) {
          const exactMatch =
            await findPendingWindowsTerminalTrackedSession({
              pidToTrackedSession,
              webhookPid: pid,
              metadata: normalizedMetadata,
              readProcessIdentityByPidFn,
              readAllWindowsProcessFactsFn,
            });
          if (
            exactMatch.kind !== 'matched'
            || exactMatch.tracked !== trackedByRunnerPid
          ) {
            throw new Error(
              'Windows Terminal Agent launch custody could not be revalidated',
            );
          }
          trackedByRunnerPid
            .windowsTerminalCancellationIdentity =
              exactMatch.cancellationIdentity;
          windowsTerminalHostPid =
            trackedByRunnerPid.pid;
        }
        trackedForPid = trackedByRunnerPid;
        requiresCanonicalMarkerAdoption =
          shouldRequireCanonicalRunnerMarkerAdoption(
            trackedByRunnerPid,
            isPlaceholderSessionId,
          );
        adoptReportedSessionIdentity(
          trackedByRunnerPid,
          sessionId,
          normalizedMetadata,
          isPlaceholderSessionId,
        );
        logger.debug(`[DAEMON RUN] Refreshed daemon session via previously recorded runner PID ${pid}`);

        if (
          trackedByRunnerPid.startedBy === 'daemon'
          && isPlaceholderSessionId
          && pidToAwaiter.has(trackedByRunnerPid.pid)
        ) {
          logger.debug(
            `[DAEMON RUN] Deferred awaiter resolution for wrapper PID ${trackedByRunnerPid.pid}; waiting for canonical session id`,
          );
        }
      } else {
        const ordinaryParentPid =
          normalizedMetadata.startedBy === 'daemon'
          && pidToAwaiter.size > 0
            ? getParentPidFn(pid)
            : null;
        const ordinaryParentSession =
          typeof ordinaryParentPid === 'number'
            ? pidToTrackedSession.get(ordinaryParentPid)
              ?? null
            : null;
        const ordinaryParentHasAwaiter =
          typeof ordinaryParentPid === 'number'
          && pidToAwaiter.has(ordinaryParentPid);
        const ordinaryParentHasChildHandle =
          typeof ordinaryParentPid === 'number'
          && ordinaryParentSession?.childProcess?.pid
            === ordinaryParentPid;
        const ordinaryParentEligible =
          typeof ordinaryParentPid === 'number'
          && ordinaryParentSession?.startedBy === 'daemon'
          && (
            ordinaryParentHasAwaiter
            || ordinaryParentHasChildHandle
          );
        const windowsTerminalMatch =
          !ordinaryParentEligible
          && spawnResourceCleanupByPid
          && sessionAttachCleanupByPid
            ? await findPendingWindowsTerminalTrackedSession({
                pidToTrackedSession,
                webhookPid: pid,
                metadata: normalizedMetadata,
                readProcessIdentityByPidFn,
                readAllWindowsProcessFactsFn,
              })
            : { kind: 'none' as const };
        if (windowsTerminalMatch.kind === 'matched') {
          const windowsTerminalSession =
            windowsTerminalMatch.tracked;
          windowsTerminalHostPid =
            windowsTerminalSession.pid;
          trackedForPid = windowsTerminalSession;
          requiresCanonicalMarkerAdoption =
            !isPlaceholderSessionId;
              windowsTerminalSession.sessionRunnerPid = pid;
          windowsTerminalSession
            .windowsTerminalCancellationIdentity =
                  windowsTerminalMatch.cancellationIdentity;
          if (
            windowsTerminalSession.hostedTerminal?.mode
              === 'windows_console'
          ) {
            windowsTerminalSession.hostedTerminal = {
              ...windowsTerminalSession.hostedTerminal,
              windows: {
                host: 'console',
                pid,
              },
            };
          }
          adoptReportedSessionIdentity(
            windowsTerminalSession,
            sessionId,
            normalizedMetadata,
            isPlaceholderSessionId,
          );
          logger.debug(
            `[DAEMON RUN] Matched Windows Terminal Agent PID ${pid} to daemon host PID ${windowsTerminalHostPid}`,
          );
        } else if (
          windowsTerminalMatch.kind === 'refused'
        ) {
          logger.debug(
            '[DAEMON RUN] Refused Windows Terminal webhook without exact packaged executable/argv custody',
            { pid },
          );
          throw new Error(
            'Windows Terminal Agent launch custody could not be verified',
          );
        // Heuristic: only attempt PPID correlation when at least one
        // ordinary daemon spawn is in flight.
        } else if (pidToAwaiter.size === 0) {
          const parentPid = normalizedMetadata.startedBy === 'daemon' ? getParentPidFn(pid) : null;
          if (didDaemonWebhookParentTimeOut({ parentPid, metadata: normalizedMetadata, pidToTrackedSession })) {
            logger.debug(`[DAEMON RUN] Ignoring late child webhook for timed-out daemon wrapper PID ${parentPid}: ${sessionId}`);
            return;
          }

          const trackedSession: TrackedSession = {
            startedBy: 'happy directly - likely by user from terminal',
            happySessionId: sessionId,
            happySessionMetadataFromLocalWebhook: normalizedMetadata,
            pid
          };
          trackedForPid = trackedSession;
          pidToTrackedSession.set(pid, trackedSession);
          logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
        } else {
          const ppid = ordinaryParentPid;
          const parentSession = ordinaryParentSession;
          const hasAwaiter = ordinaryParentHasAwaiter;
          const hasChildHandle = ordinaryParentHasChildHandle;
          if (didDaemonWebhookParentTimeOut({ parentPid: ppid, metadata: normalizedMetadata, pidToTrackedSession })) {
            logger.debug(`[DAEMON RUN] Ignoring late child webhook for timed-out daemon wrapper PID ${ppid}: ${sessionId}`);
            return;
          }
          const parentEligible =
            typeof ppid === 'number' &&
            parentSession?.startedBy === 'daemon' &&
            (hasAwaiter || hasChildHandle);

          if (parentEligible && ppid && parentSession) {
            if (didSessionWebhookTimeout(parentSession)) {
              logger.debug(`[DAEMON RUN] Ignoring late child webhook for timed-out daemon wrapper PID ${ppid}: ${sessionId}`);
              return;
            }

            trackedForPid = parentSession;
            requiresCanonicalMarkerAdoption =
              shouldRequireCanonicalRunnerMarkerAdoption(
                parentSession,
                isPlaceholderSessionId,
              );
            parentSession.sessionRunnerPid = pid;
            adoptReportedSessionIdentity(
              parentSession,
              sessionId,
              normalizedMetadata,
              isPlaceholderSessionId,
            );
            logger.debug(`[DAEMON RUN] Matched session webhook PID ${pid} to daemon wrapper PID ${ppid}`);

            if (isPlaceholderSessionId && pidToAwaiter.has(ppid)) {
              logger.debug(
                `[DAEMON RUN] Deferred awaiter resolution for wrapper PID ${ppid}; waiting for canonical session id`,
              );
            }
          } else {
            // New session started externally (not by this daemon)
            const trackedSession: TrackedSession = {
              startedBy: 'happy directly - likely by user from terminal',
              happySessionId: sessionId,
              happySessionMetadataFromLocalWebhook: normalizedMetadata,
              pid
            };
            trackedForPid = trackedSession;
            pidToTrackedSession.set(pid, trackedSession);
            logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
          }
        }
      }
    }

    const resolveSessionMarkerPid = (): number =>
      requiresCanonicalMarkerAdoption
        ? trackedForPid?.pid ?? pid
        : pid;
    const inferKnownVendorResumeId = async (
      currentSessionMarkerPid: number,
    ): Promise<string | null> => {
      if (!trackedForPid) return null;

      const agentId = resolveAgentIdFromSessionMetadata(normalizedMetadata);
      const metadataVendorResumeId = agentId
        ? resolveVendorResumeIdFromSessionMetadata(agentId, normalizedMetadata)
        : null;
      if (metadataVendorResumeId) {
        trackedForPid.vendorResumeId = metadataVendorResumeId;
        return metadataVendorResumeId;
      }

      if (trackedForPid.vendorResumeId) {
        return trackedForPid.vendorResumeId;
      }

      const markers = await listSessionMarkersFn().catch(() => []);
      const existingMarker = markers
        .filter((marker) => marker.pid === currentSessionMarkerPid)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
      const markerVendorResumeId = existingMarker && agentId
        ? resolveVendorResumeIdFromSessionMetadata(agentId, existingMarker.metadata)
        : null;
      if (markerVendorResumeId) {
        trackedForPid.vendorResumeId = markerVendorResumeId;
        return markerVendorResumeId;
      }

      return null;
    };

    const mergeKnownVendorResumeIdIntoMetadata = (vendorResumeId: string | null): Metadata => {
      if (!vendorResumeId) return normalizedMetadata;
      const agentId = resolveAgentIdFromSessionMetadata(normalizedMetadata);
      const resumeConfig = agentId ? getAgentResumeConfig(agentId) : null;
      if (!agentId || !resumeConfig) return normalizedMetadata;
      const vendorResumeIdField = 'vendorResumeIdField' in resumeConfig ? resumeConfig.vendorResumeIdField ?? null : null;
      if (!vendorResumeIdField) return normalizedMetadata;
      if (resolveVendorResumeIdFromSessionMetadata(agentId, normalizedMetadata)) return normalizedMetadata;
      return applyProviderSessionIdSessionMetadata(normalizedMetadata, {
        metadataKey: vendorResumeIdField,
        value: vendorResumeId,
      });
    };

    const trackedDaemonCanonicalSession =
      trackedForPid?.startedBy === 'daemon' && !isPlaceholderSessionId
        ? trackedForPid
        : null;
    if (trackedDaemonCanonicalSession && sessionCreationOutcome) {
      const priorOutcome = trackedDaemonCanonicalSession.sessionCreationOutcome;
      if (
        priorOutcome
        && !hasSameSessionCreationOutcome(priorOutcome, sessionCreationOutcome)
      ) {
        trackedDaemonCanonicalSession.spawnStartupReadinessFailure ??= {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
          errorMessage: 'create_or_rejoin_outcome_conflict',
        };
      } else {
        trackedDaemonCanonicalSession.sessionCreationOutcome ??= sessionCreationOutcome;
      }
    }
    if (trackedForPid) {
      const agentId = resolveAgentIdFromSessionMetadata(normalizedMetadata);
      const vendorResumeId = agentId
        ? resolveVendorResumeIdFromSessionMetadata(agentId, normalizedMetadata)
        : null;
      if (vendorResumeId) trackedForPid.vendorResumeId = vendorResumeId;
    }

    const startupReadinessGate = trackedDaemonCanonicalSession
      ? createStartupReadinessGate()
      : null;
    const assertTrackedStartupCustody = (): void => {
      if (!trackedDaemonCanonicalSession) return;
      if (
        pidToTrackedSession.get(trackedDaemonCanonicalSession.pid)
        !== trackedDaemonCanonicalSession
      ) {
        throw new Error(
          'Daemon session startup custody changed during reconciliation',
        );
      }
      if (didSessionWebhookTimeout(trackedDaemonCanonicalSession)) {
        throw new Error(
          'Daemon session webhook timed out during startup reconciliation',
        );
      }
    };
    const awaitTrackedMarkerPromotion = async (): Promise<void> => {
      assertTrackedStartupCustody();
      const promotion =
        trackedDaemonCanonicalSession?.sessionMarkerPidPromotion;
      if (promotion && !await promotion) {
        throw new Error(
          'Daemon session marker PID promotion failed',
        );
      }
      assertTrackedStartupCustody();
    };

    // Fresh runner-authority placeholder adoption is required startup custody and is awaited below.
    // Other marker refreshes remain best-effort.
    const persistSessionMarker = async (
      beforeStartupReadiness = false,
    ): Promise<void> => {
      await awaitTrackedMarkerPromotion();
      const acceptedSpawnMarkerGate = trackedForPid?.acceptedSpawnMarkerGate;
      if (acceptedSpawnMarkerGate && !await acceptedSpawnMarkerGate) {
        if (requiresCanonicalMarkerAdoption) {
          throw new Error(
            'Managed daemon spawn custody was not accepted',
          );
        }
        return;
      }
      await awaitTrackedMarkerPromotion();
      if (
        startupReadinessGate
        && !requiresCanonicalMarkerAdoption
        && !beforeStartupReadiness
        && !await startupReadinessGate.promise
      ) {
        return;
      }
      await awaitTrackedMarkerPromotion();
      const currentSessionMarkerPid = resolveSessionMarkerPid();
      const [processIdentity, proc] = await Promise.all([
        readProcessIdentityByPidFn(currentSessionMarkerPid),
        findHappyProcessByPidFn(currentSessionMarkerPid),
      ]);
      await awaitTrackedMarkerPromotion();
      if (currentSessionMarkerPid !== resolveSessionMarkerPid()) {
        await persistSessionMarker(beforeStartupReadiness);
        return;
      }
      const discoveredProcessCommand =
        typeof processIdentity?.command === 'string' && processIdentity.command.trim().length > 0
          ? processIdentity.command
          : typeof proc?.command === 'string' && proc.command.trim().length > 0
            ? proc.command
            : undefined;
      const trackedProcessCommand =
        typeof trackedForPid?.processCommand === 'string' && trackedForPid.processCommand.trim().length > 0
          ? trackedForPid.processCommand
          : undefined;
      const daemonChildSpawnArgsCommand =
        trackedForPid?.startedBy === 'daemon' &&
        Array.isArray(trackedForPid.childProcess?.spawnargs) &&
        trackedForPid.childProcess.spawnargs.length > 0
          ? trackedForPid.childProcess.spawnargs
              .filter((arg): arg is string => typeof arg === 'string' && arg.trim().length > 0)
              .join(' ')
          : undefined;
      const processCommand = discoveredProcessCommand ?? trackedProcessCommand ?? daemonChildSpawnArgsCommand;
      const processCommandHash = processCommand ? hashProcessCommand(processCommand) : undefined;
      const processStartTimeMs = processIdentity?.processStartTimeMs;
      if (processCommandHash) {
        // Store on the tracked session too so stopSession can require a match.
        if (trackedForPid) {
          trackedForPid.processCommandHash = processCommandHash;
          trackedForPid.processCommand = processCommand;
          if (processStartTimeMs !== undefined) {
            trackedForPid.processStartTimeMs = processStartTimeMs;
          }
        }
      } else {
        logger.debug(`[DAEMON RUN] Could not determine process command for PID ${currentSessionMarkerPid}; marker will be weaker`);
      }

      const storedCredentials =
        trackedForPid?.startedBy === 'daemon' && trackedForPid.spawnOptions
          ? await readCredentialsFn().catch(() => null)
          : null;
      await awaitTrackedMarkerPromotion();
      const knownVendorResumeId =
        await inferKnownVendorResumeId(currentSessionMarkerPid);
      await awaitTrackedMarkerPromotion();
      const respawn =
        trackedForPid?.startedBy === 'daemon' && trackedForPid.spawnOptions
          ? buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(
              trackedForPid.spawnOptions,
              {
                ...(params.deviceLocalSecretStorage
                  ? { deviceLocalSecretStorage: params.deviceLocalSecretStorage }
                  : {}),
                ...(storedCredentials?.encryption
                  ? { encryptionMaterial: storedCredentials.encryption }
                  : {}),
                ...(knownVendorResumeId ? { vendorResumeId: knownVendorResumeId } : {}),
              },
            )
          : null;

      const persistedMetadata = mergeKnownVendorResumeIdIntoMetadata(knownVendorResumeId);
      await awaitTrackedMarkerPromotion();
      if (currentSessionMarkerPid !== resolveSessionMarkerPid()) {
        await persistSessionMarker(beforeStartupReadiness);
        return;
      }
      await writeSessionMarkerFn(
        {
          pid: currentSessionMarkerPid,
          happySessionId: sessionId,
          startedBy: persistedMetadata.startedBy ?? 'terminal',
          cwd: normalizedPath,
          processCommandHash,
          processStartTimeMs,
          processCommand,
          metadata: persistedMetadata,
          ...(respawn ? { respawn } : {}),
          ...(trackedForPid
            ?.agentRuntimeDaemonServiceAuthorityFilePath
            ? {
                agentRuntimeDaemonServiceAuthorityFilePath:
                  trackedForPid
                    .agentRuntimeDaemonServiceAuthorityFilePath,
              }
            : {}),
        },
        ...(requiresCanonicalMarkerAdoption
          ? [{ adoptCanonicalSessionIdFromPidPlaceholder: true }]
          : []),
      );
      await awaitTrackedMarkerPromotion();
    };
    let ordinaryMarkerPersistence: Promise<boolean> | null = null;
    const startOrdinaryMarkerPersistence = (
      beforeStartupReadiness = false,
    ): Promise<boolean> => {
      if (ordinaryMarkerPersistence) return ordinaryMarkerPersistence;
      ordinaryMarkerPersistence = persistSessionMarker(
        beforeStartupReadiness,
      )
        .then(() => true)
        .catch((e) => {
          logger.debug(
            '[DAEMON RUN] Failed to write session marker',
            e,
          );
          return false;
        });
      if (trackedForPid && trackedForPid.startedBy !== 'daemon') {
        // Foreground authority promotion consumes this exact canonical write
        // rather than racing it or creating a second marker writer.
        trackedForPid.sessionMarkerPersistence =
          ordinaryMarkerPersistence;
      }
      return ordinaryMarkerPersistence;
    };
    if (
      !requiresCanonicalMarkerAdoption
      && !trackedDaemonCanonicalSession
        ?.agentRuntimeDaemonServiceAuthorityFilePath
    ) {
      void startOrdinaryMarkerPersistence();
    }

    if (!trackedDaemonCanonicalSession || !startupReadinessGate) return;
    const reconcileTrackedDaemonCanonicalWebhook =
      async (): Promise<void> => {
    const completeSpawnAwaiter = (): void => {
      const trackedPid =
        trackedDaemonCanonicalSession.spawnStartupAwaiterPid
        ?? trackedDaemonCanonicalSession.pid;
      const awaiter = pidToAwaiter.get(trackedPid);
      if (!awaiter) return;
      pidToAwaiter.delete(trackedPid);
      delete trackedDaemonCanonicalSession.spawnStartupAwaiterPid;
      awaiter(trackedDaemonCanonicalSession);
      logger.debug(
        `[DAEMON RUN] Resolved session awaiter for canonical session ${sessionId} via PID ${trackedPid}`,
      );
    };
    const identityFailure =
      trackedDaemonCanonicalSession
        .spawnStartupReadinessFailure;
    if (identityFailure) {
      startupReadinessGate.resolve(false);
      completeSpawnAwaiter();
      throw new Error(
        identityFailure.errorMessage,
      );
    }
    if (
      windowsTerminalHostPid !== null
      && trackedDaemonCanonicalSession
        .persistWindowsTerminalAcceptedAgentMarker
    ) {
      const persistAcceptedAgentMarker =
        trackedDaemonCanonicalSession
          .persistWindowsTerminalAcceptedAgentMarker;
      try {
        const exactAgentIdentity =
          trackedDaemonCanonicalSession
            .windowsTerminalCancellationIdentity;
        if (!exactAgentIdentity) {
          throw new Error(
            'Windows Terminal Agent cancellation identity was not captured',
          );
        }
        await persistAcceptedAgentMarker(
          exactAgentIdentity,
        );
      } finally {
        delete trackedDaemonCanonicalSession
          .persistWindowsTerminalAcceptedAgentMarker;
      }
    }
    const acceptedSpawnMarkerGate = trackedDaemonCanonicalSession.acceptedSpawnMarkerGate;
    if (acceptedSpawnMarkerGate && !await acceptedSpawnMarkerGate) {
      throw new Error('Daemon spawn custody was not accepted');
    }
    if (windowsTerminalHostPid !== null) {
      if (!spawnResourceCleanupByPid || !sessionAttachCleanupByPid) {
        throw new Error(
          'Windows Terminal startup custody maps are unavailable',
        );
      }
      if (pidToAwaiter.has(windowsTerminalHostPid)) {
        trackedDaemonCanonicalSession.spawnStartupAwaiterPid ??=
          windowsTerminalHostPid;
      }
      const promoted =
        await promoteTrackedSessionPidCustody({
          fromPid: windowsTerminalHostPid,
          toPid: pid,
          trackedSession: trackedDaemonCanonicalSession,
          pidToTrackedSession,
          spawnResourceCleanupByPid,
          sessionAttachCleanupByPid,
          promoteSessionMarkerFn,
          removeSessionMarkerIfOwnedFn,
          requireExactTargetOwnership: true,
          expectedTargetProcessIdentity:
            trackedDaemonCanonicalSession
              .windowsTerminalCancellationIdentity,
          targetMarkerAlreadyPersisted:
            trackedDaemonCanonicalSession
              .windowsTerminalAcceptedTargetMarkerPersisted
              === true,
          onPidPromoted,
        });
      if (!promoted) {
        throw new Error(
          'Windows Terminal Agent PID custody promotion failed',
        );
      }
    }
    await awaitTrackedMarkerPromotion();
    try {
      await awaitTrackedMarkerPromotion();
      const priorReadinessFailure =
        trackedDaemonCanonicalSession.spawnStartupReadinessFailure;
      if (priorReadinessFailure) {
        throw new Error(priorReadinessFailure.errorMessage);
      }
      const activateConnectedAccountSessionBinding =
        trackedDaemonCanonicalSession
          .activateConnectedAccountSessionBindingOnCanonicalSession;
      if (activateConnectedAccountSessionBinding) {
        let failure;
        try {
          failure = await activateConnectedAccountSessionBinding(sessionId);
        } finally {
          delete trackedDaemonCanonicalSession
            .activateConnectedAccountSessionBindingOnCanonicalSession;
        }
        if (failure) {
          trackedDaemonCanonicalSession.spawnStartupReadinessFailure = failure;
          throw new Error(failure.errorMessage);
        }
      }
      await awaitTrackedMarkerPromotion();
      const concurrentReadinessFailure =
        trackedDaemonCanonicalSession.spawnStartupReadinessFailure;
      if (concurrentReadinessFailure) {
        throw new Error(concurrentReadinessFailure.errorMessage);
      }
      // Best-effort report observers must not wait on strict startup reconciliation:
      // terminal-host serviceability is produced by this exact report and is independently useful.
      const reportObserverFailure = (error: unknown): void => {
        logger.debug('[DAEMON RUN] Tracked session reported callback failed', error);
      };
      try {
        void Promise.resolve(onTrackedSessionReported?.(trackedDaemonCanonicalSession)).catch(reportObserverFailure);
      } catch (error) {
        reportObserverFailure(error);
      }
      if (requiresCanonicalMarkerAdoption) {
        // Authority installation updates this exact marker with retained
        // generation custody. Adopt the canonical Session id first so the
        // authority owner never observes the provisional PID placeholder.
        await persistSessionMarker();
      } else if (
        trackedDaemonCanonicalSession
          .agentRuntimeDaemonServiceAuthorityFilePath
        && !await startOrdinaryMarkerPersistence(true)
      ) {
        throw new Error(
          'Runner Agent canonical session marker is unavailable',
        );
      }
      if (onTrackedSessionReady) {
        await onTrackedSessionReady(trackedDaemonCanonicalSession);
      }
      await awaitTrackedMarkerPromotion();
      const spawnAwaiterPid =
        trackedDaemonCanonicalSession.spawnStartupAwaiterPid
        ?? trackedDaemonCanonicalSession.pid;
      const hasActiveSpawnAwaiter = pidToAwaiter.has(spawnAwaiterPid);
      if (
        reconcileCanonicalReadiness
        && trackedDaemonCanonicalSession.reattachedFromDiskMarker !== true
        && hasActiveSpawnAwaiter
      ) {
        await reconcileCanonicalReadiness(
          trackedDaemonCanonicalSession,
        );
      }
    } catch (error) {
      logger.debug(
        '[DAEMON RUN] Canonical Session startup readiness failed',
        error,
      );
      trackedDaemonCanonicalSession.spawnStartupReadinessFailure ??= {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: 'Session startup reconciliation failed',
      };
      startupReadinessGate?.resolve(false);
      completeSpawnAwaiter();
      throw error;
    }
    startupReadinessGate.resolve(true);
    completeSpawnAwaiter();
    if (
      !requiresCanonicalMarkerAdoption
      && !ordinaryMarkerPersistence
    ) {
      void startOrdinaryMarkerPersistence();
    }
    };
    const inFlightReconciliation =
      trackedDaemonCanonicalSession
        .canonicalWebhookReconciliation;
    if (inFlightReconciliation) {
      const concurrentReadinessFailure =
        trackedDaemonCanonicalSession.spawnStartupReadinessFailure;
      if (concurrentReadinessFailure) {
        throw new Error(concurrentReadinessFailure.errorMessage);
      }
      await inFlightReconciliation;
      return;
    }
    const reconciliation =
      reconcileTrackedDaemonCanonicalWebhook();
    trackedDaemonCanonicalSession
      .canonicalWebhookReconciliation =
        reconciliation;
    try {
      await reconciliation;
    } finally {
      if (
        trackedDaemonCanonicalSession
          .canonicalWebhookReconciliation
        === reconciliation
      ) {
        delete trackedDaemonCanonicalSession
          .canonicalWebhookReconciliation;
      }
    }
  };
}
