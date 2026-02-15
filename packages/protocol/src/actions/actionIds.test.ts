import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';

describe('ActionIdSchema', () => {
  it('accepts known action ids', () => {
    expect(ActionIdSchema.parse('review.start')).toBe('review.start');
    expect(ActionIdSchema.parse('session.open')).toBe('session.open');
  });

  it('does not accept de-surfaced legacy action ids', () => {
    expect(() => ActionIdSchema.parse('execution.run.start')).toThrow();
  });
});
