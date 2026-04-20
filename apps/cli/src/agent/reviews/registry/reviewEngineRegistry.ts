import type { BackendTargetRefV1, ExecutionRunRetentionPolicy } from '@happier-dev/protocol';

import type { ExecutionRunProfileBoundedCompleteResult } from '../../executionRuns/profiles/ExecutionRunIntentProfile';
import { getNativeReviewEngineDescriptor } from '../engines/nativeReviewEngines';

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
  return getNativeReviewEngineDescriptor(backendId)?.reviewOutputNormalizer ?? null;
}
