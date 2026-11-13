import type { Metadata, SessionCreationOutcome } from '@/api/types';
import { invalidateProcessLaunchDiscovery } from '@/processes/launchNotification';
import { configuration } from '@/configuration';
import {
  SPAWN_SESSION_ERROR_CODES,
} from '@/session/shared/spawnSessionContract';
import type { SessionCreationTerminalSpawnErrorDetail } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import { readStoredCredentials } from '@/persistence';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { processIdentityMatches } from '@happier-dev/cli-common/processInstance';

import {
  getAgentResumeConfig,
  resolveAgentIdFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import { applyProviderSessionIdSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { adoptTrackedSessionRunnerIdentity, bindTrackedSessionIdentity, getParentPid, findTrackedSessionByRunnerPid, findPendingWindowsTerminalTrackedSession, resolveOrdinaryDaemonParentCorrelation } from './sessionReportCorrelation';

import { findHappyProcessByPid } from '../processInspection';
import { readProcessIdentityByPid } from '../processIdentity';
import { readProcessRunState } from '../processRunState';
import { classifySessionRunnerProcessPresence } from '../sessionRunnerLock';
import type { DaemonSpawnStartupReadinessFailure, TrackedSession } from '../types';
import {
  hashProcessCommand,
  isPidPlaceholderSessionId,
  listSessionMarkers,
  promoteSessionMarkerPid,
  writeSessionMarker,
} from '../sessionRegistry';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';
import { promoteTrackedSessionPidCustody } from './promoteTrackedSessionPidCustody';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import {
  readAllWindowsProcessFacts,
} from '../platform/windows/windowsProcessCustody';
import type {
  ProcessCensusProcessFact,
} from '@/processes/census/processFacts';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import {
  isCurrentTrackedSession,
  mintSessionTrackingKey,
  trackSession,
  trackedSessionForSingleSessionProcess,
  untrackSession,
  type SessionTrackingKey,
  type TrackedSessionMap,
} from '@/daemon/sessions/sessionTrackingKey';

export function resolveSessionWebhookPath(
  inputPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return expandHomeDirPath(inputPath.trim(), env, platform);
}

function shouldRequireCanonicalRunnerMarkerAdoption(
  tracked: TrackedSession,
  isPlaceholderSessionId: boolean,
  hasPendingStartup: boolean,
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
      || (
        hasPendingStartup
        && !tracked.spawnStartupCanonicalSessionId
        && tracked.spawnOptions !== undefined
        && !tracked.spawnOptions.existingSessionId?.trim()
      )
    )
  );
}

function describeCanonicalStartupReadinessFailure(error: unknown): string {
  try {
    const code =
      error && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : undefined;
    const message = error instanceof Error
      ? error.message.trim()
      : String(error).trim();
    const codePrefix = typeof code === 'string' || typeof code === 'number'
      ? `${code}: `
      : '';
    return `${codePrefix}${message || 'Unknown error'}`;
  } catch {
    return 'Unknown error';
  }
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
  _isPlaceholderSessionId: boolean,
): void {
  if (bindTrackedSessionIdentity(tracked, sessionId, true)) tracked.happySessionMetadataFromLocalWebhook = metadata;
}

/** Foreground identity registration is shared by reports and pre-runtime materialization. */
function registerExternalTrackedSession(input: Readonly<{
  trackedSessionsByKey: TrackedSessionMap;
  pid: number;
  sessionId: string;
  metadata: Metadata;
}>): TrackedSession {
  const existing = trackedSessionForSingleSessionProcess(input.trackedSessionsByKey, input.pid);
  if (existing) return existing;
  const path = resolveSessionWebhookPath(input.metadata.path);
  const metadata = path === input.metadata.path ? input.metadata : { ...input.metadata, path };
  const tracked: TrackedSession = { trackingKey: mintSessionTrackingKey(), startedBy: 'happy directly - likely by user from terminal',
    happySessionId: input.sessionId, happySessionMetadataFromLocalWebhook: metadata, pid: input.pid };
  trackSession(input.trackedSessionsByKey, tracked);
  invalidateProcessLaunchDiscovery();
  return tracked;
}

