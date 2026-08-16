import type { ReviewStartInput } from '@happier-dev/protocol';

import { resolveReviewExecutionRunIntentInput } from '@/agent/reviews/resolveReviewExecutionRunIntentInput';
import { buildCodexNativeReviewInstructions } from './buildCodexNativeReviewInstructions';
import type { CodexAppServerReviewStartRequest, CodexAppServerReviewTarget } from './codexAppServerReviewTypes';

type CodexAppServerNativeReviewRequestResolution =
  | Readonly<{ ok: true; request: CodexAppServerReviewStartRequest; displayLabel: string }>
  | Readonly<{
    ok: false;
    reason: 'not_review_intent' | 'missing_review_input' | 'invalid_review_input' | 'unsupported_follow_up';
    error?: string;
  }>;

export function resolveCodexAppServerNativeReviewRequest(params: Readonly<{
  start?: Readonly<{ intent?: string; intentInput?: unknown }> | null;
}>): CodexAppServerNativeReviewRequestResolution {
  if (params.start?.intent !== 'review') {
    return { ok: false, reason: 'not_review_intent' };
  }

  const inputResolution = resolveReviewExecutionRunIntentInput(params.start.intentInput);
  if (inputResolution.kind === 'absent') {
    return { ok: false, reason: 'missing_review_input' };
  }
  if (inputResolution.kind === 'review_follow_up') {
    return { ok: false, reason: 'unsupported_follow_up' };
  }
  if (inputResolution.kind === 'invalid') {
    return { ok: false, reason: 'invalid_review_input', error: 'Invalid review input' };
  }

  const input = inputResolution.input;
  const userInstructions = input.instructions.trim();
  const exactNativeTarget = userInstructions.length === 0
    ? resolveExactNativeReviewTarget(input)
    : null;
  const target = exactNativeTarget ?? {
    type: 'custom',
    instructions: buildCodexNativeReviewInstructions(input),
  } satisfies CodexAppServerReviewTarget;

  if (target.type === 'custom' && target.instructions.trim().length === 0) {
    return { ok: false, reason: 'invalid_review_input', error: 'Invalid review input' };
  }

  return {
    ok: true,
    displayLabel: 'Codex review',
    request: {
      target,
      delivery: 'inline',
    },
  };
}

function resolveExactNativeReviewTarget(input: ReviewStartInput): CodexAppServerReviewTarget | null {
  if (input.changeType === 'uncommitted' && input.base.kind === 'none') {
    return { type: 'uncommittedChanges' };
  }
  if (input.changeType === 'committed' && input.base.kind === 'branch') {
    const branch = input.base.baseBranch.trim();
    return branch.length > 0 ? { type: 'baseBranch', branch } : null;
  }
  return null;
}
