import { describe, expect, it } from 'vitest';

import { isSkippableProviderUnavailabilityError } from '../../src/testkit/providers/harness';

describe('providers harness: provider availability classification', () => {
  it('treats missing binary failures as skippable provider unavailability', () => {
    expect(isSkippableProviderUnavailabilityError('Missing required binary for provider kimi: kimi')).toBe(true);
  });

  it('treats auth/setup runtime failures as skippable provider unavailability', () => {
    expect(isSkippableProviderUnavailabilityError('Fatal provider runtime error (kimi.acp_resume_load_session): Authentication required')).toBe(true);
    expect(isSkippableProviderUnavailabilityError('Fatal provider runtime error (foo.bar): Provider not configured')).toBe(true);
    expect(isSkippableProviderUnavailabilityError('Fatal provider runtime error (foo.bar): LLM not set')).toBe(true);
    expect(isSkippableProviderUnavailabilityError('Fatal provider runtime error (auggie.acp_probe_models): Out of credits')).toBe(true);
    expect(
      isSkippableProviderUnavailabilityError(
        'Fatal provider runtime error (gemini.acp_probe_models): Verify your account to continue.',
      ),
    ).toBe(true);
    expect(
      isSkippableProviderUnavailabilityError(
        'Fatal provider runtime error (gemini.acp_probe_models): Account verification required',
      ),
    ).toBe(true);
    expect(
      isSkippableProviderUnavailabilityError(
        'Fatal provider runtime error (kimi.read_known_file): Prompt request failed',
      ),
    ).toBe(true);
    expect(
      isSkippableProviderUnavailabilityError(
        'Fatal provider runtime error (codex.glob_list_files): Usage limit exceeded',
      ),
    ).toBe(true);
  });

  it('does not classify regular scenario assertion failures as provider unavailability', () => {
    expect(isSkippableProviderUnavailabilityError('Missing required fixture key: acp/kimi/tool-call/Read')).toBe(false);
    expect(isSkippableProviderUnavailabilityError('Scenario exceeded maxTraceEvents')).toBe(false);
  });
});
