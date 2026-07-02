import type { BackendTargetRefV1, ExecutionRunRetentionPolicy, ReviewFindingsV2 } from '@happier-dev/protocol';

import { buildReviewFindingsV2Payload } from '../buildReviewFindingsV2Payload';
import { parseCodexNativeReviewText } from './parseCodexNativeReviewText';

export function buildCodexNativeReviewFindingsV2Payload(params: Readonly<{
  runId: string;
  callId: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  retentionPolicy?: ExecutionRunRetentionPolicy;
  rawText: string;
  generatedAtMs: number;
}>): ReviewFindingsV2 | null {
  const parsed = parseCodexNativeReviewText(params.rawText);
  if (!parsed) return null;

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
