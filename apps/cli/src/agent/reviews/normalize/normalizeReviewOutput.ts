import type { BackendTargetRefV1, ExecutionRunRetentionPolicy } from '@happier-dev/protocol';

import type { ExecutionRunProfileBoundedCompleteResult } from '../../executionRuns/profiles/ExecutionRunIntentProfile';
import { normalizeStrictJsonReviewOutput } from './normalizeStrictJsonReviewOutput';

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
  return normalizeStrictJsonReviewOutput(params);
}
