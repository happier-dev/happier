import {
  REVIEW_SCM_SCOPE_INPUT_KEY,
  ReviewFindingsV1Schema,
  ReviewFindingsV2Schema,
  ReviewTriageOverlaySchema,
} from '@happier-dev/protocol';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunStructuredMeta,
} from '../ExecutionRunIntentProfile';
import { buildReviewFindingsV2Payload } from '../../../reviews/normalize/buildReviewFindingsV2Payload';
import { buildReviewGuidanceBlock, buildStandardReviewPrompt } from '../../../reviews/prompt/buildStandardReviewPrompt';
import { normalizeReviewOutput } from '../../../reviews/normalize/normalizeReviewOutput';
import { stripTrailingJsonObjectFromText } from '../shared/stripTrailingJsonObjectFromText';
import { resolveReviewScmScope } from '../../../reviews/scope/resolve';

function readIntentInputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export const ReviewProfile: ExecutionRunIntentProfile = {
  intent: 'review',
  transcriptMaterialization: 'full',
  emitFinalSidechainMessageWhenStreamed: true,
  prepareStartParams: async ({ request, cwd }) => {
    const existing = readIntentInputRecord(request.intentInput);
    const scmReviewScope = await resolveReviewScmScope({
      cwd,
      intentInput: existing,
    });
    return {
      intentInput: {
        ...existing,
        [REVIEW_SCM_SCOPE_INPUT_KEY]: scmReviewScope,
      },
    };
  },
  buildPrompt: (params) => buildStandardReviewPrompt({ instructions: params.instructions, intentInput: params.intentInput }),
  computeSidechainStreamText: ({ fullText }) => {
    const stripped = stripTrailingJsonObjectFromText(fullText).trimEnd();
    if (stripped !== String(fullText ?? '').trimEnd()) return stripped;

    // If the model is currently emitting the final JSON object but it's not parseable yet,
    // avoid streaming partial JSON fragments by cutting at the JSON start marker.
    const t = String(fullText ?? '');
    const start = t.lastIndexOf('\n{');
    if (start >= 0) {
      const tail = t.slice(start, Math.min(t.length, start + 400));
      if (tail.includes('"summary"') || tail.includes('"findings"')) {
        return t.slice(0, start).trimEnd();
      }
    }
    return t;
  },
  buildInvalidOutputRepairPrompt: ({ rawText }) => [
    'Your previous response did not include the required final JSON object.',
    'If you have already completed the review, convert your conclusions into the required JSON now.',
    'If you have not yet inspected the workspace or gathered enough evidence, continue the review first using the available read-only tools, then return ONLY valid JSON (parsable by JSON.parse).',
    'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
    buildReviewGuidanceBlock(),
    '',
    'Content to convert:',
    rawText,
  ].filter((line) => line.length > 0).join('\n'),
  listAvailableActionIds: ({ structuredMeta, start }) =>
    structuredMeta?.kind === 'review_findings.v1' || structuredMeta?.kind === 'review_findings.v2'
      ? [
        'review.triage',
        ...(start.retentionPolicy === 'resumable' ? ['review.follow_up'] : []),
      ]
      : [],
  onBoundedComplete: ({ start, rawText, finishedAtMs }) =>
    normalizeReviewOutput({
      runId: start.runId,
      callId: start.callId,
      sidechainId: start.sidechainId,
      backendId: start.backendId,
      backendTarget: start.backendTarget,
      retentionPolicy: start.retentionPolicy,
      startedAtMs: start.startedAtMs,
      finishedAtMs,
      rawText,
      intentInput: start.intentInput,
    }),
  applyAction: ({ actionId, input, structuredMeta, start }) => {
    // Policy/model enforcement at action-time: action handlers must be given the real
    // start params so they can make consistent decisions (and we can avoid per-handler drift).
    if (!start.permissionMode || start.permissionMode.trim().length === 0) {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Missing permissionMode' };
    }
    if (actionId === 'reviews.comments.create') {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Host actions are dispatched by the execution-run host' };
    }
    if (actionId === 'review.follow_up') {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Follow-up orchestration is handled by the execution-run runtime' };
    }
    if (actionId !== 'review.triage') {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Unsupported action' };
    }
    const existing = structuredMeta?.kind === 'review_findings.v1' || structuredMeta?.kind === 'review_findings.v2'
      ? structuredMeta
      : null;
    if (!existing) {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Not a review run' };
    }

    const parsed = ReviewTriageOverlaySchema.safeParse(input ?? {});
    if (!parsed.success) {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid triage overlay' };
    }

    const existingPayload = existing.kind === 'review_findings.v2'
      ? ReviewFindingsV2Schema.parse(existing.payload)
      : (() => {
        const legacy = ReviewFindingsV1Schema.parse(existing.payload);
        return buildReviewFindingsV2Payload({
          runId: legacy.runRef.runId,
          callId: legacy.runRef.callId,
          backendId: legacy.runRef.backendId,
          backendTarget: legacy.runRef.backendTarget,
          summary: legacy.summary,
          findings: legacy.findings,
          triage: legacy.triage,
          limits: legacy.limits,
          generatedAtMs: legacy.generatedAtMs,
        });
      })();

    const updatedPayload = {
      ...existingPayload,
      triage: parsed.data,
    };

    const updatedStructured: ExecutionRunStructuredMeta = { kind: 'review_findings.v2', payload: updatedPayload };
    return {
      ok: true,
      updatedToolResultOutput: { ok: true, actionId },
      updatedToolResultMeta: { happier: updatedStructured } as any,
      updatedStructuredMeta: updatedStructured,
    };
  },
};
