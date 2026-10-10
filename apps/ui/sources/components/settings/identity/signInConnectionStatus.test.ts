import { describe, expect, it } from 'vitest';

import {
  resolveTestedSignInConnectionStatus,
  signInConnectionStatusLabel,
  signInConnectionStatusTone,
  type SignInConnectionStatus,
} from './signInConnectionStatus';

const ALL: readonly SignInConnectionStatus[] = [
  'unavailable',
  'prohibited',
  'not_configured',
  'setting_up',
  'test_required',
  'retest_required',
  'tested',
  'active',
  'needs_attention',
  'disabled',
];

describe('signInConnectionStatus', () => {
  it('reads a switch-and-test record in the order off, untestable, untested, current, outdated', () => {
    const tested = { current: true };
    const outdated = { current: false };
    expect(
      resolveTestedSignInConnectionStatus({
        enabled: false,
        testable: true,
        lastSuccessfulTest: tested,
      }),
    ).toBe('disabled');
    expect(
      resolveTestedSignInConnectionStatus({
        enabled: true,
        testable: false,
        lastSuccessfulTest: null,
      }),
    ).toBe('active');
    expect(
      resolveTestedSignInConnectionStatus({
        enabled: true,
        testable: true,
        lastSuccessfulTest: null,
      }),
    ).toBe('test_required');
    expect(
      resolveTestedSignInConnectionStatus({
        enabled: true,
        testable: true,
        lastSuccessfulTest: tested,
      }),
    ).toBe('tested');
    expect(
      resolveTestedSignInConnectionStatus({
        enabled: true,
        testable: true,
        lastSuccessfulTest: outdated,
      }),
    ).toBe('retest_required');
  });

  it('names every status once, so no two states share a word', () => {
    const labels = ALL.map(signInConnectionStatusLabel);
    expect(new Set(labels).size).toBe(ALL.length);
  });

  it('keeps healthy and switched-off states quiet and speaks only when someone is needed', () => {
    expect(
      ALL.filter((status) => signInConnectionStatusTone(status) === 'quiet'),
    ).toEqual(['prohibited', 'tested', 'active', 'disabled']);
    expect(
      ALL.filter((status) => signInConnectionStatusTone(status) === 'trouble'),
    ).toEqual(['unavailable', 'needs_attention']);
  });
});
