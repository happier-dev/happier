import { describe, expect, it } from 'vitest';

import {
  buildContinuationResumePrompt,
  GENERIC_CONTINUATION_RESUME_PROMPT,
  USAGE_LIMIT_CONTINUATION_RESUME_PROMPT,
} from './continuationResumePrompt';

describe('buildContinuationResumePrompt', () => {
  it('reassures usage-limit recovery after an account switch without a reset wait', () => {
    expect(buildContinuationResumePrompt({
      resumePromptMode: 'standard', recoveryKind: 'usage_limit',
    })).toBe(USAGE_LIMIT_CONTINUATION_RESUME_PROMPT);
  });

  it('keeps transient throttling neutral unless recovery waited for a usage reset', () => {
    expect(buildContinuationResumePrompt({
      resumePromptMode: 'standard', recoveryKind: 'rate_limit',
    })).toBe(GENERIC_CONTINUATION_RESUME_PROMPT);
    expect(buildContinuationResumePrompt({
      resumePromptMode: 'standard', recoveryKind: 'rate_limit', afterUsageLimitReset: true,
    })).toBe(USAGE_LIMIT_CONTINUATION_RESUME_PROMPT);
  });

  it('preserves custom prompts and falls back to the standard recovery prompt for blank text', () => {
    expect(buildContinuationResumePrompt({
      resumePromptMode: 'custom', customResumePrompt: '  Resume my task  ', recoveryKind: 'usage_limit',
    })).toBe('Resume my task');
    expect(buildContinuationResumePrompt({
      resumePromptMode: 'custom', customResumePrompt: '  ', recoveryKind: 'usage_limit',
    })).toBe(USAGE_LIMIT_CONTINUATION_RESUME_PROMPT);
  });
});
