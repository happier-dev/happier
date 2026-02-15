import { z } from 'zod';

import { PlanOutputV1Schema } from '@happier-dev/protocol';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunProfileBoundedCompleteResult,
  ExecutionRunStructuredMeta,
} from '../ExecutionRunIntentProfile';
import { parseTrailingJsonObject } from '../shared/parseTrailingJsonObject';

function buildPlanGuidanceBlock(): string {
  return [
    'Return a concise implementation plan.',
    '',
    'Output requirements (MANDATORY):',
    '- End your response with a single JSON object (no markdown fences).',
    '- The JSON must be the last thing in the output.',
    '',
    'JSON schema (required keys):',
    '{',
    '  "summary": "string",',
    '  "sections": [{ "title": "string", "items": ["string", "..."] }],',
    '  "risks": ["string", "..."],',
    '  "milestones": [{ "title": "string", "details": "string (optional)" }],',
    '  "recommendedBackendId": "string (optional)"',
    '}',
  ].join('\n');
}

function normalizePlanBoundedCompletion(params: Readonly<{
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
    sections: z.array(z.object({
      title: z.string().min(1),
      items: z.array(z.string().min(1)),
    }).passthrough()),
    risks: z.array(z.string().min(1)).optional(),
    milestones: z.array(z.object({
      title: z.string().min(1),
      details: z.string().optional(),
    }).passthrough()).optional(),
    recommendedBackendId: z.string().optional(),
  }).passthrough();
  const parsedModel = ModelOutputSchema.safeParse(parsedJson);
  if (!parsedModel.success) {
    const summary = 'Invalid plan output (expected strict JSON).';
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
        intent: 'plan',
        startedAtMs: params.startedAtMs,
        finishedAtMs: params.finishedAtMs,
        error: { code: 'invalid_output' },
      },
    };
  }

  const payload = PlanOutputV1Schema.parse({
    runRef: { runId: params.runId, callId: params.callId, backendId: params.backendId },
    summary: parsedModel.data.summary,
    sections: parsedModel.data.sections,
    risks: parsedModel.data.risks,
    milestones: parsedModel.data.milestones,
    recommendedBackendId: parsedModel.data.recommendedBackendId,
    generatedAtMs: params.finishedAtMs,
  });

  const summary = payload.summary || 'Plan completed.';
  const structuredMeta: ExecutionRunStructuredMeta = { kind: 'plan_output.v1', payload };

  const sectionsDigest = payload.sections.slice(0, 10).map((s) => ({
    title: s.title,
    items: s.items.slice(0, 10),
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
      intent: 'plan',
      startedAtMs: params.startedAtMs,
      finishedAtMs: params.finishedAtMs,
      sectionsDigest,
    },
    toolResultMeta: { happier: structuredMeta } as any,
    structuredMeta,
  };
}

export const PlanProfile: ExecutionRunIntentProfile = {
  intent: 'plan',
  buildPrompt: (params) => `${params.instructions}\n\n${buildPlanGuidanceBlock()}`,
  onBoundedComplete: ({ start, rawText, finishedAtMs }) =>
    normalizePlanBoundedCompletion({
      runId: start.runId,
      callId: start.callId,
      sidechainId: start.sidechainId,
      backendId: start.backendId,
      startedAtMs: start.startedAtMs,
      finishedAtMs,
      rawText,
    }),
};
