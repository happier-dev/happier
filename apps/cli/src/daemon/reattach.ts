import { ALLOWED_HAPPY_SESSION_PROCESS_TYPES } from './pidSafety';
import type { HappyProcessInfo } from './doctor';
import { hashProcessCommand, writeSessionMarker } from './sessionRegistry';
import type { DaemonSessionMarker } from './sessionRegistry';
import type { Credentials } from '@/persistence';
import type { TrackedSession } from './types';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol';
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
    if (!currentHash || currentHash !== marker.processCommandHash) {
      continue;
    }

    if (params.pidToTrackedSession.has(marker.pid)) continue;

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
      processCommandHash: marker.processCommandHash,
      reattachedFromDiskMarker: true,
    });
    adopted++;
  }

  return { adopted, eligible };
}

export async function adoptLiveDaemonSessionsFromProcesses(params: Readonly<{
  happyProcesses: HappyProcessInfo[];
  pidToTrackedSession: Map<number, TrackedSession>;
}>): Promise<number> {
  let adopted = 0;

  for (const proc of params.happyProcesses) {
    if (!LIVE_RECOVERABLE_HAPPY_SESSION_PROCESS_TYPES.has(proc.type as LiveRecoverableHappySessionProcessType)) {
      continue;
    }
    if (params.pidToTrackedSession.has(proc.pid)) {
      continue;
    }
    if (typeof proc.command !== 'string' || proc.command.trim().length === 0) {
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
