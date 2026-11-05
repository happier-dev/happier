import type { BackendTargetRefV1, ExecutionRunRetentionPolicy, ReviewFindingsV2 } from '@happier-dev/protocol';

import { buildReviewFindingsV2Payload } from '@/agent/reviews/normalize/buildReviewFindingsV2Payload';
import type { ParsedCodexNativeReview } from './parseCodexReviewText';

export function buildCodexNativeReviewFindingsV2Payload(params: Readonly<{
  runId: string;
  callId: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  retentionPolicy?: ExecutionRunRetentionPolicy;
  review: ParsedCodexNativeReview;
  generatedAtMs: number;
}>): ReviewFindingsV2 {
  const parsed = params.review;

  return buildReviewFindingsV2Payload({
    runId: params.runId,
    callId: params.callId,
    backendId: params.backendId,
    backendTarget: params.backendTarget,
    retentionPolicy: params.retentionPolicy,
    summary: parsed.summary,
    overviewMarkdown: parsed.overviewMarkdown,
    findings: parsed.findings,
    questions: [],
    assumptions: [],
    generatedAtMs: params.generatedAtMs,
  });
}
