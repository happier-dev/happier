import { describe, expect, it } from 'vitest';

import { shouldStartClaudeSessionCaffeinate } from './sessionCaffeinatePolicy';

describe('shouldStartClaudeSessionCaffeinate', () => {
  it('returns true for terminal-started sessions', () => {
    expect(shouldStartClaudeSessionCaffeinate('terminal')).toBe(true);
    expect(shouldStartClaudeSessionCaffeinate(undefined)).toBe(true);
  });

  it('returns false for daemon-started sessions', () => {
    expect(shouldStartClaudeSessionCaffeinate('daemon')).toBe(false);
  });
});
