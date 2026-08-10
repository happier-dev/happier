import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { parseOptionalBooleanEnv } from '@happier-dev/protocol';
import {
  hasTerminalAttachmentControlDescriptorThroughCatalog,
  resolveCatalogAgentIdForCliSubcommand,
} from '@/backends/catalog';
import type { AgentId } from '@/agent/core';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';
import {
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  type SessionRunnerRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from '../processSupervision/sessionRunnerRespawnDescriptor';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { resolveSessionRuntimeSnapshot } from './runtimeSnapshot/resolveSessionRuntimeSnapshot';

import type { TrackedSession } from '../types';
import { findAllHappyProcesses, findHappyProcessByPid, type HappyProcessInfo } from '../doctor';
import { adoptSessionsFromMarkers, isOwnedLiveDaemonSessionProcessCommand } from '../reattach';
import {
  clearSessionMarkerConnectedServiceRestartIntent,
  hashProcessCommand,
  listSessionMarkers,
  writeSessionMarker,
  type DaemonSessionMarker,
} from '../sessionRegistry';
import { extractResumeIdFromCommand } from './extractResumeIdFromCommand';
import {
  readTerminalAttachmentState,
} from '@/terminal/attachment/terminalAttachmentInfo';
import type { DisconnectedTerminalHostCandidate } from './disconnectedTerminalHostSupervision';

function extractExistingSessionIdFromCommand(command: string): string | null {
  const match = /(?:^|\s)--existing-session(?:=|\s+)(\S+)/.exec(command);
  const sessionId = typeof match?.[1] === 'string' ? match[1].trim() : '';
  return sessionId || null;
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMarkerAgentId(value: unknown): AgentId | null {
  return typeof value === 'string' && (CATALOG_AGENT_IDS as readonly string[]).includes(value)
    ? value as AgentId
    : null;
}

function readRuntimeSnapshotMetadata(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function shouldRecoverMarkerlessDaemonSpawnedSessions(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseOptionalBooleanEnv(env.HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED) !== false;
}

function indicatesDaemonStartedSessionCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim();
  return /(?:^|[\s"])--started-by"?(?:=|\s+)\s*"?daemon"?(?=$|[\s"])/i.test(normalized);
}

function extractBackendTargetFromCommand(command: string): SpawnSessionOptions['backendTarget'] | undefined {
  const happyStartingModeIndex = command.indexOf(' --happy-starting-mode');
  if (happyStartingModeIndex <= 0) return undefined;
  const beforeHappyStartingMode = command.slice(0, happyStartingModeIndex).trim();
  const subcommand = beforeHappyStartingMode.split(/\s+/).pop()?.trim() ?? '';
  if (!subcommand) return undefined;
  const agentId = resolveCatalogAgentIdForCliSubcommand(subcommand);
  return agentId ? { kind: 'builtInAgent', agentId } : undefined;
}

function buildRecoveredSpawnOptions(
  processInfo: Readonly<{ command: string; cwd?: string; environmentVariables?: Record<string, string> }>,
): SpawnSessionOptions | undefined {
  const directory = typeof processInfo.cwd === 'string' ? processInfo.cwd.trim() : '';
  const backendTarget = extractBackendTargetFromCommand(processInfo.command);
  if (!directory || !backendTarget) {
    return undefined;
  }

  const resume = extractResumeIdFromCommand(processInfo.command);
  return {
    directory,
    backendTarget,
    ...(resume ? { resume } : {}),
    ...(processInfo.environmentVariables ? { environmentVariables: processInfo.environmentVariables } : {}),
  };
}

function mergeRecoveredSpawnOptions(params: Readonly<{
  liveSpawnOptions?: SpawnSessionOptions;
  respawnSpawnOptions?: SpawnSessionOptions;
}>): SpawnSessionOptions | undefined {
  const { liveSpawnOptions, respawnSpawnOptions } = params;
  const directory = liveSpawnOptions?.directory ?? respawnSpawnOptions?.directory;
  if (!directory) {
    return undefined;
  }

  const environmentVariables =
    liveSpawnOptions?.environmentVariables || respawnSpawnOptions?.environmentVariables
      ? {
        ...(respawnSpawnOptions?.environmentVariables ?? {}),
        ...(liveSpawnOptions?.environmentVariables ?? {}),
      }
      : undefined;

  return {
    directory,
    ...(respawnSpawnOptions ?? {}),
    ...(liveSpawnOptions ?? {}),
    ...(environmentVariables ? { environmentVariables } : {}),
  };
}

function applyRecoveredRuntimeSnapshot(params: Readonly<{
  spawnOptions?: SpawnSessionOptions;
  metadata?: unknown;
  vendorResumeId?: string | null;
}>): SpawnSessionOptions | undefined {
  if (!params.spawnOptions) return undefined;
  return resolveSessionRuntimeSnapshot({
    incomingOptions: params.spawnOptions,
    persistedMetadata: readRuntimeSnapshotMetadata(params.metadata),
    trackedVendorResumeId: params.vendorResumeId ?? null,
  }).spawnOptions;
}

function parseRecoveredRespawnDescriptor(respawn: unknown): SessionRunnerRespawnDescriptorV1 | null {
  const parsedRespawn = SessionRunnerRespawnDescriptorV1Schema.safeParse(respawn);
  return parsedRespawn.success ? parsedRespawn.data : null;
}

function buildRecoveredRespawnDescriptor(params: Readonly<{
  spawnOptions?: SpawnSessionOptions;
  parsedRespawnDescriptor: SessionRunnerRespawnDescriptorV1 | null;
  credentials?: Credentials | null;
}>): SessionRunnerRespawnDescriptorV1 | null {
  const { spawnOptions, parsedRespawnDescriptor, credentials } = params;
  const rebuiltRespawn = spawnOptions
    ? buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions, {
      encryptionMaterial: credentials?.encryption,
    })
    : null;
  if (!parsedRespawnDescriptor) {
    return rebuiltRespawn;
  }
  if (!rebuiltRespawn) {
    return parsedRespawnDescriptor;
  }

  const mergedRespawn = SessionRunnerRespawnDescriptorV1Schema.safeParse({
    ...parsedRespawnDescriptor,
    ...rebuiltRespawn,
    ...(parsedRespawnDescriptor.sealedEnvironmentVariables && !rebuiltRespawn.sealedEnvironmentVariables
      ? { sealedEnvironmentVariables: parsedRespawnDescriptor.sealedEnvironmentVariables }
      : {}),
  });
  return mergedRespawn.success ? mergedRespawn.data : rebuiltRespawn;
}

function restoreSpawnOptionsFromRespawnDescriptor(params: Readonly<{
  parsedRespawnDescriptor: SessionRunnerRespawnDescriptorV1 | null;
  credentials?: Credentials | null;
}>): SpawnSessionOptions | undefined {
  const { parsedRespawnDescriptor, credentials } = params;
  if (!parsedRespawnDescriptor) {
    return undefined;
  }
  try {
    return buildSpawnSessionOptionsFromRespawnDescriptorV1(parsedRespawnDescriptor, {
      encryptionMaterial: credentials?.encryption,
    });
  } catch {
    return undefined;
  }
}

function readConnectedServiceRestartIntent(marker: DaemonSessionMarker): Readonly<{
  requestedAtMs: number;
}> | null {
  const intent = marker.connectedServiceRestartIntent;
  if (!intent || intent.v !== 1) return null;
  return {
    requestedAtMs: Math.max(0, Math.trunc(intent.requestedAtMs)),
  };
}

async function recoverMarkerlessDaemonSpawnedSessions(params: Readonly<{
  happyProcesses: ReadonlyArray<{
    pid: number;
    command: string;
    type: string;
    cwd?: string;
    environmentVariables?: Record<string, string>;
  }>;
  incompleteMarkerByPid: ReadonlyMap<number, Readonly<{
    happySessionId: string;
    startedBy?: string;
    cwd?: string;
    metadata?: unknown;
    respawn?: unknown;
    connectedServiceRestartIntent?: DaemonSessionMarker['connectedServiceRestartIntent'];
  }>>;
  markedPids: ReadonlySet<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
  credentials?: Credentials | null;
}>): Promise<number> {
  const { happyProcesses, incompleteMarkerByPid, markedPids, pidToTrackedSession, credentials } = params;
  let recovered = 0;

  for (const processInfo of happyProcesses) {
    if (markedPids.has(processInfo.pid) || pidToTrackedSession.has(processInfo.pid)) {
      continue;
    }
    const incompleteMarker = incompleteMarkerByPid.get(processInfo.pid);
    const isGenericHappySession = processInfo.type === 'user-session' || processInfo.type === 'dev-session';
    const liveExistingSessionId = extractExistingSessionIdFromCommand(processInfo.command);
    const incompleteMarkerSessionId =
      typeof incompleteMarker?.happySessionId === 'string' ? incompleteMarker.happySessionId.trim() : '';
    const incompleteMarkerStartedBy =
      typeof incompleteMarker?.startedBy === 'string' ? incompleteMarker.startedBy.trim() : '';
    const incompleteMarkerHasRespawnDescriptor = !!(incompleteMarker && typeof incompleteMarker.respawn === 'object' && incompleteMarker.respawn !== null);
    const normalizedProcessCommand = processInfo.command.trim().toLowerCase();
    const liveCommandLooksLikeBareRuntime =
      normalizedProcessCommand === 'node'
      || normalizedProcessCommand === 'bun'
      || normalizedProcessCommand === 'tsx'
      || normalizedProcessCommand === 'node.exe'
      || normalizedProcessCommand === 'bun.exe'
      || normalizedProcessCommand === 'tsx.exe';
    const canRecoverFromIncompleteMarker =
      incompleteMarker &&
      isGenericHappySession &&
      !!liveExistingSessionId &&
      liveExistingSessionId === incompleteMarkerSessionId;
    const canRecoverDaemonSessionFromIncompleteMarker =
      incompleteMarker &&
      (
        processInfo.type === 'daemon-spawned-session' ||
        processInfo.type === 'dev-daemon-spawned' ||
        indicatesDaemonStartedSessionCommand(processInfo.command) ||
        (isGenericHappySession && incompleteMarkerHasRespawnDescriptor && liveCommandLooksLikeBareRuntime)
      ) &&
      incompleteMarkerStartedBy === 'daemon' &&
      !!incompleteMarkerSessionId;
    if (
      processInfo.type !== 'daemon-spawned-session' &&
      processInfo.type !== 'dev-daemon-spawned' &&
      !canRecoverFromIncompleteMarker &&
      !canRecoverDaemonSessionFromIncompleteMarker
    ) {
      continue;
    }
    if (!isOwnedLiveDaemonSessionProcessCommand(processInfo.command)) {
      if (canRecoverDaemonSessionFromIncompleteMarker) {
        // CLI update takeover can reattach daemon-started runners from a previous runtime root
        // when the prior daemon only persisted incomplete markers (no process-command hash).
      } else {
        continue;
      }
    }

    const happySessionId = canRecoverDaemonSessionFromIncompleteMarker
      ? liveExistingSessionId || incompleteMarkerSessionId
      : isGenericHappySession
        ? liveExistingSessionId
        : liveExistingSessionId ?? incompleteMarkerSessionId;
    if (!happySessionId) {
      continue;
    }

    const processCommandHash = hashProcessCommand(processInfo.command);
    const parsedRespawnDescriptor = parseRecoveredRespawnDescriptor(incompleteMarker?.respawn);
    const liveSpawnOptions = buildRecoveredSpawnOptions({
      ...processInfo,
      cwd: processInfo.cwd ?? incompleteMarker?.cwd,
    });
    const respawnSpawnOptions = restoreSpawnOptionsFromRespawnDescriptor({
      parsedRespawnDescriptor,
      credentials,
    });
    const recoveredSpawnOptions = mergeRecoveredSpawnOptions({
      liveSpawnOptions,
      respawnSpawnOptions,
    });
    const vendorResumeId = extractResumeIdFromCommand(processInfo.command);
    const spawnOptions = applyRecoveredRuntimeSnapshot({
      spawnOptions: recoveredSpawnOptions,
      metadata: incompleteMarker?.metadata,
      vendorResumeId,
    });
    const trackedSession: TrackedSession = {
      startedBy: 'daemon',
      happySessionId,
      pid: processInfo.pid,
      processCommandHash,
      processCommand: processInfo.command,
      reattachedFromDiskMarker: true,
      ...(vendorResumeId ? { vendorResumeId } : {}),
      ...(spawnOptions ? { spawnOptions } : {}),
    };
    pidToTrackedSession.set(processInfo.pid, trackedSession);

    const respawn = buildRecoveredRespawnDescriptor({
      spawnOptions,
      parsedRespawnDescriptor,
      credentials,
    });

    await writeSessionMarker({
      pid: processInfo.pid,
      happySessionId,
      startedBy: 'daemon',
      ...(spawnOptions?.directory ? { cwd: spawnOptions.directory } : {}),
      processCommandHash,
      processCommand: processInfo.command,
      ...(respawn ? { respawn } : {}),
      ...(incompleteMarker?.connectedServiceRestartIntent
        ? { connectedServiceRestartIntent: incompleteMarker.connectedServiceRestartIntent }
        : {}),
    });
    recovered++;
  }

  return recovered;
}

async function includePidSpecificProcessesForAliveMarkers(params: Readonly<{
  happyProcesses: ReadonlyArray<HappyProcessInfo>;
  aliveMarkers: ReadonlyArray<DaemonSessionMarker>;
}>): Promise<HappyProcessInfo[]> {
  const processes = [...params.happyProcesses];
  const knownPids = new Set(processes.map((processInfo) => processInfo.pid));

  for (const marker of params.aliveMarkers) {
    if (knownPids.has(marker.pid)) continue;
    const processInfo = await findHappyProcessByPid(marker.pid).catch(() => null);
    if (!processInfo || knownPids.has(processInfo.pid)) continue;
    processes.push(processInfo);
    knownPids.add(processInfo.pid);
  }

  return processes;
}

type OrphanedDeadDaemonSession = Readonly<{
  sessionId: string;
  pid: number;
  activeTurnId?: string;
}>;

export type ReattachTrackedSessionsFromMarkersResult = Readonly<{
  orphanedDeadDaemonSessions: ReadonlyArray<OrphanedDeadDaemonSession>;
  /** Live session runners recovered into this daemon and requiring control binding to its final machine id. */
  recoveredLiveSessionIds?: ReadonlyArray<string>;
  disconnectedTerminalHostCandidates?: ReadonlyArray<DisconnectedTerminalHostCandidate>;
  /** Sessions whose persisted terminal topology exists but cannot be safely reconstructed. */
  unresolvedTerminalHostSessionIds?: ReadonlyArray<string>;
  connectedServiceRestartIntents: ReadonlyArray<never>;
}>;

function buildReattachResult(params: Readonly<{
  orphanedDeadDaemonSessions: ReadonlyArray<OrphanedDeadDaemonSession>;
  recoveredLiveSessionIds: ReadonlySet<string>;
  disconnectedTerminalHostCandidates?: ReadonlyArray<DisconnectedTerminalHostCandidate>;
  unresolvedTerminalHostSessionIds?: ReadonlyArray<string>;
}>): ReattachTrackedSessionsFromMarkersResult {
  const orphanedDeadDaemonSessions = Array.from(
    new Map(
      params.orphanedDeadDaemonSessions
        .filter((session) => !params.recoveredLiveSessionIds.has(session.sessionId))
        .map((session) => [`${session.sessionId}\u0000${session.activeTurnId ?? ''}`, session] as const),
    ).values(),
  );
  return {
    orphanedDeadDaemonSessions,
    ...(params.recoveredLiveSessionIds.size > 0
      ? { recoveredLiveSessionIds: Array.from(params.recoveredLiveSessionIds).sort() }
      : {}),
    ...(params.disconnectedTerminalHostCandidates?.length
      ? { disconnectedTerminalHostCandidates: params.disconnectedTerminalHostCandidates }
      : {}),
    ...(params.unresolvedTerminalHostSessionIds?.length
      ? { unresolvedTerminalHostSessionIds: Array.from(new Set(params.unresolvedTerminalHostSessionIds)) }
      : {}),
    connectedServiceRestartIntents: [],
  };
}

export async function reattachTrackedSessionsFromMarkers(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  credentials?: Credentials | null;
  // Retained as an ignored compatibility input for existing callers/tests. Cold
  // startup never probes or mutates terminal hosts for dead runner markers.
  terminalHostAdapters?: unknown;
  hasTerminalAttachmentControlDescriptor?: (
    agentId: AgentId | null | undefined,
    input: Readonly<{ happyHomeDir: string; sessionId: string }>,
  ) => Promise<boolean>;
}>): Promise<ReattachTrackedSessionsFromMarkersResult> {
  const { pidToTrackedSession, credentials } = params;
  const orphanedDeadDaemonSessions: OrphanedDeadDaemonSession[] = [];
  const disconnectedTerminalHostCandidates: DisconnectedTerminalHostCandidate[] = [];
  const unresolvedTerminalHostSessionIds: string[] = [];
  // On daemon restart, reattach to still-running sessions via disk markers (stack-scoped by HAPPIER_HOME_DIR).
  try {
    const markers = await listSessionMarkers();
    logger.debug('[DAEMON RUN] Startup reattach inputs collected', {
      markerCount: markers.length,
    });
    const aliveMarkers = [];
    for (const marker of markers) {
      try {
        process.kill(marker.pid, 0);
        aliveMarkers.push(marker);
      } catch {
        const sessionId = normalizeSessionId(marker.happySessionId);
        const markerAgentId = normalizeMarkerAgentId(marker.respawn?.backendTarget?.kind === 'builtInAgent'
          ? marker.respawn.backendTarget.agentId
          : marker.flavor);
        // Immutable terminal attachment identity is independent of provider hook/MCP control.
        // Read it first so a missing provider descriptor remains a supervised, recoverable host
        // instead of being collapsed into an ordinary dead-runner orphan.
        const attachmentState = marker.startedBy === 'daemon' && sessionId
          ? await readTerminalAttachmentState({ happyHomeDir: marker.happyHomeDir, sessionId })
          : { status: 'absent' as const };
        if (
          attachmentState.status === 'unreadable'
          || (attachmentState.status === 'present' && attachmentState.info.version !== 2)
        ) {
          unresolvedTerminalHostSessionIds.push(sessionId);
          continue;
        }
        const attachment = attachmentState.status === 'present' ? attachmentState.info : null;
        const hasExactControlDescriptor = attachment?.version === 2
          ? await (params.hasTerminalAttachmentControlDescriptor
              ?? hasTerminalAttachmentControlDescriptorThroughCatalog)(markerAgentId, {
                happyHomeDir: marker.happyHomeDir,
                sessionId,
                attachmentId: attachment.attachmentId,
              })
          : false;
        if (attachment?.version === 2) {
          disconnectedTerminalHostCandidates.push({
            sessionId,
            pid: marker.pid,
            ...(marker.activeTurnId ? { activeTurnId: marker.activeTurnId } : {}),
            happyHomeDir: marker.happyHomeDir,
            attachmentId: attachment.attachmentId,
            handle: attachment.handle,
            controlDescriptorAvailable: hasExactControlDescriptor,
          });
          continue;
        }
        if (marker.startedBy === 'daemon' && sessionId) {
          orphanedDeadDaemonSessions.push({
            sessionId,
            pid: marker.pid,
            ...(marker.activeTurnId ? { activeTurnId: marker.activeTurnId } : {}),
          });
        }
        continue;
      }
    }
    logger.debug('[DAEMON RUN] Startup reattach alive marker scan finished', {
      aliveMarkerCount: aliveMarkers.length,
    });
    const markerlessRecoveryEnabled = shouldRecoverMarkerlessDaemonSpawnedSessions();
    const shouldRunFullProcessScan = markerlessRecoveryEnabled;
    const happyProcesses = shouldRunFullProcessScan ? await findAllHappyProcesses() : [];
    const happyProcessesForReattach = await includePidSpecificProcessesForAliveMarkers({
      happyProcesses,
      aliveMarkers,
    });
    if (happyProcessesForReattach.length > happyProcesses.length) {
      logger.debug('[DAEMON RUN] Startup reattach pid-specific process fallback found live marker processes', {
        initialHappyProcessCount: happyProcesses.length,
        fallbackHappyProcessCount: happyProcessesForReattach.length - happyProcesses.length,
      });
    }
    const { adopted, adoptedPids = [], respawnRestoreErrors = [] } = adoptSessionsFromMarkers({
      markers: aliveMarkers,
      happyProcesses: happyProcessesForReattach,
      pidToTrackedSession,
      credentials,
    });
    if (adopted > 0) logger.debug(`[DAEMON RUN] Reattached ${adopted} sessions from disk markers`);
    const adoptedPidSet = new Set(adoptedPids);
    const safetyBlockedMarkerPidSet = new Set(
      aliveMarkers
        .filter((marker) => !adoptedPidSet.has(marker.pid))
        .filter((marker) => {
          const hasProcessCommandHash = typeof marker.processCommandHash === 'string' && marker.processCommandHash.trim().length > 0;
          const hasRespawnDescriptor = typeof marker.respawn === 'object' && marker.respawn !== null;
          return hasProcessCommandHash && !hasRespawnDescriptor;
        })
        .map((marker) => marker.pid),
    );
    const markerlessRecoveryBlockedPidSet = new Set<number>([...adoptedPidSet, ...safetyBlockedMarkerPidSet]);
    const incompleteMarkerByPid = new Map(
      aliveMarkers
        .filter((marker) => {
          if (adoptedPidSet.has(marker.pid)) return false;
          const hasProcessCommandHash = typeof marker.processCommandHash === 'string' && marker.processCommandHash.trim().length > 0;
          const hasRespawnDescriptor = typeof marker.respawn === 'object' && marker.respawn !== null;
          return !hasProcessCommandHash || hasRespawnDescriptor;
        })
        .map((marker) => [
          marker.pid,
          {
            happySessionId: marker.happySessionId,
            startedBy: marker.startedBy,
            cwd: marker.cwd,
            metadata: marker.metadata,
            respawn: marker.respawn,
            connectedServiceRestartIntent: marker.connectedServiceRestartIntent,
          },
        ] as const),
    );
    const recoveredMarkerlessCount = markerlessRecoveryEnabled
      ? await recoverMarkerlessDaemonSpawnedSessions({
          happyProcesses: happyProcessesForReattach,
          incompleteMarkerByPid,
          markedPids: markerlessRecoveryBlockedPidSet,
          pidToTrackedSession,
          credentials,
        })
      : 0;
    if (recoveredMarkerlessCount > 0) {
      logger.debug(
        `[DAEMON RUN] Recovered ${recoveredMarkerlessCount} live daemon session(s) that were missing disk markers during startup`,
      );
    }
    if (adopted === 0 && recoveredMarkerlessCount === 0 && (aliveMarkers.length > 0 || happyProcesses.length > 0)) {
      logger.debug('[DAEMON RUN] Startup reattach scan found no recoverable sessions', {
        aliveMarkerCount: aliveMarkers.length,
        happyProcessCount: happyProcessesForReattach.length,
        adoptedPids,
        incompleteMarkerPidCount: incompleteMarkerByPid.size,
      });
    }
    for (const restoreError of respawnRestoreErrors) {
      logger.warn(
        `[DAEMON RUN] Reattached session ${restoreError.happySessionId} without respawn descriptor continuity: ${restoreError.message}`,
      );
    }
    const recoveredLiveSessionIds = new Set(
      Array.from(pidToTrackedSession.values())
        .map((trackedSession) => trackedSession.happySessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim().length > 0)
        .map((sessionId) => sessionId.trim()),
    );
    for (const marker of aliveMarkers) {
      const restartIntent = readConnectedServiceRestartIntent(marker);
      if (!restartIntent) continue;
      await clearSessionMarkerConnectedServiceRestartIntent(marker.pid).catch((error) => {
        logger.debug('[DAEMON RUN] Failed to clear stale connected-service restart intent during startup reattach reconciliation', error);
      });
    }
    return buildReattachResult({
      orphanedDeadDaemonSessions,
      recoveredLiveSessionIds,
      disconnectedTerminalHostCandidates,
      unresolvedTerminalHostSessionIds,
    });
  } catch (e) {
    logger.debug('[DAEMON RUN] Failed to reattach sessions from disk markers', e);
  }

  const recoveredLiveSessionIds = new Set(
    Array.from(pidToTrackedSession.values())
      .map((trackedSession) => trackedSession.happySessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim().length > 0)
      .map((sessionId) => sessionId.trim()),
  );

  return buildReattachResult({
    orphanedDeadDaemonSessions,
    recoveredLiveSessionIds,
    disconnectedTerminalHostCandidates,
    unresolvedTerminalHostSessionIds,
  });
}
