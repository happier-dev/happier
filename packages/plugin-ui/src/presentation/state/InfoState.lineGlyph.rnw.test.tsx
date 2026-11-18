import { describe, expect, it } from 'vitest';

import { resolveHappierStateFailureGlyph, resolveHappierStateLineGlyphTone } from './InfoState.js';

// A failed SQL statement drew the amber warning triangle in its error line (DBW-UI-4 N8): amber says "needs you",
// rose says "failed". A line draws a failure with the same failed glyph as a card, in rose.
describe('a state line glyph', () => {
  it('draws a failure with the failed glyph in rose, a warning in amber, and the rest muted', () => {
    expect(resolveHappierStateFailureGlyph('error')).toBe('failure');
    expect(resolveHappierStateLineGlyphTone('error')).toBe('danger');
    expect(resolveHappierStateLineGlyphTone('warning')).toBe('warning');
    expect(resolveHappierStateLineGlyphTone('unavailable')).toBe('muted');
    expect(resolveHappierStateLineGlyphTone('denied')).toBe('muted');
  });
});
