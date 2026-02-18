import { ReviewFindingSchema, ReviewFindingsV1Schema, type ReviewFinding } from '@happier-dev/protocol';

import type {
  ExecutionRunProfileBoundedCompleteResult,
  ExecutionRunStructuredMeta,
} from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { parseTrailingJsonObject } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';

export function normalizeStrictJsonReviewOutput(params: Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  startedAtMs: number;
  finishedAtMs: number;
  rawText: string;
}>): ExecutionRunProfileBoundedCompleteResult {
  const trimmed = params.rawText.trim();
  const parsedJson: any = parseTrailingJsonObject(trimmed);

  const parsedRecord =
    parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
      ? (parsedJson as Record<string, unknown>)
      : null;

  const summaryRaw = parsedRecord ? parsedRecord.summary : null;
  const findingsRaw = parsedRecord ? parsedRecord.findings : null;

  if (typeof summaryRaw !== 'string' || summaryRaw.trim().length === 0 || !Array.isArray(findingsRaw)) {
    const summary = 'Invalid review output (expected strict JSON).';
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

  const findings: ReviewFinding[] = [];
  for (const item of findingsRaw) {
    const parsedFinding = ReviewFindingSchema.safeParse(item);
    if (!parsedFinding.success) {
      const summary = 'Invalid review output (expected strict JSON).';
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
    findings.push(parsedFinding.data);
  }

  const findingsPayload = ReviewFindingsV1Schema.parse({
    runRef: { runId: params.runId, callId: params.callId, backendId: params.backendId },
    summary: summaryRaw,
    findings,
    generatedAtMs: params.finishedAtMs,
  });

  const summary = findingsPayload.summary || 'Review completed.';
  const payloadFindings = findingsPayload.findings;
  const digestItems = payloadFindings.slice(0, 20).map((f) => ({
    id: f.id,
    title: f.title,
    severity: f.severity,
    category: f.category,
    ...(f.filePath ? { filePath: f.filePath } : {}),
    ...(typeof f.startLine === 'number' ? { startLine: f.startLine } : {}),
    ...(typeof f.endLine === 'number' ? { endLine: f.endLine } : {}),
  }));

  const structuredMeta: ExecutionRunStructuredMeta = { kind: 'review_findings.v1', payload: findingsPayload };
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
    findingsDigest: { total: payloadFindings.length, items: digestItems },
  };

  return {
    status: 'succeeded',
    summary,
    toolResultOutput: output,
    toolResultMeta: { happier: structuredMeta } as any,
    structuredMeta,
  };
}
