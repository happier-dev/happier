import { describe, expect, it } from 'vitest';

import { formatSessionCommandError } from './sessionCommandErrorPresentation';

describe('formatSessionCommandError', () => {
  it('explains an unavailable execution target without changing its machine code', () => {
    const error = Object.assign(new Error('target_unavailable'), {
      code: 'target_unavailable',
    });

    expect(formatSessionCommandError(error)).toBe(
      'The selected machine is not currently available. Check its connection and try again.',
    );
    expect(error.code).toBe('target_unavailable');
  });

  it('preserves an existing actionable error message', () => {
    expect(formatSessionCommandError(new Error('Choose one Session.')))
      .toBe('Choose one Session.');
  });
});
