import { describe, expect, it } from 'vitest';
import { formatErrorForUi } from './formatErrorForUi';

describe('formatErrorForUi', () => {
  it('formats Error instances using stack when available', () => {
    const err = new Error('boom');
    err.stack = 'STACK';
    expect(formatErrorForUi(err)).toContain('STACK');
  });

  it('falls back to Error.message when stack is unavailable', () => {
    const err = new Error('boom');
    err.stack = '';
    expect(formatErrorForUi(err)).toContain('boom');
  });

  it('formats non-Error values as strings', () => {
    expect(formatErrorForUi('nope')).toBe('nope');
    expect(formatErrorForUi(123)).toBe('123');
  });

  it('formats plain objects using JSON when possible', () => {
    const out = formatErrorForUi({ code: 'E_FAIL', message: 'boom' });
    expect(out).toContain('E_FAIL');
    expect(out).toContain('boom');
    expect(out).not.toBe('[object Object]');
  });

  it('redacts sensitive provider error details', () => {
    const out = formatErrorForUi({
      message: 'Authorization: Bearer provider-secret-token',
      response: {
        data: {
          access_token: 'provider-access-token',
          refresh_token: 'provider-refresh-token',
          client_secret: 'provider-client-secret',
        },
      },
    });

    expect(out).not.toContain('provider-secret-token');
    expect(out).not.toContain('provider-access-token');
    expect(out).not.toContain('provider-refresh-token');
    expect(out).not.toContain('provider-client-secret');
    expect(out).toContain('[REDACTED]');
  });

  it('truncates long output with a suffix', () => {
    const input = 'x'.repeat(1201);
    const out = formatErrorForUi(input, { maxChars: 1000 });
    expect(out).toContain('…[truncated]');
    expect(out.startsWith('x'.repeat(1000))).toBe(true);
  });

  it('clamps maxChars to at least 1000', () => {
    const input = 'x'.repeat(1201);
    const out = formatErrorForUi(input, { maxChars: 10 });
    expect(out.startsWith('x'.repeat(1000))).toBe(true);
    expect(out).toContain('…[truncated]');
  });
});