/** Uses the report's existing marker writer without admitting runtime readiness. */
async function persistForegroundSessionMarker(input: Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  metadata: Metadata;
  processIdentity: Awaited<ReturnType<typeof readProcessIdentityByPid>>;
  writeSessionMarkerFn?: typeof writeSessionMarker;
}>): Promise<void> {
  const processCommand = input.processIdentity?.command?.trim() ? input.processIdentity.command : undefined;
  const processCommandHash = processCommand ? hashProcessCommand(processCommand) : undefined;
  const processStartTimeMs = input.processIdentity?.processStartTimeMs;
  input.tracked.processCommand = processCommand;
  input.tracked.processCommandHash = processCommandHash;
  input.tracked.processStartTimeMs = processStartTimeMs;
  if (processStartTimeMs !== undefined && processCommandHash) adoptTrackedSessionRunnerIdentity(input.tracked, {
    pid: input.tracked.pid, processStartTimeMs, processCommandHash, processCommand,
  });
  await (input.writeSessionMarkerFn ?? writeSessionMarker)({ trackingKey: input.tracked.trackingKey, pid: input.tracked.pid, happySessionId: input.sessionId,
    startedBy: input.metadata.startedBy ?? 'terminal', cwd: input.metadata.path, metadata: input.metadata,
    processCommand, processCommandHash, processStartTimeMs });
}

/** Registers foreground process custody through the same tracker and marker owner as ordinary reports. */
export async function registerExternalSessionIdentity(input: Readonly<{
  trackedSessionsByKey: TrackedSessionMap;
  pid: number;
  sessionId: string;
  metadata: Metadata;
}>): Promise<TrackedSession | null> {
  const existing = trackedSessionForSingleSessionProcess(input.trackedSessionsByKey, input.pid);
  const tracked = registerExternalTrackedSession(input);
  const custody = tracked.reportMarkerCustody ??= { pending: Promise.resolve(), retiring: false };
  if (custody.retiring) return null;
  const isCurrent = () => isCurrentTrackedSession(input.trackedSessionsByKey, tracked) && !custody.retiring;
  let accepted = false;
  // Register custody before the first OS await: exit retirement must include
  // this pending observation, not allow it to publish a new owner afterwards.
  const observeIdentity = async (): Promise<TrackedSession | null> => {
    try {
      const processIdentity = await readProcessIdentityByPid(input.pid);
      const runState = await readProcessRunState(input.pid);
      if (!isCurrent() || !processIdentity) return null;
      const expectedStart = input.metadata.hostProcessStartTimeMs;
      if (expectedStart !== undefined && !processIdentityMatches({ pid: input.pid, processStartTimeMs: expectedStart }, processIdentity)) {
        return null;
      }
      const presence = classifySessionRunnerProcessPresence({ runState,
        storedProcessStartTimeMs: expectedStart ?? tracked.processStartTimeMs,
        observedProcessStartTimeMs: processIdentity.processStartTimeMs,
        storedProcessCommandHash: tracked.processCommandHash,
        observedProcessCommandHash: processIdentity.command ? hashProcessCommand(processIdentity.command) : undefined });
      if (presence !== 'present' && presence !== 'recoverable_stopped') return null;
      if (!bindTrackedSessionIdentity(tracked, input.sessionId)) return null;
      if (tracked.startedBy !== 'daemon') {
        tracked.sessionMarkerPersistence = marker;
        await persistForegroundSessionMarker({ tracked, sessionId: input.sessionId,
          metadata: tracked.happySessionMetadataFromLocalWebhook ?? input.metadata, processIdentity });
      }
      accepted = isCurrent();
      return accepted ? tracked : null;
    } catch {
      return null;
    } finally {
      // Drop only this attempt's provisional record. An ordinary report can
      // adopt the same tracker while OS I/O is pending; its custody is retained.
      if (!existing && isCurrent() && tracked.sessionMarkerPersistence === marker && !accepted) {
        untrackSession(input.trackedSessionsByKey, tracked);
      }
    }
  };
  const work = observeIdentity();
  const marker = work.then(result => result !== null);
  if (!existing) tracked.sessionMarkerPersistence = marker;
  custody.pending = Promise.all([custody.pending, work]).then(() => {});
  return work;
}

function didDaemonWebhookPidTimeOut(
  input: Readonly<{
    pid: number;
    metadata: Metadata;
    trackedSessionsByKey: TrackedSessionMap;
  }>,
): boolean {
  if (input.metadata.startedBy !== 'daemon') return false;
  return didSessionWebhookTimeout(trackedSessionForSingleSessionProcess(input.trackedSessionsByKey, input.pid));
}

