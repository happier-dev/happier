import { describe, expect, it } from 'vitest';
import { normalizeCapabilityProbeError } from './normalizeCapabilityProbeError';

describe('normalizeCapabilityProbeError', () => {
  it('normalizes Error-like objects with string messages', () => {
    expect(normalizeCapabilityProbeError(new Error('boom'))).toEqual({ message: 'boom' });
    expect(normalizeCapabilityProbeError({ message: 'nope' })).toEqual({ message: 'nope' });
  });

  it('normalizes non-empty strings', () => {
    expect(normalizeCapabilityProbeError('fail')).toEqual({ message: 'fail' });
  });

  it.each([
    { input: null, expected: 'null' },
    { input: undefined, expected: 'undefined' },
    { input: Symbol('probe-failed'), expected: 'Symbol(probe-failed)' },
    { input: { message: 123 }, expected: '[object Object]' },
    { input: { message: '' }, expected: '[object Object]' },
    { input: { message: { nested: 'boom' } }, expected: '[object Object]' },
    { input: { nested: { detail: 'boom' } }, expected: '[object Object]' },
  ])('normalizes uncommon input shape %#', ({ input, expected }) => {
    expect(normalizeCapabilityProbeError(input)).toEqual({ message: expected });
  });
});
