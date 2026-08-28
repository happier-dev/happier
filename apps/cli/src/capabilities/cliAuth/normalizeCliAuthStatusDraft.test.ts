import { describe, expect, it } from 'vitest';

import { normalizeCliAuthStatusDraft } from './normalizeCliAuthStatusDraft';

describe('normalizeCliAuthStatusDraft', () => {
  it('preserves a complete typed Agent CLI auth status', () => {
    expect(normalizeCliAuthStatusDraft({
      state: 'logged_in',
      method: 'oauth_cli',
      accountLabel: 'person@example.com',
      reason: null,
      source: 'command',
    })).toEqual({
      state: 'logged_in',
      method: 'oauth_cli',
      accountLabel: 'person@example.com',
      reason: null,
      source: 'command',
    });
  });

  it.each([
    ['missing status', undefined],
    ['non-object status', 'logged_in'],
    ['missing state', {}],
    ['unknown state', { state: 'authenticated' }],
    ['malformed optional member', { state: 'logged_in', source: 'parser' }],
  ])('fails closed neutrally for %s', (_label, value) => {
    expect(normalizeCliAuthStatusDraft(value)).toBeNull();
  });
});