function didDaemonWebhookParentTimeOut(
  input: Readonly<{
    parentPid: number | null;
    metadata: Metadata;
    trackedSessionsByKey: TrackedSessionMap;
  }>,
): boolean {
  if (input.metadata.startedBy !== 'daemon' || typeof input.parentPid !== 'number') return false;
  return didSessionWebhookTimeout(trackedSessionForSingleSessionProcess(input.trackedSessionsByKey, input.parentPid));
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
 * The spawn result for an exact no-effect Session creation refusal, whichever
 * creator (the runner, or the daemon committing before launch) met it.
 */
export function buildSessionCreationTerminalSpawnErrorResult(
  errorDetail: SessionCreationTerminalSpawnErrorDetail,
): DaemonSpawnStartupReadinessFailure {
  if (errorDetail.kind === 'session_creation_currentness_unavailable') {
    return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: `Session creation could not proceed: Account encryption currentness is unavailable (${errorDetail.reason}).`,
      errorDetail };
  }
  return {
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
    errorMessage: errorDetail.kind === 'session_creation_correspondence_conflict'
      ? 'Session creation correspondence conflicts with the existing Session'
      : errorDetail.kind === 'update_required'
        ? 'Session initial access requires updated collaboration support'
        : errorDetail.kind === 'session_creation_initial_trigger_refused'
          ? 'Session initial trigger admission was refused'
        : 'Session creation organization placement is invalid',
    errorDetail,
  };
}

/**
 * Settles the pre-existing spawn webhook waiter when the runner reaches the
 * server create-or-load boundary but receives its exact organization-placement
 * rejection before it has a Session to report. The nonce is the daemon-owned
 * attempt identity; a report must never select an arbitrary pending waiter.
 */
export function createOnDaemonSessionStartupFailure(params: Readonly<{
  trackedSessionsByKey: TrackedSessionMap;
  spawnAwaiterByKey: Map<SessionTrackingKey, (session: TrackedSession) => void>;
}>): (input: Readonly<{
  spawnNonce: string;
  errorDetail: SessionCreationTerminalSpawnErrorDetail;
}>) => boolean {
  return (input) => {
    const spawnNonce = input.spawnNonce.trim();
    if (!spawnNonce) return false;

    const candidates = [...params.trackedSessionsByKey.values()].filter((tracked) => {
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
      return params.spawnAwaiterByKey.has(tracked.trackingKey);
    });

    // A nonce must designate one live, pending spawn. Ambiguity and stale
    // reports deliberately do nothing rather than waking another attempt.
    if (candidates.length !== 1) return false;
    const tracked = candidates[0]!;
    const awaiter = params.spawnAwaiterByKey.get(tracked.trackingKey);
    if (!awaiter) return false;

    tracked.spawnStartupReadinessFailure ??=
      buildSessionCreationTerminalSpawnErrorResult(input.errorDetail);
    // Claim before invoking the existing waiter so duplicate/later callbacks
    // cannot race its cleanup path or settle this spawn twice.
    params.spawnAwaiterByKey.delete(tracked.trackingKey);
    awaiter(tracked);
    return true;
  };
}

