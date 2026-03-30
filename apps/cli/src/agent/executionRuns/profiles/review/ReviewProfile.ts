import {
  ReviewFindingsV1Schema,
  ReviewFindingsV2Schema,
  ReviewTriageOverlaySchema,
} from '@happier-dev/protocol';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunStructuredMeta,
} from '../ExecutionRunIntentProfile';
import { buildReviewFindingsV2Payload } from '@/agent/reviews/normalize/buildReviewFindingsV2Payload';
import { buildStandardReviewPrompt } from '@/agent/reviews/prompt/buildStandardReviewPrompt';
import { normalizeReviewOutput } from '@/agent/reviews/normalize/normalizeReviewOutput';

export const ReviewProfile: ExecutionRunIntentProfile = {
  intent: 'review',
  transcriptMaterialization: 'full',
  buildPrompt: (params) => buildStandardReviewPrompt({ instructions: params.instructions, intentInput: params.intentInput }),
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
