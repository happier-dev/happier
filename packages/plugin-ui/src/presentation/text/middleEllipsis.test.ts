import { describe, expect, it } from 'vitest';

import { splitForWebMiddleEllipsis } from './middleEllipsis.js';

describe('splitForWebMiddleEllipsis', () => {
  it('keeps the word space at a cut, which a browser would drop at the start or end of a run', () => {
    const split = splitForWebMiddleEllipsis('An Environment you can’t open');
    expect(split).not.toBeNull();
    // Rejoined as the two runs render, the words stay apart.
    expect(`${split!.head}${split!.tail}`.replace(/ /g, ' ')).toBe('An Environment you can’t open');
    expect(split!.tail.startsWith(' ')).toBe(false);
    expect(split!.head.endsWith(' ')).toBe(false);
  });

  it('keeps a name’s distinguishing suffix whole', () => {
    expect(splitForWebMiddleEllipsis('customer-portal · Production')).toEqual({ head: 'customer-portal', tail: ' · Production' });
  });
});
