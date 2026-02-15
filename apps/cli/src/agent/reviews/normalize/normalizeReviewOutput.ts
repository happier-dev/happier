import type { ExecutionRunProfileBoundedCompleteResult } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

import { normalizeStrictJsonReviewOutput } from './normalizeStrictJsonReviewOutput';
import { resolveReviewOutputNormalizer } from '@/agent/reviews/registry/reviewEngineRegistry';

export function normalizeReviewOutput(params: Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  startedAtMs: number;
  finishedAtMs: number;
  rawText: string;
}>): ExecutionRunProfileBoundedCompleteResult {
  const normalize = resolveReviewOutputNormalizer(params.backendId);
  if (normalize) return normalize(params);
  return normalizeStrictJsonReviewOutput(params);
}
