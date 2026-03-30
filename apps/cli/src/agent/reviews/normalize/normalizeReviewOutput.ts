import type { ExecutionRunProfileBoundedCompleteResult } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { BackendTargetRefV1, ExecutionRunRetentionPolicy } from '@happier-dev/protocol';

import { normalizeStrictJsonReviewOutput } from './normalizeStrictJsonReviewOutput';
import { resolveReviewOutputNormalizer } from '@/agent/reviews/registry/reviewEngineRegistry';

export function normalizeReviewOutput(params: Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  backendTarget: BackendTargetRefV1;
  startedAtMs: number;
  finishedAtMs: number;
  rawText: string;
  intentInput?: unknown;
  retentionPolicy?: ExecutionRunRetentionPolicy;
}>): ExecutionRunProfileBoundedCompleteResult {
  const normalize = resolveReviewOutputNormalizer(params.backendId);
  if (normalize) return normalize(params);
  return normalizeStrictJsonReviewOutput(params);
}
