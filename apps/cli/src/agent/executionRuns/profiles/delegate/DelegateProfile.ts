import { z } from 'zod';

import { DelegateOutputV1Schema } from '@happier-dev/protocol';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunProfileBoundedCompleteResult,
  ExecutionRunStructuredMeta,
} from '../ExecutionRunIntentProfile';
import { parseTrailingJsonObject } from '../shared/parseTrailingJsonObject';

function buildDelegateGuidanceBlock(): string {
  return [
    'Return a delegation result with clear deliverables.',
    '',
    'Output requirements (MANDATORY):',
    '- End your response with a single JSON object (no markdown fences).',
    '- The JSON must be the last thing in the output.',
    '',
    'JSON schema (required keys):',
    '{',
    '  "summary": "string",',
    '  "deliverables": [{ "id": "string", "title": "string", "details": "string (optional)" }]',
    '}',
  ].join('\n');
}

function normalizeDelegateBoundedCompletion(params: Readonly<{
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
    deliverables: z.array(z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      details: z.string().optional(),
    }).passthrough()),
  }).passthrough();
  const parsedModel = ModelOutputSchema.safeParse(parsedJson);
  if (!parsedModel.success) {
    const summary = 'Invalid delegate output (expected strict JSON).';
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
        intent: 'delegate',
        startedAtMs: params.startedAtMs,
        finishedAtMs: params.finishedAtMs,
        error: { code: 'invalid_output' },
      },
    };
  }

  const payload = DelegateOutputV1Schema.parse({
    runRef: { runId: params.runId, callId: params.callId, backendId: params.backendId },
    summary: parsedModel.data.summary,
    deliverables: parsedModel.data.deliverables,
    generatedAtMs: params.finishedAtMs,
  });

  const summary = payload.summary || 'Delegation completed.';
  const structuredMeta: ExecutionRunStructuredMeta = { kind: 'delegate_output.v1', payload };

  const deliverablesDigest = payload.deliverables.slice(0, 20).map((d) => ({
    id: d.id,
    title: d.title,
    ...(d.details ? { details: d.details.slice(0, 500) } : {}),
  }));

  return {
    status: 'succeeded',
    summary,
    toolResultOutput: {
      status: 'succeeded',
      summary,
      runId: params.runId,
      callId: params.callId,
      sidechainId: params.sidechainId,
      backendId: params.backendId,
      intent: 'delegate',
      startedAtMs: params.startedAtMs,
      finishedAtMs: params.finishedAtMs,
      deliverablesDigest,
    },
    toolResultMeta: { happier: structuredMeta } as any,
    structuredMeta,
  };
}

export const DelegateProfile: ExecutionRunIntentProfile = {
  intent: 'delegate',
  transcriptMaterialization: 'full',
  buildPrompt: (params) => `${params.instructions}\n\n${buildDelegateGuidanceBlock()}`,
  onBoundedComplete: ({ start, rawText, finishedAtMs }) =>
    normalizeDelegateBoundedCompletion({
      runId: start.runId,
      callId: start.callId,
      sidechainId: start.sidechainId,
      backendId: start.backendId,
      startedAtMs: start.startedAtMs,
      finishedAtMs,
      rawText,
    }),
};
