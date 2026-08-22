import { ALLOWED_HAPPY_SESSION_PROCESS_TYPES } from './pidSafety';
import type { HappyProcessInfo } from './doctor';
import { hashProcessCommand, writeSessionMarker } from './sessionRegistry';
import type { DaemonSessionMarker } from './sessionRegistry';
import type { StoredCredentials } from '@/persistence';
import type { TrackedSession } from './types';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { projectPath } from '@/projectPath';
import { resolvePackagedRuntimeProjectRoots } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import {
  buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from './processSupervision/sessionRunnerRespawnDescriptor';
import { extractResumeIdFromCommand } from './sessions/extractResumeIdFromCommand';
import { resolveSessionRuntimeSnapshot } from './sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { buildTrackedSessionFromMarker } from './sessions/trackedSessionFromMarker';
import {
  PersistedProviderResumeBindingError,
  readPersistedProviderResumeState,
} from '@/providers/lifecycle/readPersistedResumeSelection';
import { processGenerationMatches, readProcessIdentityByPid } from './processIdentity';
import type { LocalServiceProcessFact } from './local/services/inventory/provenance';
import {
  normalizeProcessCommandPathValue,
  processCommandContainsPathFragment,
} from '@/subprocess/processCommandPathMatch';
import type { DeviceLocalSecretStorage } from './deviceLocalSecretStorage';

const LIVE_RECOVERABLE_HAPPY_SESSION_PROCESS_TYPES = new Set([
  'daemon-spawned-session',
  'dev-daemon-spawned',
] as const);

type LiveRecoverableHappySessionProcessType = 'daemon-spawned-session' | 'dev-daemon-spawned';

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveCliRuntimeRootFromEntrypoint(pathLike: string | undefined): string | null {
  const normalized = normalizeOptionalString(pathLike);
  if (!normalized) return null;

  const normalizedPath = normalizeProcessCommandPathValue(normalized);
  const packageDistMarker = '/package-dist/';
  const distMarker = '/dist/';
  const srcMarker = '/src/';
  const packageDistIndex = normalizedPath.indexOf(packageDistMarker);
  if (packageDistIndex >= 0) {
    return normalizedPath.slice(0, packageDistIndex);
  }
  const distIndex = normalizedPath.indexOf(distMarker);
  if (distIndex >= 0) {
    return normalizedPath.slice(0, distIndex);
  }
  const srcIndex = normalizedPath.indexOf(srcMarker);
  if (srcIndex >= 0) {
    return normalizedPath.slice(0, srcIndex);
  }
  return null;
}

function resolveOwnedLiveDaemonSessionRuntimeRoots(): string[] {
  const ownedRoots = new Set<string>();

  const currentSubprocessEntrypointRoot = resolveCliRuntimeRootFromEntrypoint(
    normalizeOptionalString(process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT),
  );
  if (currentSubprocessEntrypointRoot) {
    ownedRoots.add(currentSubprocessEntrypointRoot);
  }

  for (const runtimeRoot of resolvePackagedRuntimeProjectRoots()) {
    ownedRoots.add(normalizeProcessCommandPathValue(runtimeRoot));
  }

  ownedRoots.add(normalizeProcessCommandPathValue(projectPath()));

  return [...ownedRoots];
}

export function isOwnedLiveDaemonSessionProcessCommand(command: string): boolean {
  const normalizedCommand = normalizeOptionalString(command);
  if (!normalizedCommand) return false;

  const ownedRoots = resolveOwnedLiveDaemonSessionRuntimeRoots();
  if (ownedRoots.length === 0) return false;

  const normalizedProcessCommand = normalizeProcessCommandPathValue(normalizedCommand);
  return ownedRoots.some((ownedRoot) => processCommandContainsPathFragment(normalizedProcessCommand, ownedRoot));
}

function canAdoptDaemonStartedHashDriftMarker(params: Readonly<{
  markerStartedBy: DaemonSessionMarker['startedBy'];
  markerProcessCommand: string | undefined;
  currentProcessCommand: string | undefined;
  procType: string | undefined;
  markerHasRespawnDescriptor: boolean;
}>): boolean {
  if (params.markerStartedBy !== 'daemon') return false;

  const markerCommand = normalizeOptionalString(params.markerProcessCommand);
  const currentCommand = normalizeOptionalString(params.currentProcessCommand);
  if (!markerCommand || !currentCommand) return false;

  const markerRuntimeRoot = resolveCliRuntimeRootFromEntrypoint(markerCommand);
  const currentRuntimeRoot = resolveCliRuntimeRootFromEntrypoint(currentCommand);
  if (markerRuntimeRoot && currentRuntimeRoot && markerRuntimeRoot === currentRuntimeRoot) {
    return true;
  }

  const isDaemonSpawnedProcessType =
    params.procType === 'daemon-spawned-session' || params.procType === 'dev-daemon-spawned';
  if (params.markerHasRespawnDescriptor && isDaemonSpawnedProcessType) {
    // During CLI-update takeover, marker command identity can degrade (e.g. bare "happier ...")
    // and live process inspection can degrade (e.g. just "node"). For daemon-started sessions,
    // a validated respawn descriptor is the durable ownership contract, so allow adoption.
    return true;
  }

  return (
    isOwnedLiveDaemonSessionProcessCommand(markerCommand) &&
    isOwnedLiveDaemonSessionProcessCommand(currentCommand)
  );
}

export function adoptSessionsFromMarkers(params: {
  markers: DaemonSessionMarker[];
  happyProcesses: HappyProcessInfo[];
  pidToTrackedSession: Map<number, TrackedSession>;
  credentials?: StoredCredentials | null;
  deviceLocalSecretStorage?: DeviceLocalSecretStorage;
  processIdentityByPid?: ReadonlyMap<number, LocalServiceProcessFact>;
}): { adopted: number; eligible: number } {
  const happyPidToType = new Map(params.happyProcesses.map((p) => [p.pid, p.type] as const));
  const happyPidToCommandHash = new Map(params.happyProcesses.map((p) => [p.pid, hashProcessCommand(p.command)] as const));
  const happyPidToCommand = new Map(params.happyProcesses.map((p) => [p.pid, p.command] as const));
  const encryptionMaterial = params.credentials?.encryption ?? undefined;

  let adopted = 0;
  let eligible = 0;

  for (const marker of params.markers) {
    // Safety: avoid PID reuse adopting an unrelated process. Only adopt if PID currently looks
    // like a Happy session process (best-effort cross-platform via ps-list classification).
    const procType = happyPidToType.get(marker.pid);
    if (!procType || !ALLOWED_HAPPY_SESSION_PROCESS_TYPES.has(procType)) {
      continue;
    }
    eligible++;
    if (marker.processStartTimeMs !== undefined) {
      const processIdentity = params.processIdentityByPid?.get(marker.pid);
      if (!processGenerationMatches(
        marker.processStartTimeMs,
        processIdentity?.processStartTimeMs,
      )) {
        continue;
      }
    }

    // Legacy markers without a process-generation witness require strict command continuity.
    if (!marker.processCommandHash) {
      continue;
    }
    const currentHash = happyPidToCommandHash.get(marker.pid);
    if (!currentHash) {
      continue;
    }
    const markerHasRespawnDescriptor = marker.respawn !== undefined;
    const respawnParsed = SessionRunnerRespawnDescriptorV1Schema.safeParse(marker.respawn);
    if (markerHasRespawnDescriptor && !respawnParsed.success) {
      continue;
    }
    if (currentHash !== marker.processCommandHash && marker.processStartTimeMs === undefined) {
      const currentCommand = happyPidToCommand.get(marker.pid);
      if (
        !canAdoptDaemonStartedHashDriftMarker({
          markerStartedBy: marker.startedBy,
          markerProcessCommand: marker.processCommand,
          currentProcessCommand: currentCommand,
          procType,
          markerHasRespawnDescriptor: respawnParsed.success,
        })
      ) {
        continue;
      }
    }
    const processIdentity = params.processIdentityByPid?.get(marker.pid);
    const observedProcessStartTimeMs =
      marker.processStartTimeMs
      ?? (
        processIdentity
        && hashProcessCommand(processIdentity.command) === currentHash
          ? processIdentity.processStartTimeMs
          : undefined
      );

    if (params.pidToTrackedSession.has(marker.pid)) continue;
    const currentCommand = happyPidToCommand.get(marker.pid);
    if (!currentCommand) {
      continue;
    }

    const persistedMetadata = marker.metadata && typeof marker.metadata === 'object' && !Array.isArray(marker.metadata)
      ? marker.metadata as Record<string, unknown>
      : null;
    let persistedProviderResumeState: ReturnType<typeof readPersistedProviderResumeState>;
    try {
      persistedProviderResumeState = readPersistedProviderResumeState(persistedMetadata);
    } catch (error) {
      if (error instanceof PersistedProviderResumeBindingError) continue;
      throw error;
    }
    if (persistedProviderResumeState.binding && (!respawnParsed.success || respawnParsed.data.version !== 2)) {
      continue;
    }

    const commandVendorResumeId = normalizeOptionalString(extractResumeIdFromCommand(currentCommand));
    let spawnOptions: SpawnSessionOptions | undefined;
    let vendorResumeId = commandVendorResumeId;
    if (respawnParsed.success) {
      const restoredSpawnOptions = buildSpawnSessionOptionsFromRespawnDescriptorV1(
        respawnParsed.data,
        {
          ...(params.deviceLocalSecretStorage
            ? { deviceLocalSecretStorage: params.deviceLocalSecretStorage }
            : {}),
          ...(encryptionMaterial ? { encryptionMaterial } : {}),
        },
      );
      const runtimeSnapshot = resolveSessionRuntimeSnapshot({
        incomingOptions: restoredSpawnOptions,
        persistedMetadata,
        trackedVendorResumeId: commandVendorResumeId,
        persistedVendorResumeId: respawnParsed.data.vendorResumeId,
      });
      spawnOptions = runtimeSnapshot.spawnOptions;
      vendorResumeId = runtimeSnapshot.snapshot.vendorResumeId?.value
        ?? commandVendorResumeId
        ?? normalizeOptionalString(respawnParsed.data.vendorResumeId);

      const validatedRespawnDescriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions);
      if (!validatedRespawnDescriptor || validatedRespawnDescriptor.version !== respawnParsed.data.version) {
        continue;
      }
    }

    params.pidToTrackedSession.set(marker.pid, buildTrackedSessionFromMarker({
      marker,
      startedByFallback: 'reattached',
      ...(spawnOptions ? { spawnOptions } : {}),
      ...(vendorResumeId ? { vendorResumeId } : {}),
      processCommandHash: currentHash,
      ...(observedProcessStartTimeMs !== undefined
        ? { processStartTimeMs: observedProcessStartTimeMs }
        : {}),
      processCommand: currentCommand,
      reattachedFromDiskMarker: true,
    }));
    adopted++;
  }

  return { adopted, eligible };
}

