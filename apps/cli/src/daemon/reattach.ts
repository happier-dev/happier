import { ALLOWED_HAPPY_SESSION_PROCESS_TYPES } from './pidSafety';
import type { HappyProcessInfo } from './doctor';
import { hashProcessCommand, writeSessionMarker } from './sessionRegistry';
import type { DaemonSessionMarker } from './sessionRegistry';
import type { Credentials } from '@/persistence';
import type { TrackedSession } from './types';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol';
import { projectPath } from '@/projectPath';
import { resolvePackagedRuntimeProjectRoots } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import {
  buildSpawnSessionOptionsFromRespawnDescriptorV1,
  SessionRunnerRespawnDescriptorV1Schema,
} from './processSupervision/sessionRunnerRespawnDescriptor';

const LIVE_RECOVERABLE_HAPPY_SESSION_PROCESS_TYPES = new Set([
  'daemon-spawned-session',
  'dev-daemon-spawned',
] as const);

type LiveRecoverableHappySessionProcessType = 'daemon-spawned-session' | 'dev-daemon-spawned';
let respawnDescriptorEncryptionMaterial: AccountScopedCryptoMaterial | null = null;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

  const currentSubprocessEntrypointRoot = resolveCliRuntimeRootFromEntrypoint(
    normalizeOptionalString(process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT),
  );
  if (currentSubprocessEntrypointRoot) {
    ownedRoots.add(currentSubprocessEntrypointRoot);
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

export function setRespawnDescriptorEncryptionMaterialForRestore(
  encryptionMaterial: AccountScopedCryptoMaterial | null,
): void {
  respawnDescriptorEncryptionMaterial = encryptionMaterial;
}

export function adoptSessionsFromMarkers(params: {
  markers: DaemonSessionMarker[];
  happyProcesses: HappyProcessInfo[];
  pidToTrackedSession: Map<number, TrackedSession>;
  credentials?: Credentials | null;
}): { adopted: number; eligible: number } {
  const happyPidToType = new Map(params.happyProcesses.map((p) => [p.pid, p.type] as const));
  const happyPidToCommandHash = new Map(params.happyProcesses.map((p) => [p.pid, hashProcessCommand(p.command)] as const));
  const happyPidToCommand = new Map(params.happyProcesses.map((p) => [p.pid, p.command] as const));
  const encryptionMaterial = params.credentials?.encryption ?? respawnDescriptorEncryptionMaterial ?? undefined;

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

    // Stronger PID reuse safety: require the marker's observed command hash to match what is currently running.
    if (!marker.processCommandHash) {
      continue;
    }
    const currentHash = happyPidToCommandHash.get(marker.pid);
    if (!currentHash) {
      continue;
    }
    if (currentHash !== marker.processCommandHash) {
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
    const spawnOptions = respawnParsed.success
      ? buildSpawnSessionOptionsFromRespawnDescriptorV1(respawnParsed.data, encryptionMaterial ? { encryptionMaterial } : undefined)
      : undefined;

    params.pidToTrackedSession.set(marker.pid, {
      startedBy: marker.startedBy ?? 'reattached',
      happySessionId: marker.happySessionId,
      happySessionMetadataFromLocalWebhook: marker.metadata,
      ...(spawnOptions ? { spawnOptions } : {}),
      ...(normalizeOptionalString(spawnOptions?.resume) ? { vendorResumeId: normalizeOptionalString(spawnOptions?.resume) } : {}),
      pid: marker.pid,
      processCommandHash: currentHash,
      processCommand: currentCommand,
      reattachedFromDiskMarker: true,
    });
    adopted++;
  }

  return { adopted, eligible };
}

export async function adoptLiveDaemonSessionsFromProcesses(params: Readonly<{
  happyProcesses: HappyProcessInfo[];
  markedPids: ReadonlySet<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
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

    const happySessionId = `PID-${proc.pid}`;
    const processCommandHash = hashProcessCommand(proc.command);
    params.pidToTrackedSession.set(proc.pid, {
      startedBy: 'daemon',
      happySessionId,
      pid: proc.pid,
      processCommandHash,
    });
    adopted++;

    await writeSessionMarker({
      pid: proc.pid,
      happySessionId,
      startedBy: 'daemon',
      processCommandHash,
      processCommand: proc.command,
    }).catch((e) => {
      // Best-effort healing only; keep the recovered live session tracked in memory even if
      // the placeholder marker could not be written.
      void e;
    });
  }

  return adopted;
}
