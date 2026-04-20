import {
    BackendTargetRefSchema,
    VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
    type BackendTargetRefV1,
    type ExecutionRunResumeHandle,
} from '@happier-dev/protocol';

import {
    resolveSessionListPreferredSessionMetadataFromState,
    type SessionMetadataLike,
} from '@/sync/domains/session/listing/sessionListLookupState';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { backendTargetsMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
export { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION };

export type VoiceAgentRunMetadataV1 = Readonly<{
  v: 1;
  runId: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  resumeHandle: ExecutionRunResumeHandle | null;
  streamId?: string | null;
  updatedAtMs: number;
  transcriptContractVersion?: number;
  welcomedEpoch?: number;
}>;

function isVoiceAgentRunMetadataV1(value: unknown): value is VoiceAgentRunMetadataV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  if (v.v !== 1) return false;
  if (v.backendTarget != null && !BackendTargetRefSchema.safeParse(v.backendTarget).success) return false;
  if (v.welcomedEpoch != null && (!Number.isFinite(v.welcomedEpoch) || v.welcomedEpoch < 0)) return false;
  if (v.streamId != null && (typeof v.streamId !== 'string' || v.streamId.trim().length === 0)) return false;
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
    return backendTargetsMatch(metadata.backendTarget, backendTarget);
  }

  if (backendTarget.kind === 'builtInAgent') {
    return metadata.backendId === backendTarget.agentId;
  }

  return metadata.backendId === backendTarget.backendId;
}

function readVoiceAgentRunMetadata(sessionId: string | null): VoiceAgentRunMetadataV1 | null {
  if (!sessionId) return null;
  const state: any = storage.getState();
  const meta = resolveSessionListPreferredSessionMetadataFromState(state, sessionId) as
    | (SessionMetadataLike & Readonly<{ voiceAgentRunV1?: unknown }>)
    | null;
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
    streamId?: string | null;
    updatedAtMs: number;
    welcomedEpoch?: number;
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
  const existing = readVoiceAgentRunMetadata(sessionId);
  const normalizedStreamId =
    Object.prototype.hasOwnProperty.call(params, 'streamId')
      ? normalizeNonEmptyString(params.streamId) ?? null
      : existing?.runId === runId
        ? normalizeNonEmptyString(existing?.streamId) ?? null
        : null;
  const welcomedEpoch =
    typeof params.welcomedEpoch === 'number' && Number.isFinite(params.welcomedEpoch) && params.welcomedEpoch >= 0
      ? Math.floor(params.welcomedEpoch)
      : typeof existing?.welcomedEpoch === 'number' && Number.isFinite(existing.welcomedEpoch) && existing.welcomedEpoch >= 0
        ? Math.floor(existing.welcomedEpoch)
        : undefined;

  const payload: VoiceAgentRunMetadataV1 = {
    v: 1,
    runId,
    backendId,
    backendTarget,
    resumeHandle: params.resumeHandle ?? null,
    streamId: normalizedStreamId,
    updatedAtMs,
    transcriptContractVersion: VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
    ...(typeof welcomedEpoch === 'number' ? { welcomedEpoch } : {}),
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
    streamId?: string | null;
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
