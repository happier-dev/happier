import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { resolveCatalogAgentIdForCliSubcommand } from '@/backends/catalog';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/backends/types';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';
import {
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  type SessionRunnerRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from '../processSupervision/sessionRunnerRespawnDescriptor';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import type { TrackedSession } from '../types';
import { findAllHappyProcesses } from '../doctor';
import {
  adoptLiveDaemonSessionsFromProcesses,
  adoptSessionsFromMarkers,
  isOwnedLiveDaemonSessionProcessCommand,
} from '../reattach';
import { hashProcessCommand, listSessionMarkers, removeSessionMarker, writeSessionMarker } from '../sessionRegistry';

function extractExistingSessionIdFromCommand(command: string): string | null {
  const match = /(?:^|\s)--existing-session(?:=|\s+)(\S+)/.exec(command);
  const sessionId = typeof match?.[1] === 'string' ? match[1].trim() : '';
  return sessionId || null;
}

function extractResumeIdFromCommand(command: string): string | null {
  const match = /(?:^|\s)--resume(?:=|\s+)(\S+)/.exec(command);
  const resumeId = typeof match?.[1] === 'string' ? match[1].trim() : '';
  return resumeId || null;
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
  const directCatalogAgentId = CATALOG_AGENT_IDS.includes(subcommand as CatalogAgentId)
    ? (subcommand as CatalogAgentId)
    : null;
  const agentId = resolveCatalogAgentIdForCliSubcommand(subcommand) ?? directCatalogAgentId;
  return agentId ? { kind: 'backend', backendId: agentId, sourceKind: 'built_in' } : undefined;
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
    respawn?: unknown;
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
    const spawnOptions = mergeRecoveredSpawnOptions({
      liveSpawnOptions,
      respawnSpawnOptions,
    });

    const vendorResumeId = extractResumeIdFromCommand(processInfo.command);
    pidToTrackedSession.set(processInfo.pid, {
      startedBy: 'daemon',
      happySessionId,
      pid: processInfo.pid,
      processCommandHash,
      processCommand: processInfo.command,
      reattachedFromDiskMarker: true,
      ...(vendorResumeId ? { vendorResumeId } : {}),
      ...(spawnOptions ? { spawnOptions } : {}),
    });

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
    });
    recovered++;
  }

  return recovered;
}

type OrphanedDeadDaemonSession = Readonly<{
  sessionId: string;
  pid: number;
}>;

export type ReattachTrackedSessionsFromMarkersResult = Readonly<{
  orphanedDeadDaemonSessions: ReadonlyArray<OrphanedDeadDaemonSession>;
}>;

export async function reattachTrackedSessionsFromMarkers(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  credentials?: Credentials | null;
}>): Promise<ReattachTrackedSessionsFromMarkersResult> {
  const { pidToTrackedSession, credentials } = params;
  const orphanedDeadDaemonSessions: OrphanedDeadDaemonSession[] = [];

  // On daemon restart, reattach to still-running sessions via disk markers (stack-scoped by HAPPIER_HOME_DIR).
  try {
    const markers = await listSessionMarkers();
    const happyProcesses = await findAllHappyProcesses();
    const aliveMarkers = [];
    for (const marker of markers) {
      try {
        process.kill(marker.pid, 0);
        aliveMarkers.push(marker);
      } catch {
        const sessionId = typeof marker.happySessionId === 'string' ? marker.happySessionId.trim() : '';
        if (marker.startedBy === 'daemon' && sessionId) {
          orphanedDeadDaemonSessions.push({
            sessionId,
            pid: marker.pid,
          });
        }
        await removeSessionMarker(marker.pid);
        continue;
      }
    }
    const { adopted } = adoptSessionsFromMarkers({ markers: aliveMarkers, happyProcesses, pidToTrackedSession, credentials });
    if (adopted > 0) logger.debug(`[DAEMON RUN] Reattached ${adopted} sessions from disk markers`);
    const adoptedPidSet = new Set(pidToTrackedSession.keys());
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
            respawn: marker.respawn,
          },
        ] as const),
    );
    const liveRecovered = await recoverMarkerlessDaemonSpawnedSessions({
      happyProcesses,
      incompleteMarkerByPid,
      markedPids: markerlessRecoveryBlockedPidSet,
      pidToTrackedSession,
      credentials,
    });
    if (liveRecovered > 0) {
      logger.debug(`[DAEMON RUN] Recovered ${liveRecovered} live daemon session(s) without disk markers`);
    }
    const liveRecoveredWithoutMarkers = await adoptLiveDaemonSessionsFromProcesses({
      happyProcesses,
      markedPids: markerlessRecoveryBlockedPidSet,
      pidToTrackedSession,
    });
    if (liveRecoveredWithoutMarkers > 0) {
      logger.debug(`[DAEMON RUN] Recovered ${liveRecoveredWithoutMarkers} live daemon session(s) without disk markers`);
    }
  } catch (e) {
    logger.debug('[DAEMON RUN] Failed to reattach sessions from disk markers', e);
  }

  const recoveredDaemonSessionIds = new Set(
    Array.from(pidToTrackedSession.values())
      .filter((trackedSession) => trackedSession.startedBy === 'daemon')
      .map((trackedSession) => trackedSession.happySessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim().length > 0),
  );

  return {
    orphanedDeadDaemonSessions: Array.from(
      new Map(
        orphanedDeadDaemonSessions
          .filter((session) => !recoveredDaemonSessionIds.has(session.sessionId))
          .map((session) => [session.sessionId, session] as const),
      ).values(),
    ),
  };
}
