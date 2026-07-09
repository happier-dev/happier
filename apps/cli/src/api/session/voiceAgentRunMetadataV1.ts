import {
  VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
  buildVoiceAgentRunMetadataV1,
  parseVoiceAgentRunMetadataV1,
  voiceAgentRunMetadataV1Equal,
  type ExecutionRunPublicState,
  type VoiceAgentRunMetadataV1,
} from '@happier-dev/protocol';

export { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION };
export type { VoiceAgentRunMetadataV1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * Merge canonical `voiceAgentRunV1` metadata derived from a voice-agent public run
 * into a session metadata record. Returns the input metadata unchanged when the run
 * is not a voice-agent run or when the canonical envelope is already equivalent.
 *
 * Backend id, transcript contract version, and envelope shape are owned by the
 * protocol `voiceAgentRunMetadataV1` contract. Legacy `streamId` is never re-emitted.
 */
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
  const existing = parseVoiceAgentRunMetadataV1(currentMetadata.voiceAgentRunV1);
  const welcomedEpoch =
    readNonNegativeInt(params.welcomedEpoch)
    ?? readNonNegativeInt(existing?.welcomedEpoch);

  const next = buildVoiceAgentRunMetadataV1({
    runId: params.run.runId,
    backendTarget: params.run.backendTarget,
    resumeHandle: params.run.resumeHandle ?? null,
    updatedAtMs: readNonNegativeInt(params.nowMs) ?? Date.now(),
    ...(typeof welcomedEpoch === 'number' ? { welcomedEpoch } : {}),
  });
  if (!next) {
    return params.metadata;
  }

  if (existing && voiceAgentRunMetadataV1Equal(existing, next)) {
    return currentMetadata;
  }

  return {
    ...currentMetadata,
    voiceAgentRunV1: next,
  };
}
