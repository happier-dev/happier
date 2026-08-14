import { describe, expect, it } from 'vitest';

import { readSessionStateFieldFromMetadata } from './publishField.js';

describe('readSessionStateFieldFromMetadata', () => {
  it('reads a bound field through the canonical binding', () => {
    expect(readSessionStateFieldFromMetadata({
      summary: { text: 'Canonical title', updatedAt: 12 },
    }, 'display.title')).toBe('Canonical title');
  });

  it('returns undefined for a field with no metadata binding', () => {
    expect(readSessionStateFieldFromMetadata({}, 'view.attention')).toBeUndefined();
  });
});
