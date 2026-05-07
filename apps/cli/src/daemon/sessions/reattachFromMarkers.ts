import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { parseOptionalBooleanEnv } from '@happier-dev/protocol';
import { resolveCatalogAgentIdForCliSubcommand } from '@/backends/catalog';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';
import {
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  type SessionRunnerRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from '../processSupervision/sessionRunnerRespawnDescriptor';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import type { TrackedSession } from '../types';
import { findAllHappyProcesses } from '../doctor';
import { adoptSessionsFromMarkers, isOwnedLiveDaemonSessionProcessCommand } from '../reattach';
import { hashProcessCommand, listSessionMarkers, removeSessionMarker, writeSessionMarker } from '../sessionRegistry';

function extractExistingSessionIdFromCommand(command: string): string | null {
  const match = /(?:^|\s)--existing-session(?:=|\s+)(\S+)/.exec(command);
  const sessionId = typeof match?.[1] === 'string' ? match[1].trim() : '';
  return sessionId || null;
}

function shouldRecoverMarkerlessDaemonSpawnedSessions(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseOptionalBooleanEnv(env.HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED) !== false;
}

function extractResumeIdFromCommand(command: string): string | null {
  const match = /(?:^|\s)--resume(?:=|\s+)(\S+)/.exec(command);
  const resumeId = typeof match?.[1] === 'string' ? match[1].trim() : '';
  return resumeId || null;
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
    const canRecoverFromIncompleteMarker =
      incompleteMarker &&
      isGenericHappySession &&
      !!liveExistingSessionId &&
      liveExistingSessionId === incompleteMarkerSessionId;
    if (
      processInfo.type !== 'daemon-spawned-session' &&
      processInfo.type !== 'dev-daemon-spawned' &&
      !canRecoverFromIncompleteMarker
    ) {
      continue;
    }
    if (!isOwnedLiveDaemonSessionProcessCommand(processInfo.command)) {
      continue;
    }

    const happySessionId = isGenericHappySession
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
    logger.debug('[DAEMON RUN] Startup reattach inputs collected', {
      markerCount: markers.length,
      happyProcessCount: happyProcesses.length,
    });
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
    logger.debug('[DAEMON RUN] Startup reattach alive marker scan finished', {
      aliveMarkerCount: aliveMarkers.length,
    });
    const { adopted, adoptedPids = [], respawnRestoreErrors = [] } = adoptSessionsFromMarkers({
      markers: aliveMarkers,
      happyProcesses,
      pidToTrackedSession,
      credentials,
    });
    if (adopted > 0) logger.debug(`[DAEMON RUN] Reattached ${adopted} sessions from disk markers`);
    const markedPidSet = new Set(
      aliveMarkers
        .filter((marker) => typeof marker.processCommandHash === 'string' && marker.processCommandHash.trim().length > 0)
        .map((marker) => marker.pid),
    );
    const incompleteMarkerByPid = new Map(
      aliveMarkers
        .filter((marker) => typeof marker.processCommandHash !== 'string' || marker.processCommandHash.trim().length === 0)
        .map((marker) => [
          marker.pid,
          {
            happySessionId: marker.happySessionId,
            cwd: marker.cwd,
            respawn: marker.respawn,
          },
        ] as const),
    );
    const recoveredMarkerlessCount = shouldRecoverMarkerlessDaemonSpawnedSessions()
      ? await recoverMarkerlessDaemonSpawnedSessions({
          happyProcesses,
          incompleteMarkerByPid,
          markedPids: markedPidSet,
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
        happyProcessCount: happyProcesses.length,
        adoptedPids,
        incompleteMarkerPidCount: incompleteMarkerByPid.size,
      });
    }
    for (const restoreError of respawnRestoreErrors) {
      logger.warn(
        `[DAEMON RUN] Reattached session ${restoreError.happySessionId} without respawn descriptor continuity: ${restoreError.message}`,
      );
    }
  } catch (e) {
    logger.debug('[DAEMON RUN] Failed to reattach sessions from disk markers', e);
  }

  const recoveredDaemonSessionIds = new Set(
    Array.from(pidToTrackedSession.values())
      .filter((trackedSession) => trackedSession.startedBy === 'daemon')
      .map((trackedSession) => trackedSession.happySessionId),
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
