import type { SessionContinuationResumePromptModeV1 } from '@happier-dev/protocol';

/**
 * Standard resume prompt sent after a recovered provider-context switch/restart.
 * Keep this short and neutral: the provider context already contains the
 * interrupted work, and recovery proof comes from provider-visible activity.
 */
export const STANDARD_CONTINUATION_RESUME_PROMPT = 'Continue where you left off';

/**
 * Resolves the prompt text for a continuation attempt. `custom` uses the
 * account-level custom text; empty/missing custom text fails safe to the
 * standard prompt (never silently off).
 */
export function buildContinuationResumePrompt(input: Readonly<{
  resumePromptMode: SessionContinuationResumePromptModeV1;
  customResumePrompt?: string | null;
}>): string {
  if (input.resumePromptMode === 'custom') {
    const custom = input.customResumePrompt?.trim() ?? '';
    if (custom.length > 0) return custom;
  }
  return STANDARD_CONTINUATION_RESUME_PROMPT;
}
