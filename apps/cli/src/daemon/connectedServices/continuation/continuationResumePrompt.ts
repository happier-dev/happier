import type { SessionContinuationResumePromptModeV1 } from '@happier-dev/protocol';

/**
 * Standard resume prompt sent after a recovered provider-context switch/restart.
 * States the fact that a turn WAS interrupted (a directive wake signal — a purely
 * permissive prompt lets an agent whose visible context looks "settled" treat the
 * wake as a no-op, incident cmq8171vw 2026-06-12) while staying neutral: no
 * "recovered provider context" framing and no "do not repeat" bias — the provider
 * context already contains the interrupted work.
 */
export const STANDARD_CONTINUATION_RESUME_PROMPT = 'The interrupted turn was recovered. Continue from where you left off.';

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
