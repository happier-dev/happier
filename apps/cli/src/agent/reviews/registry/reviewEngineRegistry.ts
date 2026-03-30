import type { ExecutionRunProfileBoundedCompleteResult } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { BackendTargetRefV1, ExecutionRunRetentionPolicy } from '@happier-dev/protocol';

import { resolveNativeReviewOutputNormalizer } from '@/agent/reviews/engines/nativeReviewEngines';

export type ReviewOutputNormalizer = (params: Readonly<{
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
}>) => ExecutionRunProfileBoundedCompleteResult;

export function resolveReviewOutputNormalizer(backendId: string): ReviewOutputNormalizer | null {
  return resolveNativeReviewOutputNormalizer(backendId);
}