export function createOnHappySessionWebhook(params: Readonly<{
  trackedSessionsByKey: TrackedSessionMap;
  spawnAwaiterByKey: Map<SessionTrackingKey, (session: TrackedSession) => void>;
  deviceLocalSecretStorage?: DeviceLocalSecretStorage;
  findHappyProcessByPidFn?: typeof findHappyProcessByPid;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
  readAllWindowsProcessFactsFn?: () => Promise<
    ReadonlyMap<number, ProcessCensusProcessFact>
  >;
  listSessionMarkersFn?: typeof listSessionMarkers;
  writeSessionMarkerFn?: typeof writeSessionMarker;
  promoteSessionMarkerFn?: typeof promoteSessionMarkerPid;
  getParentPidFn?: (pid: number) => number | null | Promise<number | null>;
  readCredentialsFn?: typeof readStoredCredentials;
  onTrackedSessionReady?: (tracked: TrackedSession) => Promise<void>;
  onTrackedSessionReported?: (tracked: TrackedSession) => Promise<void> | void;
  /** Private checkout persistence follows accepted canonical startup facts only. */
  registerAcceptedWorkspace?: (metadata: Metadata, sessionId: string) => Promise<void>;
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
  reportedTrackingKey?: SessionTrackingKey | null,
) => Promise<void> {
  const {
    trackedSessionsByKey,
    spawnAwaiterByKey,
    findHappyProcessByPidFn = findHappyProcessByPid,
    readProcessIdentityByPidFn = readProcessIdentityByPid,
    readAllWindowsProcessFactsFn =
      readAllWindowsProcessFacts,
    listSessionMarkersFn = listSessionMarkers,
    writeSessionMarkerFn = writeSessionMarker,
    promoteSessionMarkerFn = promoteSessionMarkerPid,
    getParentPidFn = getParentPid,
    readCredentialsFn = readStoredCredentials,
    onTrackedSessionReady,
    onTrackedSessionReported,
    registerAcceptedWorkspace,
    onPidPromoted,
  } = params;

  return async (
    sessionId: string,
    sessionMetadata: Metadata,
    reconcileCanonicalReadiness?: (tracked: TrackedSession) => Promise<void>,
    sessionCreationOutcome?: SessionCreationOutcome,
    reportedTrackingKey?: SessionTrackingKey | null,
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
    logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(trackedSessionsByKey.values(), (tracked) => tracked.pid).join(', ')}`);

    if (didDaemonWebhookPidTimeOut({ pid, metadata: normalizedMetadata, trackedSessionsByKey })) {
      logger.debug(`[DAEMON RUN] Ignoring late session webhook for timed-out daemon PID ${pid}: ${sessionId}`);
      return;
    }

    // The OS sample is only admission evidence for a still-unmatched daemon
    // report. Re-read correlation maps after this await; acceptance can arrive
    // while the existing process-state boundary is inspecting the runner.
    // A report names its Session by the key its daemon spawn handed it; the
    // key counts only from the process that Session is tracked on, so an
    // inherited key in a descendant process never claims it.
    const resolveReportedSession = (): TrackedSession | undefined => {
      const keyedSession = reportedTrackingKey
        ? trackedSessionsByKey.get(reportedTrackingKey)
        : undefined;
      return keyedSession?.pid === pid || keyedSession?.sessionRunnerPid === pid
        ? keyedSession
        : trackedSessionForSingleSessionProcess(trackedSessionsByKey, pid);
    };
    const untrackedDaemonRunState = normalizedMetadata.startedBy === 'daemon'
      && !resolveReportedSession()
      && !findTrackedSessionByRunnerPid(trackedSessionsByKey, pid)
        ? await readProcessRunState(pid)
        : null;
    const rejectDeadExternalDaemonReport = (): boolean => {
      if (untrackedDaemonRunState !== 'dead' && untrackedDaemonRunState !== 'zombie') return false;
      logger.infoFile('[DAEMON RUN] Warning: ignored positively dead untracked daemon report', { pid });
      return true;
    };
    // Check if we already have this PID (daemon-spawned)
    const reportedSession = resolveReportedSession();
    const existingSession = reportedSession?.pid === pid ? reportedSession : undefined;
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
          spawnAwaiterByKey.has(existingSession.trackingKey),
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
        if (isPlaceholderSessionId && spawnAwaiterByKey.has(existingSession.trackingKey)) {
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
      const trackedByRunnerPid = reportedSession?.sessionRunnerPid === pid
        ? reportedSession
        : findTrackedSessionByRunnerPid(trackedSessionsByKey, pid);
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
              trackedSessionsByKey,
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
          adoptTrackedSessionRunnerIdentity(trackedByRunnerPid, exactMatch.cancellationIdentity);
          windowsTerminalHostPid =
            trackedByRunnerPid.pid;
        }
        trackedForPid = trackedByRunnerPid;
        requiresCanonicalMarkerAdoption =
          shouldRequireCanonicalRunnerMarkerAdoption(
            trackedByRunnerPid,
            isPlaceholderSessionId,
          spawnAwaiterByKey.has(trackedByRunnerPid.trackingKey),
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
          && spawnAwaiterByKey.has(trackedByRunnerPid.trackingKey)
        ) {
          logger.debug(
            `[DAEMON RUN] Deferred awaiter resolution for wrapper PID ${trackedByRunnerPid.pid}; waiting for canonical session id`,
          );
        }
      } else {
        const ordinaryParent = await resolveOrdinaryDaemonParentCorrelation({
          metadata: normalizedMetadata, pid, trackedSessionsByKey, spawnAwaiterByKey, getParentPidFn,
        });
        const ordinaryParentPid = ordinaryParent.parentPid;
        const ordinaryParentSession = ordinaryParent.tracked;
        const ordinaryParentHasAwaiter = ordinaryParent.hasAwaiter;
        const ordinaryParentHasChildHandle = ordinaryParent.hasChildHandle;
        const ordinaryParentEligible = ordinaryParent.eligible;
        const windowsTerminalMatch =
          !ordinaryParentEligible
            ? await findPendingWindowsTerminalTrackedSession({
                trackedSessionsByKey,
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
          adoptTrackedSessionRunnerIdentity(windowsTerminalSession, windowsTerminalMatch.cancellationIdentity);
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
        } else if (spawnAwaiterByKey.size === 0) {
          const parentPid = normalizedMetadata.startedBy === 'daemon' ? await getParentPidFn(pid) : null;
          if (didDaemonWebhookParentTimeOut({ parentPid, metadata: normalizedMetadata, trackedSessionsByKey })) {
            logger.debug(`[DAEMON RUN] Ignoring late child webhook for timed-out daemon wrapper PID ${parentPid}: ${sessionId}`);
            return;
          }

          if (rejectDeadExternalDaemonReport()) return;
          const trackedSession = registerExternalTrackedSession({ trackedSessionsByKey, pid, sessionId, metadata: normalizedMetadata });
          trackedForPid = trackedSession;
          logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
        } else {
          const ppid = ordinaryParentPid;
          const parentSession = ordinaryParentSession;
          const hasAwaiter = ordinaryParentHasAwaiter;
          const hasChildHandle = ordinaryParentHasChildHandle;
          if (didDaemonWebhookParentTimeOut({ parentPid: ppid, metadata: normalizedMetadata, trackedSessionsByKey })) {
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
          spawnAwaiterByKey.has(parentSession.trackingKey),
              );
            parentSession.sessionRunnerPid = pid;
            adoptReportedSessionIdentity(
              parentSession,
              sessionId,
              normalizedMetadata,
              isPlaceholderSessionId,
            );
            logger.debug(`[DAEMON RUN] Matched session webhook PID ${pid} to daemon wrapper PID ${ppid}`);

            if (isPlaceholderSessionId && spawnAwaiterByKey.has(parentSession.trackingKey)) {
              logger.debug(
                `[DAEMON RUN] Deferred awaiter resolution for wrapper PID ${ppid}; waiting for canonical session id`,
              );
            }
          } else {
            // New session started externally (not by this daemon)
            if (rejectDeadExternalDaemonReport()) return;
            const trackedSession = registerExternalTrackedSession({ trackedSessionsByKey, pid, sessionId, metadata: normalizedMetadata });
            trackedForPid = trackedSession;
            logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
          }
        }
      }
    }

    const markerCustody = trackedForPid
      ? trackedForPid.reportMarkerCustody ??= { pending: Promise.resolve(), retiring: false }
      : null;
    const reportTargetsTrackedOwner = trackedForPid?.pid === pid;
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
      const markerTrackingKey = trackedForPid.trackingKey;
      const existingMarker = markers
        .filter((marker) => marker.trackingKey === markerTrackingKey && marker.pid === currentSessionMarkerPid)
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
        !isCurrentTrackedSession(trackedSessionsByKey, trackedDaemonCanonicalSession)
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
      if (!requiresCanonicalMarkerAdoption && reportTargetsTrackedOwner && trackedForPid?.pid !== pid) return;
      const currentSessionMarkerPid = resolveSessionMarkerPid();
      const processIdentity = await readProcessIdentityByPidFn(currentSessionMarkerPid);
      await awaitTrackedMarkerPromotion();
      if (!requiresCanonicalMarkerAdoption && reportTargetsTrackedOwner && trackedForPid?.pid !== pid) return;
      if (currentSessionMarkerPid !== resolveSessionMarkerPid()) {
        await persistSessionMarker(beforeStartupReadiness);
        return;
      }
      if (trackedForPid && (trackedForPid.runnerProcessIdentity?.pid !== pid || !trackedForPid.runnerProcessIdentity.processCommand)) {
        const runnerIdentity = currentSessionMarkerPid === pid
          ? processIdentity
          : await readProcessIdentityByPidFn(pid).catch((error) => {
            logger.infoFile('[DAEMON RUN] Runner identity unavailable during session report', { pid, error });
            return null;
          });
        await awaitTrackedMarkerPromotion();
        if (!requiresCanonicalMarkerAdoption && reportTargetsTrackedOwner && trackedForPid.pid !== pid) return;
        if (currentSessionMarkerPid !== resolveSessionMarkerPid()) {
          await persistSessionMarker(beforeStartupReadiness);
          return;
        }
        if ((trackedForPid.sessionRunnerPid === undefined || trackedForPid.sessionRunnerPid === pid)
          && runnerIdentity?.processStartTimeMs !== undefined && typeof runnerIdentity.command === 'string' && runnerIdentity.command.trim()) {
          adoptTrackedSessionRunnerIdentity(trackedForPid, {
            pid: runnerIdentity.pid,
            processStartTimeMs: runnerIdentity.processStartTimeMs,
            processCommandHash: hashProcessCommand(runnerIdentity.command),
            processCommand: runnerIdentity.command,
          });
        }
      }

      const processCommand =
        typeof processIdentity?.command === 'string' && processIdentity.command.trim().length > 0
          ? processIdentity.command
          : undefined;
      const processCommandHash = processCommand ? hashProcessCommand(processCommand) : undefined;
      const processStartTimeMs = processIdentity?.processStartTimeMs;
      if (trackedForPid && processIdentity?.pid === trackedForPid.pid) {
        trackedForPid.processCommandHash = processCommandHash;
        trackedForPid.processCommand = processCommand;
        trackedForPid.processStartTimeMs = processStartTimeMs;
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
      if (!requiresCanonicalMarkerAdoption && reportTargetsTrackedOwner && trackedForPid?.pid !== pid) return;
      if (currentSessionMarkerPid !== resolveSessionMarkerPid()) {
        await persistSessionMarker(beforeStartupReadiness);
        return;
      }
      if (trackedForPid && trackedForPid.startedBy !== 'daemon') {
        await persistForegroundSessionMarker({ tracked: trackedForPid, sessionId, metadata: persistedMetadata,
          processIdentity, writeSessionMarkerFn });
        return;
      }
      if (!trackedForPid) return;
      const markerTrackingKey = trackedForPid.trackingKey;
      await writeSessionMarkerFn(
        {
          trackingKey: markerTrackingKey,
          pid: currentSessionMarkerPid,
          happySessionId: sessionId,
          startedBy: persistedMetadata.startedBy ?? 'terminal',
          cwd: normalizedPath,
          processCommandHash,
          processStartTimeMs,
          processCommand,
          metadata: persistedMetadata,
          ...(respawn ? { respawn } : {}),
          // The spawn-captured binding is a Session fact. A reattaching daemon
          // adopts this runner marker, so it must carry the binding that
          // authorizes the Session's shared native-state observation files.
          ...(trackedForPid?.startedBy === 'daemon'
            && trackedForPid.materializedStateObservationBinding
            ? {
                materializedStateObservationBinding:
                  trackedForPid.materializedStateObservationBinding,
              }
            : {}),
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
      if (requiresCanonicalMarkerAdoption && currentSessionMarkerPid !== pid) {
        // A live launch wrapper retains process/exit custody, while daemon-service
        // authority belongs to the reported runner. Materialize its exact marker
        // through the existing promotion owner before installing that authority.
        const runnerIdentity = trackedForPid?.runnerProcessIdentity;
        if (!runnerIdentity || runnerIdentity.pid !== pid) {
          throw new Error('Canonical Session runner identity is unavailable');
        }
        const promotion = await promoteSessionMarkerFn({
          trackingKey: markerTrackingKey,
          fromPid: currentSessionMarkerPid,
          toPid: pid,
        });
        await awaitTrackedMarkerPromotion();
        if (
          trackedForPid?.runnerProcessIdentity !== runnerIdentity
          || promotion?.targetMarkerOwnership?.happySessionId !== sessionId
          || !processIdentityMatches(runnerIdentity, {
            pid,
            processStartTimeMs: promotion.targetMarkerOwnership.processStartTimeMs,
            processCommandHash: promotion.targetMarkerOwnership.processCommandHash,
          })
        ) {
          throw new Error('Canonical Session runner marker identity changed');
        }
      }
    };
    const runReportMarkerPersistence = (beforeStartupReadiness = false): Promise<void> => {
      if (markerCustody?.retiring) {
        return requiresCanonicalMarkerAdoption
          ? Promise.reject(new Error('Daemon session marker custody is retiring'))
          : Promise.resolve();
      }
      const work = persistSessionMarker(beforeStartupReadiness);
      if (markerCustody) {
        markerCustody.pending = Promise.all([
          markerCustody.pending,
          work.catch(() => {
            logger.infoFile('[DAEMON RUN] Warning: failed to persist correlated session marker', { pid });
          }),
        ]).then(() => {});
      }
      return work;
    };
    let ordinaryMarkerPersistence: Promise<boolean> | null = null;
    const startOrdinaryMarkerPersistence = (
      beforeStartupReadiness = false,
    ): Promise<boolean> => {
      if (ordinaryMarkerPersistence) return ordinaryMarkerPersistence;
      ordinaryMarkerPersistence = runReportMarkerPersistence(
        beforeStartupReadiness,
      )
        .then(() => true)
        .catch(() => {
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
      // Windows Terminal's exact accepted-marker callback is the sole writer
      // for this startup. Letting the provisional PID webhook also start the
      // ordinary writer can race after canonical admission and restore the
      // PID placeholder over the accepted Session identity.
      && !trackedForPid
        ?.persistWindowsTerminalAcceptedAgentMarker
    ) {
      void startOrdinaryMarkerPersistence();
    }

    const registerAcceptedCanonicalWorkspace = (): void => {
      if (isPlaceholderSessionId || !registerAcceptedWorkspace) return;
      // Workspace metadata cannot delay or overturn the accepted Session start.
      void Promise.resolve().then(() => registerAcceptedWorkspace(normalizedMetadata, sessionId)).catch((error: unknown) => {
        logger.debug('[DAEMON RUN] Accepted Session workspace registration failed', serializeAxiosErrorForLog(error));
      });
    };
    if (!trackedDaemonCanonicalSession || !startupReadinessGate) {
      registerAcceptedCanonicalWorkspace();
      return;
    }
    const reconcileTrackedDaemonCanonicalWebhook =
      async (): Promise<void> => {
    const completeSpawnAwaiter = async (): Promise<void> => {
      const awaiterKey = trackedDaemonCanonicalSession.trackingKey;
      const awaiter = spawnAwaiterByKey.get(awaiterKey);
      if (!awaiter) return;
      spawnAwaiterByKey.delete(awaiterKey);
      await awaiter(trackedDaemonCanonicalSession);
      logger.debug(
        `[DAEMON RUN] Resolved session awaiter for canonical session ${sessionId} via PID ${trackedDaemonCanonicalSession.pid}`,
      );
    };
    const identityFailure =
      trackedDaemonCanonicalSession
        .spawnStartupReadinessFailure;
    if (identityFailure) {
      startupReadinessGate.resolve(false);
      await completeSpawnAwaiter();
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
            .runnerProcessIdentity;
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
      const promoted =
        await promoteTrackedSessionPidCustody({
          fromPid: windowsTerminalHostPid,
          toPid: pid,
          trackedSession: trackedDaemonCanonicalSession,
          trackedSessionsByKey,
          promoteSessionMarkerFn,
          requireExactTargetOwnership: true,
          expectedTargetProcessIdentity:
            trackedDaemonCanonicalSession
              .runnerProcessIdentity,
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
        await runReportMarkerPersistence();
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
      invalidateProcessLaunchDiscovery();
      await awaitTrackedMarkerPromotion();
      const hasActiveSpawnAwaiter = spawnAwaiterByKey.has(trackedDaemonCanonicalSession.trackingKey);
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
        '[DAEMON RUN] Canonical Session startup readiness failed: '
          + describeCanonicalStartupReadinessFailure(error),
        error,
      );
      trackedDaemonCanonicalSession.spawnStartupReadinessFailure ??= {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: 'Session startup reconciliation failed',
      };
      startupReadinessGate?.resolve(false);
      await completeSpawnAwaiter();
      throw error;
    }
    startupReadinessGate.resolve(true);
    await completeSpawnAwaiter();
    registerAcceptedCanonicalWorkspace();
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
