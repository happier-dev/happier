import { z } from 'zod/mini';

import { DelegateOutputV1Schema } from '@happier-dev/protocol/messages/structured/delegateOutputV1';
import { SessionUpdatePostInputV1Schema } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunProfileBoundedCompleteResult,
  ExecutionRunStructuredMeta,
  ExecutionRunStructuredOutputRecovery,
} from '../ExecutionRunIntentProfile';
import { redactTranscriptSecrets, redactTranscriptSecretsExcept } from '@/api/session/client/transport/transcriptSecretRedaction';
import { parseTrailingJsonObject } from '../shared/parseTrailingJsonObject';
import { deriveLooseDelegateDeliverables } from '../shared/deriveLooseDelegateDeliverables';
import { stripTrailingJsonObjectFromText } from '../shared/stripTrailingJsonObjectFromText';

/** Delegate output is Agent prose except each deliverable's id, which its readers reference. */
function redactDelegateProse<D extends Readonly<{ id: string }>>(output: Readonly<{ summary: string; deliverables: readonly D[] }>) {
  return {
    summary: redactTranscriptSecrets(output.summary),
    deliverables: output.deliverables.map(deliverable => redactTranscriptSecretsExcept(deliverable, ['id'])),
  };
}

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
    'When available, add evidence references in an optional `evidence` array: check_outcome (name, outcome passed/failed/skipped), pull_request (url), screenshot (artifactId), or preview_url (url). Add optional `deviations` and `nextStep` strings. Do not include evidence bodies.',
  ].join('\n');
}

function normalizeDelegateBoundedCompletion(params: Readonly<{
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
  const clampString = (value: string, maxLength: number): string => {
    if (value.length <= maxLength) return value;
    return value.slice(0, maxLength);
  };

  const deriveSingleDeliverableFallback = (text: string): { summary: string; deliverables: { id: string; title: string }[] } | null => {
    const firstLine = String(text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!firstLine) return null;

    const title = clampString(firstLine, 400);
    return {
      summary: clampString(firstLine, 20_000),
      deliverables: [{ id: 'd1', title }],
    };
  };

  const trimmed = params.rawText.trim();
  const parsedJson: unknown = parseTrailingJsonObject(trimmed);
  const ModelOutputSchema = z.looseObject({
    summary: z.string().check(z.minLength(1)),
    deliverables: z.array(z.looseObject({
      id: z.string().check(z.minLength(1)),
      title: z.string().check(z.minLength(1)),
      details: z.optional(z.string()),
    })),
  });
  const parsedModel = ModelOutputSchema.safeParse(parsedJson);
  if (!parsedModel.success) {
    const delegateRecovery = params.structuredOutputRecovery?.delegate;
    const loose =
      delegateRecovery === 'loose-deliverables' || delegateRecovery === 'loose-deliverables-with-single-fallback'
        ? deriveLooseDelegateDeliverables(trimmed)
          ?? (delegateRecovery === 'loose-deliverables-with-single-fallback' ? deriveSingleDeliverableFallback(trimmed) : null)
        : null;
    if (loose) {
      const payload = DelegateOutputV1Schema.parse({
        runRef: {
          runId: params.runId,
          callId: params.callId,
          backendId: params.backendId,
          backendTarget: params.backendTarget,
        },
        ...redactDelegateProse(loose),
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

  const modelResult = parsedModel.data;
  const prose = redactDelegateProse(modelResult);
  const workerReport = modelResult.evidence !== undefined || modelResult.deviations !== undefined || modelResult.nextStep !== undefined
    ? SessionUpdatePostInputV1Schema.safeParse({
        summary: prose.summary,
        deliverables: redactTranscriptSecrets(modelResult.evidence),
        deviations: redactTranscriptSecrets(modelResult.deviations),
        nextStep: redactTranscriptSecrets(modelResult.nextStep),
      }) : null;
  const payload = DelegateOutputV1Schema.parse({
    runRef: {
      runId: params.runId,
      callId: params.callId,
      backendId: params.backendId,
      backendTarget: params.backendTarget,
    },
    ...prose,
    ...(workerReport?.success ? { workerReport: workerReport.data } : {}),
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
  computeSidechainStreamText: ({ fullText }) => stripTrailingJsonObjectFromText(fullText),
  buildInvalidOutputRepairPrompt: ({ rawText }) => [
    'Your previous response did not include the required final JSON object.',
    'Do not run any tools. Return ONLY valid JSON (parsable by JSON.parse).',
    'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
    'Return a single JSON object with this shape:',
    '{',
    '  "summary": "Ok",',
    '  "deliverables": [{ "id": "d1", "title": "Deliverable", "details": "Optional details" }]',
    '}',
    '',
    'Content to convert:',
    rawText,
  ].join('\n'),
  onBoundedComplete: ({ start, rawText, finishedAtMs, structuredOutputRecovery }) =>
    normalizeDelegateBoundedCompletion({
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
