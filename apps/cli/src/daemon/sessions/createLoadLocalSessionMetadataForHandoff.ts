import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { resolveSessionMachineWorkspacePath } from '@/session/machineControlLocality';
import os from 'node:os';

import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';

import { buildHandoffSessionMetadataFromTrackedSession } from './buildHandoffSessionMetadataFromTrackedSession';
import type { TrackedSession } from '../types';

function resolveTrackedSessionForHandoff(
  pidToTrackedSession: Map<number, TrackedSession>,
  sessionId: string,
  allowProviderResumeIds = true,
): TrackedSession | null {
  const providerSessionId = readNonBlankOpaqueIdentifier(sessionId);
  if (!providerSessionId) {
    return null;
  }
  const happierSessionId = sessionId.trim();

  for (const trackedSession of pidToTrackedSession.values()) {
    const trackedHappierSessionId = trackedSession.happySessionId?.trim() ?? '';
    if (trackedHappierSessionId && trackedHappierSessionId === happierSessionId) {
      return trackedSession;
    }

    if (!allowProviderResumeIds) continue;

    const trackedVendorResumeId = readNonBlankOpaqueIdentifier(trackedSession.vendorResumeId);
    const trackedSpawnResumeId = readNonBlankOpaqueIdentifier(trackedSession.spawnOptions?.resume);
    if (trackedVendorResumeId === providerSessionId || trackedSpawnResumeId === providerSessionId) {
      return trackedSession;
    }
  }

  return null;
}

export function createResolveHostedSessionWorkingDirectory(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  getMachineId: () => string;
}>): (sessionId: string) => Promise<string | null> {
  const fallbackHomeDir = os.homedir();
  return async (sessionId) => {
    const trackedSession = resolveTrackedSessionForHandoff(params.pidToTrackedSession, sessionId, false);
    if (!trackedSession) return null;
    const machineId = params.getMachineId();
    const metadata = await buildHandoffSessionMetadataFromTrackedSession({ trackedSession, machineId, fallbackHomeDir });
    if (!metadata) return null;
    return resolveSessionMachineWorkspacePath({
      metadata: metadata.exportMetadata,
      currentMachineId: machineId,
      candidatePath: metadata.exportMetadata.path,
    });
  };
}

export function createLoadLocalSessionMetadataForHandoff(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  getMachineId: () => string;
}>): (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null> {
  const fallbackHomeDir = os.homedir();

  return async (sessionId: string): Promise<SessionHandoffLocalMetadataSource | null> => {
    const trackedSession = resolveTrackedSessionForHandoff(params.pidToTrackedSession, sessionId);
    if (!trackedSession) {
      return null;
    }

    return await buildHandoffSessionMetadataFromTrackedSession({
      trackedSession,
      machineId: params.getMachineId(),
      fallbackHomeDir,
    });
  };
}
