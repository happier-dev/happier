import { describe, expect, it } from 'vitest';
import { formatGeminiErrorForUi } from './formatGeminiErrorForUi';

describe('formatGeminiErrorForUi', () => {
  it('returns fallback message for non-object errors', () => {
    expect(formatGeminiErrorForUi('boom', null)).toBe('Process error occurred');
  });

  it('formats Error instances using stack when available', () => {
    const err = new Error('boom');
    err.stack = 'STACK';
    expect(formatGeminiErrorForUi(err, null)).toContain('STACK');
  });

  it('formats model-not-found errors', () => {
    expect(formatGeminiErrorForUi({ code: 404 }, 'gemini-x')).toContain('Model "gemini-x" not found');
  });

  it('formats rate-limit errors by numeric status', () => {
    expect(formatGeminiErrorForUi({ status: 429 }, null)).toContain('rate limit exceeded');
  });

  it('formats auth-required errors with workspace guidance', () => {
    expect(formatGeminiErrorForUi({ code: -32000, message: 'Authentication required' }, null))
      .toContain('happier gemini project set');
  });

  it('formats empty object errors as missing CLI install', () => {
    expect(formatGeminiErrorForUi({}, null)).toContain('Is "gemini" CLI installed?');
  });

  it('does not include empty quota reset time when no duration is captured', () => {
    expect(formatGeminiErrorForUi({ message: 'quota reset after ' }, null)).not.toContain('Quota resets in .');
  });

  it('formats quota reset time when duration is present', () => {
    expect(formatGeminiErrorForUi({ message: 'quota reset after 3h20m35s' }, null))
      .toContain('Quota resets in 3h20m35s.');
  });
});
