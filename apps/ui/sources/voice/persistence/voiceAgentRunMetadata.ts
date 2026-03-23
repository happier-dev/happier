import {
    BackendTargetRefSchema,
    buildBackendTargetKey,
    type BackendTargetRefV1,
    type ExecutionRunResumeHandle,
} from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

export const VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION = 2;

export type VoiceAgentRunMetadataV1 = Readonly<{
  v: 1;
  runId: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  resumeHandle: ExecutionRunResumeHandle | null;
  updatedAtMs: number;
  transcriptContractVersion?: number;
}>;

function isVoiceAgentRunMetadataV1(value: unknown): value is VoiceAgentRunMetadataV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  if (v.v !== 1) return false;
  if (v.backendTarget != null && !BackendTargetRefSchema.safeParse(v.backendTarget).success) return false;
  return (
    typeof v.runId === 'string'
    && v.runId.trim().length > 0
    && typeof v.backendId === 'string'
    && v.backendId.trim().length > 0
    && typeof v.updatedAtMs === 'number'
    && Number.isFinite(v.updatedAtMs)
  );
}

export function doesVoiceAgentRunMetadataMatchBackendTarget(
  metadata: VoiceAgentRunMetadataV1 | null | undefined,
  backendTarget: BackendTargetRefV1,
): boolean {
  if (!metadata) return false;
  if (metadata.backendTarget) {
    return buildBackendTargetKey(metadata.backendTarget) === buildBackendTargetKey(backendTarget);
  }

  if (backendTarget.kind === 'builtInAgent') {
    return metadata.backendId === backendTarget.agentId;
  }

  return metadata.backendId === backendTarget.backendId;
}

function readVoiceAgentRunMetadata(sessionId: string | null): VoiceAgentRunMetadataV1 | null {
  if (!sessionId) return null;
  const session: any = storage.getState().sessions?.[sessionId] ?? null;
  const meta = session?.metadata ?? null;
  const runMeta = meta?.voiceAgentRunV1 ?? null;
  return isVoiceAgentRunMetadataV1(runMeta) ? runMeta : null;
}

async function writeVoiceAgentRunMetadata(
  sessionId: string | null,
  params: Readonly<{
    runId: string;
    backendId: string;
    backendTarget: BackendTargetRefV1;
    resumeHandle: ExecutionRunResumeHandle | null;
    updatedAtMs: number;
  }>,
): Promise<void> {
  const runId = normalizeNonEmptyString(params.runId);
  const backendId = normalizeNonEmptyString(params.backendId);
  const backendTarget = BackendTargetRefSchema.safeParse(params.backendTarget).success ? params.backendTarget : null;
  const updatedAtMs =
    typeof params.updatedAtMs === 'number' && Number.isFinite(params.updatedAtMs) && params.updatedAtMs >= 0
      ? Math.floor(params.updatedAtMs)
      : Date.now();
  if (!sessionId || !runId || !backendId || !backendTarget) return;

  const payload: VoiceAgentRunMetadataV1 = {
    v: 1,
    runId,
    backendId,
    backendTarget,
    resumeHandle: params.resumeHandle ?? null,
    updatedAtMs,
    transcriptContractVersion: VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
  };

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
    backendId: string;
    backendTarget: BackendTargetRefV1;
    resumeHandle: ExecutionRunResumeHandle | null;
    updatedAtMs: number;
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
