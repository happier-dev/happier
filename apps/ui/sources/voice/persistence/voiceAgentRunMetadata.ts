import {
    VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
    buildVoiceAgentRunMetadataV1,
    doesVoiceAgentRunMetadataMatchBackendTarget,
    parseVoiceAgentRunMetadataV1,
    type BackendTargetRefV1,
    type ExecutionRunResumeHandle,
    type VoiceAgentRunMetadataV1,
} from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

export { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION };
export { doesVoiceAgentRunMetadataMatchBackendTarget };
export type { VoiceAgentRunMetadataV1 };

function readVoiceAgentRunMetadata(sessionId: string | null): VoiceAgentRunMetadataV1 | null {
  if (!sessionId) return null;
  const state: any = storage.getState();
  const meta = readVoiceSessionOwnerMetadataFromState(state, sessionId);
  return parseVoiceAgentRunMetadataV1(meta?.voiceAgentRunV1 ?? null);
}

async function writeVoiceAgentRunMetadata(
  sessionId: string | null,
  params: Readonly<{
    runId: string;
    backendTarget: BackendTargetRefV1;
    resumeHandle: ExecutionRunResumeHandle | null;
    updatedAtMs: number;
    welcomedEpoch?: number;
  }>,
): Promise<void> {
  if (!sessionId) return;
  const existing = readVoiceAgentRunMetadata(sessionId);
  const welcomedEpoch =
    typeof params.welcomedEpoch === 'number' && Number.isFinite(params.welcomedEpoch) && params.welcomedEpoch >= 0
      ? Math.floor(params.welcomedEpoch)
      : existing?.welcomedEpoch;
  const payload = buildVoiceAgentRunMetadataV1({
    runId: params.runId,
    backendTarget: params.backendTarget,
    resumeHandle: params.resumeHandle ?? null,
    updatedAtMs: params.updatedAtMs,
    ...(typeof welcomedEpoch === 'number' ? { welcomedEpoch } : {}),
  });
  if (!payload) return;

  await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => ({
    ...metadata,
    voiceAgentRunV1: payload,
  }));
}

async function clearVoiceAgentRunMetadata(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => ({
    ...metadata,
    voiceAgentRunV1: null,
  }));
}

export function readVoiceAgentRunMetadataFromSession(params: Readonly<{ sessionId: string }>): VoiceAgentRunMetadataV1 | null {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  return readVoiceAgentRunMetadata(sessionId);
}

export async function writeVoiceAgentRunMetadataToSession(
  params: Readonly<{
    sessionId: string;
    runId: string;
    backendTarget: BackendTargetRefV1;
    resumeHandle: ExecutionRunResumeHandle | null;
    updatedAtMs: number;
    welcomedEpoch?: number;
  }>,
): Promise<void> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  await writeVoiceAgentRunMetadata(sessionId, params);
}

export async function clearVoiceAgentRunMetadataFromSession(
  params: Readonly<{ sessionId: string }>,
): Promise<void> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  await clearVoiceAgentRunMetadata(sessionId);
}