export async function adoptLiveDaemonSessionsFromProcesses(params: Readonly<{
  happyProcesses: HappyProcessInfo[];
  markedPids: ReadonlySet<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
}>): Promise<number> {
  let adopted = 0;

  for (const proc of params.happyProcesses) {
    if (!LIVE_RECOVERABLE_HAPPY_SESSION_PROCESS_TYPES.has(proc.type as LiveRecoverableHappySessionProcessType)) {
      continue;
    }
    if (params.markedPids.has(proc.pid)) {
      continue;
    }
    if (params.pidToTrackedSession.has(proc.pid)) {
      continue;
    }
    if (typeof proc.command !== 'string' || proc.command.trim().length === 0) {
      continue;
    }
    if (!isOwnedLiveDaemonSessionProcessCommand(proc.command)) {
      continue;
    }
    const processIdentity = await (
      params.readProcessIdentityByPidFn ?? readProcessIdentityByPid
    )(proc.pid);
    if (
      processIdentity?.processStartTimeMs === undefined
      || hashProcessCommand(processIdentity.command) !== hashProcessCommand(proc.command)
    ) {
      continue;
    }

    const happySessionId = `PID-${proc.pid}`;
    const processCommandHash = hashProcessCommand(proc.command);
    const processStartTimeMs = processIdentity.processStartTimeMs;
    params.pidToTrackedSession.set(proc.pid, {
      startedBy: 'daemon',
      happySessionId,
      pid: proc.pid,
      processCommandHash,
      processStartTimeMs,
    });
    adopted++;

    await writeSessionMarker({
      pid: proc.pid,
      happySessionId,
      startedBy: 'daemon',
      processCommandHash,
      processStartTimeMs,
      processCommand: proc.command,
    }).catch((e) => {
      // Best-effort healing only; keep the recovered live session tracked in memory even if
      // the placeholder marker could not be written.
      void e;
    });
  }

  return adopted;
}
