import { ReviewFindingSchema, ReviewFindingsV1Schema } from '@happier-dev/protocol';
import { z } from 'zod';

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
  const ModelOutputSchema = z.object({
    summary: z.string().min(1),
    findings: z.array(ReviewFindingSchema),
  }).passthrough();
  const parsedModel = ModelOutputSchema.safeParse(parsedJson);
  if (!parsedModel.success) {
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

  const findingsPayload = ReviewFindingsV1Schema.parse({
    runRef: { runId: params.runId, callId: params.callId, backendId: params.backendId },
    summary: parsedModel.data.summary,
    findings: parsedModel.data.findings,
    generatedAtMs: params.finishedAtMs,
  });

  const summary = findingsPayload.summary || 'Review completed.';
  const findings = findingsPayload.findings;
  const digestItems = findings.slice(0, 20).map((f) => ({
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
    findingsDigest: { total: findings.length, items: digestItems },
  };

  return {
    status: 'succeeded',
    summary,
    toolResultOutput: output,
    toolResultMeta: { happier: structuredMeta } as any,
    structuredMeta,
  };
}

