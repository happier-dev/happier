import { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION, type BackendTargetRefV1, type ExecutionRunPublicState } from '@happier-dev/protocol';
export { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION };

export type VoiceAgentRunMetadataV1 = Readonly<{
  v: 1;
  runId: string;
  backendId: string;
  backendTarget: BackendTargetRefV1;
  resumeHandle: unknown | null;
  updatedAtMs: number;
  transcriptContractVersion: number;
  welcomedEpoch?: number;
  streamId?: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function readOptionalStreamId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveBackendId(backendTarget: BackendTargetRefV1): string {
  return backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : backendTarget.backendId;
}

function readExistingVoiceAgentRunMetadata(value: unknown): VoiceAgentRunMetadataV1 | null {
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;
  const runId = typeof value.runId === 'string' && value.runId.trim().length > 0 ? value.runId.trim() : null;
  const backendId = typeof value.backendId === 'string' && value.backendId.trim().length > 0 ? value.backendId.trim() : null;
  const updatedAtMs = readNonNegativeInt(value.updatedAtMs);
  if (!runId || !backendId || updatedAtMs === undefined || !isRecord(value.backendTarget)) {
    return null;
  }
  const welcomedEpoch = readNonNegativeInt(value.welcomedEpoch);
  const streamId = readOptionalStreamId(value.streamId);
  return {
    v: 1,
    runId,
    backendId,
    backendTarget: value.backendTarget as BackendTargetRefV1,
    resumeHandle: value.resumeHandle ?? null,
    updatedAtMs,
    transcriptContractVersion:
      readNonNegativeInt(value.transcriptContractVersion) ?? VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
    ...(typeof welcomedEpoch === 'number' ? { welcomedEpoch } : {}),
    ...(streamId !== undefined ? { streamId } : {}),
  };
}

function sameSerialized(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function mergeVoiceAgentRunMetadataFromExecutionRun(params: Readonly<{
  metadata: Record<string, unknown> | null;
  run: ExecutionRunPublicState;
  welcomedEpoch?: number;
  nowMs?: number;
}>): Record<string, unknown> | null {
  if (params.run.intent !== 'voice_agent') {
    return params.metadata;
  }

  const currentMetadata = isRecord(params.metadata) ? params.metadata : {};
  const existing = readExistingVoiceAgentRunMetadata(currentMetadata.voiceAgentRunV1);
  const welcomedEpoch =
    readNonNegativeInt(params.welcomedEpoch)
    ?? readNonNegativeInt(existing?.welcomedEpoch)
    ?? undefined;
  const next: VoiceAgentRunMetadataV1 = {
    v: 1,
    runId: params.run.runId,
    backendId: resolveBackendId(params.run.backendTarget),
    backendTarget: params.run.backendTarget,
    resumeHandle: params.run.resumeHandle ?? null,
    updatedAtMs:
      readNonNegativeInt(params.nowMs)
      ?? Date.now(),
    transcriptContractVersion: VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
    ...(typeof welcomedEpoch === 'number' ? { welcomedEpoch } : {}),
    ...(existing?.streamId !== undefined ? { streamId: existing.streamId ?? null } : {}),
  };

  if (
    existing
    && existing.runId === next.runId
    && existing.backendId === next.backendId
    && existing.updatedAtMs === next.updatedAtMs
    && existing.transcriptContractVersion === next.transcriptContractVersion
    && readNonNegativeInt(existing.welcomedEpoch) === readNonNegativeInt(next.welcomedEpoch)
    && readOptionalStreamId(existing.streamId) === readOptionalStreamId(next.streamId)
    && sameSerialized(existing.backendTarget, next.backendTarget)
    && sameSerialized(existing.resumeHandle, next.resumeHandle)
  ) {
    return currentMetadata;
  }

  return {
    ...currentMetadata,
    voiceAgentRunV1: next,
  };
}
