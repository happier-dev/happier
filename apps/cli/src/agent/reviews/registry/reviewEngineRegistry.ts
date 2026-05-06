import type { BackendTargetRefV1, ExecutionRunRetentionPolicy } from '@happier-dev/protocol';

import type { ExecutionRunProfileBoundedCompleteResult } from '../../executionRuns/profiles/ExecutionRunIntentProfile';

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

const REVIEW_OUTPUT_NORMALIZERS: Record<string, ReviewOutputNormalizer> = {};

export function resolveReviewOutputNormalizer(backendId: string): ReviewOutputNormalizer | null {
  const key = String(backendId ?? '').trim();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(REVIEW_OUTPUT_NORMALIZERS, key)
    ? REVIEW_OUTPUT_NORMALIZERS[key]!
    : null;
}
