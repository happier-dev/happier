import { ALLOWED_HAPPY_SESSION_PROCESS_TYPES } from './pidSafety';
import type { HappyProcessInfo } from './doctor';
import type { DaemonSessionMarker } from './sessionRegistry';
import { hashProcessCommand } from './sessionRegistry';
import type { TrackedSession } from './types';
import type { Credentials } from '@/persistence';
import { projectPath } from '@/projectPath';
import { resolvePackagedRuntimeProjectRoots } from '@/runtime/resolvePackagedRuntimeEntrypoint';
import {
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from './processSupervision/sessionRunnerRespawnDescriptor';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { resolveSessionRuntimeSnapshot } from './sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { extractResumeIdFromCommand } from './sessions/extractResumeIdFromCommand';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

type AdoptSessionsFromMarkersResult = Readonly<{
  adopted: number;
  eligible: number;
  adoptedPids: ReadonlyArray<number>;
  respawnRestoreErrors: ReadonlyArray<{
    pid: number;
    happySessionId: string;
    message: string;
  }>;
}>;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRuntimeSnapshotMetadata(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function applyMarkerRuntimeSnapshot(
  spawnOptions: SpawnSessionOptions,
  metadata: unknown,
): SpawnSessionOptions {
  return resolveSessionRuntimeSnapshot({
    incomingOptions: spawnOptions,
    persistedMetadata: readRuntimeSnapshotMetadata(metadata),
  }).spawnOptions;
}

function normalizePathLike(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function resolveCliRuntimeRootFromEntrypoint(pathLike: string | undefined): string | null {
  const normalized = normalizeOptionalString(pathLike);
  if (!normalized) return null;

  const normalizedPath = normalizePathLike(normalized);
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

  const subprocessEntrypointRoot = resolveCliRuntimeRootFromEntrypoint(
    normalizeOptionalString(process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT),
  );
  if (subprocessEntrypointRoot) {
    ownedRoots.add(subprocessEntrypointRoot);
  }

  for (const runtimeRoot of resolvePackagedRuntimeProjectRoots()) {
    ownedRoots.add(normalizePathLike(runtimeRoot));
  }

  ownedRoots.add(normalizePathLike(projectPath()));
  return [...ownedRoots];
}

export function isOwnedLiveDaemonSessionProcessCommand(command: string): boolean {
  const normalizedCommand = normalizeOptionalString(command);
  if (!normalizedCommand) return false;

  const ownedRoots = resolveOwnedLiveDaemonSessionRuntimeRoots();
  if (ownedRoots.length === 0) return false;

  const normalizedProcessCommand = normalizePathLike(normalizedCommand);
  return ownedRoots.some((ownedRoot) => normalizedProcessCommand.includes(ownedRoot));
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
  const isUserSessionClassification =
    params.procType === 'user-session' || params.procType === 'dev-session';
  const currentCommandLooksLikeBareRuntime =
    currentCommand === 'node' ||
    currentCommand === 'bun' ||
    currentCommand === 'tsx' ||
    currentCommand === 'node.exe' ||
    currentCommand === 'bun.exe';

  if (
    params.markerHasRespawnDescriptor
    && (
      isDaemonSpawnedProcessType
      || (isUserSessionClassification && currentCommandLooksLikeBareRuntime)
    )
  ) {
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
  credentials?: Credentials | null;
  readProcessInstanceFingerprint?: typeof readProcessInstanceFingerprintSync;
}): AdoptSessionsFromMarkersResult {
  const happyPidToType = new Map(params.happyProcesses.map((p) => [p.pid, p.type] as const));
  const happyPidToCommandHash = new Map(params.happyProcesses.map((p) => [p.pid, hashProcessCommand(p.command)] as const));
  const happyPidToCommand = new Map(params.happyProcesses.map((p) => [p.pid, p.command] as const));
  const readProcessInstanceFingerprint = params.readProcessInstanceFingerprint ?? readProcessInstanceFingerprintSync;

  let adopted = 0;
  let eligible = 0;
  const adoptedPids: number[] = [];
  const respawnRestoreErrors: Array<{ pid: number; happySessionId: string; message: string }> = [];

  for (const marker of params.markers) {
    // Safety: avoid PID reuse adopting an unrelated process. Only adopt if PID currently looks
    // like a Happy session process (best-effort cross-platform via ps-list classification).
    const procType = happyPidToType.get(marker.pid);
    if (!procType || !ALLOWED_HAPPY_SESSION_PROCESS_TYPES.has(procType)) {
      continue;
    }
    eligible++;

    const currentProcessInstanceFingerprint = readProcessInstanceFingerprint(marker.pid) ?? undefined;
    if (
      marker.processInstanceFingerprint
      && currentProcessInstanceFingerprint !== marker.processInstanceFingerprint
    ) {
      continue;
    }

    // Legacy markers have no process-generation fingerprint, so retain strict command matching.
    if (!marker.processCommandHash) {
      continue;
    }
    const currentHash = happyPidToCommandHash.get(marker.pid);
    if (!currentHash) {
      continue;
    }
    if (currentHash !== marker.processCommandHash && !marker.processInstanceFingerprint) {
      const currentCommand = happyPidToCommand.get(marker.pid);
      if (
        !canAdoptDaemonStartedHashDriftMarker({
          markerStartedBy: marker.startedBy,
          markerProcessCommand: marker.processCommand,
          currentProcessCommand: currentCommand,
          procType,
          markerHasRespawnDescriptor: typeof marker.respawn === 'object' && marker.respawn !== null,
        })
      ) {
        continue;
      }
    }

    if (params.pidToTrackedSession.has(marker.pid)) continue;

    const currentCommand = happyPidToCommand.get(marker.pid);
    if (!currentCommand) {
      continue;
    }

    const respawnParsed = SessionRunnerRespawnDescriptorV1Schema.safeParse((marker as any).respawn);
    let spawnOptions: SpawnSessionOptions | undefined;
    if (respawnParsed.success) {
      try {
        const restoredSpawnOptions = buildSpawnSessionOptionsFromRespawnDescriptorV1(respawnParsed.data, {
          encryptionMaterial: params.credentials?.encryption,
        });
        spawnOptions = applyMarkerRuntimeSnapshot(restoredSpawnOptions, marker.metadata);
      } catch (error) {
        respawnRestoreErrors.push({
          pid: marker.pid,
          happySessionId: marker.happySessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Restore the runner's vendor resume identity so adoption never reduces restartability.
    // Prefer the persisted descriptor field; belt-and-braces backfill from the live argv
    // (`--resume <id>`) heals runners whose marker predates identity persistence.
    const vendorResumeId =
      (respawnParsed.success ? normalizeOptionalString(respawnParsed.data.vendorResumeId) : undefined) ??
      normalizeOptionalString(extractResumeIdFromCommand(currentCommand));

    params.pidToTrackedSession.set(marker.pid, {
      startedBy: marker.startedBy ?? 'reattached',
      happySessionId: marker.happySessionId,
      happySessionMetadataFromLocalWebhook: marker.metadata,
      ...(spawnOptions ? { spawnOptions } : {}),
      ...(vendorResumeId ? { vendorResumeId } : {}),
      ...(marker.activeTurnId ? { activeTurnId: marker.activeTurnId } : {}),
      pid: marker.pid,
      processCommandHash: currentHash,
      ...(currentProcessInstanceFingerprint ? { processInstanceFingerprint: currentProcessInstanceFingerprint } : {}),
      processCommand: currentCommand,
      reattachedFromDiskMarker: true,
    });
    adoptedPids.push(marker.pid);
    adopted++;
  }

  return { adopted, eligible, adoptedPids, respawnRestoreErrors };
}
