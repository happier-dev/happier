import os from 'node:os';

import { createLocalSessionHandoffMetadataStore } from '@/session/handoff/metadata/localSessionHandoffMetadataStore';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';

import { buildHandoffSessionMetadataFromTrackedSession } from './buildHandoffSessionMetadataFromTrackedSession';
import type { TrackedSession } from '../types';

type LocalSessionHandoffMetadataStore = Readonly<{
  loadByVendorResumeId(vendorResumeId: string): Promise<Record<string, unknown> | null>;
}>;

function collectTrackedSessionIds(trackedSession: TrackedSession): string[] {
  return [
    trackedSession.happySessionId,
    trackedSession.vendorResumeId,
    trackedSession.spawnOptions?.resume,
  ]
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);
}

function resolveTrackedSessionForHandoff(
  pidToTrackedSession: Map<number, TrackedSession>,
  sessionId: string,
): TrackedSession | null {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return null;
  }

  for (const trackedSession of pidToTrackedSession.values()) {
    if (collectTrackedSessionIds(trackedSession).includes(normalizedSessionId)) {
      return trackedSession;
    }
  }

  return null;
}

function resolveTrackedSessionHandoffVendorResumeId(trackedSession: TrackedSession): string {
  const vendorResumeId =
    typeof trackedSession.vendorResumeId === 'string' && trackedSession.vendorResumeId.trim().length > 0
      ? trackedSession.vendorResumeId.trim()
      : typeof trackedSession.spawnOptions?.resume === 'string' && trackedSession.spawnOptions.resume.trim().length > 0
        ? trackedSession.spawnOptions.resume.trim()
        : '';
  return vendorResumeId;
}

export function createLoadLocalSessionMetadataForHandoff(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  getMachineId: () => string;
  activeServerDir: string;
  localSessionHandoffMetadataStore?: LocalSessionHandoffMetadataStore;
}>): (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null> {
  const localSessionHandoffMetadataStore =
    params.localSessionHandoffMetadataStore ??
    createLocalSessionHandoffMetadataStore({
      activeServerDir: params.activeServerDir,
    });
  const fallbackHomeDir = os.homedir();

  return async (sessionId: string): Promise<SessionHandoffLocalMetadataSource | null> => {
    const trackedSession = resolveTrackedSessionForHandoff(params.pidToTrackedSession, sessionId);
    if (!trackedSession) {
      return null;
    }

    const vendorResumeId = resolveTrackedSessionHandoffVendorResumeId(trackedSession);
    const localExportMetadataOverlay =
      vendorResumeId ? await localSessionHandoffMetadataStore.loadByVendorResumeId(vendorResumeId) : null;

    return await buildHandoffSessionMetadataFromTrackedSession({
      trackedSession,
      machineId: params.getMachineId(),
      fallbackHomeDir,
      localExportMetadataOverlay,
    });
  };
}
