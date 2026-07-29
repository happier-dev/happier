import { SessionIndexedIdentifierMaxLengthV1 } from '../sessions/idsV1.js';

/**
 * Internal CORE-A candidate owner. The stable SDK constant remains unpublished
 * until RA21-M/CORE.T2B promotes the measured members.
 */
export const AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 = Object.freeze({
  hostIndexedIdMaxCodeUnits: SessionIndexedIdentifierMaxLengthV1,
  providerIdMaxCodeUnits: 2_000,
  inputIdsMaxItems: 512,
  toolNameMaxCodeUnits: 512,
  modelIdMaxCodeUnits: 512,
  usageSourceMaxCodeUnits: 128,
  filePathMaxCodeUnits: 10_000,
  descriptionMaxCodeUnits: 8_000,
  deltaTextMaxCodeUnits: 64 * 1_024,
  compactInstructionsMaxCodeUnits: 32 * 1_024,
  json: Object.freeze({
    maxDepth: 24,
    maxNodes: 8_192,
    maxKeyUtf8Bytes: 256,
    maxStringUtf8Bytes: 256 * 1_024,
  }),
  usage: Object.freeze({
    breakdownMaxEntries: 64,
    breakdownKeyMaxCodeUnits: 128,
    currencyMaxCodeUnits: 16,
    contextCategoriesMaxItems: 64,
    contextCategoryKeyMaxCodeUnits: 128,
    contextCategoryLabelMaxCodeUnits: 512,
  }),
  safeIntegerMax: Number.MAX_SAFE_INTEGER,
  p0MeasuredCandidates: Object.freeze({
    inputTextMaxCodeUnits: 512 * 1_024,
    transcriptTextMaxCodeUnits: 512 * 1_024,
    jsonValueMaxJsonBytes: 1_024 * 1_024,
    sendRequestMaxJsonBytes: 2_500_000,
    eventMaxJsonBytes: 2_500_000,
    fileEditMemberMaxCodeUnits: 1_000_000,
    fileEditContentMaxJsonBytes: 2_000_000,
    conversationRollbackMaxAffectedTurns: 4_096,
    preWatchReplayBufferMaxEvents: 1_024,
    preWatchReplayBufferMaxJsonBytes: 8 * 1_024 * 1_024,
    completionReplayCacheMaxEntries: 1_024,
    completionReplayCacheMaxJsonBytes: 8 * 1_024 * 1_024,
  }),
} as const);

export type AgentSessionRuntimeLimitsCandidateV1 =
  typeof AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1;
