import type {
  ExecutionRunProfileBoundedCompleteResult,
  ExecutionRunStructuredMeta,
} from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { BackendTargetRefV1, ExecutionRunRetentionPolicy } from '@happier-dev/protocol';

import { normalizeStrictJsonReviewOutput } from '@/agent/reviews/normalize/normalizeStrictJsonReviewOutput';
import { buildCodexNativeReviewFindingsV2Payload } from './buildCodexNativeReviewFindingsV2Payload';

export function normalizeCodexReviewOutput(params: Readonly<{
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
  const strictResult = normalizeStrictJsonReviewOutput(params);
  if (strictResult.status === 'succeeded') return strictResult;

  const findingsPayload = buildCodexNativeReviewFindingsV2Payload({
    runId: params.runId,
    callId: params.callId,
    backendId: params.backendId,
    backendTarget: params.backendTarget,
    retentionPolicy: params.retentionPolicy,
    rawText: params.rawText,
    generatedAtMs: params.finishedAtMs,
  });

  if (!findingsPayload) {
    const summary = 'Invalid review output (unsupported Codex review format).';
    return {
      status: 'failed',
      summary,
      toolResultOutput: {
        status: 'failed',
        summary,
        runId: params.runId,
        callId: params.callId,
        sidechainId: params.sidechainId,
        backendId: params.backendId,
        intent: 'review',
        startedAtMs: params.startedAtMs,
        finishedAtMs: params.finishedAtMs,
        error: { code: 'invalid_output' },
      },
    };
  }

  const summary = findingsPayload.summary || 'Codex review completed.';
  const digestItems = findingsPayload.findings.slice(0, 20).map((finding) => ({
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    category: finding.category,
    ...(finding.filePath ? { filePath: finding.filePath } : {}),
    ...(typeof finding.startLine === 'number' ? { startLine: finding.startLine } : {}),
    ...(typeof finding.endLine === 'number' ? { endLine: finding.endLine } : {}),
  }));

  const structuredMeta: ExecutionRunStructuredMeta = {
    kind: 'review_findings.v2',
    payload: findingsPayload,
  };
  const output = {
    status: 'succeeded',
    summary,
    runId: params.runId,
    callId: params.callId,
    sidechainId: params.sidechainId,
    backendId: params.backendId,
    intent: 'review',
    startedAtMs: params.startedAtMs,
    finishedAtMs: params.finishedAtMs,
    findingsDigest: { total: findingsPayload.findings.length, items: digestItems },
  };

  return {
    status: 'succeeded',
    summary,
    toolResultOutput: output,
    toolResultMeta: { happier: structuredMeta },
    structuredMeta,
  };
}
