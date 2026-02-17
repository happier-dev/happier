import { ReviewTriageOverlaySchema } from '@happier-dev/protocol';

import type {
  ExecutionRunIntentProfile,
  ExecutionRunStructuredMeta,
} from '../ExecutionRunIntentProfile';
import { buildStandardReviewPrompt } from '@/agent/reviews/prompt/buildStandardReviewPrompt';
import { normalizeReviewOutput } from '@/agent/reviews/normalize/normalizeReviewOutput';

export const ReviewProfile: ExecutionRunIntentProfile = {
  intent: 'review',
  transcriptMaterialization: 'full',
  buildPrompt: (params) => buildStandardReviewPrompt({ instructions: params.instructions }),
  onBoundedComplete: ({ start, rawText, finishedAtMs }) =>
    normalizeReviewOutput({
      runId: start.runId,
      callId: start.callId,
      sidechainId: start.sidechainId,
      backendId: start.backendId,
      startedAtMs: start.startedAtMs,
      finishedAtMs,
      rawText,
    }),
  applyAction: ({ actionId, input, structuredMeta, start }) => {
    // Policy/model enforcement at action-time: action handlers must be given the real
    // start params so they can make consistent decisions (and we can avoid per-handler drift).
    if (!start.permissionMode || start.permissionMode.trim().length === 0) {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Missing permissionMode' };
    }
    if (actionId !== 'review.triage') {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Unsupported action' };
    }
    const existing = structuredMeta?.kind === 'review_findings.v1' ? structuredMeta : null;
    if (!existing) {
      return { ok: false, errorCode: 'execution_run_action_not_supported', error: 'Not a review run' };
    }

    const parsed = ReviewTriageOverlaySchema.safeParse(input ?? {});
    if (!parsed.success) {
      return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid triage overlay' };
    }

    const updatedPayload = {
      ...(existing.payload as any),
      triage: parsed.data,
    };

    const updatedStructured: ExecutionRunStructuredMeta = { kind: 'review_findings.v1', payload: updatedPayload };
    return {
      ok: true,
      updatedToolResultOutput: { ok: true, actionId },
      updatedToolResultMeta: { happier: updatedStructured } as any,
      updatedStructuredMeta: updatedStructured,
    };
  },
};
