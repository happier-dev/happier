import { z } from 'zod';

import { DelegateOutputV1Schema, type BackendTargetRefV1 } from '@happier-dev/protocol';

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

function clampString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function parseLooseDelegateDeliverables(text: string): { summary: string; deliverables: { id: string; title: string }[] } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return null;

  const deliverables: { id: string; title: string }[] = [];
  for (const line of lines) {
    const markerMatch = line.match(/^(?:[-*•]|\d+[.)])\s*(.+)$/u);
    if (!markerMatch) continue;

    const stripped = markerMatch[1]!.trim();
    if (!stripped) continue;

    const match = stripped.match(/^([^:]{1,200}):\s*(.+)$/u);
    if (match) {
      deliverables.push({
        id: clampString(match[1]!.trim(), 200),
        title: clampString(match[2]!.trim(), 400),
      });
      continue;
    }

    deliverables.push({
      id: `d${deliverables.length + 1}`,
      title: clampString(stripped, 400),
    });
  }

  if (deliverables.length === 0) {
    const firstLine = lines[0]!;
    return {
      summary: clampString(firstLine, 20_000),
      deliverables: [{ id: 'd1', title: clampString(firstLine, 400) }],
    };
  }

  return {
    summary: clampString(lines[0]!, 20_000),
    deliverables,
  };
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
    const loose =
      params.backendId === 'pi' || params.backendId === 'codex'
        ? parseLooseDelegateDeliverables(trimmed)
        : null;
    if (loose) {
      const payload = DelegateOutputV1Schema.parse({
        runRef: {
          runId: params.runId,
          callId: params.callId,
          backendId: params.backendId,
          backendTarget: params.backendTarget,
        },
        summary: loose.summary,
        deliverables: loose.deliverables,
        generatedAtMs: params.finishedAtMs,
      });

      const summary = payload.summary || 'Delegation completed.';
      const structuredMeta: ExecutionRunStructuredMeta = { kind: 'delegate_output.v1', payload };

      const deliverablesDigest = payload.deliverables.slice(0, 20).map((deliverable) => ({
        id: deliverable.id,
        title: deliverable.title,
        ...(deliverable.details ? { details: deliverable.details.slice(0, 500) } : {}),
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

    if (params.backendId === 'codex') {
      const firstLine = trimmed.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
      if (firstLine) {
        const payload = DelegateOutputV1Schema.parse({
          runRef: {
            runId: params.runId,
            callId: params.callId,
            backendId: params.backendId,
            backendTarget: params.backendTarget,
          },
          summary: clampString(firstLine, 20_000),
          deliverables: [{ id: 'd1', title: clampString(firstLine, 400) }],
          generatedAtMs: params.finishedAtMs,
        });

        const summary = payload.summary || 'Delegation completed.';
        const structuredMeta: ExecutionRunStructuredMeta = { kind: 'delegate_output.v1', payload };

        const deliverablesDigest = payload.deliverables.slice(0, 20).map((deliverable) => ({
          id: deliverable.id,
          title: deliverable.title,
          ...(deliverable.details ? { details: deliverable.details.slice(0, 500) } : {}),
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

  const payload = DelegateOutputV1Schema.parse({
    runRef: {
      runId: params.runId,
      callId: params.callId,
      backendId: params.backendId,
      backendTarget: params.backendTarget,
    },
    summary: parsedModel.data.summary,
    deliverables: parsedModel.data.deliverables,
    generatedAtMs: params.finishedAtMs,
  });

  const summary = payload.summary || 'Delegation completed.';
  const structuredMeta: ExecutionRunStructuredMeta = { kind: 'delegate_output.v1', payload };

  const deliverablesDigest = payload.deliverables.slice(0, 20).map((deliverable) => ({
    id: deliverable.id,
    title: deliverable.title,
    ...(deliverable.details ? { details: deliverable.details.slice(0, 500) } : {}),
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
      backendTarget: start.backendTarget,
      startedAtMs: start.startedAtMs,
      finishedAtMs,
      rawText,
    }),
};
