import { z } from 'zod/mini';

import { PlanOutputV1Schema } from '@happier-dev/protocol/messages/structured/planOutputV1';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunProfileBoundedCompleteResult,
  ExecutionRunStructuredMeta,
  ExecutionRunStructuredOutputRecovery,
} from '../ExecutionRunIntentProfile';
import { redactTranscriptSecrets, redactTranscriptSecretsExcept } from '@/api/session/client/transport/transcriptSecretRedaction';
import { parseTrailingJsonObject } from '../shared/parseTrailingJsonObject';
import { deriveLoosePlanSections } from '../shared/deriveLoosePlanSections';
import { stripTrailingJsonObjectFromText } from '../shared/stripTrailingJsonObjectFromText';

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
  backendTarget: BackendTargetRefV1;
  startedAtMs: number;
  finishedAtMs: number;
  rawText: string;
  structuredOutputRecovery?: ExecutionRunStructuredOutputRecovery;
}>): ExecutionRunProfileBoundedCompleteResult {
  const trimmed = params.rawText.trim();
  const parsedJson: any = parseTrailingJsonObject(trimmed);
  const ModelOutputSchema = z.looseObject({
    summary: z.string().check(z.minLength(1)),
    sections: z.array(z.looseObject({
      title: z.string().check(z.minLength(1)),
      items: z.array(z.string().check(z.minLength(1))),
    })),
    risks: z.optional(z.array(z.string().check(z.minLength(1)))),
    milestones: z.optional(z.array(z.looseObject({
      title: z.string().check(z.minLength(1)),
      details: z.optional(z.string()),
    }))),
    recommendedBackendId: z.optional(z.string()),
  });
  const parsedModel = ModelOutputSchema.safeParse(parsedJson);
  if (!parsedModel.success) {
    // Recovered sections are Agent prose, masked after they are derived from the exact text.
    const loose =
      params.structuredOutputRecovery?.plan === 'loose-sections'
        ? redactTranscriptSecrets(deriveLoosePlanSections(trimmed))
        : null;
    if (loose) {
      const payload = PlanOutputV1Schema.parse({
        runRef: {
          runId: params.runId,
          callId: params.callId,
          backendId: params.backendId,
          backendTarget: params.backendTarget,
        },
        summary: loose.summary,
        sections: loose.sections,
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

  // Every model field is Agent prose except the backend it recommends, a reference.
  const model = redactTranscriptSecretsExcept(parsedModel.data, ['recommendedBackendId']);
  const recommendedBackendId =
    typeof parsedModel.data.recommendedBackendId === 'string' && parsedModel.data.recommendedBackendId.trim().length > 0
      ? parsedModel.data.recommendedBackendId.trim()
      : undefined;

  const payload = PlanOutputV1Schema.parse({
    runRef: {
      runId: params.runId,
      callId: params.callId,
      backendId: params.backendId,
      backendTarget: params.backendTarget,
    },
    summary: model.summary,
    sections: model.sections,
    risks: model.risks,
    milestones: model.milestones,
    recommendedBackendId,
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
  supportsDetached: true,
  transcriptMaterialization: 'full',
  buildPrompt: (params) => `${params.instructions}\n\n${buildPlanGuidanceBlock()}`,
  computeSidechainStreamText: ({ fullText }) => stripTrailingJsonObjectFromText(fullText),
  buildInvalidOutputRepairPrompt: ({ rawText }) => [
    'Your previous response did not include the required final JSON object.',
    'Do not run any tools. Return ONLY valid JSON (parsable by JSON.parse).',
    'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
    'Return a single JSON object with this shape:',
    '{',
    '  "summary": "Ok",',
    '  "sections": [{ "title": "Steps", "items": ["Step 1"] }],',
    '  "risks": [],',
    '  "milestones": [],',
    '  "recommendedBackendId": "backend-id"',
    '}',
    '',
    'Content to convert:',
    rawText,
  ].join('\n'),
  onBoundedComplete: ({ start, rawText, finishedAtMs, structuredOutputRecovery }) =>
    normalizePlanBoundedCompletion({
      runId: start.runId,
      callId: start.callId,
      sidechainId: start.sidechainId,
      backendId: start.backendId,
      backendTarget: start.backendTarget,
      startedAtMs: start.startedAtMs,
      finishedAtMs,
      rawText,
      structuredOutputRecovery,
    }),
};
