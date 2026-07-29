import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { parseOptionalBooleanEnv } from '@happier-dev/protocol';
import { resolveCatalogAgentIdForCliSubcommand } from '@/agent/catalog/resolution';
import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/agent/catalog/ids';
import {
  buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  normalizeOwnedMarkerRespawnEnvironmentCiphertext,
  type SessionRunnerRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from '../processSupervision/sessionRunnerRespawnDescriptor';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

import type { TrackedSession } from '../types';
import { findAllHappyProcesses, findHappyProcessByPid, type HappyProcessInfo } from '../doctor';
import {
  adoptLiveDaemonSessionsFromProcesses,
  adoptSessionsFromMarkers,
  isOwnedLiveDaemonSessionProcessCommand,
} from '../reattach';
import {
  clearSessionMarkerConnectedServiceRestartIntent,
  hashProcessCommand,
  listSessionMarkers,
  removeSessionMarker,
  rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned,
  writeSessionMarker,
  type DaemonSessionMarker,
  type ManagedLocalServiceRunAttachmentMarkerOwnership,
  type ManagedLocalServiceRunAttachmentV1,
} from '../sessionRegistry';
import { toTrackedPluginLocalServicesBridgeAuthorizationFields } from '../local/services/pluginBridgeAuthorization';
import { resolveSessionRuntimeSnapshot } from './runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { extractResumeIdFromCommand } from './extractResumeIdFromCommand';
import { readTerminalHostAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';
import type { DisconnectedTerminalHostCandidate } from './disconnectedTerminalHostSupervision';
import {
  PersistedProviderResumeBindingError,
  readPersistedProviderResumeState,
} from '@/providers/lifecycle/readPersistedResumeSelection';
import { readProcessIdentityByPid } from '../processIdentity';
import type { LocalServiceProcessFact } from '../local/services/inventory/provenance';

function extractExistingSessionIdFromCommand(command: string): string | null {
  const match = /(?:^|\s)--existing-session(?:=|\s+)(\S+)/.exec(command);
  const sessionId = typeof match?.[1] === 'string' ? match[1].trim() : '';
  return sessionId || null;
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

function readRuntimeSnapshotMetadata(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function applyRecoveredRuntimeSnapshot(params: Readonly<{
  spawnOptions?: SpawnSessionOptions;
  metadata?: unknown;
  vendorResumeId?: string | null;
  persistedVendorResumeId?: string | null;
}>): SpawnSessionOptions | undefined {
  if (!params.spawnOptions) return undefined;
  return resolveSessionRuntimeSnapshot({
    incomingOptions: params.spawnOptions,
    persistedMetadata: readRuntimeSnapshotMetadata(params.metadata),
    trackedVendorResumeId: params.vendorResumeId ?? null,
    persistedVendorResumeId: params.persistedVendorResumeId ?? null,
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
  vendorResumeId?: string | null;
}>): SessionRunnerRespawnDescriptorV1 | null {
  const {
    spawnOptions,
    parsedRespawnDescriptor,
    credentials,
    vendorResumeId,
  } = params;
  const rebuiltRespawn = spawnOptions
    ? buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions, {
        encryptionMaterial: credentials?.encryption,
        ...(vendorResumeId ? { vendorResumeId } : {}),
      })
    : null;
  if (!parsedRespawnDescriptor) {
    return rebuiltRespawn;
  }
  if (!rebuiltRespawn) {
    return parsedRespawnDescriptor;
  }
  if (parsedRespawnDescriptor.version === 2 && rebuiltRespawn.version !== 2) {
    return parsedRespawnDescriptor;
  }

  const mergedRespawn = SessionRunnerRespawnDescriptorV1Schema.safeParse({
    ...parsedRespawnDescriptor,
    ...rebuiltRespawn,
    ...(parsedRespawnDescriptor.sealedEnvironmentVariables
      ? {
          sealedEnvironmentVariables:
            parsedRespawnDescriptor.sealedEnvironmentVariables,
        }
      : {}),
  });
  return mergedRespawn.success
    ? mergedRespawn.data
    : parsedRespawnDescriptor.version === 2
      ? parsedRespawnDescriptor
      : rebuiltRespawn;
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

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveDisconnectedTerminalMode(params: Readonly<{
  marker: DaemonSessionMarker;
  hostKind: DisconnectedTerminalHostCandidate['handle']['kind'];
  attachmentId: string;
}>): TerminalMode | null {
  if (params.hostKind === 'tmux' || params.hostKind === 'zellij') return params.hostKind;
  const terminal = params.marker.metadata?.terminal;
  const evidenceAttachmentId = terminal?.controlServiceabilityV1?.attachmentId;
  if (typeof evidenceAttachmentId === 'string' && evidenceAttachmentId !== params.attachmentId) return null;
  const mode = terminal?.mode;
  return mode === 'windows_terminal' || mode === 'windows_console' ? mode : null;
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

function shouldRecoverMarkerlessDaemonSpawnedSessions(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseOptionalBooleanEnv(env.HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED) !== false;
}

async function includePidSpecificHappyProcessesForAliveMarkers(params: Readonly<{
  happyProcesses: ReadonlyArray<HappyProcessInfo>;
  aliveMarkers: ReadonlyArray<DaemonSessionMarker>;
}>): Promise<HappyProcessInfo[]> {
  const processByPid = new Map(params.happyProcesses.map((processInfo) => [processInfo.pid, processInfo] as const));
  const result = [...params.happyProcesses];
  for (const marker of params.aliveMarkers) {
    if (processByPid.has(marker.pid)) continue;
    const processInfo = await findHappyProcessByPid(marker.pid).catch(() => null);
    if (!processInfo || processByPid.has(processInfo.pid)) continue;
    processByPid.set(processInfo.pid, processInfo);
    result.push(processInfo);
  }
  return result;
}

async function rewriteExactlyAdoptedRespawnAliases(params: Readonly<{
  markers: ReadonlyArray<DaemonSessionMarker>;
  happyProcesses: ReadonlyArray<HappyProcessInfo>;
  processIdentityByPid: ReadonlyMap<
    number,
    LocalServiceProcessFact
  >;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  credentials?: Credentials | null;
}>): Promise<void> {
  const encryptionMaterial = params.credentials?.encryption;
  if (!encryptionMaterial) return;
  const processByPid = new Map(
    params.happyProcesses.map((processInfo) => [
      processInfo.pid,
      processInfo,
    ] as const),
  );

  for (const marker of params.markers) {
    const sealedEnvironmentVariables =
      marker.respawn?.sealedEnvironmentVariables;
    if (
      !sealedEnvironmentVariables
      || !marker.processCommandHash
      || marker.processStartTimeMs === undefined
    ) {
      continue;
    }
    const tracked = params.pidToTrackedSession.get(marker.pid);
    const processInfo = processByPid.get(marker.pid);
    const processIdentity =
      params.processIdentityByPid.get(marker.pid);
    if (
      !tracked
      || tracked.happySessionId !== marker.happySessionId
      || tracked.processCommandHash !==
        marker.processCommandHash
      || tracked.processStartTimeMs !==
        marker.processStartTimeMs
      || !processInfo
      || extractExistingSessionIdFromCommand(
        processInfo.command,
      ) !== marker.happySessionId
      || !isOwnedLiveDaemonSessionProcessCommand(
        processInfo.command,
      )
      || hashProcessCommand(processInfo.command) !==
        marker.processCommandHash
      || processIdentity?.pid !== marker.pid
      || processIdentity.processStartTimeMs !==
        marker.processStartTimeMs
      || hashProcessCommand(processIdentity.command) !==
        marker.processCommandHash
    ) {
      continue;
    }

    try {
      const normalized =
        normalizeOwnedMarkerRespawnEnvironmentCiphertext({
          sealedEnvironmentVariables,
          encryptionMaterial,
        });
      if (
        !normalized
        || normalized.ciphertext ===
          sealedEnvironmentVariables.ciphertext
      ) {
        continue;
      }
      await rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned({
        pid: marker.pid,
        ownership: {
          happySessionId: marker.happySessionId,
          processCommandHash:
            marker.processCommandHash,
          processStartTimeMs:
            marker.processStartTimeMs,
        },
        expectedCiphertext:
          sealedEnvironmentVariables.ciphertext,
        replacementCiphertext: normalized.ciphertext,
      });
    } catch (error) {
      logger.debug(
        `[DAEMON RUN] Failed to rewrite an exactly adopted respawn environment alias for session ${marker.happySessionId}`,
        error,
      );
    }
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
    processCommandHash?: string;
    processStartTimeMs?: number;
    processCommand?: string;
    metadata?: unknown;
    respawn?: unknown;
    connectedServiceRestartIntent?: DaemonSessionMarker['connectedServiceRestartIntent'];
    activeTurnId?: string;
    agentSessionStartupInstructionsMarkerV1?:
      DaemonSessionMarker['agentSessionStartupInstructionsMarkerV1'];
    localServicesBridgeAuthorization?: DaemonSessionMarker['localServicesBridgeAuthorization'];
  }>>;
  markedPids: ReadonlySet<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
  credentials?: Credentials | null;
}>): Promise<number> {
  const {
    happyProcesses,
    incompleteMarkerByPid,
    markedPids,
    pidToTrackedSession,
    credentials,
  } = params;
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
    const persistedMetadata = readRuntimeSnapshotMetadata(incompleteMarker?.metadata);
    let persistedProviderResumeState: ReturnType<typeof readPersistedProviderResumeState>;
    try {
      persistedProviderResumeState = readPersistedProviderResumeState(persistedMetadata);
    } catch (error) {
      if (error instanceof PersistedProviderResumeBindingError) continue;
      throw error;
    }
    if (persistedProviderResumeState.binding && parsedRespawnDescriptor?.version !== 2) {
      continue;
    }
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
      metadata: persistedMetadata,
      vendorResumeId,
      persistedVendorResumeId: parsedRespawnDescriptor?.vendorResumeId,
    });
    const validatedRecoveredRespawn = spawnOptions
      ? buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions)
      : null;
    if ((spawnOptions && !validatedRecoveredRespawn)
      || (parsedRespawnDescriptor
        && validatedRecoveredRespawn
        && validatedRecoveredRespawn.version !== parsedRespawnDescriptor.version)
      || (parsedRespawnDescriptor?.version === 2 && validatedRecoveredRespawn?.version !== 2)) {
      continue;
    }
    const resolvedVendorResumeId = typeof spawnOptions?.resume === 'string' && spawnOptions.resume.trim().length > 0
      ? spawnOptions.resume.trim()
      : vendorResumeId
        ?? parsedRespawnDescriptor?.vendorResumeId
        ?? null;
    pidToTrackedSession.set(processInfo.pid, {
      startedBy: 'daemon',
      happySessionId,
      pid: processInfo.pid,
      processCommandHash,
      processCommand: processInfo.command,
      reattachedFromDiskMarker: true,
      ...(resolvedVendorResumeId ? { vendorResumeId: resolvedVendorResumeId } : {}),
      ...(spawnOptions ? { spawnOptions } : {}),
      ...toTrackedPluginLocalServicesBridgeAuthorizationFields(incompleteMarker?.localServicesBridgeAuthorization),
      ...(incompleteMarker?.activeTurnId
        ? { reattachedInterruptedTurnId: incompleteMarker.activeTurnId }
        : {}),
      ...(incompleteMarker?.agentSessionStartupInstructionsMarkerV1
        ? {
            agentSessionStartupInstructionsMarkerV1:
              incompleteMarker.agentSessionStartupInstructionsMarkerV1,
          }
        : {}),
    });

    const respawn = buildRecoveredRespawnDescriptor({
      spawnOptions,
      parsedRespawnDescriptor,
      credentials,
      vendorResumeId: resolvedVendorResumeId,
    });

    await writeSessionMarker({
      pid: processInfo.pid,
      happySessionId,
      startedBy: 'daemon',
      ...(spawnOptions?.directory ? { cwd: spawnOptions.directory } : {}),
      processCommandHash,
      ...(incompleteMarker?.processStartTimeMs !== undefined
        ? {
            processStartTimeMs:
              incompleteMarker.processStartTimeMs,
          }
        : {}),
      processCommand: processInfo.command,
      ...(respawn ? { respawn } : {}),
      ...(incompleteMarker?.connectedServiceRestartIntent
        ? { connectedServiceRestartIntent: incompleteMarker.connectedServiceRestartIntent }
        : {}),
      ...(incompleteMarker?.localServicesBridgeAuthorization
        ? { localServicesBridgeAuthorization: incompleteMarker.localServicesBridgeAuthorization }
        : {}),
      ...(incompleteMarker?.activeTurnId ? { activeTurnId: incompleteMarker.activeTurnId } : {}),
      ...(incompleteMarker?.agentSessionStartupInstructionsMarkerV1
        ? {
            agentSessionStartupInstructionsMarkerV1:
              incompleteMarker.agentSessionStartupInstructionsMarkerV1,
          }
        : {}),
    });
    recovered++;
  }

  return recovered;
}

export type OrphanedDeadDaemonSession = Readonly<{
  sessionId: string;
  pid: number;
  activeTurnId?: string;
  processCommandHash?: string;
  processStartTimeMs?: number;
  recoveredLiveSession?: boolean;
}>;

export type ReattachTrackedSessionsFromMarkersResult = Readonly<{
  orphanedDeadDaemonSessions: ReadonlyArray<OrphanedDeadDaemonSession>;
  disconnectedTerminalHostCandidates?: ReadonlyArray<DisconnectedTerminalHostCandidate>;
  unresolvedTerminalHostSessionIds?: ReadonlyArray<string>;
  managedProviderRecoveryCandidates?: ReadonlyArray<Readonly<{
    pid: number;
    sessionId: string;
    attachment: ManagedLocalServiceRunAttachmentV1;
    markerOwnership: ManagedLocalServiceRunAttachmentMarkerOwnership;
  }>>;
  connectedServiceRestartIntents: ReadonlyArray<never>;
}>;

function buildReattachResult(params: Readonly<{
  orphanedDeadDaemonSessions: ReadonlyArray<OrphanedDeadDaemonSession>;
  recoveredLiveSessionIds: ReadonlySet<string>;
  disconnectedTerminalHostCandidates?: ReadonlyArray<DisconnectedTerminalHostCandidate>;
  unresolvedTerminalHostSessionIds?: ReadonlyArray<string>;
  managedProviderRecoveryCandidates?: ReattachTrackedSessionsFromMarkersResult['managedProviderRecoveryCandidates'];
}>): ReattachTrackedSessionsFromMarkersResult {
  const orphanedDeadDaemonSessions = params.orphanedDeadDaemonSessions.map((session) => ({
    ...session,
    ...(params.recoveredLiveSessionIds.has(session.sessionId)
      ? { recoveredLiveSession: true as const }
      : {}),
  }));

  return {
    orphanedDeadDaemonSessions,
    ...(params.disconnectedTerminalHostCandidates?.length
      ? { disconnectedTerminalHostCandidates: params.disconnectedTerminalHostCandidates }
      : {}),
    ...(params.unresolvedTerminalHostSessionIds?.length
      ? { unresolvedTerminalHostSessionIds: Array.from(new Set(params.unresolvedTerminalHostSessionIds)) }
      : {}),
    ...(params.managedProviderRecoveryCandidates?.length
      ? { managedProviderRecoveryCandidates: params.managedProviderRecoveryCandidates }
      : {}),
    connectedServiceRestartIntents: [],
  };
}

export async function reattachTrackedSessionsFromMarkers(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  credentials?: Credentials | null;
  // Compatibility-only inputs: cold startup intentionally never probes or
  // mutates terminal hosts for dead runner markers.
  terminalHostAdapters?: unknown;
  loadTerminalHostAdapters?: unknown;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
}>): Promise<ReattachTrackedSessionsFromMarkersResult> {
  const { pidToTrackedSession, credentials } = params;
  const orphanedDeadDaemonSessions: OrphanedDeadDaemonSession[] = [];
  const disconnectedTerminalHostCandidates: DisconnectedTerminalHostCandidate[] = [];
  const unresolvedTerminalHostSessionIds: string[] = [];
  // On daemon restart, reattach to still-running sessions via disk markers (stack-scoped by HAPPIER_HOME_DIR).
  try {
    const markers = await listSessionMarkers();
    const aliveMarkers = [];
    for (const marker of markers) {
      try {
        process.kill(marker.pid, 0);
        aliveMarkers.push(marker);
      } catch {
        const sessionId = normalizeSessionId(marker.happySessionId);
        const attachmentState = marker.startedBy === 'daemon' && sessionId
          ? await readTerminalHostAttachmentState({ happyHomeDir: marker.happyHomeDir, sessionId })
          : { status: 'absent' as const };
        if (
          attachmentState.status === 'unreadable'
          || (attachmentState.status === 'present' && attachmentState.info.version !== 2)
        ) {
          unresolvedTerminalHostSessionIds.push(sessionId);
          continue;
        }
        if (attachmentState.status === 'present' && attachmentState.info.version === 2) {
          const terminalMode = resolveDisconnectedTerminalMode({
            marker,
            hostKind: attachmentState.info.handle.kind,
            attachmentId: attachmentState.info.attachmentId,
          });
          if (!terminalMode) {
            unresolvedTerminalHostSessionIds.push(sessionId);
            continue;
          }
          disconnectedTerminalHostCandidates.push({
            sessionId,
            pid: marker.pid,
            happyHomeDir: marker.happyHomeDir,
            attachmentId: attachmentState.info.attachmentId,
            handle: attachmentState.info.handle,
            terminalMode,
            controlDescriptorAvailable: false,
          });
          continue;
        }
        if (marker.startedBy === 'daemon' && sessionId) {
          orphanedDeadDaemonSessions.push({
            sessionId,
            pid: marker.pid,
            ...(marker.activeTurnId ? { activeTurnId: marker.activeTurnId } : {}),
            ...(marker.processCommandHash
              ? { processCommandHash: marker.processCommandHash }
              : {}),
            ...(marker.processStartTimeMs !== undefined
              ? { processStartTimeMs: marker.processStartTimeMs }
              : {}),
          });
          continue;
        }
        await removeSessionMarker(marker.pid);
        continue;
      }
    }
    const markerlessRecoveryEnabled = shouldRecoverMarkerlessDaemonSpawnedSessions();
    const shouldRunFullProcessScan = markerlessRecoveryEnabled;
    const happyProcesses = shouldRunFullProcessScan ? await findAllHappyProcesses() : [];
    const happyProcessesForReattach = await includePidSpecificHappyProcessesForAliveMarkers({
      happyProcesses,
      aliveMarkers,
    });
    const processIdentityByPid = new Map<number, LocalServiceProcessFact>();
    await Promise.all(aliveMarkers.map(async (marker) => {
      if (marker.processStartTimeMs === undefined) return;
      const processIdentity = await (
        params.readProcessIdentityByPidFn ?? readProcessIdentityByPid
      )(marker.pid);
      if (processIdentity) {
        processIdentityByPid.set(marker.pid, processIdentity);
      }
    }));
    const { adopted } = adoptSessionsFromMarkers({
      markers: aliveMarkers,
      happyProcesses: happyProcessesForReattach,
      pidToTrackedSession,
      credentials,
      processIdentityByPid,
    });
    await rewriteExactlyAdoptedRespawnAliases({
      markers: aliveMarkers,
      happyProcesses: happyProcessesForReattach,
      processIdentityByPid,
      pidToTrackedSession,
      credentials,
    });
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
            processCommandHash:
              marker.processCommandHash,
            processStartTimeMs:
              marker.processStartTimeMs,
            processCommand:
              marker.processCommand,
            metadata: marker.metadata,
            respawn: marker.respawn,
            connectedServiceRestartIntent: marker.connectedServiceRestartIntent,
            activeTurnId: marker.activeTurnId,
            agentSessionStartupInstructionsMarkerV1:
              marker.agentSessionStartupInstructionsMarkerV1,
            localServicesBridgeAuthorization: marker.localServicesBridgeAuthorization,
          },
        ] as const),
    );
    const liveRecovered = markerlessRecoveryEnabled
      ? await recoverMarkerlessDaemonSpawnedSessions({
          happyProcesses: happyProcessesForReattach,
          incompleteMarkerByPid,
          markedPids: markerlessRecoveryBlockedPidSet,
          pidToTrackedSession,
          credentials,
        })
      : 0;
    if (liveRecovered > 0) {
      logger.debug(`[DAEMON RUN] Recovered ${liveRecovered} live daemon session(s) without disk markers`);
    }
    const liveRecoveredWithoutMarkers = markerlessRecoveryEnabled
      ? await adoptLiveDaemonSessionsFromProcesses({
          happyProcesses: happyProcessesForReattach,
          markedPids: markerlessRecoveryBlockedPidSet,
          pidToTrackedSession,
        })
      : 0;
    if (liveRecoveredWithoutMarkers > 0) {
      logger.debug(`[DAEMON RUN] Recovered ${liveRecoveredWithoutMarkers} live daemon session(s) without disk markers`);
    }
    const recoveredLiveSessionIds = new Set(
      Array.from(pidToTrackedSession.values())
        .map((trackedSession) => trackedSession.happySessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim().length > 0)
        .map((sessionId) => sessionId.trim()),
    );
    const managedProviderRecoveryCandidates =
      aliveMarkers.flatMap((marker) => {
        const sessionId = normalizeSessionId(marker.happySessionId);
        const attachment = marker.managedLocalServiceRunAttachment;
        const tracked = pidToTrackedSession.get(marker.pid);
        if (
          !sessionId
          || /^PID-\d+$/.test(sessionId)
          || !attachment
          || !tracked
          || normalizeSessionId(tracked.happySessionId) !== sessionId
          || typeof marker.processCommandHash !== 'string'
          || typeof marker.processStartTimeMs !== 'number'
          || tracked.processCommandHash !== marker.processCommandHash
          || tracked.processStartTimeMs !== marker.processStartTimeMs
        ) {
          return [];
        }
        return [{
          pid: marker.pid,
          sessionId,
          attachment,
          markerOwnership: {
            happySessionId: sessionId,
            processCommandHash: marker.processCommandHash,
            processStartTimeMs: marker.processStartTimeMs,
          },
        }];
      });
    for (const marker of aliveMarkers) {
      const restartIntent = readConnectedServiceRestartIntent(marker);
      if (!restartIntent) continue;
      await clearSessionMarkerConnectedServiceRestartIntent(marker.pid).catch((error: unknown) => {
        logger.debug('[DAEMON RUN] Failed to clear stale connected-service restart intent during startup reattach reconciliation', error);
      });
    }
    return buildReattachResult({
      orphanedDeadDaemonSessions,
      recoveredLiveSessionIds,
      disconnectedTerminalHostCandidates,
      unresolvedTerminalHostSessionIds,
      managedProviderRecoveryCandidates,
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
