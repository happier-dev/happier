import type { SessionContinuationResumePromptModeV1 } from '@happier-dev/protocol';
import type { ConnectedServiceRuntimeAuthFailureKind } from '../runtimeAuth/types';

export const USAGE_LIMIT_CONTINUATION_RESUME_PROMPT =
  'Usage limits are lifted. Continue where you left off.';
export const GENERIC_CONTINUATION_RESUME_PROMPT = 'Continue where you left off';

/**
 * Resolves the prompt text for a continuation attempt. `custom` uses the
 * account-level custom text; empty/missing custom text fails safe to the
 * standard prompt (never silently off).
 */
export function buildContinuationResumePrompt(input: Readonly<{
  resumePromptMode: SessionContinuationResumePromptModeV1;
  customResumePrompt?: string | null;
  recoveryKind?: ConnectedServiceRuntimeAuthFailureKind | null;
}>): string {
  if (input.resumePromptMode === 'custom') {
    const custom = input.customResumePrompt?.trim() ?? '';
    if (custom.length > 0) return custom;
  }
  return input.recoveryKind === 'usage_limit' || input.recoveryKind === 'rate_limit'
    ? USAGE_LIMIT_CONTINUATION_RESUME_PROMPT
    : GENERIC_CONTINUATION_RESUME_PROMPT;
}
