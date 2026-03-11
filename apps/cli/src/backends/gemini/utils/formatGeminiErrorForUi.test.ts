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
    const out = formatGeminiErrorForUi({ code: 404 }, 'gemini-x');
    expect(out).toContain('Model "gemini-x" not found');
    expect(out).toContain('Available models:');
    expect(out).toContain('gemini-3.1-pro-preview');
  });

  it('formats rate-limit errors by numeric status', () => {
    expect(formatGeminiErrorForUi({ status: 429 }, null)).toContain('rate limit exceeded');
  });

  it('formats auth-required errors with workspace guidance', () => {
    expect(formatGeminiErrorForUi({ code: -32000, message: 'Authentication required' }, null))
      .toContain('happier gemini project set');
  });

  it('formats empty object errors as generic missing CLI guidance', () => {
    const output = formatGeminiErrorForUi({}, null);
    expect(output).toContain('Happier provider settings');
    expect(output).toContain('"gemini"');
    expect(output).toContain('PATH');
    expect(output).not.toContain('npm install -g');
  });

  it('does not include empty quota reset time when no duration is captured', () => {
    expect(formatGeminiErrorForUi({ message: 'quota reset after ' }, null)).not.toContain('Quota resets in .');
  });

  it('formats quota reset time when duration is present', () => {
    expect(formatGeminiErrorForUi({ message: 'quota reset after 3h20m35s' }, null))
      .toContain('Quota resets in 3h20m35s.');
  });
});
