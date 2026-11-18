import { describe, expect, it } from 'vitest';

import { joinHappierFacts } from './FactLine.js';

describe('joined facts', () => {
  it('keeps each separator with the fact that follows it when the line wraps', () => {
    const joined = joinHappierFacts('Stop after 1 h unused', null, 'wakes', 'Kept');
    // Ordinary spaces are where a line may break: no piece between them may end with the separator.
    const pieces = joined.split(' ');
    expect(pieces.some(piece => piece.endsWith('·'))).toBe(false);
    expect(joined.replace(/\s/g, ' ')).toBe('Stop after 1 h unused · wakes · Kept');
  });
});
