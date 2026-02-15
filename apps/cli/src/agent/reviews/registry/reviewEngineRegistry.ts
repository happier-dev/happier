import type { ExecutionRunProfileBoundedCompleteResult } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

import { resolveNativeReviewOutputNormalizer } from '@/agent/reviews/engines/nativeReviewEngines';

export type ReviewOutputNormalizer = (params: Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  startedAtMs: number;
  finishedAtMs: number;
  rawText: string;
}>) => ExecutionRunProfileBoundedCompleteResult;

export function resolveReviewOutputNormalizer(backendId: string): ReviewOutputNormalizer | null {
  return resolveNativeReviewOutputNormalizer(backendId);
}
